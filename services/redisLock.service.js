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


function dealEmitKey(sessionId, sequence) {
    return `idem:deal:session:${sessionId}:seq:${sequence}`;
}

module.exports = {
    acquireLock,
    renewLock,
    releaseLock,
    claimEventIdempotency,
    releaseEventIdempotency,
    pregameLockKey,
    dealEmitKey,
};
