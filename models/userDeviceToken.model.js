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

module.exports = {
  upsertToken,
  deactivateToken,
  deactivateTokenByValue,
  listActiveByUserId,
};
