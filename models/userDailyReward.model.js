const { query } = require('../db');

async function findByUserId(userId) {
  const result = await query(
    'SELECT * FROM user_daily_rewards WHERE user_id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

async function upsertProgress(userId, { lastClaimedDay, lastClaimedDate, cycleStartedDate, incrementCyclesCompleted = false }) {
  const existing = await findByUserId(userId);

  if (!existing) {
    const result = await query(
      `INSERT INTO user_daily_rewards (
         user_id, last_claimed_day, last_claimed_date, cycle_started_date, cycles_completed, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [
        userId,
        lastClaimedDay ?? null,
        lastClaimedDate ?? null,
        cycleStartedDate ?? (lastClaimedDay === 1 ? lastClaimedDate : null),
        incrementCyclesCompleted ? 1 : 0,
      ]
    );
    return result.rows[0];
  }

  const newCyclesCompleted = existing.cycles_completed + (incrementCyclesCompleted ? 1 : 0);

  const result = await query(
    `UPDATE user_daily_rewards
     SET last_claimed_day = $2,
         last_claimed_date = $3,
         cycle_started_date = COALESCE($4, cycle_started_date),
         cycles_completed = $5,
         updated_at = NOW()
     WHERE user_id = $1
     RETURNING *`,
    [
      userId,
      lastClaimedDay ?? existing.last_claimed_day,
      lastClaimedDate ?? existing.last_claimed_date,
      cycleStartedDate ?? (existing.cycle_started_date || (lastClaimedDay === 1 ? lastClaimedDate : null)),
      newCyclesCompleted,
    ]
  );
  return result.rows[0];
}

module.exports = {
  findByUserId,
  upsertProgress,
};

