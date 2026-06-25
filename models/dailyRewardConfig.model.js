const { query } = require('../db');

function toNumber(value) {
  return value == null ? 0 : Number(value);
}

async function getAllActive() {
  const result = await query(
    `SELECT day_number, amount, image_url, reward_type, bonus_expiry_days, active
     FROM daily_reward_configs
     WHERE active = true
     ORDER BY day_number ASC`
  );
  return result.rows.map((row) => ({
    day: row.day_number,
    amount: toNumber(row.amount),
    image_url: row.image_url,
    reward_type: row.reward_type,
    bonus_expiry_days: row.bonus_expiry_days,
    active: row.active,
  }));
}

async function getByDay(day) {
  const result = await query(
    `SELECT day_number, amount, image_url, reward_type, bonus_expiry_days, active
     FROM daily_reward_configs
     WHERE day_number = $1`,
    [day]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    day: row.day_number,
    amount: toNumber(row.amount),
    image_url: row.image_url,
    reward_type: row.reward_type,
    bonus_expiry_days: row.bonus_expiry_days,
    active: row.active,
  };
}

module.exports = {
  getAllActive,
  getByDay,
};

