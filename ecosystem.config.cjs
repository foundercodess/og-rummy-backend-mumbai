/**
 * PM2 process manager config for OG Rummy API.
 *
 * Multi-instance is supported when Redis is configured:
 * - Socket.IO Redis adapter (cross-process room emits)
 * - Durable timer sweeper (orphan turn/declare/rematch/bot/pregame clocks)
 * - Leader election (live-count + bot scanner)
 *
 * Prefer websocket-only transports behind a non-sticky LB:
 *   SOCKET_TRANSPORTS=websocket
 *
 * Usage:
 *   CLUSTER_INSTANCES=2 pm2 start ecosystem.config.cjs
 *   pm2 reload ecosystem.config.cjs
 */
const instances = Math.max(1, Number(process.env.CLUSTER_INSTANCES) || 1);

module.exports = {
  apps: [
    {
      name: 'og-rummy-api',
      script: 'server.js',
      instances,
      exec_mode: instances > 1 ? 'cluster' : 'fork',
      watch: false,
      max_memory_restart: process.env.PM2_MAX_MEMORY || '1500M',
      kill_timeout: 8000,
      listen_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        CLUSTER_INSTANCES: String(instances),
        // Sweeper auto-enables when CLUSTER_INSTANCES>1; force on for safety.
        DURABLE_TIMER_SWEEPER_ENABLED:
          process.env.DURABLE_TIMER_SWEEPER_ENABLED
          || (instances > 1 ? 'true' : 'false'),
        SOCKET_TRANSPORTS:
          process.env.SOCKET_TRANSPORTS
          || (instances > 1 ? 'websocket' : 'websocket,polling'),
        DB_POOL_MAX:
          process.env.DB_POOL_MAX
          || (instances > 1 ? '10' : '30'),
      },
      node_args: process.env.NODE_OPTIONS || '',
    },
  ],
};
