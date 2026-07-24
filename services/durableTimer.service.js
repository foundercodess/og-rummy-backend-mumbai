'use strict';

/**
 * Redis-backed durable timer registry.
 *
 * Design (safe for current single-process prod):
 * - Local setTimeout remains the primary game clock (unchanged behavior).
 * - arm()/cancel() dual-write deadlines to Redis when Redis is available.
 * - Optional sweeper (DURABLE_TIMER_SWEEPER_ENABLED=true) recovers orphaned
 *   timers if a process dies. Handlers MUST be idempotent (turn timeout already is).
 *
 * Do NOT enable multi-process PM2/K8s replicas until the sweeper is validated
 * for every timer kind you migrate.
 */

const { ensureRedisConnection } = require('./redis.service');

const ZSET_KEY = process.env.DURABLE_TIMER_ZSET_KEY || 'durable:timers:due';
const KEY_PREFIX = process.env.DURABLE_TIMER_KEY_PREFIX || 'durable:timer:';
const DEFAULT_GRACE_MS = Math.max(0, Number(process.env.DURABLE_TIMER_GRACE_MS) || 2000);
const SWEEP_INTERVAL_MS = Math.max(
  500,
  Number(process.env.DURABLE_TIMER_SWEEP_INTERVAL_MS) || 1000,
);
const SWEEP_BATCH = Math.max(1, Number(process.env.DURABLE_TIMER_SWEEP_BATCH) || 50);

let sweeperHandle = null;
let sweeperInFlight = false;

function isArmEnabled() {
  // Dual-write on by default when Redis exists; disable with DURABLE_TIMER_ARM=false
  return String(process.env.DURABLE_TIMER_ARM || 'true').toLowerCase() !== 'false';
}

function isSweeperEnabled() {
  if (process.env.DURABLE_TIMER_SWEEPER_ENABLED != null
    && String(process.env.DURABLE_TIMER_SWEEPER_ENABLED).trim() !== '') {
    return String(process.env.DURABLE_TIMER_SWEEPER_ENABLED).toLowerCase() === 'true';
  }
  // Auto-enable when intentionally running multiple Node workers.
  const clusterInstances = Number(process.env.CLUSTER_INSTANCES || process.env.instances || 1);
  return Number.isFinite(clusterInstances) && clusterInstances > 1;
}

function timerMember(kind, sessionId, token) {
  return `${kind}:${Number(sessionId)}:${String(token)}`;
}

function timerDataKey(member) {
  return `${KEY_PREFIX}${member}`;
}

/**
 * @param {{ kind: string, sessionId: number|string, token: string|number, fireAtMs: number, payload?: object, graceMs?: number }} opts
 */
async function arm(opts = {}) {
  if (!isArmEnabled()) return false;
  const kind = String(opts.kind || '').trim();
  const sessionId = Number(opts.sessionId);
  const token = opts.token;
  const fireAtMs = Number(opts.fireAtMs);
  if (!kind || Number.isNaN(sessionId) || token == null || !Number.isFinite(fireAtMs)) {
    return false;
  }

  const client = await ensureRedisConnection();
  if (!client) return false;

  const graceMs = Number.isFinite(Number(opts.graceMs))
    ? Math.max(0, Number(opts.graceMs))
    : DEFAULT_GRACE_MS;
  const dueAt = fireAtMs + graceMs;
  const member = timerMember(kind, sessionId, token);
  const payload = {
    kind,
    session_id: sessionId,
    token: String(token),
    fire_at_ms: fireAtMs,
    due_at_ms: dueAt,
    payload: opts.payload || {},
    armed_at: new Date().toISOString(),
  };

  try {
    const ttlSeconds = Math.max(
      60,
      Math.ceil((dueAt - Date.now()) / 1000) + 120,
    );
    const pipeline = client.pipeline();
    pipeline.set(timerDataKey(member), JSON.stringify(payload), 'EX', ttlSeconds);
    pipeline.zadd(ZSET_KEY, dueAt, member);
    await pipeline.exec();
    return true;
  } catch (err) {
    console.error(`[DURABLE_TIMER] arm failed kind=${kind} session=${sessionId}:`, err.message);
    return false;
  }
}

/**
 * @param {{ kind: string, sessionId: number|string, token: string|number }} opts
 */
async function cancel(opts = {}) {
  if (!isArmEnabled()) return false;
  const kind = String(opts.kind || '').trim();
  const sessionId = Number(opts.sessionId);
  const token = opts.token;
  if (!kind || Number.isNaN(sessionId) || token == null) return false;

  const client = await ensureRedisConnection();
  if (!client) return false;

  const member = timerMember(kind, sessionId, token);
  try {
    const pipeline = client.pipeline();
    pipeline.del(timerDataKey(member));
    pipeline.zrem(ZSET_KEY, member);
    await pipeline.exec();
    return true;
  } catch (err) {
    console.error(`[DURABLE_TIMER] cancel failed kind=${kind} session=${sessionId}:`, err.message);
    return false;
  }
}

async function armTurnTimeout(sessionId, turn, graceMs) {
  if (!turn || turn.turn_id == null || !turn.ends_at) return false;
  const fireAtMs = Date.parse(turn.ends_at);
  if (!Number.isFinite(fireAtMs)) return false;
  return arm({
    kind: 'turn',
    sessionId,
    token: turn.turn_id,
    fireAtMs,
    graceMs,
    payload: {
      turn_id: Number(turn.turn_id),
      type: turn.type || 'normal',
      user_id: turn.user_id || null,
    },
  });
}

async function cancelTurnTimeout(sessionId, turnId) {
  if (turnId == null) return false;
  return cancel({ kind: 'turn', sessionId, token: turnId });
}

/**
 * @param {{ onDue: (entry: object) => Promise<void>, kinds?: string[] }} opts
 */
function startSweeper(opts = {}) {
  if (!isSweeperEnabled()) {
    console.log('[DURABLE_TIMER] Sweeper disabled (set DURABLE_TIMER_SWEEPER_ENABLED=true to enable)');
    return;
  }
  if (typeof opts.onDue !== 'function') {
    throw new Error('durableTimer.startSweeper requires onDue handler');
  }
  if (sweeperHandle) return;

  const allowedKinds = Array.isArray(opts.kinds) && opts.kinds.length
    ? new Set(opts.kinds.map(String))
    : null;

  console.log(
    `[DURABLE_TIMER] Sweeper enabled interval=${SWEEP_INTERVAL_MS}ms batch=${SWEEP_BATCH}`,
  );

  sweeperHandle = setInterval(() => {
    if (sweeperInFlight) return;
    sweeperInFlight = true;
    sweepOnce(opts.onDue, allowedKinds)
      .catch((err) => {
        console.error('[DURABLE_TIMER] sweep error:', err.message);
      })
      .finally(() => {
        sweeperInFlight = false;
      });
  }, SWEEP_INTERVAL_MS);
  if (typeof sweeperHandle.unref === 'function') sweeperHandle.unref();
}

function stopSweeper() {
  if (!sweeperHandle) return;
  clearInterval(sweeperHandle);
  sweeperHandle = null;
}

async function sweepOnce(onDue, allowedKinds) {
  const client = await ensureRedisConnection();
  if (!client) return;

  const now = Date.now();
  const dueMembers = await client.zrangebyscore(ZSET_KEY, '-inf', now, 'LIMIT', 0, SWEEP_BATCH);
  if (!Array.isArray(dueMembers) || dueMembers.length === 0) return;

  for (const member of dueMembers) {
    const dataRaw = await client.get(timerDataKey(member));
    // Always remove from zset so we don't spin on poison entries.
    await client.zrem(ZSET_KEY, member);
    if (!dataRaw) {
      await client.del(timerDataKey(member));
      continue;
    }

    let entry;
    try {
      entry = JSON.parse(dataRaw);
    } catch (_) {
      await client.del(timerDataKey(member));
      continue;
    }

    if (allowedKinds && !allowedKinds.has(String(entry.kind))) {
      continue;
    }

    // Claim so only one worker processes this deadline.
    const claimKey = `idem:durable-timer:${member}`;
    const claimed = await client.set(claimKey, '1', 'EX', 120, 'NX');
    if (claimed !== 'OK') continue;

    await client.del(timerDataKey(member));
    try {
      await onDue(entry);
    } catch (err) {
      console.error(`[DURABLE_TIMER] onDue failed member=${member}:`, err.message);
    }
  }
}

async function getStats() {
  const client = await ensureRedisConnection();
  if (!client) {
    return {
      arm_enabled: isArmEnabled(),
      sweeper_enabled: isSweeperEnabled(),
      redis: false,
      due_count: null,
    };
  }
  try {
    const dueCount = await client.zcard(ZSET_KEY);
    return {
      arm_enabled: isArmEnabled(),
      sweeper_enabled: isSweeperEnabled(),
      redis: true,
      due_count: dueCount,
    };
  } catch (err) {
    return {
      arm_enabled: isArmEnabled(),
      sweeper_enabled: isSweeperEnabled(),
      redis: false,
      error: err.message,
    };
  }
}

module.exports = {
  arm,
  cancel,
  armTurnTimeout,
  cancelTurnTimeout,
  startSweeper,
  stopSweeper,
  getStats,
};
