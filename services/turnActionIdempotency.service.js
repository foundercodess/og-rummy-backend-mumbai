const { cacheGetJson, cacheSetJson } = require('./redis.service');
const { acquireLock, releaseLock } = require('./redisLock.service');

/**
 * Turn-scoped idempotency for pick/discard.
 * Retries / double-taps replay the same ACK instead of drawing/discarding again.
 * No client change required — keyed by session + turn_id + user_id.
 */

const RESULT_TTL_MS = 5 * 60 * 1000;
const LOCK_TTL_SECONDS = 20;

function pickResultKey(sessionId, turnId, userId) {
  return `idem:result:pick:${sessionId}:${turnId}:${userId}`;
}

function discardResultKey(sessionId, turnId, userId) {
  return `idem:result:discard:${sessionId}:${turnId}:${userId}`;
}

function pickLockKey(sessionId, turnId, userId) {
  return `lock:pick:${sessionId}:${turnId}:${userId}`;
}

function discardLockKey(sessionId, turnId, userId) {
  return `lock:discard:${sessionId}:${turnId}:${userId}`;
}

function resolveTurnId(session) {
  const n = Number(session?.metadata?.turn?.turn_id);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function getStoredAck(key) {
  return cacheGetJson(key);
}

async function storeAck(key, ack) {
  await cacheSetJson(key, ack, RESULT_TTL_MS);
}

async function withTurnActionLock(lockKey, owner, fn) {
  const got = await acquireLock(lockKey, owner, LOCK_TTL_SECONDS);
  if (!got) {
    const err = new Error('Action already in progress — retry shortly');
    err.code = 'ACTION_IN_PROGRESS';
    throw err;
  }
  try {
    return await fn();
  } finally {
    await releaseLock(lockKey, owner);
  }
}

module.exports = {
  pickResultKey,
  discardResultKey,
  pickLockKey,
  discardLockKey,
  resolveTurnId,
  getStoredAck,
  storeAck,
  withTurnActionLock,
  RESULT_TTL_MS,
};
