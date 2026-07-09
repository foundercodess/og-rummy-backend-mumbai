const cron = require('node-cron');
const redisLockService = require('./redisLock.service');
const giftauraPgService = require('./giftauraPg.service');
const { syncPendingRechargesFromPg } = require('./wallet.service');

const LOCK_KEY = 'lock:job:recharge-payin-sync';
const LOCK_TTL_SECONDS = 540;

async function runRechargePayinSyncWithLock(options = {}) {
  const owner = `recharge-payin-sync:${process.pid}:${Date.now()}`;
  const acquired = await redisLockService.acquireLock(LOCK_KEY, owner, LOCK_TTL_SECONDS);
  if (!acquired) {
    const err = new Error('Recharge pay-in sync is already running');
    err.code = 'RECHARGE_PAYIN_SYNC_LOCK_HELD';
    throw err;
  }
  try {
    return await syncPendingRechargesFromPg(options);
  } finally {
    await redisLockService.releaseLock(LOCK_KEY, owner);
  }
}

async function runRechargePayinSyncCronTick() {
  try {
    const result = await runRechargePayinSyncWithLock({ trigger: 'cron' });
    if (result.skipped) {
      return result;
    }
    if (result.checked > 0 || result.errors > 0) {
      console.log(
        `[recharge-payin-sync] cron: checked=${result.checked} changed=${result.changed} `
          + `success=${result.successful} failed=${result.failed} pending=${result.still_pending} `
          + `errors=${result.errors}`
      );
    }
    return result;
  } catch (err) {
    if (err.code === 'RECHARGE_PAYIN_SYNC_LOCK_HELD') {
      console.log('[recharge-payin-sync] cron: skipped (lock held)');
      return { skipped: true, reason: 'lock_held' };
    }
    console.error('[recharge-payin-sync] cron failed:', err.message);
    throw err;
  }
}

function startRechargePayinSyncCron() {
  if (process.env.RECHARGE_PAYIN_SYNC_ENABLED === 'false') {
    console.log('[recharge-payin-sync] Cron disabled (RECHARGE_PAYIN_SYNC_ENABLED=false)');
    return { stop: () => {} };
  }
  if (!process.env.DATABASE_URL) {
    console.log('[recharge-payin-sync] Cron not started (DATABASE_URL unset)');
    return { stop: () => {} };
  }
  if (!giftauraPgService.isConfigured()) {
    console.log('[recharge-payin-sync] Cron not started (GiftAura pay-in not configured)');
    return { stop: () => {} };
  }

  const expression = process.env.RECHARGE_PAYIN_SYNC_CRON || '*/10 * * * *';
  const schedule = cron.validate(expression) ? expression : '*/10 * * * *';
  if (!cron.validate(expression)) {
    console.warn(
      `[recharge-payin-sync] Invalid RECHARGE_PAYIN_SYNC_CRON="${expression}", using */10 * * * *`
    );
  }

  const tz = process.env.RECHARGE_PAYIN_SYNC_TZ || undefined;
  const opts = tz ? { timezone: tz } : {};

  const task = cron.schedule(
    schedule,
    () => {
      runRechargePayinSyncCronTick().catch(() => {});
    },
    opts
  );

  console.log(`[recharge-payin-sync] Cron scheduled: "${schedule}"${tz ? ` (${tz})` : ''}`);
  return {
    stop: () => {
      task.stop();
      console.log('[recharge-payin-sync] Cron stopped');
    },
  };
}

module.exports = {
  startRechargePayinSyncCron,
  runRechargePayinSyncWithLock,
  runRechargePayinSyncCronTick,
};
