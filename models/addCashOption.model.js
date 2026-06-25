const { query } = require('../db');

function toNumber(value) {
  return value == null ? null : Number(value);
}

/** Get add-cash option by id (for tier credit calculation). */
async function getById(id) {
  if (!id) return null;
  const result = await query(
    'SELECT id, base_amount, instant_cash, bonus FROM add_cash_options WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

/** Get active add-cash options for config API. */
async function getActiveForConfig() {
  const result = await query(
    `SELECT 
       id,
       base_amount,
       instant_cash,
       bonus,
       is_hot,
       active
     FROM add_cash_options
     WHERE active = true
     ORDER BY sort_order ASC, id ASC`
  );

  return result.rows.map((row) => ({
    ...row,
    base_amount: toNumber(row.base_amount),
    instant_cash: toNumber(row.instant_cash),
    bonus: toNumber(row.bonus),
  }));
}

async function getAllForAdmin() {
  const result = await query(
    `SELECT
       id,
       base_amount,
       instant_cash,
       bonus,
       is_hot,
       active,
       sort_order
     FROM add_cash_options
     ORDER BY sort_order ASC, id ASC`
  );

  return result.rows.map((row) => ({
    ...row,
    base_amount: toNumber(row.base_amount),
    instant_cash: toNumber(row.instant_cash),
    bonus: toNumber(row.bonus),
  }));
}

async function updateActive(id, active) {
  const result = await query(
    `UPDATE add_cash_options
     SET active = $2,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, base_amount, instant_cash, bonus, is_hot, active, sort_order`,
    [id, active]
  );
  const row = result.rows[0] || null;
  if (!row) return null;
  return {
    ...row,
    base_amount: toNumber(row.base_amount),
    instant_cash: toNumber(row.instant_cash),
    bonus: toNumber(row.bonus),
  };
}

async function createOption({
  baseAmount,
  instantCash = 0,
  bonus = 0,
  isHot = false,
  active = true,
  sortOrder = 0,
}) {
  const result = await query(
    `INSERT INTO add_cash_options (
       base_amount,
       instant_cash,
       bonus,
       is_hot,
       active,
       sort_order,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
     RETURNING id, base_amount, instant_cash, bonus, is_hot, active, sort_order`,
    [baseAmount, instantCash, bonus, isHot, active, sortOrder]
  );
  const row = result.rows[0] || null;
  if (!row) return null;
  return {
    ...row,
    base_amount: toNumber(row.base_amount),
    instant_cash: toNumber(row.instant_cash),
    bonus: toNumber(row.bonus),
  };
}

module.exports = {
  createOption,
  getAllForAdmin,
  getActiveForConfig,
  getById,
  updateActive,
};

