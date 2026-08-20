require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { testConnection, getPoolMetrics, dbPoolMiddleware } = require('./db');
const {
  registerSocketServer,
  getSocketRuntimeStats,
  getClusterSocketRuntimeStats,
} = require('./realtime/socketServer');
const { pingRedis } = require('./services/redis.service');
const { pingKafka } = require('./services/kafka.service');
const { startBotEngine } = require('./services/botEngine');
const { startStaleSessionCleanupCron } = require('./services/staleSessionCleanup.scheduler');
const { startWithdrawalPayoutSyncCron } = require('./services/withdrawalPayoutSync.scheduler');
const { startRechargePayinSyncCron } = require('./services/rechargePayinSync.scheduler');
const {
  startRuntimeObservability,
  setSocketStatsProvider,
  getLastEventLoopLagMs,
  getHotpathSnapshot,
} = require('./realtime/runtimeObservability');
const { startBotInjectionSettingsPoller } = require('./services/botInjectionSettings.service');
const durableTimer = require('./services/durableTimer.service');
const groupingAsync = require('./services/groupingAsync.service');

const app = express();
const server = http.createServer(app);
// Node 18+ defaults requestTimeout to 5m, which aborts large APK uploads with 408.
const APK_UPLOAD_REQUEST_TIMEOUT_MS = parseInt(process.env.APK_UPLOAD_REQUEST_TIMEOUT_MS, 10) || 3600000;
server.requestTimeout = APK_UPLOAD_REQUEST_TIMEOUT_MS;
server.headersTimeout = APK_UPLOAD_REQUEST_TIMEOUT_MS + 1000;
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const configRoutes = require('./routes/config.routes');
const gameRoutes = require('./routes/game.routes');
const uploadRoutes = require('./routes/upload.routes');
const walletRoutes = require('./routes/wallet.routes');
const notificationRoutes = require('./routes/notification.routes');
const rewardsRoutes = require('./routes/rewards.routes');
const couponRoutes = require('./routes/coupon.routes');
const supportRoutes = require('./routes/support.routes');
const adminRoutes = require('./routes/admin.routes');
const gameplayRoutes = require('./routes/gameplay.routes');
// Auth/wallet/admin share a dedicated PG pool when DB_POOL_SPLIT=true so login
// bursts do not starve gameplay socket hot-paths.
app.use('/api/auth', dbPoolMiddleware('auth'), authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/config', configRoutes);
app.use('/api/games', gameRoutes);
app.use('/api/gameplay', gameplayRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/wallet', dbPoolMiddleware('auth'), walletRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/rewards', rewardsRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/admin', dbPoolMiddleware('auth'), adminRoutes);


app.get('/health', (req, res) => {
  const socketsLocal = io ? getSocketRuntimeStats(io) : null;
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    event_loop_lag_ms: getLastEventLoopLagMs(),
    sockets_connected: socketsLocal?.connected ?? null,
    max_sockets_per_worker: Math.max(0, Number(process.env.MAX_SOCKETS_PER_WORKER) || 0) || null,
    admit_max_event_loop_lag_ms: Math.max(0, Number(process.env.ADMIT_MAX_EVENT_LOOP_LAG_MS) || 0) || null,
    grouping_workers: groupingAsync.getStats(),
  });
});

/**
 * Readiness for ALB target-group drain / ASG protection.
 * Keep TG health check on /health (always 200 while process is up).
 * Optionally point a second check or custom action at /ready — returns 503 when
 * this worker is at socket cap or event-loop lag exceeds ADMIT_MAX_EVENT_LOOP_LAG_MS.
 */
app.get('/ready', (req, res) => {
  const lag = getLastEventLoopLagMs();
  const connected = io ? (getSocketRuntimeStats(io).connected || 0) : 0;
  const maxSockets = Math.max(0, Number(process.env.MAX_SOCKETS_PER_WORKER) || 0);
  const maxLag = Math.max(0, Number(process.env.ADMIT_MAX_EVENT_LOOP_LAG_MS) || 0);
  const atSocketCap = maxSockets > 0 && connected >= maxSockets;
  const lagHigh = maxLag > 0 && lag > maxLag;
  const ready = !atSocketCap && !lagHigh;
  const body = {
    status: ready ? 'ready' : 'not_ready',
    event_loop_lag_ms: lag,
    sockets_connected: connected,
    max_sockets_per_worker: maxSockets || null,
    admit_max_event_loop_lag_ms: maxLag || null,
    reasons: [
      ...(atSocketCap ? ['server_at_capacity'] : []),
      ...(lagHigh ? ['server_backpressure'] : []),
    ],
  };
  if (!ready) return res.status(503).json(body);
  return res.json(body);
});

// Health check - useful for Docker and load balancers
app.get('/health/details', async (req, res) => {
  // const dbStatus = process.env.DATABASE_URL ? await testConnection() : { ok: null, message: 'not configured' };
  // const redisStatus = await pingRedis();
  // const kafkaStatus = await pingKafka();
  // // let durable = null;
  // // try {
  // //   durable = await durableTimer.getStats();
  // // } catch (_) {
  // //   durable = null;
  // // }

  // const [
  //   dbStatus,
  //   redisStatus,
  //   kafkaStatus,
  //   durable,
  // ] = await Promise.all([
  //   process.env.DATABASE_URL
  //     ? testConnection().catch(err => ({
  //         ok: false,
  //         error: err.message,
  //       }))
  //     : Promise.resolve({
  //         ok: null,
  //         message: 'not configured',
  //       }),

  //   pingRedis().catch(err => ({
  //     ok: false,
  //     error: err.message,
  //   })),

  //   // process.env.KAFKA_ENABLED === 'true'
  //   //   ? pingKafka().catch(err => ({
  //   //       ok: false,
  //   //       error: err.message,
  //   //     }))
  //   //   : 
  //     Promise.resolve({
  //         ok: null,
  //         message: 'disabled',
  //       }),

  //   durableTimer.getStats().catch(() => null),
  // ]);


  const results = await Promise.allSettled([
    process.env.DATABASE_URL
      ? testConnection()
      : Promise.resolve({ ok: null }),
  
    pingRedis(),
  
    process.env.KAFKA_ENABLED === 'true'
      ? pingKafka()
      : Promise.resolve({ ok: null, message: 'disabled' }),
  
    durableTimer.getStats(),
  ]);
  
  const [dbStatus, redisStatus, kafkaStatus, durable] = results.map(r =>
    r.status === 'fulfilled'
      ? r.value
      : { ok: false, error: r.reason?.message }
  );

  const sockets = io ? await getClusterSocketRuntimeStats(io) : null;
  res.json({
    status: 'ok',
    message: 'OG Rummy API is running on EC2, 20 aug 2026',
    database: dbStatus.ok === true ? 'connected' : dbStatus.ok === false ? 'error' : 'not configured',
    redis: redisStatus.ok === true ? 'connected' : redisStatus.ok === false ? 'error' : 'not configured',
    kafka: kafkaStatus.ok === true ? 'connected' : kafkaStatus.ok === false ? 'error' : 'not configured',
    event_loop_lag_ms: getLastEventLoopLagMs(),
    db_pool: getPoolMetrics(),
    hotpath: getHotpathSnapshot(),
    sockets,
    grouping_workers: groupingAsync.getStats(),
    admission: {
      max_sockets_per_worker: Math.max(0, Number(process.env.MAX_SOCKETS_PER_WORKER) || 0) || null,
      admit_max_event_loop_lag_ms: Math.max(0, Number(process.env.ADMIT_MAX_EVENT_LOOP_LAG_MS) || 0) || null,
    },
    durable_timers: durable,
    ...(dbStatus.timestamp && { dbTimestamp: dbStatus.timestamp }),
    ...(dbStatus.error && { dbError: dbStatus.error }),
    ...(redisStatus.error && { redisError: redisStatus.error }),
    ...(kafkaStatus.error && { kafkaError: kafkaStatus.error }),
  });
});



// Root route
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to OG Rummy API', version: '7 july 2026' });
});

const io = registerSocketServer(server);
setSocketStatsProvider(() => getSocketRuntimeStats(io));
startRuntimeObservability();
groupingAsync.ensureStarted();
startBotInjectionSettingsPoller();
startBotEngine(io);
startStaleSessionCleanupCron();
startWithdrawalPayoutSyncCron();
startRechargePayinSyncCron();

// BullMQ worker: admin FCM multicast campaigns (inactive reminders, etc.)
try {
  const { startPushCampaignWorker } = require('./queues/pushCampaign.queue');
  const pushCampaignService = require('./services/pushCampaign.service');
  startPushCampaignWorker(async (data) =>
    pushCampaignService.processInactiveReminderCampaign(data)
  );
} catch (err) {
  console.error('[push-queue] failed to start worker:', err.message);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
