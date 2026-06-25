const telemetryService = require('./telemetry.service');

function parseDateOrNull(value, code) {
  if (value == null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    const err = new Error(code);
    err.code = code;
    throw err;
  }
  return d.toISOString();
}

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

async function listTelemetryForAdmin(query = {}) {
  const page = parsePositiveInt(query.page, 1, 1000000);
  const limit = parsePositiveInt(query.limit, 50, 500);
  const offset = (page - 1) * limit;

  const sessionIdRaw = query.session_id ?? query.sessionId;
  const userIdRaw = query.user_id ?? query.userId;
  const sessionId = sessionIdRaw != null ? Number(sessionIdRaw) : null;
  const userId = userIdRaw != null ? Number(userIdRaw) : null;

  if (sessionIdRaw != null && (!Number.isInteger(sessionId) || sessionId <= 0)) {
    const err = new Error('INVALID_SESSION_ID');
    err.code = 'INVALID_SESSION_ID';
    throw err;
  }
  if (userIdRaw != null && (!Number.isInteger(userId) || userId <= 0)) {
    const err = new Error('INVALID_USER_ID');
    err.code = 'INVALID_USER_ID';
    throw err;
  }

  let success = null;
  if (query.success === 'true') success = true;
  if (query.success === 'false') success = false;

  const result = await telemetryService.listTelemetryEvents({
    sessionId,
    userId,
    eventName: query.event_name || query.eventName || null,
    success,
    traceId: query.trace_id || query.traceId || null,
    fromDate: parseDateOrNull(query.from || query.from_date, 'INVALID_DATE_FROM'),
    toDate: parseDateOrNull(query.to || query.to_date, 'INVALID_DATE_TO'),
    limit,
    offset,
  });

  return {
    ...result,
    pagination: {
      ...result.pagination,
      page,
    },
  };
}

async function getSessionTelemetryForAdmin(sessionId, query = {}) {
  return telemetryService.getSessionTelemetryReport(sessionId, {
    fromDate: parseDateOrNull(query.from || query.from_date, 'INVALID_DATE_FROM'),
    toDate: parseDateOrNull(query.to || query.to_date, 'INVALID_DATE_TO'),
  });
}

async function getTraceForAdmin(traceId) {
  return telemetryService.getTelemetryTrace(traceId);
}

async function getTelemetrySummaryForAdmin(query = {}) {
  return telemetryService.getGlobalTelemetryReport({
    fromDate: parseDateOrNull(query.from || query.from_date, 'INVALID_DATE_FROM'),
    toDate: parseDateOrNull(query.to || query.to_date, 'INVALID_DATE_TO'),
    limit: parsePositiveInt(query.top_events, 25, 100),
  });
}

module.exports = {
  listTelemetryForAdmin,
  getSessionTelemetryForAdmin,
  getTraceForAdmin,
  getTelemetrySummaryForAdmin,
};
