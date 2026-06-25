const { query } = require('../db');

function formatForResponse(row) {
  if (!row) return null;

  return {
    id: row.id,
    message: row.message,
    type: row.type,
    is_active: row.is_active,
    sort_order: row.sort_order,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    metadata: row.metadata || {},
    created_by_admin_id: row.created_by_admin_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function create({ message, type, isActive, sortOrder, startsAt, endsAt, metadata, createdByAdminId }) {
  const result = await query(
    `INSERT INTO notices (
       message,
       type,
       is_active,
       sort_order,
       starts_at,
       ends_at,
       metadata,
       created_by_admin_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [message, type, isActive, sortOrder, startsAt, endsAt, metadata, createdByAdminId]
  );

  return formatForResponse(result.rows[0]);
}

async function listAll() {
  const result = await query(
    `SELECT *
     FROM notices
     ORDER BY is_active DESC, sort_order ASC, id DESC`
  );

  return result.rows.map(formatForResponse);
}

async function listActive(at = new Date()) {
  const result = await query(
    `SELECT *
     FROM notices
     WHERE is_active = true
       AND (starts_at IS NULL OR starts_at <= $1)
       AND (ends_at IS NULL OR ends_at >= $1)
     ORDER BY sort_order ASC, id DESC`,
    [at]
  );

  return result.rows.map(formatForResponse);
}

async function findById(id) {
  const result = await query(
    `SELECT *
     FROM notices
     WHERE id = $1`,
    [id]
  );

  return formatForResponse(result.rows[0] || null);
}

async function updateById(id, { message, type, isActive, sortOrder, startsAt, endsAt, metadata }) {
  const result = await query(
    `UPDATE notices
     SET message = $2,
         type = $3,
         is_active = $4,
         sort_order = $5,
         starts_at = $6,
         ends_at = $7,
         metadata = $8,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, message, type, isActive, sortOrder, startsAt, endsAt, metadata]
  );

  return formatForResponse(result.rows[0] || null);
}

async function deleteById(id) {
  const result = await query(
    `DELETE FROM notices
     WHERE id = $1
     RETURNING id`,
    [id]
  );

  return result.rowCount > 0;
}

module.exports = {
  create,
  listAll,
  listActive,
  findById,
  updateById,
  deleteById,
};