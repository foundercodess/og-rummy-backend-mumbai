// const { Pool } = require('pg');

// let pool = null;
// if (process.env.DATABASE_URL) {
//   // RDS requires SSL; rejectUnauthorized: false needed for RDS CA in Alpine (traffic still encrypted)
//   const useSsl = process.env.DATABASE_URL.includes('rds.amazonaws.com') || process.env.DATABASE_SSL === 'true';
//   pool = new Pool({
//     connectionString: process.env.DATABASE_URL,
//     ssl: useSsl ? { rejectUnauthorized: false } : false,
//     max: 10,
//     idleTimeoutMillis: 30000,
//     connectionTimeoutMillis: 10000,
//   });
//   pool.on('error', (err) => {
//     console.error('Unexpected DB pool error:', err);
//   });
// }

// async function query(text, params) {
//   if (!pool) throw new Error('DATABASE_URL not configured');
//   return pool.query(text, params);
// }

// async function testConnection() {
//   if (!pool) return { ok: null };
//   try {
//     const result = await pool.query('SELECT NOW()');
//     return { ok: true, timestamp: result.rows[0].now };
//   } catch (err) {
//     return { ok: false, error: err.message };
//   }
// }

// module.exports = { pool, query, testConnection };


const { Pool } = require('pg');

let pool = null;

if (process.env.DATABASE_URL) {
  const useSsl = process.env.DATABASE_URL.includes('rds.amazonaws.com') || process.env.DATABASE_SSL === 'true';
  
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSsl ? { 
      // Add these SSL options for better performance
      requestCert: true,
      rejectUnauthorized: false
    } : false,
    
    // Single-process default 8. With multiple Node workers put PgBouncer in
    // front and lower per-process max (e.g. DB_POOL_MAX=8) so total PG
    // connections stay under RDS max_connections.
    max: (() => {
      const parsed = parseInt(process.env.DB_POOL_MAX, 10);
      const poolMax = Number.isFinite(parsed) && parsed > 0 ? parsed : 8;
      if (poolMax > 15) {
        console.warn(
          `[DB] High DB_POOL_MAX=${poolMax}. With multiple Node workers this can exceed RDS max_connections; prefer PgBouncer + DB_POOL_MAX<=10.`
        );
      }
      return poolMax;
    })(),
    
    // Keep connections alive to avoid reconnection overhead
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000,
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT) || 5000, // Reduced from 10000
    
    // ADD THESE IMPORTANT SETTINGS:
    // Allow idle connections to be used immediately
    allowExitOnIdle: false,
    
    // Keep connections alive with heartbeat
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    
    // Statement timeout to prevent long-running queries
    statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT) || 30000,
    idle_in_transaction_session_timeout: parseInt(process.env.DB_IDLE_IN_TX_TIMEOUT, 10) || 60000,
    
    // Application name for easier debugging in RDS logs
    application_name: process.env.DB_APPLICATION_NAME
      || `og-rummy-api${process.env.NODE_APP_INSTANCE != null ? `-w${process.env.NODE_APP_INSTANCE}` : ''}`,
  });

  // Avoid flooding logs under connection churn (10k-scale). Enable with DB_LOG_CONNECT=true.
  if (String(process.env.DB_LOG_CONNECT || '').toLowerCase() === 'true') {
    pool.on('connect', () => {
      console.log('[DB] New connection established to Postgres');
    });
  }
  // 'acquire' fires on every pool.connect() / pool.query() checkout — far too noisy for logs.
  // Uncomment only when debugging connection-leak issues.
  // pool.on('acquire', () => { console.log('[DB] Client acquired from pool'); });

  pool.on('error', (err) => {
    console.error('[DB] Unexpected pool error:', err.message);
  });
  
  // Verify connectivity at startup
  pool.query('SELECT 1').then(() => {
    console.log('[DB] Pool initialized successfully');
  }).catch((err) => {
    console.error('[DB] Failed to connect to Postgres at startup:', err.message);
  });
}

function snapshotPoolMetrics() {
  if (!pool) return null;
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    max: pool.options.max
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
    // Connection may already be dead; pool will discard on release(err).
  }
}

// Single-statement helper. Never holds a transaction across release — callers
// that need BEGIN/COMMIT must use withTransaction() so the same client is kept.
async function query(text, params) {
  if (!pool) throw new Error('DATABASE_URL not configured');

  const slowQueryMs = parseInt(process.env.DB_SLOW_QUERY_MS, 10) || 100;
  const slowAcquireMs = parseInt(process.env.DB_SLOW_ACQUIRE_MS, 10) || 50;
  const queuedAt = Date.now();
  let client;
  try {
    client = await pool.connect();
    const acquiredAt = Date.now();
    const acquireMs = acquiredAt - queuedAt;

    if (TXN_CONTROL_RE.test(String(text || ''))) {
      console.error(
        '[DB] query() cannot run transaction control SQL (would use a random pool client). Use withTransaction().'
      );
      const err = new Error('query() cannot run BEGIN/COMMIT/ROLLBACK; use withTransaction()');
      err.code = 'DB_TXN_VIA_QUERY';
      throw err;
    }

    const result = await client.query(text, params);
    const execMs = Date.now() - acquiredAt;
    const totalMs = Date.now() - queuedAt;

    if (totalMs > slowQueryMs || acquireMs > slowAcquireMs) {
      const metrics = snapshotPoolMetrics();
      console.warn(
        `Slow query total=${totalMs}ms acquire=${acquireMs}ms exec=${execMs}ms ` +
          `pool=${JSON.stringify(metrics)} sql=${compactSqlForLog(text)}`
      );
    }

    return result;
  } catch (err) {
    const totalMs = Date.now() - queuedAt;
    console.error(
      `Query failed total=${totalMs}ms pool=${JSON.stringify(snapshotPoolMetrics())} ` +
        `sql=${compactSqlForLog(text)} error=${err.message}`
    );
    await rollbackQuiet(client);
    throw err;
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * Run fn(client) inside a single-connection BEGIN/COMMIT.
 * On error the transaction is rolled back before the client is returned to the pool.
 */
async function withTransaction(fn) {
  if (!pool) throw new Error('DATABASE_URL not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await rollbackQuiet(client);
    throw err;
  } finally {
    client.release();
  }
}

// Add a helper for prepared statements (better performance for repeated queries)
async function getPreparedStatement(name, text) {
  try {
    await pool.query(`PREPARE ${name} AS ${text}`);
    return async (params) => {
      return pool.query(`EXECUTE ${name}(${params.map((_, i) => `$${i+1}`).join(',')})`, params);
    };
  } catch (err) {
    console.error(`Error preparing statement ${name}:`, err);
    return null;
  }
}

// Add connection pool metrics endpoint (useful for monitoring)
async function getPoolMetrics() {
  return snapshotPoolMetrics();
}

async function testConnection() {
  if (!pool) return { ok: null };
  try {
    const start = Date.now();
    const result = await pool.query('SELECT NOW()');
    const latency = Date.now() - start;
    const metrics = await getPoolMetrics();
    
    return { 
      ok: true, 
      timestamp: result.rows[0].now,
      latency: `${latency}ms`,
      poolMetrics: metrics
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { 
  pool, 
  query,
  withTransaction,
  testConnection,
  getPoolMetrics,
  getPreparedStatement 
};