'use strict';

const crypto = require('crypto');
const { ensureRedisConnection } = require('./redis.service');
const userModel = require('../models/user.model');
const avatarModel = require('../models/avatar.model');

const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const LEASE_TTL_SECONDS = Math.max(300, Number(process.env.BOT_LEASE_TTL_SECONDS) || 7200);

/** @type {Map<number, { sessionId: number, expiresAt: number }>} */
const memoryLeaseByBotId = new Map();
/** @type {Map<number, Set<number>>} */
const memoryBotsBySessionId = new Map();

function leaseKey(botUserId) {
  return `bot:lease:${botUserId}`;
}

function sessionBotsKey(sessionId) {
  return `bot:session:${sessionId}`;
}

function generateRandomBotName(length = 10) {
  const bytes = crypto.randomBytes(Math.max(6, length));
  return Array.from(bytes.slice(0, length), (b) => ALPHANUMERIC[b % ALPHANUMERIC.length]).join('');
}

function rememberMemoryLease(sessionId, botUserId) {
  const sid = Number(sessionId);
  const bid = Number(botUserId);
  if (Number.isNaN(sid) || Number.isNaN(bid)) return;
  memoryLeaseByBotId.set(bid, {
    sessionId: sid,
    expiresAt: Date.now() + (LEASE_TTL_SECONDS * 1000),
  });
  if (!memoryBotsBySessionId.has(sid)) {
    memoryBotsBySessionId.set(sid, new Set());
  }
  memoryBotsBySessionId.get(sid).add(bid);
}

function forgetMemoryLease(sessionId, botUserId) {
  const sid = Number(sessionId);
  const bid = Number(botUserId);
  if (!Number.isNaN(bid)) memoryLeaseByBotId.delete(bid);
  if (!Number.isNaN(sid)) {
    const set = memoryBotsBySessionId.get(sid);
    if (set) {
      set.delete(bid);
      if (set.size === 0) memoryBotsBySessionId.delete(sid);
    }
  }
}

function isMemoryLeaseAvailable(botUserId, sessionId) {
  const bid = Number(botUserId);
  const sid = Number(sessionId);
  const lease = memoryLeaseByBotId.get(bid);
  if (!lease) return true;
  if (lease.expiresAt <= Date.now()) {
    forgetMemoryLease(lease.sessionId, bid);
    return true;
  }
  return Number(lease.sessionId) === sid;
}

async function isBotLeaseAvailable(botUserId, sessionId) {
  const bid = Number(botUserId);
  const sid = Number(sessionId);
  if (Number.isNaN(bid)) return false;

  const client = await ensureRedisConnection();
  if (!client) return isMemoryLeaseAvailable(bid, sid);

  try {
    const owner = await client.get(leaseKey(bid));
    if (!owner) return true;
    return Number(owner) === sid;
  } catch (_) {
    return isMemoryLeaseAvailable(bid, sid);
  }
}

async function refreshBotDisplayIdentity(botUserId) {
  const bid = Number(botUserId);
  if (Number.isNaN(bid)) return null;
  const existing = await userModel.findById(bid);
  if (!existing) return null;
  const nextName = generateRandomBotName();
  const nextAvatar = (!existing.avatar || String(existing.avatar).trim() === '')
    ? await avatarModel.getRandomAvatarUrl()
    : existing.avatar;
  await userModel.updateProfile(bid, {
    name: nextName,
    avatar: nextAvatar,
  });
  return userModel.findById(bid);
}

async function acquireBotLease(sessionId, botUserId, options = {}) {
  const sid = Number(sessionId);
  const bid = Number(botUserId);
  if (Number.isNaN(sid) || Number.isNaN(bid)) return false;

  const available = await isBotLeaseAvailable(bid, sid);
  if (!available) return false;

  const client = await ensureRedisConnection();
  if (client) {
    try {
      const acquired = await client.set(leaseKey(bid), String(sid), 'EX', LEASE_TTL_SECONDS, 'NX');
      if (acquired !== 'OK') {
        const owner = await client.get(leaseKey(bid));
        if (Number(owner) !== sid) return false;
      }
      await client.sadd(sessionBotsKey(sid), String(bid));
      await client.expire(sessionBotsKey(sid), LEASE_TTL_SECONDS);
    } catch (_) {
      if (!isMemoryLeaseAvailable(bid, sid)) return false;
      rememberMemoryLease(sid, bid);
    }
  } else {
    rememberMemoryLease(sid, bid);
  }

  if (options.refreshDisplayName === true) {
    await refreshBotDisplayIdentity(bid);
  }
  return true;
}

async function releaseBotLease(sessionId, botUserId) {
  const sid = Number(sessionId);
  const bid = Number(botUserId);
  if (Number.isNaN(sid) || Number.isNaN(bid)) return;

  forgetMemoryLease(sid, bid);
  const client = await ensureRedisConnection();
  if (!client) return;

  try {
    const owner = await client.get(leaseKey(bid));
    if (owner && Number(owner) === sid) {
      await client.del(leaseKey(bid));
    }
    await client.srem(sessionBotsKey(sid), String(bid));
  } catch (_) {
    // memory fallback already cleared
  }
}

async function releaseBotsForSession(sessionId) {
  const sid = Number(sessionId);
  if (Number.isNaN(sid)) return;

  const memorySet = memoryBotsBySessionId.get(sid);
  if (memorySet) {
    for (const botId of Array.from(memorySet)) {
      forgetMemoryLease(sid, botId);
    }
  }

  const client = await ensureRedisConnection();
  if (!client) return;

  try {
    const botIds = await client.smembers(sessionBotsKey(sid));
    if (Array.isArray(botIds) && botIds.length > 0) {
      const pipeline = client.pipeline();
      for (const rawId of botIds) {
        pipeline.del(leaseKey(rawId));
      }
      pipeline.del(sessionBotsKey(sid));
      await pipeline.exec();
    }
  } catch (_) {
    // best effort
  }
}

function pickRandomUnusedBotIndex(poolSize, triedIndices = new Set()) {
  const size = Math.max(1, Number(poolSize) || 1);
  if (triedIndices.size >= size) return null;
  let index = null;
  let guard = 0;
  while (guard < size * 3) {
    guard += 1;
    const candidate = Math.floor(Math.random() * size) + 1;
    if (!triedIndices.has(candidate)) {
      index = candidate;
      break;
    }
  }
  if (index == null) {
    for (let i = 1; i <= size; i += 1) {
      if (!triedIndices.has(i)) {
        index = i;
        break;
      }
    }
  }
  return index;
}

module.exports = {
  acquireBotLease,
  releaseBotLease,
  releaseBotsForSession,
  isBotLeaseAvailable,
  refreshBotDisplayIdentity,
  pickRandomUnusedBotIndex,
  generateRandomBotName,
};
