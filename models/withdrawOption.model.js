const { query } = require('../db');

function toNumber(value) {
  return value == null ? 0 : Number(value);
}

async function getActiveForConfig() {
  const result = await query(
    `SELECT id, amount, min_kyc_level, is_hot, active
     FROM withdraw_options
     WHERE active = true
     ORDER BY sort_order ASC, id ASC`
  );

  return result.rows.map((row) => ({
    ...row,
    amount: toNumber(row.amount),
  }));
}

async function getAllForAdmin() {
  const result = await query(
    `SELECT id, amount, min_kyc_level, is_hot, active, sort_order
     FROM withdraw_options
     ORDER BY sort_order ASC, id ASC`
  );

  return result.rows.map((row) => ({
    ...row,
    amount: toNumber(row.amount),
  }));
}

async function updateActive(id, active) {
  const result = await query(
    `UPDATE withdraw_options
     SET active = $2,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, amount, min_kyc_level, is_hot, active, sort_order`,
    [id, active]
  );

  const row = result.rows[0] || null;
  if (!row) return null;
  return {
    ...row,
    amount: toNumber(row.amount),
  };
}

async function createOption({
  amount,
  minKycLevel = 'none',
  isHot = false,
  active = true,
  sortOrder = 0,
}) {
  const result = await query(
    `INSERT INTO withdraw_options (
       amount,
       min_kyc_level,
       is_hot,
       active,
       sort_order,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING id, amount, min_kyc_level, is_hot, active, sort_order`,
    [amount, minKycLevel, isHot, active, sortOrder]
  );
  const row = result.rows[0] || null;
  if (!row) return null;
  return {
    ...row,
    amount: toNumber(row.amount),
  };
}

module.exports = {
  createOption,
  getAllForAdmin,
  getActiveForConfig,
  updateActive,
};

