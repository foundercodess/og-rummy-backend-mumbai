const { query } = require('../db');

const STATUS = { REQ: 'req', ACTIVE: 'active', DEACTIVE: 'deactive' };

async function create({ phone, deviceInfo, ip, userAgent }) {
  const result = await query(
    `INSERT INTO login_attempts (phone, status, device_info, ip, user_agent, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING id, phone, status, device_info, ip, user_agent, session_id, created_at`,
    [phone, STATUS.REQ, deviceInfo || null, ip || null, userAgent || null]
  );
  return result.rows[0];
}

async function findById(id) {
  const result = await query(
    'SELECT * FROM login_attempts WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

async function findByIdAndPhone(id, phone) {
  const result = await query(
    'SELECT * FROM login_attempts WHERE id = $1 AND phone = $2',
    [id, phone]
  );
  return result.rows[0] || null;
}

/** Deactivate all active sessions for this user (for one-session-per-user). */
async function deactivateActiveByUserId(userId) {
  const result = await query(
    `UPDATE login_attempts
     SET status = $1, updated_at = NOW()
     WHERE user_id = $2
       AND status = $3
     RETURNING id, user_id, phone, status, session_id, device_info, ip, user_agent, updated_at, created_at`,
    [STATUS.DEACTIVE, userId, STATUS.ACTIVE]
  );
  return result.rows || [];
}

/**
 * Promote a request attempt to active session. Deactivates any other active session for this user.
 * Returns the updated row.
 */
async function promoteToActive(attemptId, userId, sessionId) {
  await query('BEGIN');
  try {
    const replacedSessions = await deactivateActiveByUserId(userId);
    const result = await query(
      `UPDATE login_attempts
       SET user_id = $1, status = $2, session_id = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING id, user_id, phone, status, session_id, created_at`,
      [userId, STATUS.ACTIVE, sessionId, attemptId]
    );
    await query('COMMIT');
    return {
      attempt: result.rows[0] || null,
      replacedSessions,
    };
  } catch (e) {
    await query('ROLLBACK');
    throw e;
  }
}

/**
 * Create a new active session (when request_id not provided). Deactivates other active for user.
 */
async function createActiveSession({ userId, phone, deviceInfo, ip, userAgent, sessionId }) {
  await query('BEGIN');
  try {
    const replacedSessions = await deactivateActiveByUserId(userId);
    const result = await query(
    `INSERT INTO login_attempts (user_id, phone, status, device_info, ip, user_agent, session_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     RETURNING id, user_id, phone, status, session_id, created_at`,
    [userId, phone, STATUS.ACTIVE, deviceInfo || null, ip || null, userAgent || null, sessionId]
    );
    await query('COMMIT');
    return {
      attempt: result.rows[0] || null,
      replacedSessions,
    };
  } catch (e) {
    await query('ROLLBACK');
    throw e;
  }
}

async function findActiveBySessionId(sessionId) {
  const result = await query(
    'SELECT * FROM login_attempts WHERE session_id = $1 AND status = $2',
    [sessionId, STATUS.ACTIVE]
  );
  return result.rows[0] || null;
}

async function deactivateBySessionId(sessionId) {
  const result = await query(
    `UPDATE login_attempts SET status = $1, updated_at = NOW() WHERE session_id = $2 AND status = $3 RETURNING id`,
    [STATUS.DEACTIVE, sessionId, STATUS.ACTIVE]
  );
  return result.rowCount > 0;
}

module.exports = {
  STATUS,
  create,
  findById,
  findByIdAndPhone,
  promoteToActive,
  createActiveSession,
  findActiveBySessionId,
  deactivateBySessionId,
};
