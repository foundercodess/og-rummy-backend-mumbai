const { query } = require('../db');

async function upsertToken({
  userId,
  fcmToken,
  platform = null,
  deviceId = null,
  appVersion = null,
}) {
  const result = await query(
    `INSERT INTO user_device_tokens (
       user_id, fcm_token, platform, device_id, app_version, active, last_seen_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, true, NOW(), NOW())
     ON CONFLICT (fcm_token) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           platform = COALESCE(EXCLUDED.platform, user_device_tokens.platform),
           device_id = COALESCE(EXCLUDED.device_id, user_device_tokens.device_id),
           app_version = COALESCE(EXCLUDED.app_version, user_device_tokens.app_version),
           active = true,
           last_seen_at = NOW(),
           updated_at = NOW()
     RETURNING *`,
    [userId, fcmToken, platform, deviceId, appVersion]
  );
  return result.rows[0] || null;
}

async function deactivateToken({ userId, fcmToken }) {
  const result = await query(
    `UPDATE user_device_tokens
     SET active = false, updated_at = NOW()
     WHERE user_id = $1 AND fcm_token = $2
     RETURNING id`,
    [userId, fcmToken]
  );
  return result.rowCount > 0;
}

async function deactivateTokenByValue(fcmToken) {
  if (!fcmToken) return 0;
  const result = await query(
    `UPDATE user_device_tokens
     SET active = false, updated_at = NOW()
     WHERE fcm_token = $1`,
    [fcmToken]
  );
  return result.rowCount;
}

async function listActiveByUserId(userId) {
  const result = await query(
    `SELECT fcm_token, platform, device_id
     FROM user_device_tokens
     WHERE user_id = $1 AND active = true
     ORDER BY last_seen_at DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * Page active FCM tokens for human users with no real-money play in N days.
 * Uses keyset pagination on token id for stable worker sweeps.
 */
async function listActiveTokensForInactiveGameplay({
  inactiveDays,
  afterId = 0,
  limit = 500,
} = {}) {
  const days = Number(inactiveDays);
  const lim = Math.min(Math.max(Number(limit) || 500, 1), 500);
  const cursor = Math.max(Number(afterId) || 0, 0);
  if (!Number.isFinite(days) || days <= 0) return [];

  const result = await query(
    `SELECT
       udt.id,
       udt.user_id,
       udt.fcm_token
     FROM user_device_tokens udt
     INNER JOIN users u ON u.id = udt.user_id
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
     ) gameplay ON true
     WHERE udt.active = true
       AND udt.id > $1
       AND COALESCE(u.is_bot, false) = false
       AND COALESCE(u.active, true) = true
       AND (
         gameplay.last_gameplay_at IS NULL
         OR gameplay.last_gameplay_at < NOW() - ($2::int * INTERVAL '1 day')
       )
     ORDER BY udt.id ASC
     LIMIT $3`,
    [cursor, days, lim]
  );
  return result.rows || [];
}

async function countUsersWithTokensForInactiveGameplay(inactiveDays) {
  const days = Number(inactiveDays);
  if (!Number.isFinite(days) || days <= 0) return 0;
  const result = await query(
    `SELECT COUNT(DISTINCT udt.user_id)::int AS count
     FROM user_device_tokens udt
     INNER JOIN users u ON u.id = udt.user_id
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
     ) gameplay ON true
     WHERE udt.active = true
       AND COALESCE(u.is_bot, false) = false
       AND COALESCE(u.active, true) = true
       AND (
         gameplay.last_gameplay_at IS NULL
         OR gameplay.last_gameplay_at < NOW() - ($1::int * INTERVAL '1 day')
       )`,
    [days]
  );
  return Number(result.rows[0]?.count) || 0;
}

module.exports = {
  upsertToken,
  deactivateToken,
  deactivateTokenByValue,
  listActiveByUserId,
  listActiveTokensForInactiveGameplay,
  countUsersWithTokensForInactiveGameplay,
};
