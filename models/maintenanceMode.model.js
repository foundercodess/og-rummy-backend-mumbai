const { query } = require('../db');

function formatForResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    enabled: row.enabled === true,
    title: row.title || null,
    message: row.message || null,
    start_at: row.start_at || null,
    end_at: row.end_at || null,
    metadata: row.metadata || {},
    updated_by: row.updated_by || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function getCurrent() {
  const result = await query(
    `SELECT *
     FROM maintenance_modes
     ORDER BY id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function upsertCurrent({
  enabled,
  title,
  message,
  startAt = null,
  endAt = null,
  metadata = {},
  updatedBy = null,
}) {
  const existing = await getCurrent();
  if (!existing) {
    const insertResult = await query(
      `INSERT INTO maintenance_modes (
         enabled, title, message, start_at, end_at, metadata, updated_by, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW())
       RETURNING *`,
      [enabled, title, message, startAt, endAt, JSON.stringify(metadata || {}), updatedBy]
    );
    return insertResult.rows[0] || null;
  }

  const updateResult = await query(
    `UPDATE maintenance_modes
     SET enabled = $2,
         title = $3,
         message = $4,
         start_at = $5,
         end_at = $6,
         metadata = $7::jsonb,
         updated_by = $8,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [existing.id, enabled, title, message, startAt, endAt, JSON.stringify(metadata || {}), updatedBy]
  );
  return updateResult.rows[0] || null;
}

module.exports = {
  formatForResponse,
  getCurrent,
  upsertCurrent,
};
