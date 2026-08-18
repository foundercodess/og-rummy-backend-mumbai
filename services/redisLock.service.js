const { ensureRedisConnection } = require('./redis.service');

async function acquireLock(key, owner, ttlSeconds) {
    const client = await ensureRedisConnection();
    if (!client) return true;

    try {
        const result = await client.set(key, owner, 'EX', ttlSeconds, 'NX');
        return result === 'OK';
    } catch (err) {
        console.error('Failed to acquire Redis lock:', err.message);
        return false;
    }
}

async function renewLock(key, owner, ttlSeconds) {
    const client = await ensureRedisConnection();
    if (!client) return true;

    try {
        const renewed = await client.eval(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) else return 0 end",
            1,
            key,
            owner,
            String(ttlSeconds)
        );
        return renewed === 1;
    } catch (err) {
        console.error('Failed to renew Redis lock:', err.message);
        return false;
    }
}

async function releaseLock(key, owner) {
    const client = await ensureRedisConnection();
    if (!client) return true;

    try {
        const released = await client.eval(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
            1,
            key,
            owner
        );
        return released === 1;
    } catch (err) {
        console.error('Failed to release Redis lock:', err.message);
        return false;
    }
}

async function claimEventIdempotency(key, ttlSeconds) {
    const client = await ensureRedisConnection();
    if (!client) return true;

    try {
        const result = await client.set(key, '1', 'EX', ttlSeconds, 'NX');
        return result === 'OK';
    } catch (err) {
        console.error('Failed to claim Redis idempotency key:', err.message);
        return false;
    }
}

async function releaseEventIdempotency(key) {
    const client = await ensureRedisConnection();
    if (!client) return true;

    try {
        await client.del(key);
        return true;
    } catch (err) {
        console.error('Failed to release Redis idempotency key:', err.message);
        return false;
    }
}

function pregameLockKey(sessionId) {
    return `lock:pregame:session:${sessionId}`;
}

/** Serializes seat assignment across workers for the same waiting table. */
function joinSessionLockKey(sessionId) {
    return `lock:join:session:${sessionId}`;
}

function dealEmitKey(sessionId, sequence) {
    return `idem:deal:session:${sessionId}:seq:${sequence}`;
}

/**
 * Acquire a join-seat lock and hold it alive (via periodic renewal) for the
 * duration of `fn`. Prevents the 15-second fixed TTL from expiring while
 * Postgres is under heavy load, which was the root cause of
 * `duplicate key ... game_session_players_unique_seat` errors.
 *
 * @param {string} key      - Lock key (e.g. joinSessionLockKey(sessionId))
 * @param {string} owner    - Unique owner token
 * @param {number} ttlSec   - Initial TTL and renewal interval target
 * @param {Function} fn     - Async function to run while holding the lock
 * @returns {*} Return value of fn
 */
async function withJoinLock(key, owner, ttlSec, fn) {
    // Try to acquire; retry with 50ms backoff up to ~1s.
    let acquired = await acquireLock(key, owner, ttlSec);
    if (!acquired) {
        for (let i = 0; i < 20 && !acquired; i += 1) {
            await new Promise((r) => setTimeout(r, 50));
            acquired = await acquireLock(key, owner, ttlSec);
        }
    }
    if (!acquired) {
        const err = new Error('Session join busy — retry shortly');
        err.code = 'SESSION_JOIN_BUSY';
        throw err;
    }

    // Renew every (ttlSec / 2) seconds so the lock never expires under slow DB.
    const renewEveryMs = Math.max(1000, Math.floor((ttlSec / 2) * 1000));
    const renewTimer = setInterval(async () => {
        const ok = await renewLock(key, owner, ttlSec).catch(() => false);
        if (!ok) {
            console.warn(`[join-lock] Failed to renew ${key} — owner=${owner}`);
        }
    }, renewEveryMs);
    if (renewTimer.unref) renewTimer.unref();

    try {
        return await fn();
    } finally {
        clearInterval(renewTimer);
        await releaseLock(key, owner).catch(() => {});
    }
}

module.exports = {
    acquireLock,
    renewLock,
    releaseLock,
    withJoinLock,
    claimEventIdempotency,
    releaseEventIdempotency,
    pregameLockKey,
    joinSessionLockKey,
    dealEmitKey,
};
