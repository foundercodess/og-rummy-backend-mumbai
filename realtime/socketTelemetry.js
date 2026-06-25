const telemetryService = require('../services/telemetry.service');

function resolveSessionIdFromPayload(payload = {}) {
  const raw = payload.session_id ?? payload.sessionId ?? null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function extractTraceId(payload = {}) {
  const raw = payload.trace_id ?? payload.traceId ?? null;
  return raw ? String(raw).trim() : null;
}

function enrichAckResponse(ack, traceId, handlerMs, clientRttMs = null) {
  if (!ack || typeof ack !== 'object' || Array.isArray(ack)) return ack;
  const timing = {
    ...(ack.timing && typeof ack.timing === 'object' ? ack.timing : {}),
    handler_ms: handlerMs,
  };
  if (clientRttMs != null && clientRttMs > 0) {
    timing.client_rtt_ms = clientRttMs;
  }
  const enriched = {
    ...ack,
    trace_id: traceId,
    server_time: ack.server_time || new Date().toISOString(),
    timing,
  };
  if (clientRttMs != null && clientRttMs > 0) {
    enriched.client_rtt_ms = clientRttMs;
  }
  return enriched;
}

function wrapSocketListener(socket, eventName, listener) {
  if (!telemetryService.isTelemetryEnabled()) return listener;
  if (telemetryService.TELEMETRY_SKIPPED_EVENTS.has(eventName)) return listener;

  return async function telemetryWrapped(...args) {
    const startedAtMs = Date.now();
    const serverReceivedAt = new Date().toISOString();
    const payload = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])
      ? args[0]
      : {};
    const traceId = extractTraceId(payload) || telemetryService.generateTraceId();
    const sessionId = resolveSessionIdFromPayload(payload);
    const clientSentAt = telemetryService.parseClientTimestamp(
      payload.client_sent_at ?? payload.clientSentAt ?? payload.meta?.client_sent_at
    );
    const clientRttMs = telemetryService.resolveClientRttMs(payload, startedAtMs);

    const lastArg = args[args.length - 1];
    const hasCallback = typeof lastArg === 'function';
    let recorded = false;

    const recordOnce = (extra = {}) => {
      if (recorded) return;
      recorded = true;
      telemetryService.recordInboundAck({
        game_session_id: sessionId,
        user_id: socket?.user?.id ?? null,
        socket_id: socket?.id ?? null,
        trace_id: traceId,
        direction: 'inbound',
        channel: 'socket_ack',
        event_name: eventName,
        server_received_at: serverReceivedAt,
        server_completed_at: new Date().toISOString(),
        handler_ms: Date.now() - startedAtMs,
        client_sent_at: clientSentAt,
        client_rtt_ms: clientRttMs,
        request_bytes: telemetryService.resolvePayloadBytes(payload),
        payload_summary: telemetryService.summarizePayload(payload),
        ...extra,
      });
    };

    try {
      if (!hasCallback) {
        const result = await listener.apply(this, args);
        recordOnce({ success: true });
        return result;
      }

      const userCallback = lastArg;
      const wrappedArgs = [
        ...args.slice(0, -1),
        function telemetryCallback(ack) {
          const ackObj = ack && typeof ack === 'object' && !Array.isArray(ack)
            ? ack
            : { success: false, message: 'invalid_ack_payload' };
          recordOnce({
            success: ackObj.success !== false,
            error_message: ackObj.success === false
              ? String(ackObj.message || ackObj.code || 'request_failed').slice(0, 500)
              : null,
            response_bytes: telemetryService.estimateJsonBytes(ackObj),
            ack_summary: telemetryService.summarizeAck(ackObj),
          });
          userCallback(enrichAckResponse(
            ackObj,
            traceId,
            Date.now() - startedAtMs,
            clientRttMs
          ));
        },
      ];
      return await listener.apply(this, wrappedArgs);
    } catch (err) {
      recordOnce({
        success: false,
        error_message: String(err.message || 'handler_error').slice(0, 500),
      });
      throw err;
    }
  };
}

function instrumentSocket(socket) {
  if (!telemetryService.isTelemetryEnabled()) return;
  if (socket.__telemetryInstrumented) return;
  socket.__telemetryInstrumented = true;

  const originalOn = socket.on.bind(socket);
  socket.on = function instrumentedOn(eventName, listener) {
    if (typeof listener !== 'function') {
      return originalOn(eventName, listener);
    }
    return originalOn(eventName, wrapSocketListener(socket, eventName, listener));
  };
}

function attachTraceToPayload(payload = {}, traceId = null) {
  const id = traceId || telemetryService.generateTraceId();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { trace_id: id };
  }
  return {
    ...payload,
    trace_id: payload.trace_id || payload.traceId || id,
  };
}

function traceSessionBroadcast({
  sessionId = null,
  eventName = '',
  payload = {},
  targetUserId = null,
  traceId = null,
} = {}) {
  if (!telemetryService.isTelemetryEnabled()) return payload;
  const resolvedTraceId = traceId
    || extractTraceId(payload)
    || telemetryService.generateTraceId();

  const enrichedPayload = attachTraceToPayload(payload, resolvedTraceId);
  const responseBytes = telemetryService.estimateJsonBytes(enrichedPayload);

  telemetryService.recordBroadcast({
    game_session_id: sessionId,
    user_id: targetUserId,
    trace_id: resolvedTraceId,
    event_name: eventName,
    response_bytes: responseBytes,
    payload_summary: {
      ...telemetryService.summarizePayload(payload),
      ...(responseBytes != null ? { response_bytes: responseBytes } : {}),
    },
    server_received_at: new Date().toISOString(),
    server_completed_at: new Date().toISOString(),
  });

  return enrichedPayload;
}

async function handleClientTelemetryAck(socket, payload = {}) {
  const traceId = extractTraceId(payload);
  if (!traceId) return { success: false, message: 'trace_id is required' };

  const clientAckAt = telemetryService.parseClientTimestamp(
    payload.client_ack_at ?? payload.clientAckAt ?? payload.received_at
  ) || new Date().toISOString();

  const deliveryMs = await telemetryService.resolveBroadcastDeliveryMs(traceId, payload);
  const renderMs = Number(payload.render_ms ?? payload.renderMs);
  const normalizedRenderMs = Number.isFinite(renderMs) && renderMs > 0 ? Math.round(renderMs) : null;

  telemetryService.recordClientDeliveryAck({
    game_session_id: resolveSessionIdFromPayload(payload),
    user_id: socket?.user?.id ?? null,
    socket_id: socket?.id ?? null,
    trace_id: traceId,
    event_name: String(payload.event_name || payload.eventName || 'unknown').slice(0, 64),
    client_ack_at: clientAckAt,
    client_sent_at: telemetryService.parseClientTimestamp(
      payload.client_sent_at ?? payload.clientSentAt
    ),
    delivery_ms: deliveryMs,
    handler_ms: normalizedRenderMs,
    request_bytes: telemetryService.resolvePayloadBytes(
      payload,
      payload.received_payload_bytes ?? payload.receivedPayloadBytes
    ),
    response_bytes: Number(payload.received_payload_bytes ?? payload.receivedPayloadBytes) > 0
      ? Math.round(Number(payload.received_payload_bytes ?? payload.receivedPayloadBytes))
      : null,
    payload_summary: {
      ...telemetryService.summarizePayload(payload),
      ...(payload.received_payload_bytes != null
        ? { received_payload_bytes: Number(payload.received_payload_bytes) }
        : {}),
    },
    ack_summary: {
      received: payload.received !== false,
      render_ms: normalizedRenderMs,
      delivery_ms: deliveryMs,
      received_payload_bytes: Number(payload.received_payload_bytes ?? payload.receivedPayloadBytes) || null,
    },
  });

  return {
    success: true,
    trace_id: traceId,
    server_time: new Date().toISOString(),
    delivery_ms: deliveryMs,
    render_ms: normalizedRenderMs,
  };
}

module.exports = {
  instrumentSocket,
  traceSessionBroadcast,
  handleClientTelemetryAck,
  attachTraceToPayload,
};
