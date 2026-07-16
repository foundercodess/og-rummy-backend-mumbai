const cron = require('node-cron');
const redisLockService = require('./redisLock.service');
const { runStaleSessionCleanup } = require('./staleSessionCleanup.service');

const LOCK_KEY = 'lock:job:stale-session-cleanup';
const LOCK_TTL_SECONDS = 300;

/**
 * Runs cleanup with a Redis lock so multiple API instances do not double-cancel in parallel.
 * When Redis is unavailable, redisLockService treats acquire as success (same as other jobs).
 */
async function runStaleSessionCleanupWithLock(options = {}) {
  const owner = `cleanup:${process.pid}:${Date.now()}`;
  const acquired = await redisLockService.acquireLock(LOCK_KEY, owner, LOCK_TTL_SECONDS);
  if (!acquired) {
    const err = new Error('Stale session cleanup is already running');
    err.code = 'CLEANUP_LOCK_HELD';
    throw err;
  }
  try {
    return await runStaleSessionCleanup(options);
  } finally {
    await redisLockService.releaseLock(LOCK_KEY, owner);
  }
}

async function runStaleSessionCleanupCronTick() {
  try {
    const result = await runStaleSessionCleanupWithLock({
      trigger: 'cron',
    });
    if (result.cancelled_count > 0) {
      console.log(
        `[stale-session-cleanup] cron: cancelled ${result.cancelled_count} session(s) `
          + `(stale_after_hours=${result.stale_after_hours})`
      );
    }
    return result;
  } catch (err) {
    if (err.code === 'CLEANUP_LOCK_HELD') {
      console.log('[stale-session-cleanup] cron: skipped (lock held)');
      return { skipped: true, reason: 'lock_held' };
    }
    if (err.code === 'DATABASE_NOT_CONFIGURED') {
      return { skipped: true, reason: 'no_database' };
    }
    console.error('[stale-session-cleanup] cron failed:', err.message);
    throw err;
  }
}

/**
 * Admin / manual trigger — throws CLEANUP_LOCK_HELD if another run is active.
 */
async function triggerStaleSessionCleanupFromAdmin(params = {}) {
  const adminUserId = params.adminUserId != null ? Number(params.adminUserId) : null;
  const trigger = Number.isInteger(adminUserId) && adminUserId > 0
    ? `admin:${adminUserId}`
    : 'admin_manual';

  return runStaleSessionCleanupWithLock({
    staleAfterHours: params.staleAfterHours,
    maxBatch: params.maxBatch,
    trigger,
  });
}

function startStaleSessionCleanupCron() {
  if (process.env.STALE_SESSION_CLEANUP_ENABLED === 'false') {
    console.log('[stale-session-cleanup] Cron disabled (STALE_SESSION_CLEANUP_ENABLED=false)');
    return { stop: () => {} };
  }
  if (!process.env.DATABASE_URL) {
    console.log('[stale-session-cleanup] Cron not started (DATABASE_URL unset)');
    return { stop: () => {} };
  }

  const expression = process.env.STALE_SESSION_CLEANUP_CRON || '0 */2 * * *';
  if (!cron.validate(expression)) {
    console.warn(`[stale-session-cleanup] Invalid STALE_SESSION_CLEANUP_CRON="${expression}", using default 0 */2 * * *`);
  }

  const schedule = cron.validate(expression) ? expression : '0 */2 * * *';
  const tz = process.env.STALE_SESSION_CLEANUP_TZ || undefined;
  const opts = tz ? { timezone: tz } : {};

  const task = cron.schedule(
    schedule,
    () => {
      setImmediate(() => {
        runStaleSessionCleanupCronTick().catch(() => {});
      });
    },
    opts
  );

  console.log(`[stale-session-cleanup] Cron scheduled: "${schedule}"${tz ? ` (${tz})` : ''}`);
  return {
    stop: () => {
      task.stop();
      console.log('[stale-session-cleanup] Cron stopped');
    },
  };
}

module.exports = {
  startStaleSessionCleanupCron,
  runStaleSessionCleanupWithLock,
  runStaleSessionCleanupCronTick,
  triggerStaleSessionCleanupFromAdmin,
};
