const { query } = require('../db');

function toNumber(value) {
  return value == null ? 0 : Number(value);
}

function formatForResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    wallet_id: row.wallet_id,
    type: row.type,
    amount: toNumber(row.amount),
    order_id: row.order_id,
    payment_ref: row.payment_ref,
    status: row.status,
    payment_response: row.payment_response,
    add_cash_option_id: row.add_cash_option_id,
    currency: row.currency,
    name: row.name,
    email: row.email,
    phone: row.phone,
    promo_code_id: row.promo_code_id,
    promo_bonus_amount: toNumber(row.promo_bonus_amount),
    promo_instant_cash: toNumber(row.promo_instant_cash),
    requested_at: row.requested_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function findByOrderId(orderId) {
  const result = await query(
    'SELECT * FROM recharge_transactions WHERE order_id = $1',
    [orderId]
  );
  return result.rows[0] || null;
}

async function findByPaymentRef(paymentRef) {
  const normalized = paymentRef == null ? '' : String(paymentRef).trim();
  if (!normalized) return null;
  const result = await query(
    `SELECT * FROM recharge_transactions
     WHERE payment_ref = $1 OR order_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [normalized]
  );
  return result.rows[0] || null;
}

async function createInit({
  userId,
  walletId,
  type,
  amount,
  orderId,
  addCashOptionId,
  currency,
  name,
  email,
  phone,
  promoCodeId,
  promoBonusAmount,
  promoInstantCash,
}) {
  const result = await query(
    `INSERT INTO recharge_transactions (
       user_id, wallet_id, type, amount, order_id, add_cash_option_id, currency,
       name, email, phone, promo_code_id, promo_bonus_amount, promo_instant_cash, status, requested_at
     ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'INR'), $8, $9, $10, $11, COALESCE($12, 0), COALESCE($13, 0), 'init', NOW())
     RETURNING *`,
    [
      userId,
      walletId,
      type,
      amount,
      orderId,
      addCashOptionId || null,
      currency || null,
      name || null,
      email || null,
      phone || null,
      promoCodeId || null,
      promoBonusAmount ?? 0,
      promoInstantCash ?? 0,
    ]
  );
  return result.rows[0] || null;
}

async function updateStatusByOrderId({ orderId, status, paymentRef, paymentResponse, completedAt }) {
  const result = await query(
    `UPDATE recharge_transactions
     SET status = $2,
         payment_ref = COALESCE($3, payment_ref),
         payment_response = COALESCE($4, payment_response),
         completed_at = COALESCE($5, completed_at),
         updated_at = NOW()
     WHERE order_id = $1
     RETURNING *`,
    [orderId, status, paymentRef || null, paymentResponse || null, completedAt || null]
  );
  return result.rows[0] || null;
}

async function listPendingForPgSync({ minAgeMinutes = 2, limit = 50 } = {}) {
  const result = await query(
    `SELECT *
     FROM recharge_transactions
     WHERE status = 'init'
       AND type = 'conventional'
       AND order_id IS NOT NULL
       AND requested_at < NOW() - ($1::text || ' minutes')::interval
     ORDER BY requested_at ASC
     LIMIT $2`,
    [String(minAgeMinutes), limit]
  );
  return result.rows;
}

async function listByUserId({ userId, limit = 50, offset = 0, fromDate = null, toDate = null }) {
  const params = [userId];
  let idx = params.length + 1;
  const where = ['user_id = $1'];

  if (fromDate) {
    where.push(`requested_at >= $${idx++}`);
    params.push(fromDate);
  }
  if (toDate) {
    where.push(`requested_at <= $${idx++}`);
    params.push(toDate);
  }

  params.push(limit, offset);

  const result = await query(
    `SELECT * FROM recharge_transactions
     WHERE ${where.join(' AND ')}
     ORDER BY requested_at DESC, id DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return result.rows.map(formatForResponse);
}

module.exports = {
  formatForResponse,
  findByOrderId,
  findByPaymentRef,
  createInit,
  updateStatusByOrderId,
  listPendingForPgSync,
  listByUserId,
};

