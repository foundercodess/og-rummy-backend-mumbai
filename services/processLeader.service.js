'use strict';

/**
 * Single-leader election for process-wide loops (live count, bot scanner).
 * Uses Redis SET NX + renew so only one Node worker runs the loop.
 */
const crypto = require('crypto');
const { ensureRedisConnection } = require('./redis.service');

const OWNER = `${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

function isLeaderElectionEnabled() {
  // On by default when Redis exists; disable with PROCESS_LEADER_ENABLED=false
  return String(process.env.PROCESS_LEADER_ENABLED || 'true').toLowerCase() !== 'false';
}

/**
 * @param {string} name lock name suffix
 * @param {{ ttlSeconds?: number, renewEveryMs?: number, onBecomeLeader?: Function, onLoseLeadership?: Function }} opts
 */
function startProcessLeader(name, opts = {}) {
  const lockKey = `leader:${name}`;
  const ttlSeconds = Math.max(5, Number(opts.ttlSeconds) || 15);
  const renewEveryMs = Math.max(
    1000,
    Number(opts.renewEveryMs) || Math.floor((ttlSeconds * 1000) / 3),
  );

  let isLeader = false;
  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    if (!isLeaderElectionEnabled()) {
      if (!isLeader) {
        isLeader = true;
        if (typeof opts.onBecomeLeader === 'function') {
          try { opts.onBecomeLeader(); } catch (_) { /* ignore */ }
        }
      }
      return;
    }

    const client = await ensureRedisConnection();
    if (!client) {
      // No Redis — every process leads (same as pre-multi-instance).
      if (!isLeader) {
        isLeader = true;
        if (typeof opts.onBecomeLeader === 'function') {
          try { opts.onBecomeLeader(); } catch (_) { /* ignore */ }
        }
      }
      return;
    }

    try {
      if (isLeader) {
        const renewed = await client.eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) else return 0 end",
          1,
          lockKey,
          OWNER,
          String(ttlSeconds),
        );
        if (renewed !== 1) {
          isLeader = false;
          if (typeof opts.onLoseLeadership === 'function') {
            try { opts.onLoseLeadership(); } catch (_) { /* ignore */ }
          }
        }
        return;
      }

      const got = await client.set(lockKey, OWNER, 'EX', ttlSeconds, 'NX');
      if (got === 'OK') {
        isLeader = true;
        console.log(`[LEADER] acquired ${lockKey} owner=${OWNER}`);
        if (typeof opts.onBecomeLeader === 'function') {
          try { opts.onBecomeLeader(); } catch (_) { /* ignore */ }
        }
      }
    } catch (err) {
      console.error(`[LEADER] tick ${lockKey} failed:`, err.message);
    }
  }

  tick().catch(() => {});
  timer = setInterval(() => {
    tick().catch(() => {});
  }, renewEveryMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    isLeader: () => isLeader,
    owner: OWNER,
    stop: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (!isLeader) return;
      try {
        const client = await ensureRedisConnection();
        if (!client) return;
        await client.eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
          1,
          lockKey,
          OWNER,
        );
      } catch (_) {
        // ignore
      }
      isLeader = false;
    },
  };
}

module.exports = {
  startProcessLeader,
  OWNER,
};
