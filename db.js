'use strict';

const { Pool } = require('pg');
const requestContext = require('./services/requestContext.service');

let gameplayPool = null;
let authPool = null;

const POOL_SPLIT_ENABLED = String(process.env.DB_POOL_SPLIT || '').toLowerCase() === 'true';

function parsePoolMax(envName, fallback) {
  const parsed = parseInt(process.env[envName], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createPool({ applicationNameSuffix, max }) {
  if (!process.env.DATABASE_URL) return null;

  const useSsl = process.env.DATABASE_URL.includes('rds.amazonaws.com')
    || process.env.DATABASE_SSL === 'true';

  if (max > 15) {
    console.warn(
      `[DB] High pool max=${max} (${applicationNameSuffix}). Prefer PgBouncer + lower per-process max.`,
    );
  }

  const created = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSsl
      ? {
        requestCert: true,
        rejectUnauthorized: false,
      }
      : false,
    max,
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT, 10) || 30000,
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT, 10) || 5000,
    allowExitOnIdle: false,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT, 10) || 30000,
    idle_in_transaction_session_timeout: parseInt(process.env.DB_IDLE_IN_TX_TIMEOUT, 10) || 60000,
    application_name: process.env.DB_APPLICATION_NAME
      || `og-rummy-api-${applicationNameSuffix}${process.env.NODE_APP_INSTANCE != null ? `-w${process.env.NODE_APP_INSTANCE}` : ''}`,
  });

  if (String(process.env.DB_LOG_CONNECT || '').toLowerCase() === 'true') {
    created.on('connect', () => {
      console.log(`[DB] New ${applicationNameSuffix} connection established`);
    });
  }

  created.on('error', (err) => {
    console.error(`[DB] Unexpected ${applicationNameSuffix} pool error:`, err.message);
  });

  created.query('SELECT 1').then(() => {
    console.log(`[DB] ${applicationNameSuffix} pool initialized (max=${max})`);
  }).catch((err) => {
    console.error(`[DB] Failed to connect ${applicationNameSuffix} pool:`, err.message);
  });

  return created;
}

if (process.env.DATABASE_URL) {
  const gameplayMax = parsePoolMax(
    'DB_POOL_MAX_GAMEPLAY',
    parsePoolMax('DB_POOL_MAX', 8),
  );
  gameplayPool = createPool({
    applicationNameSuffix: 'gameplay',
    max: gameplayMax,
  });

  if (POOL_SPLIT_ENABLED) {
    const authMax = parsePoolMax('DB_POOL_MAX_AUTH', 4);
    authPool = createPool({
      applicationNameSuffix: 'auth',
      max: authMax,
    });
    console.log('[DB] Pool split enabled (gameplay vs auth/http)');
  }
}

/** Active pool from ALS (`auth`) or gameplay default. */
function getActivePool() {
  const store = requestContext.getStore();
  if (authPool && store?.db_pool === 'auth') return authPool;
  return gameplayPool;
}

function snapshotOne(target) {
  if (!target) return null;
  return {
    totalCount: target.totalCount,
    idleCount: target.idleCount,
    waitingCount: target.waitingCount,
    max: target.options.max,
  };
}

function snapshotPoolMetrics() {
  if (!POOL_SPLIT_ENABLED || !authPool) {
    return snapshotOne(gameplayPool);
  }
  return {
    split: true,
    gameplay: snapshotOne(gameplayPool),
    auth: snapshotOne(authPool),
    active: requestContext.getStore()?.db_pool || 'gameplay',
  };
}

function compactSqlForLog(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 240);
}

const TXN_CONTROL_RE = /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|END)\b/i;

async function rollbackQuiet(client) {
  if (!client) return;
  try {
    await client.query('ROLLBACK');
  } catch (_) {
    // ignore
  }
}

function traceSuffixFromContext() {
  const store = requestContext.getStore();
  if (!store) return '';
  const parts = [];
  if (store.trace_id) parts.push(`trace=${store.trace_id}`);
  if (store.event_name) parts.push(`event=${store.event_name}`);
  if (store.session_id != null) parts.push(`session=${store.session_id}`);
  if (store.db_pool) parts.push(`db_pool=${store.db_pool}`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

function wrapClientForTracing(client) {
  const nativeQuery = client.query.bind(client);
  return {
    ...client,
    query: (text, params) => runTimedQuery(
      () => nativeQuery(text, params),
      text,
      { logOnError: false },
    ),
    release: (...args) => client.release(...args),
  };
}

async function runTimedQuery(executeQuery, text, { logOnError = true } = {}) {
  const slowQueryMs = parseInt(process.env.DB_SLOW_QUERY_MS, 10) || 100;
  const slowAcquireMs = parseInt(process.env.DB_SLOW_ACQUIRE_MS, 10) || 50;
  const queuedAt = Date.now();
  let acquireMs = 0;

  try {
    const acquiredAt = Date.now();
    acquireMs = acquiredAt - queuedAt;
    const result = await executeQuery();
    const execMs = Date.now() - acquiredAt;
    const totalMs = Date.now() - queuedAt;

    requestContext.recordQuerySpan({
      sql: text,
      acquireMs,
      execMs,
      totalMs,
      ok: true,
    });

    if (totalMs > slowQueryMs || acquireMs > slowAcquireMs) {
      const metrics = snapshotPoolMetrics();
      console.warn(
        `Slow query total=${totalMs}ms acquire=${acquireMs}ms exec=${execMs}ms ` +
          `pool=${JSON.stringify(metrics)}${traceSuffixFromContext()} ` +
          `sql=${compactSqlForLog(text)}`,
      );
      requestContext.logSpanDump('slow_query', { sql: compactSqlForLog(text) });
    }

    return result;
  } catch (err) {
    const totalMs = Date.now() - queuedAt;
    requestContext.recordQuerySpan({
      sql: text,
      acquireMs,
      execMs: Math.max(0, totalMs - acquireMs),
      totalMs,
      ok: false,
      error: err.message,
    });
    if (logOnError) {
      console.error(
        `Query failed total=${totalMs}ms pool=${JSON.stringify(snapshotPoolMetrics())}` +
          `${traceSuffixFromContext()} sql=${compactSqlForLog(text)} error=${err.message}`,
      );
      requestContext.logSpanDump('query_error', {
        sql: compactSqlForLog(text),
        error: err.message,
      });
    }
    throw err;
  }
}

async function query(text, params) {
  const active = getActivePool();
  if (!active) throw new Error('DATABASE_URL not configured');

  if (TXN_CONTROL_RE.test(String(text || ''))) {
    console.error(
      '[DB] query() cannot run transaction control SQL (would use a random pool client). Use withTransaction().',
    );
    const err = new Error('query() cannot run BEGIN/COMMIT/ROLLBACK; use withTransaction()');
    err.code = 'DB_TXN_VIA_QUERY';
    throw err;
  }

  const slowQueryMs = parseInt(process.env.DB_SLOW_QUERY_MS, 10) || 100;
  const slowAcquireMs = parseInt(process.env.DB_SLOW_ACQUIRE_MS, 10) || 50;

  const queuedAt = Date.now();
  let client;
  try {
    client = await active.connect();
    const acquiredAt = Date.now();
    const acquireMs = acquiredAt - queuedAt;

    const result = await client.query(text, params);
    const execMs = Date.now() - acquiredAt;
    const totalMs = Date.now() - queuedAt;

    requestContext.recordQuerySpan({
      sql: text,
      acquireMs,
      execMs,
      totalMs,
      ok: true,
    });

    if (totalMs > slowQueryMs || acquireMs > slowAcquireMs) {
      const metrics = snapshotPoolMetrics();
      console.warn(
        `Slow query total=${totalMs}ms acquire=${acquireMs}ms exec=${execMs}ms ` +
          `pool=${JSON.stringify(metrics)}${traceSuffixFromContext()} ` +
          `sql=${compactSqlForLog(text)}`,
      );
      requestContext.logSpanDump('slow_query', { sql: compactSqlForLog(text) });
    }

    return result;
  } catch (err) {
    const totalMs = Date.now() - queuedAt;
    const acquireMs = client ? Math.min(totalMs, Date.now() - queuedAt) : totalMs;
    requestContext.recordQuerySpan({
      sql: text,
      acquireMs,
      execMs: Math.max(0, totalMs - acquireMs),
      totalMs,
      ok: false,
      error: err.message,
    });
    console.error(
      `Query failed total=${totalMs}ms pool=${JSON.stringify(snapshotPoolMetrics())}` +
        `${traceSuffixFromContext()} sql=${compactSqlForLog(text)} error=${err.message}`,
    );
    requestContext.logSpanDump('query_error', {
      sql: compactSqlForLog(text),
      error: err.message,
    });
    await rollbackQuiet(client);
    throw err;
  } finally {
    if (client) client.release();
  }
}

async function withTransaction(fn) {
  const active = getActivePool();
  if (!active) throw new Error('DATABASE_URL not configured');
  const client = wrapClientForTracing(await active.connect());
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await rollbackQuiet(client);
    requestContext.logSpanDump('transaction_error', { error: err.message });
    throw err;
  } finally {
    client.release();
  }
}

async function getPreparedStatement(name, text) {
  const active = getActivePool();
  try {
    await active.query(`PREPARE ${name} AS ${text}`);
    return async (params) => active.query(
      `EXECUTE ${name}(${params.map((_, i) => `$${i + 1}`).join(',')})`,
      params,
    );
  } catch (err) {
    console.error(`Error preparing statement ${name}:`, err);
    return null;
  }
}

async function getPoolMetrics() {
  return snapshotPoolMetrics();
}

async function testConnection() {
  const active = getActivePool() || gameplayPool;
  if (!active) return { ok: null };
  try {
    const start = Date.now();
    const result = await active.query('SELECT NOW()');
    const latency = Date.now() - start;
    const metrics = await getPoolMetrics();
    return {
      ok: true,
      timestamp: result.rows[0].now,
      latency: `${latency}ms`,
      poolMetrics: metrics,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Express middleware: pin HTTP auth/wallet/admin bursts to the auth PG pool. */
function dbPoolMiddleware(poolName) {
  return (req, res, next) => {
    requestContext.run(
      {
        db_pool: poolName,
        event_name: `http:${req.method}:${req.path}`,
        trace_id: req.headers['x-request-id'] || null,
      },
      () => next(),
    );
  };
}

/** Proxy so `const { pool } = require('../db')` still routes via ALS. */
const pool = new Proxy({}, {
  get(_target, prop) {
    const active = getActivePool();
    if (!active) return undefined;
    const value = active[prop];
    return typeof value === 'function' ? value.bind(active) : value;
  },
});

module.exports = {
  pool,
  query,
  withTransaction,
  testConnection,
  getPoolMetrics,
  getPreparedStatement,
  getActivePool,
  dbPoolMiddleware,
  gameplayPool,
  authPool,
};
