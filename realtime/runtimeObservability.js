'use strict';

const { getPoolMetrics } = require('../db');
const liveSessionState = require('../services/liveSessionState.service');
const durableTimer = require('../services/durableTimer.service');

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
let socketStatsProvider = null;
let lastEventLoopLagMs = 0;

function setSocketStatsProvider(fn) {
  socketStatsProvider = typeof fn === 'function' ? fn : null;
}

function getLastEventLoopLagMs() {
  return lastEventLoopLagMs;
}

function startRuntimeObservability() {
  if (started) return;
  started = true;

  let lastCheck = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lag = now - lastCheck - 1000;
    lastCheck = now;
    lastEventLoopLagMs = Math.max(0, lag);
    if (lag > EVENT_LOOP_WARN_MS) {
      console.warn(`[EVENT_LOOP] lag=${lag}ms`);
    }
  }, 1000).unref();

  setInterval(async () => {
    const pool = getPoolMetrics();
    const live = typeof liveSessionState.getStats === 'function'
      ? liveSessionState.getStats()
      : null;
    const sockets = socketStatsProvider ? socketStatsProvider() : null;
    let durable = null;
    try {
      durable = await durableTimer.getStats();
    } catch (_) {
      durable = null;
    }
    if (pool || live || sockets || durable) {
      console.log(
        `[RUNTIME_METRICS] lag_ms=${lastEventLoopLagMs} ` +
          `pool=${JSON.stringify(pool)} live=${JSON.stringify(live)} ` +
          `sockets=${JSON.stringify(sockets)} durable=${JSON.stringify(durable)}`,
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
  setSocketStatsProvider,
  getLastEventLoopLagMs,
  warnLargeLiveSnapshot,
};
