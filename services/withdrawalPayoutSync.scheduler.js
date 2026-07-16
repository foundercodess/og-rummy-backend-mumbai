const cron = require('node-cron');
const redisLockService = require('./redisLock.service');
const giftauraPayoutService = require('./giftauraPayout.service');
const { syncPendingWithdrawalsFromPg } = require('./withdrawal.service');

const LOCK_KEY = 'lock:job:withdrawal-payout-sync';
const LOCK_TTL_SECONDS = 540;

async function runWithdrawalPayoutSyncWithLock(options = {}) {
  const owner = `withdrawal-payout-sync:${process.pid}:${Date.now()}`;
  const acquired = await redisLockService.acquireLock(LOCK_KEY, owner, LOCK_TTL_SECONDS);
  if (!acquired) {
    const err = new Error('Withdrawal payout sync is already running');
    err.code = 'WITHDRAWAL_PAYOUT_SYNC_LOCK_HELD';
    throw err;
  }
  try {
    return await syncPendingWithdrawalsFromPg(options);
  } finally {
    await redisLockService.releaseLock(LOCK_KEY, owner);
  }
}

async function runWithdrawalPayoutSyncCronTick() {
  try {
    const result = await runWithdrawalPayoutSyncWithLock({ trigger: 'cron' });
    if (result.skipped) {
      return result;
    }
    if (result.checked > 0 || result.errors > 0) {
      console.log(
        `[withdrawal-payout-sync] cron: checked=${result.checked} changed=${result.changed} `
          + `success=${result.successful} failed=${result.failed} pending=${result.still_pending} `
          + `not_found=${result.not_found} errors=${result.errors}`
      );
    }
    return result;
  } catch (err) {
    if (err.code === 'WITHDRAWAL_PAYOUT_SYNC_LOCK_HELD') {
      console.log('[withdrawal-payout-sync] cron: skipped (lock held)');
      return { skipped: true, reason: 'lock_held' };
    }
    console.error('[withdrawal-payout-sync] cron failed:', err.message);
    throw err;
  }
}

async function triggerWithdrawalPayoutSyncFromAdmin(params = {}) {
  const adminUserId = params.adminUserId != null ? Number(params.adminUserId) : null;
  const trigger = Number.isInteger(adminUserId) && adminUserId > 0
    ? `admin:${adminUserId}`
    : 'admin_manual';

  return runWithdrawalPayoutSyncWithLock({ trigger });
}

function startWithdrawalPayoutSyncCron() {
  if (process.env.WITHDRAWAL_PAYOUT_SYNC_ENABLED === 'false') {
    console.log('[withdrawal-payout-sync] Cron disabled (WITHDRAWAL_PAYOUT_SYNC_ENABLED=false)');
    return { stop: () => {} };
  }
  if (!process.env.DATABASE_URL) {
    console.log('[withdrawal-payout-sync] Cron not started (DATABASE_URL unset)');
    return { stop: () => {} };
  }
  if (!giftauraPayoutService.isConfigured()) {
    console.log('[withdrawal-payout-sync] Cron not started (GiftAura payout not configured)');
    return { stop: () => {} };
  }

  const expression = process.env.WITHDRAWAL_PAYOUT_SYNC_CRON || '*/10 * * * *';
  const schedule = cron.validate(expression) ? expression : '*/10 * * * *';
  if (!cron.validate(expression)) {
    console.warn(
      `[withdrawal-payout-sync] Invalid WITHDRAWAL_PAYOUT_SYNC_CRON="${expression}", using */10 * * * *`
    );
  }

  const tz = process.env.WITHDRAWAL_PAYOUT_SYNC_TZ || undefined;
  const opts = tz ? { timezone: tz } : {};

  const task = cron.schedule(
    schedule,
    () => {
      setImmediate(() => {
        runWithdrawalPayoutSyncCronTick().catch(() => {});
      });
    },
    opts
  );

  console.log(`[withdrawal-payout-sync] Cron scheduled: "${schedule}"${tz ? ` (${tz})` : ''}`);
  return {
    stop: () => {
      task.stop();
      console.log('[withdrawal-payout-sync] Cron stopped');
    },
  };
}

module.exports = {
  startWithdrawalPayoutSyncCron,
  runWithdrawalPayoutSyncWithLock,
  runWithdrawalPayoutSyncCronTick,
  triggerWithdrawalPayoutSyncFromAdmin,
};
