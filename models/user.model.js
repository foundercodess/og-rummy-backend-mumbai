const { query } = require('../db');

async function findById(id) {
  const result = await query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function getAll() {
  const result = await query(
    'SELECT id, name, phone, avatar, view_id, is_verified, active, created_at, updated_at FROM users ORDER BY id ASC'
  );
  return result.rows;
}

async function getAllPaginated({ page = 1, limit = 20, last7days = false } = {}) {
  const offset = (page - 1) * limit;
  const condition = last7days ? `WHERE created_at >= NOW() - INTERVAL '7 days'` : '';

  const countResult = await query(`SELECT COUNT(*) FROM users ${condition}`);
  const total = parseInt(countResult.rows[0].count, 10);

  const result = await query(
    `SELECT id, name, phone, avatar, view_id, is_verified, active, created_at, updated_at FROM users ${condition} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return { users: result.rows, total };
}

async function findByPhone(phone) {
  const result = await query('SELECT * FROM users WHERE phone = $1', [phone]);
  return result.rows[0] || null;
}

async function updateProfile(userId, { name, avatar }) {
  const updates = ['updated_at = NOW()'];
  const params = [];
  let paramIndex = 1;

  if (name != null && String(name).trim() !== '') {
    updates.push(`name = $${paramIndex++}`);
    params.push(String(name).trim());
  }
  if (avatar != null && String(avatar).trim() !== '') {
    updates.push(`avatar = $${paramIndex++}`);
    params.push(String(avatar).trim());
  }

  if (params.length === 0) {
    const user = await findById(userId);
    return user;
  }

  params.push(userId);
  const result = await query(
    `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    params
  );
  return result.rows[0] || null;
}

async function upsertOtp(phone, otp, expiresAt) {
  await query(
    `INSERT INTO users (phone, otp, otp_expires_at, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (phone)
     DO UPDATE SET otp = $2, otp_expires_at = $3, updated_at = NOW()`,
    [phone, otp, expiresAt]
  );
}

async function viewIdExists(viewId) {
  const result = await query('SELECT 1 FROM users WHERE view_id = $1', [viewId]);
  return result.rows.length > 0;
}

async function findByViewId(viewId) {
  const normalized = viewId == null ? '' : String(viewId).trim();
  if (!normalized) return null;
  const result = await query('SELECT * FROM users WHERE view_id = $1', [normalized]);
  return result.rows[0] || null;
}

async function verifyOtpAndMarkVerified(phone, name = null, viewId = null, avatar = null) {
  const updates = ['otp = NULL', 'otp_expires_at = NULL', 'is_verified = TRUE', 'updated_at = NOW()'];
  const params = [phone];
  let paramIndex = 2;

  if (name !== null && name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    params.push(name);
  }
  if (viewId !== null && viewId !== undefined) {
    updates.push(`view_id = $${paramIndex++}`);
    params.push(viewId);
  }
  if (avatar !== null && avatar !== undefined && String(avatar).trim() !== '') {
    updates.push(`avatar = $${paramIndex++}`);
    params.push(String(avatar).trim());
  }

  await query(
    `UPDATE users SET ${updates.join(', ')} WHERE phone = $1`,
    params
  );
}

async function create(phone) {
  const result = await query(
    `INSERT INTO users (phone) VALUES ($1)
     ON CONFLICT (phone) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [phone]
  );
  return result.rows[0];
}

async function updateActiveStatus(userId, active) {
  const result = await query(
    `UPDATE users
     SET active = $2,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, phone, active, updated_at`,
    [userId, active]
  );
  return result.rows[0] || null;
}

module.exports = {
  findById,
  findByViewId,
  getAll,
  getAllPaginated,
  findByPhone,
  viewIdExists,
  upsertOtp,
  verifyOtpAndMarkVerified,
  create,
  updateProfile,
  updateActiveStatus,
};
