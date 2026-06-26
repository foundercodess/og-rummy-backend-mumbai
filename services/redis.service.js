const Redis = require('ioredis');
const { createClient } = require('redis');

let redis = null;
let adapterPubClient = null;
let adapterSubClient = null;
let adapterConnectPromise = null;

function isTlsRedisUrl(url) {
  return typeof url === 'string' && url.startsWith('rediss://');
}

function getRedisClient() {
  if (redis) return redis;
  if (!process.env.REDIS_URL) return null;

  const options = {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  };
  if (isTlsRedisUrl(process.env.REDIS_URL)) {
    options.tls = {};
  }

  redis = new Redis(process.env.REDIS_URL, options);

  redis.on('error', (err) => {
    console.error('Redis error:', err.message);
  });

  return redis;
}

async function ensureRedisConnection() {
  const client = getRedisClient();
  if (!client) return null;
  if (client.status === 'ready' || client.status === 'connect') return client;
  await client.connect();
  return client;
}

async function pingRedis() {
  const client = await ensureRedisConnection();
  if (!client) return { ok: null, message: 'not configured' };

  try {
    const response = await client.ping();
    return { ok: response === 'PONG' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getSocketAdapterRedisClients() {
  if (!process.env.REDIS_URL) return null;

  if (adapterPubClient && adapterSubClient && adapterPubClient.isOpen && adapterSubClient.isOpen) {
    return { pubClient: adapterPubClient, subClient: adapterSubClient };
  }

  if (adapterConnectPromise) {
    return adapterConnectPromise;
  }

  adapterPubClient = createClient({
    url: process.env.REDIS_URL,
    ...(isTlsRedisUrl(process.env.REDIS_URL)
      ? { socket: { tls: true, rejectUnauthorized: false } }
      : {}),
  });
  adapterSubClient = adapterPubClient.duplicate();

  adapterPubClient.on('error', (err) => {
    console.error('Redis adapter pub client error:', err.message);
  });

  adapterSubClient.on('error', (err) => {
    console.error('Redis adapter sub client error:', err.message);
  });


  

  adapterConnectPromise = (async () => {
    try {
      await Promise.all([adapterPubClient.connect(), adapterSubClient.connect()]);
      return { pubClient: adapterPubClient, subClient: adapterSubClient };
    } catch (err) {
      adapterPubClient = null;
      adapterSubClient = null;
      throw err;
    } finally {
      adapterConnectPromise = null;
    }
  })();

  return adapterConnectPromise;
}



module.exports = {
  getRedisClient,
  ensureRedisConnection,
  pingRedis,
  getSocketAdapterRedisClients,
};
