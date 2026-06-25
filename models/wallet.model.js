const { query } = require('../db');

function toNumber(value) {
  return value == null ? 0 : Number(value);
}

function formatForResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    total_balance: toNumber(row.total_balance),
    pending_bonus: toNumber(row.pending_bonus),
    released_bonus: toNumber(row.released_bonus),
    withdrawable: toNumber(row.withdrawable),
    deposit: toNumber(row.deposit),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function findByUserId(userId) {
  const result = await query(
    'SELECT * FROM wallets WHERE user_id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

async function createForUser(userId) {
  const result = await query(
    `INSERT INTO wallets (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE
       SET user_id = EXCLUDED.user_id
     RETURNING *`,
    [userId]
  );
  return result.rows[0] || null;
}

async function getOrCreateByUserId(userId) {
  const existing = await findByUserId(userId);
  if (existing) return formatForResponse(existing);
  const created = await createForUser(userId);
  return formatForResponse(created);
}

module.exports = {
  findByUserId,
  createForUser,
  getOrCreateByUserId,
  formatForResponse,
};

