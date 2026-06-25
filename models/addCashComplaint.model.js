const { query } = require('../db');

function formatForResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    cash_transaction_id: row.cash_transaction_id,
    recharge_transaction_id: row.recharge_transaction_id,
    payment_proof_image_url: row.payment_proof_image_url,
    utr_no: row.utr_no,
    payment_time: row.payment_time,
    phone: row.phone,
    status: row.status,
    admin_notes: row.admin_notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function create({
  userId,
  cashTransactionId,
  rechargeTransactionId = null,
  paymentProofImageUrl,
  utrNo = null,
  paymentTime = null,
  phone = null,
}) {
  const result = await query(
    `INSERT INTO add_cash_complaints (
       user_id,
       cash_transaction_id,
       recharge_transaction_id,
       payment_proof_image_url,
       utr_no,
       payment_time,
       phone,
       status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
     RETURNING *`,
    [
      userId,
      cashTransactionId,
      rechargeTransactionId || null,
      paymentProofImageUrl,
      utrNo || null,
      paymentTime || null,
      phone || null,
    ]
  );
  return result.rows[0] || null;
}

async function listByUserId({ userId, limit = 50, offset = 0 }) {
  const safeLimit = Number.isNaN(Number(limit)) ? 50 : Math.min(Number(limit), 100);
  const safeOffset = Number.isNaN(Number(offset)) ? 0 : Math.max(Number(offset), 0);

  const result = await query(
    `SELECT * FROM add_cash_complaints
     WHERE user_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [userId, safeLimit, safeOffset]
  );
  return result.rows.map(formatForResponse);
}

module.exports = {
  formatForResponse,
  create,
  listByUserId,
};

