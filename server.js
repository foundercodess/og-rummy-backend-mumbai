require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { testConnection } = require('./db');
const { registerSocketServer } = require('./realtime/socketServer');
const { pingRedis } = require('./services/redis.service');
const { pingKafka } = require('./services/kafka.service');
const { startBotEngine } = require('./services/botEngine');
const { startStaleSessionCleanupCron } = require('./services/staleSessionCleanup.scheduler');
const { startWithdrawalPayoutSyncCron } = require('./services/withdrawalPayoutSync.scheduler');
const { startRechargePayinSyncCron } = require('./services/rechargePayinSync.scheduler');
const { startRuntimeObservability } = require('./realtime/runtimeObservability');

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
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/config', configRoutes);
app.use('/api/games', gameRoutes);
app.use('/api/gameplay', gameplayRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/rewards', rewardsRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/admin', adminRoutes);

// Health check - useful for Docker and load balancers
app.get('/health', async (req, res) => {
  const dbStatus = process.env.DATABASE_URL ? await testConnection() : { ok: null, message: 'not configured' };
  const redisStatus = await pingRedis();
  const kafkaStatus = await pingKafka();
  res.json({
    status: 'ok',
    message: 'OG Rummy API is running on EC2, version 5',
    database: dbStatus.ok === true ? 'connected' : dbStatus.ok === false ? 'error' : 'not configured',
    redis: redisStatus.ok === true ? 'connected' : redisStatus.ok === false ? 'error' : 'not configured',
    kafka: kafkaStatus.ok === true ? 'connected' : kafkaStatus.ok === false ? 'error' : 'not configured',
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
startRuntimeObservability();
startBotEngine(io);
startStaleSessionCleanupCron();
startWithdrawalPayoutSyncCron();
startRechargePayinSyncCron();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
