const { query } = require('../db');

function formatForResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    game_commission_percent: Number(row.game_commission_percent),
    withdrawal_fee_percent: Number(row.withdrawal_fee_percent),
    withdrawal_min_amount: Number(row.withdrawal_min_amount),
    withdrawal_daily_max_count: Number(row.withdrawal_daily_max_count),
    withdrawal_daily_max_amount: Number(row.withdrawal_daily_max_amount),
    withdrawal_min_account_age_hours: Number(row.withdrawal_min_account_age_hours),
    withdrawal_new_account_max_amount: Number(row.withdrawal_new_account_max_amount),
    withdrawal_max_processing_count: Number(row.withdrawal_max_processing_count),
    withdrawal_require_approved_kyc: row.withdrawal_require_approved_kyc === true,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function getCurrent() {
  const result = await query(
    `SELECT *
     FROM platform_commercial_settings
     ORDER BY id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function upsertCurrent(fields) {
  const existing = await getCurrent();
  if (!existing) {
    const insertResult = await query(
      `INSERT INTO platform_commercial_settings (
         game_commission_percent,
         withdrawal_fee_percent,
         withdrawal_min_amount,
         withdrawal_daily_max_count,
         withdrawal_daily_max_amount,
         withdrawal_min_account_age_hours,
         withdrawal_new_account_max_amount,
         withdrawal_max_processing_count,
         withdrawal_require_approved_kyc,
         updated_by,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       RETURNING *`,
      [
        fields.game_commission_percent,
        fields.withdrawal_fee_percent,
        fields.withdrawal_min_amount,
        fields.withdrawal_daily_max_count,
        fields.withdrawal_daily_max_amount,
        fields.withdrawal_min_account_age_hours,
        fields.withdrawal_new_account_max_amount,
        fields.withdrawal_max_processing_count,
        fields.withdrawal_require_approved_kyc,
        fields.updatedBy ?? null,
      ]
    );
    return insertResult.rows[0] || null;
  }

  const updateResult = await query(
    `UPDATE platform_commercial_settings
     SET game_commission_percent = $2,
         withdrawal_fee_percent = $3,
         withdrawal_min_amount = $4,
         withdrawal_daily_max_count = $5,
         withdrawal_daily_max_amount = $6,
         withdrawal_min_account_age_hours = $7,
         withdrawal_new_account_max_amount = $8,
         withdrawal_max_processing_count = $9,
         withdrawal_require_approved_kyc = $10,
         updated_by = $11,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      existing.id,
      fields.game_commission_percent,
      fields.withdrawal_fee_percent,
      fields.withdrawal_min_amount,
      fields.withdrawal_daily_max_count,
      fields.withdrawal_daily_max_amount,
      fields.withdrawal_min_account_age_hours,
      fields.withdrawal_new_account_max_amount,
      fields.withdrawal_max_processing_count,
      fields.withdrawal_require_approved_kyc,
      fields.updatedBy ?? null,
    ]
  );
  return updateResult.rows[0] || null;
}

module.exports = {
  formatForResponse,
  getCurrent,
  upsertCurrent,
};
