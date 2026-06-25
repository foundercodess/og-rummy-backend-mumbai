const { query } = require('../db');

function formatForResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    content: row.content,
    type: row.type,
    is_read: row.is_read,
    read_at: row.read_at,
    metadata: row.metadata,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function create({ userId, title, content, type = 'system', metadata = null }) {
  const result = await query(
    `INSERT INTO notifications (user_id, title, content, type, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, title, content, type, metadata]
  );
  return formatForResponse(result.rows[0]);
}

async function listByUserId({ userId, limit = 50, offset = 0 }) {
  const result = await query(
    `SELECT * FROM notifications
     WHERE user_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return result.rows.map(formatForResponse);
}

async function countUnreadByUserId(userId) {
  const result = await query(
    'SELECT COUNT(*)::INT AS count FROM notifications WHERE user_id = $1 AND is_read = false',
    [userId]
  );
  return result.rows[0]?.count ?? 0;
}

async function markReadById({ userId, id }) {
  const result = await query(
    `UPDATE notifications
     SET is_read = true,
         read_at = COALESCE(read_at, NOW()),
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [id, userId]
  );
  return formatForResponse(result.rows[0] || null);
}

async function markAllReadByUserId(userId) {
  const result = await query(
    `UPDATE notifications
     SET is_read = true,
         read_at = COALESCE(read_at, NOW()),
         updated_at = NOW()
     WHERE user_id = $1 AND is_read = false
     RETURNING *`,
    [userId]
  );
  return result.rows.map(formatForResponse);
}

async function deleteById({ userId, id }) {
  const result = await query(
    `DELETE FROM notifications
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [id, userId]
  );
  return result.rowCount > 0;
}

async function deleteAllByUserId(userId) {
  const result = await query(
    `DELETE FROM notifications
     WHERE user_id = $1`,
    [userId]
  );
  return result.rowCount;
}

module.exports = {
  formatForResponse,
  create,
  listByUserId,
  countUnreadByUserId,
  markReadById,
  markAllReadByUserId,
  deleteById,
  deleteAllByUserId,
};

