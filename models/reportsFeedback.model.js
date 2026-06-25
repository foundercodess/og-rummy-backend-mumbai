const { query } = require('../db');

function formatForResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    type: row.type,
    feedback_content: row.feedback_content,
    picture_urls: row.picture_urls || [],
    phone: row.phone,
    status: row.status,
    admin_notes: row.admin_notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function create({ userId, type, feedbackContent, pictureUrls = [], phone = null }) {
  const result = await query(
    `INSERT INTO reports_feedback (
       user_id, type, feedback_content, picture_urls, phone, status
     ) VALUES ($1, $2, $3, $4, $5, 'open')
     RETURNING *`,
    [userId, type, feedbackContent, pictureUrls, phone || null]
  );
  return result.rows[0] || null;
}

async function listByUserId({ userId, limit = 50, offset = 0, type = null }) {
  const safeLimit = Number.isNaN(Number(limit)) ? 50 : Math.min(Number(limit), 100);
  const safeOffset = Number.isNaN(Number(offset)) ? 0 : Math.max(Number(offset), 0);

  const params = [userId];
  const where = ['user_id = $1'];
  let idx = 2;

  if (type) {
    where.push(`type = $${idx++}`);
    params.push(type);
  }

  params.push(safeLimit, safeOffset);

  const result = await query(
    `SELECT * FROM reports_feedback
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return result.rows.map(formatForResponse);
}

module.exports = {
  formatForResponse,
  create,
  listByUserId,
};

