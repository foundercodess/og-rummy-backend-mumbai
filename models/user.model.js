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

/**
 * Paginated admin user list with live play + stale lobby flags.
 * Stale = seated in waiting/ready non-practice lobby with no activity for staleAfterHours (default 2h).
 */
async function getAllPaginated({ page = 1, limit = 20, last7days = false, staleAfterHours = 2 } = {}) {
  const offset = (page - 1) * limit;
  const staleHours = Number.isInteger(Number(staleAfterHours)) && Number(staleAfterHours) > 0
    ? Number(staleAfterHours)
    : 2;
  const condition = last7days ? `WHERE u.created_at >= NOW() - INTERVAL '7 days'` : '';

  const countResult = await query(`SELECT COUNT(*) FROM users u ${condition}`);
  const total = parseInt(countResult.rows[0].count, 10);

  const result = await query(
    `SELECT
       u.id,
       u.name,
       u.phone,
       u.avatar,
       u.view_id,
       u.is_verified,
       u.active,
       u.created_at,
       u.updated_at,
       COALESCE(play.is_playing, false) AS is_playing,
       play.session_status,
       play.player_status,
       play.session_updated_at,
       CASE
         WHEN play.session_id IS NULL THEN 'none'
         WHEN play.session_status IN ('waiting', 'ready')
           AND play.session_updated_at < NOW() - ($3::int * INTERVAL '1 hour')
           THEN 'stale'
         WHEN play.player_status = 'disconnected' THEN 'disconnected'
         ELSE 'ok'
       END AS stale_status
     FROM users u
     LEFT JOIN LATERAL (
       SELECT
         gs.id AS session_id,
         gs.status AS session_status,
         gs.updated_at AS session_updated_at,
         gsp.status AS player_status,
         true AS is_playing
       FROM game_session_players gsp
       INNER JOIN game_sessions gs ON gs.id = gsp.game_session_id
       WHERE gsp.user_id = u.id
         AND gsp.status IN ('joined', 'disconnected')
         AND gs.status IN ('waiting', 'ready', 'active')
         AND COALESCE((gs.metadata->>'practice_mode')::boolean, false) = false
         AND COALESCE((gs.metadata->>'practice_bot_only')::boolean, false) = false
         AND COALESCE((gsp.metadata->>'is_bot')::boolean, false) = false
       ORDER BY
         CASE gs.status WHEN 'active' THEN 0 WHEN 'ready' THEN 1 ELSE 2 END,
         gs.updated_at DESC
       LIMIT 1
     ) play ON true
     ${condition}
     ORDER BY u.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset, staleHours]
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
