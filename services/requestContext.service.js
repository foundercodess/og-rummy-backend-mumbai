'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const MAX_SPANS = Number(process.env.REQUEST_TRACE_MAX_SPANS) || 64;
const storage = new AsyncLocalStorage();

function compactSql(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 160);
}

function run(context, fn) {
  const store = {
    trace_id: context.trace_id || null,
    session_id: context.session_id ?? null,
    event_name: context.event_name || null,
    user_id: context.user_id ?? null,
    // 'auth' | 'gameplay' — routes HTTP auth/wallet bursts off the gameplay PG pool
    db_pool: context.db_pool === 'auth' ? 'auth' : 'gameplay',
    spans: [],
  };
  return storage.run(store, fn);
}

function getStore() {
  return storage.getStore() || null;
}

function recordQuerySpan({
  sql,
  acquireMs = 0,
  execMs = 0,
  totalMs = 0,
  ok = true,
  error = null,
} = {}) {
  const store = getStore();
  if (!store) return;

  store.spans.push({
    sql: compactSql(sql),
    acquire_ms: acquireMs,
    exec_ms: execMs,
    total_ms: totalMs,
    ok,
    ...(error ? { error: String(error).slice(0, 200) } : {}),
  });
  if (store.spans.length > MAX_SPANS) {
    store.spans.shift();
  }
}

function formatSpanDump(store) {
  if (!store || !store.spans.length) return null;

  const queries = store.spans;
  const acquireTotal = queries.reduce((sum, row) => sum + (row.acquire_ms || 0), 0);
  const execTotal = queries.reduce((sum, row) => sum + (row.exec_ms || 0), 0);

  return {
    trace_id: store.trace_id,
    session_id: store.session_id,
    event_name: store.event_name,
    user_id: store.user_id,
    query_count: queries.length,
    query_total_ms: queries.reduce((sum, row) => sum + (row.total_ms || 0), 0),
    acquire_total_ms: acquireTotal,
    exec_total_ms: execTotal,
    queries,
  };
}

function logSpanDump(reason, extra = {}) {
  const dump = formatSpanDump(getStore());
  if (!dump) return;

  console.warn(
    `[REQUEST_TRACE] reason=${reason} ${JSON.stringify({ ...dump, ...extra })}`,
  );
}

module.exports = {
  run,
  getStore,
  recordQuerySpan,
  formatSpanDump,
  logSpanDump,
};
