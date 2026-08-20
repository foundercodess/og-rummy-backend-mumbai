'use strict';

/**
 * Offloads buildBestGrouping / evaluateSubmittedGrouping to worker threads
 * so the Socket.IO event loop stays under ~10–20ms lag at high CCU.
 *
 * Disable with GROUPING_WORKER_ENABLED=false (falls back to sync on main thread).
 */
const { Worker } = require('worker_threads');
const path = require('path');
const groupingService = require('./grouping.service');

const WORKER_ENABLED = String(process.env.GROUPING_WORKER_ENABLED || 'true').toLowerCase() !== 'false';
const WORKER_COUNT = Math.max(
  1,
  Math.min(8, Number(process.env.GROUPING_WORKER_COUNT) || 2),
);
const JOB_TIMEOUT_MS = Math.max(
  50,
  Number(process.env.GROUPING_WORKER_TIMEOUT_MS) || 2500,
);

let nextJobId = 1;
const workers = [];
const idle = [];
const waitQueue = [];
const pending = new Map();
let started = false;

function workerScriptPath() {
  return path.join(__dirname, 'grouping.worker.js');
}

function rejectJob(jobId, err) {
  const entry = pending.get(jobId);
  if (!entry) return;
  pending.delete(jobId);
  clearTimeout(entry.timer);
  entry.reject(err instanceof Error ? err : new Error(String(err)));
}

function resolveJob(jobId, result) {
  const entry = pending.get(jobId);
  if (!entry) return;
  pending.delete(jobId);
  clearTimeout(entry.timer);
  entry.resolve(result);
}

function onWorkerMessage(worker, msg) {
  const jobId = msg?.id;
  if (jobId == null) return;
  if (msg.ok === false) {
    rejectJob(jobId, new Error(msg.error || 'grouping worker failed'));
  } else {
    resolveJob(jobId, msg.result);
  }
  idle.push(worker);
  pumpQueue();
}

function onWorkerError(worker, err) {
  console.error('[groupingAsync] worker error:', err?.message || err);
  // Fail in-flight jobs assigned to this worker are hard to track; recreate worker.
  replaceWorker(worker);
}

function replaceWorker(dead) {
  const idx = workers.indexOf(dead);
  if (idx >= 0) workers.splice(idx, 1);
  const idleIdx = idle.indexOf(dead);
  if (idleIdx >= 0) idle.splice(idleIdx, 1);
  try {
    dead.terminate();
  } catch (_) {
    // ignore
  }
  if (!WORKER_ENABLED) return;
  spawnWorker();
}

function spawnWorker() {
  const worker = new Worker(workerScriptPath());
  worker.on('message', (msg) => onWorkerMessage(worker, msg));
  worker.on('error', (err) => onWorkerError(worker, err));
  worker.on('exit', (code) => {
    if (code !== 0) {
      console.warn(`[groupingAsync] worker exited code=${code}`);
    }
    const idx = workers.indexOf(worker);
    if (idx >= 0) workers.splice(idx, 1);
    const idleIdx = idle.indexOf(worker);
    if (idleIdx >= 0) idle.splice(idleIdx, 1);
    if (WORKER_ENABLED && started) spawnWorker();
  });
  workers.push(worker);
  idle.push(worker);
}

function ensureStarted() {
  if (started || !WORKER_ENABLED) return;
  started = true;
  for (let i = 0; i < WORKER_COUNT; i += 1) spawnWorker();
  console.log(`[groupingAsync] worker pool started count=${WORKER_COUNT}`);
}

function pumpQueue() {
  while (waitQueue.length && idle.length) {
    const job = waitQueue.shift();
    const worker = idle.shift();
    worker.postMessage(job.message);
  }
}

function runOnWorker(method, payload) {
  ensureStarted();
  if (!WORKER_ENABLED || workers.length === 0) {
    return Promise.resolve(runSync(method, payload));
  }

  const id = nextJobId;
  nextJobId += 1;
  const message = { id, method, ...payload };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rejectJob(id, new Error(`grouping worker timeout after ${JOB_TIMEOUT_MS}ms`));
    }, JOB_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });
    waitQueue.push({ message });
    pumpQueue();
  });
}

function runSync(method, payload) {
  if (method === 'buildBestGrouping') {
    return groupingService.buildBestGrouping(
      payload.cards || [],
      payload.wildJoker || null,
      payload.options || {},
    );
  }
  if (method === 'evaluateSubmittedGrouping') {
    return groupingService.evaluateSubmittedGrouping(
      payload.cards || [],
      payload.wildJoker || null,
      payload.submittedGroups || [],
    );
  }
  throw new Error(`Unknown grouping method: ${method}`);
}

async function buildBestGrouping(cards, wildJoker, options = {}) {
  try {
    return await runOnWorker('buildBestGrouping', { cards, wildJoker, options });
  } catch (err) {
    console.warn(`[groupingAsync] fallback sync buildBestGrouping: ${err.message}`);
    return groupingService.buildBestGrouping(cards, wildJoker, options);
  }
}

async function evaluateSubmittedGrouping(cards, wildJoker, submittedGroups = []) {
  try {
    return await runOnWorker('evaluateSubmittedGrouping', {
      cards,
      wildJoker,
      submittedGroups,
    });
  } catch (err) {
    console.warn(`[groupingAsync] fallback sync evaluateSubmittedGrouping: ${err.message}`);
    return groupingService.evaluateSubmittedGrouping(cards, wildJoker, submittedGroups);
  }
}

function getStats() {
  return {
    enabled: WORKER_ENABLED,
    workers: workers.length,
    idle: idle.length,
    queued: waitQueue.length,
    pending: pending.size,
  };
}

module.exports = {
  buildBestGrouping,
  evaluateSubmittedGrouping,
  getStats,
  ensureStarted,
};
