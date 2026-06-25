const { pool } = require('../db');
const dailyRewardConfigModel = require('../models/dailyRewardConfig.model');
const userDailyRewardModel = require('../models/userDailyReward.model');

const REWARD_TIMEZONE = process.env.REWARD_TIMEZONE || 'Asia/Kolkata';

function toDateStringInTimeZone(date, timeZone = REWARD_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;

  return `${year}-${month}-${day}`;
}

function shiftDateString(dateString, daysDelta) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + daysDelta);
  return utc.toISOString().slice(0, 10);
}

function normalizeClaimDate(value) {
  if (!value) return null;

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const dateValue = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dateValue.getTime())) {
    return null;
  }

  return toDateStringInTimeZone(dateValue);
}

function todayDateString() {
  return toDateStringInTimeZone(new Date());
}

function dateStringDaysAgo(days) {
  const today = todayDateString();
  return shiftDateString(today, -days);
}

function buildStatus({ configs, progress }) {
  const today = todayDateString();
  const lastDate = normalizeClaimDate(progress?.last_claimed_date);
  const lastDay = progress?.last_claimed_day != null ? Number(progress.last_claimed_day) : null;
  const completedCycle = Number(progress?.cycles_completed || 0) >= 1 || (lastDay != null && lastDay >= 7);

  let canClaimToday = false;
  let todayDayNumber = null;

  if (!completedCycle) {
    if (lastDate == null || lastDay == null) {
      // First-time claim starts from day 1.
      canClaimToday = true;
      todayDayNumber = 1;
    } else if (lastDate === today) {
      // Already claimed today.
      canClaimToday = false;
      todayDayNumber = null;
    } else {
      // One-time ladder progression: unlock only the next day, no reset on missed days.
      canClaimToday = true;
      todayDayNumber = Math.min(7, Math.max(1, lastDay + 1));
    }
  }

  const days = configs.map((cfg) => {
    let status = 'locked';
    if (lastDay && cfg.day <= lastDay && lastDate) {
      status = 'claimed';
    } else if (cfg.day === todayDayNumber && canClaimToday) {
      status = 'available';
    }
    return {
      day: cfg.day,
      amount: cfg.amount,
      image_url: cfg.image_url,
      reward_type: cfg.reward_type,
      status,
    };
  });

  return {
    current_day: completedCycle
      ? 7
      : (todayDayNumber || (lastDate && lastDay ? lastDay : 1)),
    can_claim_today: canClaimToday,
    today_day_number: todayDayNumber,
    completed: completedCycle,
    days,
  };
}

async function getDailyStatus(userId) {
  const [configs, progress] = await Promise.all([
    dailyRewardConfigModel.getAllActive(),
    userDailyRewardModel.findByUserId(userId),
  ]);

  return buildStatus({ configs, progress });
}

async function claimDailyReward(userId) {
  if (!pool) {
    throw new Error('DATABASE_URL not configured');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const configsResult = await client.query(
      `SELECT day_number, amount, image_url, reward_type, bonus_expiry_days, active
       FROM daily_reward_configs
       WHERE active = true
       ORDER BY day_number ASC`
    );
    const configs = configsResult.rows.map((row) => ({
      day: row.day_number,
      amount: Number(row.amount),
      image_url: row.image_url,
      reward_type: row.reward_type,
      bonus_expiry_days: row.bonus_expiry_days,
      active: row.active,
    }));

    const progressResult = await client.query(
      'SELECT * FROM user_daily_rewards WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    const progress = progressResult.rows[0] || null;

    const status = buildStatus({ configs, progress });
    if (!status.can_claim_today || !status.today_day_number) {
      await client.query('ROLLBACK');
      return { claimed: null, status };
    }

    const claimDay = status.today_day_number;
    const cfg = configs.find((c) => c.day === claimDay);
    if (!cfg) {
      throw new Error('CONFIG_FOR_DAY_NOT_FOUND');
    }

    const today = todayDateString();
    const incrementCyclesCompleted = claimDay === 7 && Number(progress?.cycles_completed || 0) < 1;

    // Update progress
    let updatedProgress;
    if (!progress) {
      const upsertRes = await client.query(
        `INSERT INTO user_daily_rewards (
           user_id, last_claimed_day, last_claimed_date, cycle_started_date, cycles_completed, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING *`,
        [
          userId,
          claimDay,
          today,
          claimDay === 1 ? today : null,
          incrementCyclesCompleted ? 1 : 0,
        ]
      );
      updatedProgress = upsertRes.rows[0];
    } else {
      const newCycles = Number(progress.cycles_completed || 0) + (incrementCyclesCompleted ? 1 : 0);
      const cycleStarted = claimDay === 1 ? today : progress.cycle_started_date;

      const upsertRes = await client.query(
        `UPDATE user_daily_rewards
         SET last_claimed_day = $2,
             last_claimed_date = $3,
             cycle_started_date = $4,
             cycles_completed = $5,
             updated_at = NOW()
         WHERE user_id = $1
         RETURNING *`,
        [userId, claimDay, today, cycleStarted, newCycles]
      );
      updatedProgress = upsertRes.rows[0];
    }

    // Credit wallet:
    // - instant_cash -> deposit
    // - bonus -> pending_bonus (with expiry)
    const walletRes = await client.query(
      'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    let walletRow = walletRes.rows[0];
    if (!walletRow) {
      const createRes = await client.query(
        `INSERT INTO wallets (user_id)
         VALUES ($1)
         ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
         RETURNING *`,
        [userId]
      );
      walletRow = createRes.rows[0];
    }

    const amount = Number(cfg.amount);
    const rewardType = String(cfg.reward_type || '').trim();
    const isInstant = rewardType === 'instant_cash';
    const isBonus = rewardType === 'bonus';

    if (!isInstant && !isBonus) {
      throw new Error('INVALID_DAILY_REWARD_TYPE');
    }

    const now = new Date();
    const expiresAt =
      isBonus && cfg.bonus_expiry_days != null
        ? new Date(now.getTime() + Number(cfg.bonus_expiry_days) * 24 * 60 * 60 * 1000)
        : null;

    const newTotal = isInstant ? Number(walletRow.total_balance) + amount : Number(walletRow.total_balance);
    const newDeposit = isInstant ? Number(walletRow.deposit) + amount : Number(walletRow.deposit);
    const newPendingBonus = isBonus ? Number(walletRow.pending_bonus) + amount : Number(walletRow.pending_bonus);

    await client.query(
      `UPDATE wallets
       SET total_balance = $2,
           deposit = $3,
           pending_bonus = $4,
           updated_at = NOW()
       WHERE id = $1`,
      [walletRow.id, newTotal, newDeposit, newPendingBonus]
    );

    await client.query(
      `INSERT INTO wallet_transactions (
         user_id, wallet_id, transaction_type, amount, source, reference_type, reference_id, expires_at, metadata
       ) VALUES (
         $1, $2, $3, $4, 'daily_reward', 'daily_reward_day', $5, $6, $7::jsonb
       )`,
      [
        userId,
        walletRow.id,
        isInstant ? 'deposit_credit' : 'pending_bonus_credit',
        amount,
        claimDay,
        expiresAt,
        { reward_type: rewardType },
      ]
    );

    await client.query('COMMIT');

    const newStatus = buildStatus({ configs, progress: updatedProgress });

    return {
      claimed: {
        day: claimDay,
        amount: cfg.amount,
        image_url: cfg.image_url,
        reward_type: cfg.reward_type,
      },
      status: newStatus,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getDailyStatus,
  claimDailyReward,
};

