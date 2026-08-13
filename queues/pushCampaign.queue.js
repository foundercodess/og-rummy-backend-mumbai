'use strict';

const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');

const QUEUE_NAME = 'push-campaigns';

let connection = null;
let queue = null;
let worker = null;

function isTlsRedisUrl(url) {
  return typeof url === 'string' && url.startsWith('rediss://');
}

function getBullConnection() {
  if (connection) return connection;
  if (!process.env.REDIS_URL) return null;

  const options = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
  if (isTlsRedisUrl(process.env.REDIS_URL)) {
    options.tls = {};
  }

  connection = new IORedis(process.env.REDIS_URL, options);
  connection.on('error', (err) => {
    console.error('[push-queue] Redis error:', err.message);
  });
  return connection;
}

function getQueue() {
  if (queue) return queue;
  const conn = getBullConnection();
  if (!conn) return null;
  queue = new Queue(QUEUE_NAME, { connection: conn });
  return queue;
}

async function enqueuePushCampaign(campaignId) {
  const q = getQueue();
  if (!q) {
    const err = new Error('PUSH_QUEUE_UNAVAILABLE');
    err.code = 'PUSH_QUEUE_UNAVAILABLE';
    throw err;
  }
  const job = await q.add(
    'run-campaign',
    { campaignId: Number(campaignId) },
    {
      jobId: `push-campaign-${campaignId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    }
  );
  return job;
}

function startPushCampaignWorker(processor) {
  if (worker) return worker;
  const conn = getBullConnection();
  if (!conn) {
    console.warn('[push-queue] REDIS_URL missing — push campaign worker not started');
    return null;
  }

  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name !== 'run-campaign') return null;
      return processor(job.data);
    },
    {
      connection: conn,
      concurrency: Number(process.env.PUSH_CAMPAIGN_CONCURRENCY || 1),
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`[push-queue] job ${job?.id} failed:`, err?.message || err);
  });
  worker.on('completed', (job) => {
    console.log(`[push-queue] job ${job?.id} completed`);
  });

  console.log('[push-queue] BullMQ worker started');
  return worker;
}

module.exports = {
  QUEUE_NAME,
  getQueue,
  enqueuePushCampaign,
  startPushCampaignWorker,
};
