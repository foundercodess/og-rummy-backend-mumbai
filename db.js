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
      rejectUnauthorized: false,
      // Add these SSL options for better performance
      requestCert: true,
      rejectUnauthorized: false
    } : false,
    
    // CRITICAL: Increase connection pool for better throughput
    max: parseInt(process.env.DB_POOL_MAX) || 20,  // Increased from 10 to 20
    
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
    
    // Application name for easier debugging in RDS logs
    application_name: 'app-runner-service',
  });
  
  // Fires once per new physical TCP connection to Postgres.
  // Set session defaults in a SINGLE query to avoid the pg@9 deprecation warning
  // ("Calling client.query() when already executing a query").
  pool.on('connect', (client) => {
    console.log('[DB] New connection established to Postgres');
    client.query(
      'SET statement_timeout = 30000; SET idle_in_transaction_session_timeout = 60000;',
    );
  });

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

// Optimized query function with performance monitoring
async function query(text, params) {
  if (!pool) throw new Error('DATABASE_URL not configured');
  
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    
    // Log slow queries (>100ms)
    if (duration > 100) {
      console.warn(`Slow query (${duration}ms):`, text.substring(0, 200));
    }
    
    return result;
  } catch (err) {
    const duration = Date.now() - start;
    console.error(`Query failed after ${duration}ms:`, err.message);
    throw err;
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
  if (!pool) return null;
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    max: pool.options.max
  };
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
  testConnection,
  getPoolMetrics,
  getPreparedStatement 
};