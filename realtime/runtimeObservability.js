'use strict';

const { getPoolMetrics } = require('../db');
const requestContext = require('../services/requestContext.service');
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

const HOTPATH_SLOW_MS = Math.max(20, Number(process.env.HOTPATH_SLOW_MS) || 80);
const HOTPATH_SAMPLE_CAP = 2000;
const hotpathStats = new Map();

function getHotpathBucket(eventName) {
  const key = String(eventName || 'unknown');
  let bucket = hotpathStats.get(key);
  if (!bucket) {
    bucket = {
      n: 0,
      ok: 0,
      fail: 0,
      inFlight: 0,
      sum: 0,
      max: 0,
      samples: [],
    };
    hotpathStats.set(key, bucket);
  }
  return bucket;
}

function percentileFromSamples(samples, p) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
}

function beginHotpath(eventName) {
  const bucket = getHotpathBucket(eventName);
  bucket.inFlight += 1;
  return Date.now();
}

function recordHotpath(eventName, startedAtMs, extra = {}) {
  const bucket = getHotpathBucket(eventName);
  bucket.inFlight = Math.max(0, bucket.inFlight - 1);
  const ms = Math.max(0, Date.now() - Number(startedAtMs || 0));
  const ok = extra.ok !== false;
  bucket.n += 1;
  bucket.sum += ms;
  bucket.max = Math.max(bucket.max, ms);
  if (ok) bucket.ok += 1;
  else bucket.fail += 1;
  bucket.samples.push(ms);
  if (bucket.samples.length > HOTPATH_SAMPLE_CAP) bucket.samples.shift();

  if (ms >= HOTPATH_SLOW_MS) {
    const sessionId = extra.session_id != null ? extra.session_id : '';
    const traceId = extra.trace_id || requestContext.getStore()?.trace_id || '';
    console.warn(
      `[HOTPATH_SLOW] event=${eventName} ms=${ms} ok=${ok} session=${sessionId} ` +
        `trace=${traceId} lag_ms=${lastEventLoopLagMs}`,
    );
    requestContext.logSpanDump('hotpath_slow', {
      event: eventName,
      handler_ms: ms,
      ok,
    });
  }
  return ms;
}

function getHotpathSnapshot() {
  const out = {};
  for (const [eventName, bucket] of hotpathStats.entries()) {
    out[eventName] = {
      n: bucket.n,
      ok: bucket.ok,
      fail: bucket.fail,
      in_flight: bucket.inFlight,
      avg_ms: bucket.n ? Math.round(bucket.sum / bucket.n) : 0,
      p50_ms: percentileFromSamples(bucket.samples, 0.5),
      p95_ms: percentileFromSamples(bucket.samples, 0.95),
      p99_ms: percentileFromSamples(bucket.samples, 0.99),
      max_ms: bucket.max,
    };
  }
  return out;
}

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
    const hotpath = getHotpathSnapshot();
    if (pool || live || sockets || durable || Object.keys(hotpath).length) {
      console.log(
        `[RUNTIME_METRICS] lag_ms=${lastEventLoopLagMs} ` +
          `pool=${JSON.stringify(pool)} live=${JSON.stringify(live)} ` +
          `sockets=${JSON.stringify(sockets)} durable=${JSON.stringify(durable)} ` +
          `hotpath=${JSON.stringify(hotpath)}`,
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
  beginHotpath,
  recordHotpath,
  getHotpathSnapshot,
};
