const { query } = require('../db');

function toNumber(value) {
  return value == null ? null : Number(value);
}

/** Get active promo codes for config API (list for frontend). */
async function getActiveForConfig() {
  const result = await query(
    `SELECT id, code, min_amount, bonus_type, bonus_value, instant_cash,
            display_label, valid_from, valid_until, sort_order
     FROM promo_codes
     WHERE active = true
       AND (valid_from IS NULL OR valid_from <= NOW())
       AND (valid_until IS NULL OR valid_until >= NOW())
     ORDER BY sort_order ASC, id ASC`
  );

  return result.rows.map((row) => ({
    id: row.id,
    code: row.code,
    min_amount: toNumber(row.min_amount),
    bonus_type: row.bonus_type,
    bonus_value: toNumber(row.bonus_value),
    instant_cash: toNumber(row.instant_cash),
    display_label: row.display_label,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    sort_order: row.sort_order,
  }));
}

/** Get active promos with user usage flag (for coupon API). */
async function getActiveWithUserUsage(userId) {
  const result = await query(
    `SELECT p.id, p.code, p.min_amount, p.bonus_type, p.bonus_value, p.instant_cash,
            p.display_label, p.valid_from, p.valid_until, p.sort_order,
            EXISTS(
              SELECT 1 FROM promo_code_usage u
              WHERE u.promo_code_id = p.id AND u.user_id = $1
            ) AS used
     FROM promo_codes p
     WHERE p.active = true
       AND (p.valid_from IS NULL OR p.valid_from <= NOW())
       AND (p.valid_until IS NULL OR p.valid_until >= NOW())
     ORDER BY p.sort_order ASC, p.id ASC`,
    [userId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    code: row.code,
    min_amount: toNumber(row.min_amount),
    bonus_type: row.bonus_type,
    bonus_value: toNumber(row.bonus_value),
    instant_cash: toNumber(row.instant_cash),
    display_label: row.display_label,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    sort_order: row.sort_order,
    used: Boolean(row.used),
  }));
}

/** Find promo by code (case-insensitive). */
async function findByCode(code) {
  if (!code || typeof code !== 'string') return null;
  const normalized = String(code).trim().toUpperCase();
  if (!normalized) return null;

  const result = await query(
    `SELECT * FROM promo_codes
     WHERE UPPER(TRIM(code)) = $1 AND active = true
       AND (valid_from IS NULL OR valid_from <= NOW())
       AND (valid_until IS NULL OR valid_until >= NOW())`,
    [normalized]
  );
  return result.rows[0] || null;
}

/** Count uses by user for max_uses_per_user. */
async function countUserUsage(promoCodeId, userId) {
  const result = await query(
    'SELECT COUNT(*)::int AS cnt FROM promo_code_usage WHERE promo_code_id = $1 AND user_id = $2',
    [promoCodeId, userId]
  );
  return result.rows[0]?.cnt ?? 0;
}

/** Count total uses for max_uses_total. */
async function countTotalUsage(promoCodeId) {
  const result = await query(
    'SELECT COUNT(*)::int AS cnt FROM promo_code_usage WHERE promo_code_id = $1',
    [promoCodeId]
  );
  return result.rows[0]?.cnt ?? 0;
}

/** Record promo usage (call on payment success). */
async function recordUsage(promoCodeId, userId, rechargeTransactionId) {
  await query(
    `INSERT INTO promo_code_usage (promo_code_id, user_id, recharge_transaction_id)
     VALUES ($1, $2, $3)`,
    [promoCodeId, userId, rechargeTransactionId]
  );
}

/** Calculate bonus amount for a given deposit. */
function calculateBonus(promo, depositAmount) {
  const amt = Number(depositAmount) || 0;
  if (amt <= 0) return { bonusAmount: 0, instantCash: toNumber(promo?.instant_cash) || 0 };

  const bonusValue = toNumber(promo.bonus_value) || 0;
  const instantCash = toNumber(promo.instant_cash) || 0;
  let bonusAmount = 0;

  if (promo.bonus_type === 'percent') {
    bonusAmount = Math.round((amt * bonusValue) / 100);
  } else if (promo.bonus_type === 'fixed') {
    bonusAmount = bonusValue;
  }

  return { bonusAmount, instantCash };
}

module.exports = {
  getActiveForConfig,
  getActiveWithUserUsage,
  findByCode,
  countUserUsage,
  countTotalUsage,
  recordUsage,
  calculateBonus,
};
