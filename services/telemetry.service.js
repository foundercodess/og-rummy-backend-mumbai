const crypto = require('crypto');
const telemetryModel = require('../models/telemetry.model');

const TELEMETRY_SKIPPED_EVENTS = new Set([
  'client:telemetry:ack',
  'notice:get',
  'connection:ready',
]);


function isTelemetryEnabled() {
  const raw = process.env.GAME_TELEMETRY_ENABLED;
  if (raw === undefined || raw === '') return true;
  return String(raw).trim().toLowerCase() === 'true';
}



function generateTraceId() {
  return crypto.randomBytes(12).toString('hex');
}

const MAX_LATENCY_MS = 300000;
const CLOCK_SKEW_TOLERANCE_MS = 30000;

function parseClientTimestamp(value) {
  if (value == null || value === '') return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    const epochMs = value > 1e12 ? value : Math.round(value * 1000);
    const d = new Date(epochMs);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  if (typeof value === 'string' && /^\d{10,13}$/.test(value.trim())) {
    const num = Number(value.trim());
    const epochMs = num > 1e12 ? num : Math.round(num * 1000);
    const d = new Date(epochMs);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeLatencyMs(delta) {
  if (!Number.isFinite(delta)) return null;
  if (delta < 0) {
    if (delta < -CLOCK_SKEW_TOLERANCE_MS) return null;
    return Math.round(Math.abs(delta));
  }
  if (delta > MAX_LATENCY_MS) return null;
  return Math.round(delta);
}

function computeClientRttMs(clientSentAt, serverReceivedMs) {
  if (!clientSentAt) return null;
  const sentMs = Date.parse(clientSentAt);
  if (Number.isNaN(sentMs)) return null;
  return normalizeLatencyMs(serverReceivedMs - sentMs);
}

function resolveClientRttMs(payload = {}, serverReceivedMs = Date.now()) {
  const root = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const meta = root.meta && typeof root.meta === 'object' ? root.meta : {};

  const explicit = Number(
    root.client_rtt_ms
    ?? root.clientRttMs
    ?? root.rtt_ms
    ?? root.rttMs
    ?? meta.client_rtt_ms
    ?? meta.clientRttMs
  );
  if (Number.isFinite(explicit) && explicit > 0) {
    return normalizeLatencyMs(explicit);
  }

  const clientSentAt = parseClientTimestamp(
    root.client_sent_at
    ?? root.clientSentAt
    ?? meta.client_sent_at
    ?? meta.clientSentAt
  );
  return computeClientRttMs(clientSentAt, serverReceivedMs);
}

function resolveDeliveryMsFromPayload(payload = {}) {
  const root = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const explicit = Number(
    root.delivery_ms
    ?? root.deliveryMs
    ?? root.broadcast_delivery_ms
    ?? root.broadcastDeliveryMs
    ?? root.rtt_ms
    ?? root.rttMs
  );
  if (Number.isFinite(explicit) && explicit > 0) {
    return normalizeLatencyMs(explicit);
  }
  return null;
}

function computeDurationMs(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return null;
  return normalizeLatencyMs(toMs - fromMs);
}

function percentile(values, p = 0.95) {
  const sorted = [...values].filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[idx];
}

function statsFromValues(values = []) {
  const samples = values.filter((v) => Number.isFinite(v) && v > 0);
  if (!samples.length) {
    return {
      sample_count: 0,
      avg_ms: null,
      p95_ms: null,
      min_ms: null,
      max_ms: null,
    };
  }
  const sum = samples.reduce((acc, v) => acc + v, 0);
  return {
    sample_count: samples.length,
    avg_ms: Math.round(sum / samples.length),
    p95_ms: percentile(samples, 0.95),
    min_ms: Math.min(...samples),
    max_ms: Math.max(...samples),
  };
}

function buildLatencyAnalytics(events = []) {
  const serverHandlerMs = [];
  const clientRequestRttMs = [];
  const broadcastDeliveryMs = [];

  const emitsByTrace = new Map();
  (events || []).forEach((row) => {
    const channel = row.channel;
    if (channel === 'socket_emit') {
      emitsByTrace.set(row.trace_id, row);
    }
    if (channel === 'socket_ack' && row.handler_ms > 0) {
      serverHandlerMs.push(Number(row.handler_ms));
    }
    if (channel === 'socket_ack' && row.client_rtt_ms > 0) {
      clientRequestRttMs.push(Number(row.client_rtt_ms));
    }
    if (channel === 'client_ack' && row.delivery_ms > 0) {
      broadcastDeliveryMs.push(Number(row.delivery_ms));
      return;
    }
    if (channel === 'client_ack' && row.client_ack_at) {
      const emit = emitsByTrace.get(row.trace_id);
      if (!emit) return;
      const emitAt = emit.server_received_at || emit.server_completed_at || emit.created_at;
      const delivery = computeDurationMs(emitAt, row.client_ack_at);
      if (delivery > 0) broadcastDeliveryMs.push(delivery);
    }
  });

  const requestBytes = [];
  const responseBytes = [];
  (events || []).forEach((row) => {
    if (row.request_bytes > 0) requestBytes.push(Number(row.request_bytes));
    if (row.response_bytes > 0) responseBytes.push(Number(row.response_bytes));
  });

  return {
    server_processing: statsFromValues(serverHandlerMs),
    client_request_rtt: statsFromValues(clientRequestRttMs),
    broadcast_delivery: statsFromValues(broadcastDeliveryMs),
    payload_sizes: {
      request: statsFromValues(requestBytes),
      response: statsFromValues(responseBytes),
    },
    data_quality: {
      client_request_rtt_available: clientRequestRttMs.length > 0,
      client_request_rtt_note: clientRequestRttMs.length > 0
        ? 'Client sends client_sent_at on socket emits.'
        : 'No client_sent_at samples yet — use timing.handler_ms as server-only latency or update the mobile app.',
      broadcast_delivery_available: broadcastDeliveryMs.length > 0,
      broadcast_delivery_note: broadcastDeliveryMs.length > 0
        ? 'Computed from socket_emit -> client:telemetry:ack.'
        : 'No delivery acks yet — mobile must call client:telemetry:ack after game:pick / game:turn.',
      server_processing_note: 'handler_ms on inbound socket ACKs (server work only, not full network RTT).',
    },
  };
}

function estimateJsonBytes(value) {
  if (value == null) return null;
  try {
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (!Number.isFinite(bytes) || bytes < 0) return null;
    return Math.min(bytes, 5 * 1024 * 1024);
  } catch {
    return null;
  }
}

function resolvePayloadBytes(payload = {}, explicitBytes = null) {
  const explicit = Number(explicitBytes ?? payload.payload_bytes ?? payload.payloadBytes);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.min(Math.round(explicit), 5 * 1024 * 1024);
  }
  return estimateJsonBytes(payload);
}

function summarizePayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  const out = {};
  const keys = [
    'session_id',
    'session_code',
    'source',
    'card_uid',
    'group_id',
    'to_group_id',
    'from_group_id',
    'ready',
    'success',
    'code',
    'message',
  ];
  keys.forEach((key) => {
    if (payload[key] != null && payload[key] !== '') out[key] = payload[key];
  });
  if (Array.isArray(payload.groups)) {
    out.groups_count = payload.groups.length;
  }
  const requestBytes = resolvePayloadBytes(payload);
  if (requestBytes != null) out.request_bytes = requestBytes;
  const sentAt = parseClientTimestamp(
    payload.client_sent_at ?? payload.clientSentAt ?? payload.meta?.client_sent_at
  );
  if (sentAt) out.client_sent_at = sentAt;
  return out;
}

function summarizeAck(ack = {}) {
  if (!ack || typeof ack !== 'object' || Array.isArray(ack)) {
    return {};
  }
  const out = {
    success: ack.success === true,
  };
  if (ack.message) out.message = String(ack.message).slice(0, 500);
  if (ack.code) out.code = ack.code;
  const summary = ack?.data?.grouping?.summary;
  if (summary && typeof summary === 'object') {
    out.valid_for_declare = summary.valid_for_declare === true;
    out.display_point = Number(summary.display_point);
    out.ungrouped_points = Number(summary.ungrouped_points);
  }
  const grouping = ack?.data?.grouping;
  if (grouping && typeof grouping === 'object') {
    const groupCount = Array.isArray(grouping.groups) ? grouping.groups.length : 0;
    if (groupCount > 0) out.grouping_groups_count = groupCount;
  }
  const responseBytes = estimateJsonBytes(ack);
  if (responseBytes != null) out.response_bytes = responseBytes;
  return out;
}

function recordEventAsync(row = {}) {
  if (!isTelemetryEnabled()) return;
  setImmediate(() => {
    telemetryModel.insertEvent(row).catch((err) => {
      console.warn('[TELEMETRY] persist failed:', err.message);
    });
  });
}

function recordInboundAck(row = {}) {
  recordEventAsync(row);
}

function recordBroadcast(row = {}) {
  recordEventAsync({
    direction: 'outbound',
    channel: 'socket_emit',
    delivery_status: 'sent',
    success: true,
    ...row,
  });
}

function recordClientDeliveryAck(row = {}) {
  recordEventAsync({
    direction: 'inbound',
    channel: 'client_ack',
    delivery_status: 'acked_by_client',
    success: true,
    ...row,
  });
}

function formatEventRow(row = {}) {
  return {
    id: Number(row.id),
    game_session_id: row.game_session_id != null ? Number(row.game_session_id) : null,
    user_id: row.user_id != null ? Number(row.user_id) : null,
    socket_id: row.socket_id || null,
    trace_id: row.trace_id,
    direction: row.direction,
    channel: row.channel,
    event_name: row.event_name,
    success: row.success,
    error_message: row.error_message || null,
    delivery_status: row.delivery_status || null,
    client_sent_at: row.client_sent_at || null,
    server_received_at: row.server_received_at || null,
    server_completed_at: row.server_completed_at || null,
    client_ack_at: row.client_ack_at || null,
    handler_ms: row.handler_ms != null ? Number(row.handler_ms) : null,
    client_rtt_ms: row.client_rtt_ms != null ? Number(row.client_rtt_ms) : null,
    delivery_ms: row.delivery_ms != null ? Number(row.delivery_ms) : null,
    request_bytes: row.request_bytes != null ? Number(row.request_bytes) : null,
    response_bytes: row.response_bytes != null ? Number(row.response_bytes) : null,
    server_handler_ms: row.channel === 'socket_ack' && row.handler_ms != null
      ? Number(row.handler_ms)
      : null,
    broadcast_delivery_ms: row.channel === 'client_ack' && row.delivery_ms != null
      ? Number(row.delivery_ms)
      : null,
    payload_summary: row.payload_summary || {},
    ack_summary: row.ack_summary || {},
    created_at: row.created_at,
  };
}

async function listTelemetryEvents(filters = {}) {
  const result = await telemetryModel.listEvents(filters);
  return {
    events: result.rows.map(formatEventRow),
    pagination: {
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      total_pages: Math.ceil(result.total / result.limit) || 0,
    },
  };
}

async function getTelemetryTrace(traceId) {
  const rows = await telemetryModel.listByTraceId(String(traceId || '').trim());
  if (!rows.length) {
    const err = new Error('TRACE_NOT_FOUND');
    err.code = 'TRACE_NOT_FOUND';
    throw err;
  }
  return {
    trace_id: traceId,
    events: rows.map(formatEventRow),
  };
}

async function getSessionTelemetryReport(sessionId, filters = {}) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('INVALID_SESSION_ID');
    err.code = 'INVALID_SESSION_ID';
    throw err;
  }

  const [summary, recent, errors] = await Promise.all([
    telemetryModel.getSessionSummary(id, filters),
    telemetryModel.listEvents({ sessionId: id, limit: 200, offset: 0 }),
    telemetryModel.listEvents({
      sessionId: id,
      success: false,
      limit: 50,
      offset: 0,
    }),
  ]);

  const deliveryGaps = await telemetryModel.listEvents({
    sessionId: id,
    limit: 500,
    offset: 0,
  });

  const emitsByTrace = new Map();
  const acksByTrace = new Set();
  (deliveryGaps.rows || []).forEach((row) => {
    if (row.channel === 'socket_emit') {
      emitsByTrace.set(row.trace_id, row);
    }
    if (row.channel === 'client_ack' || row.delivery_status === 'acked_by_client') {
      acksByTrace.add(row.trace_id);
    }
  });

  const undelivered = [];
  emitsByTrace.forEach((emitRow, trace) => {
    if (!acksByTrace.has(trace)) {
      undelivered.push({
        trace_id: trace,
        event_name: emitRow.event_name,
        created_at: emitRow.created_at,
        delivery_status: 'no_client_ack',
      });
    }
  });

  const timeline = recent.rows.map(formatEventRow).reverse();
  const analytics = buildLatencyAnalytics(recent.rows);

  return {
    session_id: id,
    analytics,
    summary: summary.map((row) => ({
      event_name: row.event_name,
      direction: row.direction,
      channel: row.channel,
      event_count: Number(row.event_count) || 0,
      error_count: Number(row.error_count) || 0,
      client_acked_count: Number(row.client_acked_count) || 0,
      emit_count: Number(row.emit_count) || 0,
      avg_server_handler_ms: row.avg_server_handler_ms != null ? Number(row.avg_server_handler_ms) : null,
      p95_server_handler_ms: row.p95_server_handler_ms != null ? Number(row.p95_server_handler_ms) : null,
      avg_client_request_rtt_ms: row.avg_client_request_rtt_ms != null
        ? Number(row.avg_client_request_rtt_ms)
        : null,
      p95_client_request_rtt_ms: row.p95_client_request_rtt_ms != null
        ? Number(row.p95_client_request_rtt_ms)
        : null,
      avg_broadcast_delivery_ms: row.avg_broadcast_delivery_ms != null
        ? Number(row.avg_broadcast_delivery_ms)
        : null,
      p95_broadcast_delivery_ms: row.p95_broadcast_delivery_ms != null
        ? Number(row.p95_broadcast_delivery_ms)
        : null,
      client_request_rtt_samples: Number(row.client_request_rtt_samples) || 0,
      broadcast_delivery_samples: Number(row.broadcast_delivery_samples) || 0,
      first_at: row.first_at,
      last_at: row.last_at,
    })),
    timeline,
    errors: errors.rows.map(formatEventRow),
    undelivered_emits: undelivered.slice(0, 50),
  };
}

function numOrNull(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildGlobalAnalyticsFromTotals(totals = {}) {
  const rttSamples = Number(totals.client_request_rtt_samples) || 0;
  const deliverySamples = Number(totals.broadcast_delivery_samples) || 0;
  const avgRtt = numOrNull(totals.avg_client_request_rtt_ms);
  const p95Rtt = numOrNull(totals.p95_client_request_rtt_ms);
  const avgDelivery = numOrNull(totals.avg_broadcast_delivery_ms);
  const p95Delivery = numOrNull(totals.p95_broadcast_delivery_ms);
  const avgHandler = numOrNull(totals.avg_server_handler_ms);
  const p95Handler = numOrNull(totals.p95_server_handler_ms);

  return {
    server_processing: {
      sample_count: Number(totals.server_handler_samples) || 0,
      avg_ms: avgHandler,
      p95_ms: p95Handler,
      min_ms: null,
      max_ms: null,
    },
    client_request_rtt: {
      sample_count: rttSamples,
      avg_ms: avgRtt,
      p95_ms: p95Rtt,
      min_ms: null,
      max_ms: null,
    },
    broadcast_delivery: {
      sample_count: deliverySamples,
      avg_ms: avgDelivery,
      p95_ms: p95Delivery,
      min_ms: null,
      max_ms: null,
    },
    data_quality: {
      client_request_rtt_available: rttSamples > 0,
      client_request_rtt_note: rttSamples > 0
        ? 'Client sends client_sent_at on socket emits.'
        : 'No client_sent_at samples yet — update the mobile app.',
      broadcast_delivery_available: deliverySamples > 0,
      broadcast_delivery_note: deliverySamples > 0
        ? 'Computed from socket_emit -> client:telemetry:ack.'
        : 'No delivery acks yet — mobile must call client:telemetry:ack after game:pick / game:turn.',
      server_processing_note: 'handler_ms on inbound socket ACKs (server work only, not full network RTT).',
    },
  };
}

async function getGlobalTelemetryReport(filters = {}) {
  const summary = await telemetryModel.getGlobalSummary(filters);
  const rawTotals = summary.totals || {};

  const totals = {
    total_events: Number(rawTotals.total_events) || 0,
    sessions: Number(rawTotals.sessions) || 0,
    users: Number(rawTotals.users) || 0,
    errors: Number(rawTotals.errors) || 0,
    emits: Number(rawTotals.emits) || 0,
    client_acks: Number(rawTotals.client_acks) || 0,
    avg_server_handler_ms: numOrNull(rawTotals.avg_server_handler_ms),
    p95_server_handler_ms: numOrNull(rawTotals.p95_server_handler_ms),
    avg_client_request_rtt_ms: numOrNull(rawTotals.avg_client_request_rtt_ms),
    p95_client_request_rtt_ms: numOrNull(rawTotals.p95_client_request_rtt_ms),
    avg_broadcast_delivery_ms: numOrNull(rawTotals.avg_broadcast_delivery_ms),
    p95_broadcast_delivery_ms: numOrNull(rawTotals.p95_broadcast_delivery_ms),
    client_request_rtt_samples: Number(rawTotals.client_request_rtt_samples) || 0,
    broadcast_delivery_samples: Number(rawTotals.broadcast_delivery_samples) || 0,
    server_handler_samples: Number(rawTotals.server_handler_samples) || 0,
    avg_response_ms: numOrNull(rawTotals.avg_client_request_rtt_ms),
    p95_response_ms: numOrNull(rawTotals.p95_client_request_rtt_ms),
    // Legacy / doc aliases (some admin UIs bind these names)
    avg_handler_ms: numOrNull(rawTotals.avg_server_handler_ms),
    p95_handler_ms: numOrNull(rawTotals.p95_server_handler_ms),
    avg_client_rtt_ms: numOrNull(rawTotals.avg_client_request_rtt_ms),
    p95_client_rtt_ms: numOrNull(rawTotals.p95_client_request_rtt_ms),
  };

  const dataQuality = {
    client_request_rtt_requires_client_sent_at: true,
    broadcast_delivery_requires_client_telemetry_ack: true,
    client_request_rtt_samples: totals.client_request_rtt_samples,
    broadcast_delivery_samples: totals.broadcast_delivery_samples,
    response_metrics_available: totals.client_request_rtt_samples > 0,
    broadcast_metrics_available: totals.broadcast_delivery_samples > 0,
  };

  const analytics = buildGlobalAnalyticsFromTotals(totals);

  return {
    totals,
    // Session report uses report.analytics.* — mirror that on global summary for dashboard cards
    analytics,
    // Flat aliases (bind overview cards here if not using totals.*)
    avg_response_ms: totals.avg_response_ms,
    p95_response_ms: totals.p95_response_ms,
    avg_server_handler_ms: totals.avg_server_handler_ms,
    p95_server_handler_ms: totals.p95_server_handler_ms,
    avg_broadcast_delivery_ms: totals.avg_broadcast_delivery_ms,
    p95_broadcast_delivery_ms: totals.p95_broadcast_delivery_ms,
    latency_cards: {
      avg_response: {
        avg_ms: totals.avg_response_ms,
        p95_ms: totals.p95_response_ms,
        sample_count: totals.client_request_rtt_samples,
      },
      server_processing: {
        avg_ms: totals.avg_server_handler_ms,
        p95_ms: totals.p95_server_handler_ms,
        sample_count: totals.server_handler_samples,
      },
      broadcast_delivery: {
        avg_ms: totals.avg_broadcast_delivery_ms,
        p95_ms: totals.p95_broadcast_delivery_ms,
        sample_count: totals.broadcast_delivery_samples,
      },
    },
    by_event: (summary.by_event || []).map((row) => ({
      event_name: row.event_name,
      channel: row.channel,
      event_count: Number(row.event_count) || 0,
      error_count: Number(row.error_count) || 0,
      avg_server_handler_ms: row.avg_server_handler_ms != null ? Number(row.avg_server_handler_ms) : null,
      p95_server_handler_ms: row.p95_server_handler_ms != null ? Number(row.p95_server_handler_ms) : null,
      avg_client_request_rtt_ms: row.avg_client_request_rtt_ms != null
        ? Number(row.avg_client_request_rtt_ms)
        : null,
      p95_client_request_rtt_ms: row.p95_client_request_rtt_ms != null
        ? Number(row.p95_client_request_rtt_ms)
        : null,
      avg_broadcast_delivery_ms: row.avg_broadcast_delivery_ms != null
        ? Number(row.avg_broadcast_delivery_ms)
        : null,
      p95_broadcast_delivery_ms: row.p95_broadcast_delivery_ms != null
        ? Number(row.p95_broadcast_delivery_ms)
        : null,
      avg_response_ms: row.avg_client_request_rtt_ms != null
        ? Number(row.avg_client_request_rtt_ms)
        : null,
      p95_response_ms: row.p95_client_request_rtt_ms != null
        ? Number(row.p95_client_request_rtt_ms)
        : null,
    })),
    recent_errors: (summary.recent_errors || []).map(formatEventRow),
    data_quality: dataQuality,
    filters,
  };
}

async function resolveBroadcastDeliveryMs(traceId, payload = {}) {
  const fromPayload = resolveDeliveryMsFromPayload(payload);
  if (fromPayload != null) return fromPayload;

  const serverEmitAt = parseClientTimestamp(
    payload.server_emit_at
    ?? payload.serverEmitAt
    ?? payload.server_time
    ?? payload.serverTime
  );
  const clientAckAt = parseClientTimestamp(
    payload.client_ack_at ?? payload.clientAckAt ?? payload.received_at
  ) || new Date().toISOString();

  if (serverEmitAt) {
    return computeDurationMs(serverEmitAt, clientAckAt);
  }

  const emitRow = await telemetryModel.findLatestEmitByTraceId(traceId);
  if (!emitRow) return null;
  const emitAt = emitRow.server_received_at || emitRow.server_completed_at || emitRow.created_at;
  return computeDurationMs(emitAt, clientAckAt);
}

module.exports = {
  isTelemetryEnabled,
  TELEMETRY_SKIPPED_EVENTS,
  generateTraceId,
  parseClientTimestamp,
  computeClientRttMs,
  resolveClientRttMs,
  resolveDeliveryMsFromPayload,
  computeDurationMs,
  buildLatencyAnalytics,
  resolveBroadcastDeliveryMs,
  estimateJsonBytes,
  resolvePayloadBytes,
  summarizePayload,
  summarizeAck,
  recordEventAsync,
  recordInboundAck,
  recordBroadcast,
  recordClientDeliveryAck,
  listTelemetryEvents,
  getTelemetryTrace,
  getSessionTelemetryReport,
  getGlobalTelemetryReport,
};
