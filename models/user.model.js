const { query } = require('../db');

/** SQL fragment: only human accounts (admin lists / dashboard user counts). */
const HUMAN_USERS_WHERE = 'COALESCE(u.is_bot, false) = false';

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
 * Paginated admin user list with live play + activity timestamps.
 * - onboard_at: registration time (users.created_at)
 * - last_gameplay_at: last real-money table join or completed session
 * - last_activity_at: last socket connection (users.last_socket_at)
 * - last_successful_withdrawal_at: latest successful withdrawal completed time
 * - inactiveGameplayDays: users with no real-money play within N days (null/never = included)
 */
async function getAllPaginated({
  page = 1,
  limit = 20,
  last7days = false,
  inactiveGameplayDays = null,
} = {}) {
  const offset = (page - 1) * limit;
  const inactiveDays = Number(inactiveGameplayDays);
  const useInactiveFilter = Number.isFinite(inactiveDays) && inactiveDays > 0;

  const conditions = [HUMAN_USERS_WHERE];
  if (last7days) {
    conditions.push(`u.created_at >= NOW() - INTERVAL '7 days'`);
  }
  if (useInactiveFilter) {
    // No real-money play/join in the last N days (includes never played).
    conditions.push(`(
      gameplay.last_gameplay_at IS NULL
      OR gameplay.last_gameplay_at < NOW() - ($3::int * INTERVAL '1 day')
    )`);
  }
  const condition = `WHERE ${conditions.join(' AND ')}`;

  const gameplayLateral = `
     LEFT JOIN LATERAL (
       SELECT GREATEST(
         (
           SELECT MAX(gsp.joined_at)
           FROM game_session_players gsp
           INNER JOIN game_sessions gs ON gs.id = gsp.game_session_id
           WHERE gsp.user_id = u.id
             AND COALESCE((gs.metadata->>'practice_mode')::boolean, false) = false
             AND COALESCE((gs.metadata->>'practice_bot_only')::boolean, false) = false
             AND COALESCE((gsp.metadata->>'is_bot')::boolean, false) = false
         ),
         (
           SELECT MAX(COALESCE(gs.ended_at, gs.updated_at, gs.created_at))
           FROM game_session_players gsp
           INNER JOIN game_sessions gs ON gs.id = gsp.game_session_id
           WHERE gsp.user_id = u.id
             AND gs.status = 'completed'
             AND COALESCE((gs.metadata->>'practice_mode')::boolean, false) = false
             AND COALESCE((gs.metadata->>'practice_bot_only')::boolean, false) = false
             AND COALESCE((gsp.metadata->>'is_bot')::boolean, false) = false
         )
       ) AS last_gameplay_at
     ) gameplay ON true`;

  let total;
  if (useInactiveFilter) {
    const countCondition = condition.replace('$3::int', '$1::int');
    const countResult = await query(
      `SELECT COUNT(*) FROM users u ${gameplayLateral} ${countCondition}`,
      [inactiveDays]
    );
    total = parseInt(countResult.rows[0].count, 10);
  } else {
    const countResult = await query(`SELECT COUNT(*) FROM users u ${condition}`);
    total = parseInt(countResult.rows[0].count, 10);
  }

  const listParams = useInactiveFilter ? [limit, offset, inactiveDays] : [limit, offset];

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
       u.created_at AS onboard_at,
       u.updated_at,
       u.last_socket_at,
       COALESCE(play.is_playing, false) AS is_playing,
       play.session_status,
       play.player_status,
       gameplay.last_gameplay_at,
       u.last_socket_at AS last_activity_at,
       wd.last_successful_withdrawal_at
     FROM users u
     LEFT JOIN LATERAL (
       SELECT
         gs.status AS session_status,
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
     ${gameplayLateral}
     LEFT JOIN LATERAL (
       SELECT MAX(COALESCE(wt.completed_at, wt.updated_at, wt.created_at)) AS last_successful_withdrawal_at
       FROM withdrawal_transactions wt
       WHERE wt.user_id = u.id
         AND wt.status = 'successful'
     ) wd ON true
     ${condition}
     ORDER BY u.created_at DESC
     LIMIT $1 OFFSET $2`,
    listParams
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

/** Exact name match for humans only (case-insensitive). Used for admin wallet credit lookup. */
async function findHumansByExactName(name) {
  const normalized = name == null ? '' : String(name).trim();
  if (!normalized) return [];
  const result = await query(
    `SELECT *
     FROM users u
     WHERE ${HUMAN_USERS_WHERE}
       AND u.name IS NOT NULL
       AND LOWER(TRIM(u.name)) = LOWER($1)
     ORDER BY u.id ASC
     LIMIT 11`,
    [normalized]
  );
  return result.rows;
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

async function markAsBot(userId) {
  const result = await query(
    `UPDATE users
     SET is_bot = true,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id`,
    [userId]
  );
  return result.rows[0] || null;
}

/** Fire-and-forget friendly: mark last realtime socket connection time. */
async function touchLastSocketAt(userId) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) return null;
  const result = await query(
    `UPDATE users
     SET last_socket_at = NOW()
     WHERE id = $1
     RETURNING id, last_socket_at`,
    [uid]
  );
  return result.rows[0] || null;
}

module.exports = {
  HUMAN_USERS_WHERE,
  findById,
  findByViewId,
  findHumansByExactName,
  getAll,
  getAllPaginated,
  findByPhone,
  viewIdExists,
  upsertOtp,
  verifyOtpAndMarkVerified,
  create,
  updateProfile,
  updateActiveStatus,
  markAsBot,
  touchLastSocketAt,
};
