const { query } = require('../db');

function formatForResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    enabled: row.enabled === true,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function getCurrent() {
  const result = await query(
    `SELECT *
     FROM bot_injection_settings
     ORDER BY id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function upsertCurrent({ enabled, updatedBy = null }) {
  const existing = await getCurrent();
  if (!existing) {
    const insertResult = await query(
      `INSERT INTO bot_injection_settings (enabled, updated_by, updated_at)
       VALUES ($1, $2, NOW())
       RETURNING *`,
      [enabled, updatedBy]
    );
    return insertResult.rows[0] || null;
  }

  const updateResult = await query(
    `UPDATE bot_injection_settings
     SET enabled = $2,
         updated_by = $3,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [existing.id, enabled, updatedBy]
  );
  return updateResult.rows[0] || null;
}

module.exports = {
  formatForResponse,
  getCurrent,
  upsertCurrent,
};
