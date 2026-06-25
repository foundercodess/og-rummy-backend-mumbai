const { query } = require('../db');

async function insertEvent(row = {}) {
  const result = await query(
    `INSERT INTO game_telemetry_events (
       game_session_id,
       user_id,
       socket_id,
       trace_id,
       direction,
       channel,
       event_name,
       success,
       error_message,
       delivery_status,
       client_sent_at,
       server_received_at,
       server_completed_at,
       client_ack_at,
       handler_ms,
       client_rtt_ms,
       delivery_ms,
       request_bytes,
       response_bytes,
       payload_summary,
       ack_summary
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21::jsonb
     )
     RETURNING id, created_at`,
    [
      row.game_session_id ?? null,
      row.user_id ?? null,
      row.socket_id ?? null,
      row.trace_id,
      row.direction,
      row.channel,
      row.event_name,
      row.success ?? null,
      row.error_message ?? null,
      row.delivery_status ?? null,
      row.client_sent_at ?? null,
      row.server_received_at ?? null,
      row.server_completed_at ?? null,
      row.client_ack_at ?? null,
      row.handler_ms ?? null,
      row.client_rtt_ms ?? null,
      row.delivery_ms ?? null,
      row.request_bytes ?? null,
      row.response_bytes ?? null,
      JSON.stringify(row.payload_summary || {}),
      JSON.stringify(row.ack_summary || {}),
    ]
  );
  return result.rows[0] || null;
}

async function listEvents({
  sessionId = null,
  userId = null,
  eventName = null,
  success = null,
  traceId = null,
  fromDate = null,
  toDate = null,
  limit = 100,
  offset = 0,
} = {}) {
  const where = [];
  const params = [];
  let idx = 1;

  if (sessionId != null) {
    where.push(`game_session_id = $${idx++}`);
    params.push(sessionId);
  }
  if (userId != null) {
    where.push(`user_id = $${idx++}`);
    params.push(userId);
  }
  if (eventName) {
    where.push(`event_name = $${idx++}`);
    params.push(eventName);
  }
  if (success === true || success === false) {
    where.push(`success = $${idx++}`);
    params.push(success);
  }
  if (traceId) {
    where.push(`trace_id = $${idx++}`);
    params.push(traceId);
  }
  if (fromDate) {
    where.push(`created_at >= $${idx++}`);
    params.push(fromDate);
  }
  if (toDate) {
    where.push(`created_at <= $${idx++}`);
    params.push(toDate);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  const countResult = await query(
    `SELECT COUNT(*)::int AS total FROM game_telemetry_events ${whereClause}`,
    params
  );

  const listResult = await query(
    `SELECT *
     FROM game_telemetry_events
     ${whereClause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    [...params, safeLimit, safeOffset]
  );

  return {
    total: countResult.rows[0]?.total || 0,
    rows: listResult.rows,
    limit: safeLimit,
    offset: safeOffset,
  };
}

async function listByTraceId(traceId) {
  const result = await query(
    `SELECT *
     FROM game_telemetry_events
     WHERE trace_id = $1
     ORDER BY created_at ASC, id ASC`,
    [traceId]
  );
  return result.rows;
}

async function findLatestEmitByTraceId(traceId) {
  const result = await query(
    `SELECT *
     FROM game_telemetry_events
     WHERE trace_id = $1
       AND channel = 'socket_emit'
     ORDER BY id DESC
     LIMIT 1`,
    [traceId]
  );
  return result.rows[0] || null;
}

async function getSessionSummary(sessionId, { fromDate = null, toDate = null } = {}) {
  const params = [sessionId];
  let idx = 2;
  const dateFilters = [];
  if (fromDate) {
    dateFilters.push(`created_at >= $${idx++}`);
    params.push(fromDate);
  }
  if (toDate) {
    dateFilters.push(`created_at <= $${idx++}`);
    params.push(toDate);
  }
  const dateClause = dateFilters.length > 0 ? ` AND ${dateFilters.join(' AND ')}` : '';

  const result = await query(
    `SELECT
       event_name,
       direction,
       channel,
       COUNT(*)::int AS event_count,
       COUNT(*) FILTER (WHERE success = false)::int AS error_count,
       COUNT(*) FILTER (WHERE delivery_status = 'acked_by_client')::int AS client_acked_count,
       COUNT(*) FILTER (WHERE channel = 'socket_emit')::int AS emit_count,
       ROUND(AVG(handler_ms) FILTER (
         WHERE channel = 'socket_ack' AND handler_ms IS NOT NULL AND handler_ms > 0
       ))::int AS avg_server_handler_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY handler_ms)
         FILTER (WHERE channel = 'socket_ack' AND handler_ms IS NOT NULL AND handler_ms > 0)
       )::int AS p95_server_handler_ms,
       ROUND(AVG(client_rtt_ms) FILTER (
         WHERE channel = 'socket_ack' AND client_rtt_ms IS NOT NULL AND client_rtt_ms > 0
       ))::int AS avg_client_request_rtt_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY client_rtt_ms)
         FILTER (WHERE channel = 'socket_ack' AND client_rtt_ms IS NOT NULL AND client_rtt_ms > 0)
       )::int AS p95_client_request_rtt_ms,
       ROUND(AVG(delivery_ms) FILTER (
         WHERE channel = 'client_ack' AND delivery_ms IS NOT NULL AND delivery_ms > 0
       ))::int AS avg_broadcast_delivery_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY delivery_ms)
         FILTER (WHERE channel = 'client_ack' AND delivery_ms IS NOT NULL AND delivery_ms > 0)
       )::int AS p95_broadcast_delivery_ms,
       COUNT(*) FILTER (
         WHERE channel = 'socket_ack' AND client_rtt_ms IS NOT NULL AND client_rtt_ms > 0
       )::int AS client_request_rtt_samples,
       COUNT(*) FILTER (
         WHERE channel = 'client_ack' AND delivery_ms IS NOT NULL AND delivery_ms > 0
       )::int AS broadcast_delivery_samples,
       MIN(created_at) AS first_at,
       MAX(created_at) AS last_at
     FROM game_telemetry_events
     WHERE game_session_id = $1${dateClause}
     GROUP BY event_name, direction, channel
     ORDER BY event_count DESC, event_name ASC`,
    params
  );
  return result.rows;
}

async function getGlobalSummary({ fromDate = null, toDate = null, limit = 20 } = {}) {
  const where = [];
  const params = [];
  let idx = 1;
  if (fromDate) {
    where.push(`created_at >= $${idx++}`);
    params.push(fromDate);
  }
  if (toDate) {
    where.push(`created_at <= $${idx++}`);
    params.push(toDate);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);

  const totals = await query(
    `SELECT
       COUNT(*)::int AS total_events,
       COUNT(DISTINCT game_session_id)::int AS sessions,
       COUNT(DISTINCT user_id)::int AS users,
       COUNT(*) FILTER (WHERE success = false)::int AS errors,
       COUNT(*) FILTER (WHERE channel = 'socket_emit')::int AS emits,
       COUNT(*) FILTER (WHERE delivery_status = 'acked_by_client')::int AS client_acks,
       ROUND(AVG(handler_ms) FILTER (
         WHERE channel = 'socket_ack' AND handler_ms IS NOT NULL AND handler_ms > 0
       ))::int AS avg_server_handler_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY handler_ms)
         FILTER (WHERE channel = 'socket_ack' AND handler_ms IS NOT NULL AND handler_ms > 0)
       )::int AS p95_server_handler_ms,
       ROUND(AVG(client_rtt_ms) FILTER (
         WHERE channel = 'socket_ack' AND client_rtt_ms IS NOT NULL AND client_rtt_ms > 0
       ))::int AS avg_client_request_rtt_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY client_rtt_ms)
         FILTER (WHERE channel = 'socket_ack' AND client_rtt_ms IS NOT NULL AND client_rtt_ms > 0)
       )::int AS p95_client_request_rtt_ms,
       ROUND(AVG(delivery_ms) FILTER (
         WHERE channel = 'client_ack' AND delivery_ms IS NOT NULL AND delivery_ms > 0
       ))::int AS avg_broadcast_delivery_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY delivery_ms)
         FILTER (WHERE channel = 'client_ack' AND delivery_ms IS NOT NULL AND delivery_ms > 0)
       )::int AS p95_broadcast_delivery_ms,
       COUNT(*) FILTER (
         WHERE channel = 'socket_ack' AND client_rtt_ms IS NOT NULL AND client_rtt_ms > 0
       )::int AS client_request_rtt_samples,
       COUNT(*) FILTER (
         WHERE channel = 'client_ack' AND delivery_ms IS NOT NULL AND delivery_ms > 0
       )::int AS broadcast_delivery_samples,
       COUNT(*) FILTER (
         WHERE channel = 'socket_ack' AND handler_ms IS NOT NULL AND handler_ms > 0
       )::int AS server_handler_samples
     FROM game_telemetry_events
     ${whereClause}`,
    params
  );

  const byEvent = await query(
    `SELECT
       event_name,
       channel,
       COUNT(*)::int AS event_count,
       COUNT(*) FILTER (WHERE success = false)::int AS error_count,
       ROUND(AVG(handler_ms) FILTER (
         WHERE channel = 'socket_ack' AND handler_ms IS NOT NULL AND handler_ms > 0
       ))::int AS avg_server_handler_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY handler_ms)
         FILTER (WHERE channel = 'socket_ack' AND handler_ms IS NOT NULL AND handler_ms > 0)
       )::int AS p95_server_handler_ms,
       ROUND(AVG(client_rtt_ms) FILTER (
         WHERE channel = 'socket_ack' AND client_rtt_ms IS NOT NULL AND client_rtt_ms > 0
       ))::int AS avg_client_request_rtt_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY client_rtt_ms)
         FILTER (WHERE channel = 'socket_ack' AND client_rtt_ms IS NOT NULL AND client_rtt_ms > 0)
       )::int AS p95_client_request_rtt_ms,
       ROUND(AVG(delivery_ms) FILTER (
         WHERE channel = 'client_ack' AND delivery_ms IS NOT NULL AND delivery_ms > 0
       ))::int AS avg_broadcast_delivery_ms,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY delivery_ms)
         FILTER (WHERE channel = 'client_ack' AND delivery_ms IS NOT NULL AND delivery_ms > 0)
       )::int AS p95_broadcast_delivery_ms
     FROM game_telemetry_events
     ${whereClause}
     GROUP BY event_name, channel
     ORDER BY event_count DESC
     LIMIT $${idx}`,
    [...params, safeLimit]
  );

  const recentErrors = await query(
    `SELECT id, game_session_id, user_id, trace_id, event_name, error_message, handler_ms, client_rtt_ms, created_at
     FROM game_telemetry_events
     ${whereClause}${whereClause ? ' AND' : ' WHERE'} success = false
     ORDER BY created_at DESC, id DESC
     LIMIT 25`,
    params
  );

  return {
    totals: totals.rows[0] || {},
    by_event: byEvent.rows,
    recent_errors: recentErrors.rows,
  };
}

module.exports = {
  insertEvent,
  listEvents,
  listByTraceId,
  findLatestEmitByTraceId,
  getSessionSummary,
  getGlobalSummary,
};
