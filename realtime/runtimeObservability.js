'use strict';

const { getPoolMetrics } = require('../db');
const liveSessionState = require('../services/liveSessionState.service');

const EVENT_LOOP_WARN_MS = Math.max(
  10,
  Number(process.env.EVENT_LOOP_WARN_MS) || 50,
);
const METRICS_LOG_INTERVAL_MS = Math.max(
  15_000,
  Number(process.env.RUNTIME_METRICS_LOG_INTERVAL_MS) || 60_000,
);
const LIVE_SNAPSHOT_WARN_BYTES = Math.max(
  50_000,
  Number(process.env.LIVE_SNAPSHOT_WARN_BYTES) || 200_000,
);

let started = false;

function startRuntimeObservability() {
  if (started) return;
  started = true;

  let lastCheck = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lag = now - lastCheck - 1000;
    lastCheck = now;
    if (lag > EVENT_LOOP_WARN_MS) {
      console.warn(`[EVENT_LOOP] lag=${lag}ms`);
    }
  }, 1000).unref();

  setInterval(() => {
    const pool = getPoolMetrics();
    const live = typeof liveSessionState.getStats === 'function'
      ? liveSessionState.getStats()
      : null;
    if (pool || live) {
      console.log(
        `[RUNTIME_METRICS] pool=${JSON.stringify(pool)} live=${JSON.stringify(live)}`,
      );
    }
  }, METRICS_LOG_INTERVAL_MS).unref();
}

function warnLargeLiveSnapshot(sessionId, snapshot) {
  if (!snapshot) return;
  try {
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    if (bytes > LIVE_SNAPSHOT_WARN_BYTES) {
      console.warn(
        `[LIVE_STATE] large snapshot session=${sessionId} bytes=${bytes}`,
      );
    }
  } catch (_) {
    // ignore serialization errors
  }
}

module.exports = {
  startRuntimeObservability,
  warnLargeLiveSnapshot,
};
