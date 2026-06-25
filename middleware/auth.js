const authService = require('../services/auth.service');
const loginAttemptModel = require('../models/loginAttempt.model');
const userModel = require('../models/user.model');

/**
 * Require valid Bearer JWT and active session (one-session-per-user).
 * Sets req.user = { id: userId } on success; sends 401 otherwise.
 */
async function requireAuth(req, res, next) {
  const authHeader = req.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Authorization required. Send Bearer token in Authorization header.',
    });
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return res.status(401).json({ success: false, message: 'Invalid or missing token.' });
  }

  const payload = authService.verifyToken(token);
  if (!payload || !payload.userId || !payload.sessionId) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }

  const session = await loginAttemptModel.findActiveBySessionId(payload.sessionId);
  if (!session || session.user_id !== payload.userId) {
    return res.status(401).json({
      success: false,
      message: 'Session invalid or logged out from another device.',
    });
  }

  const user = await userModel.findById(payload.userId);
  if (!user) {
    return res.status(401).json({ success: false, message: 'User not found.' });
  }
  if (user.active === false) {
    return res.status(403).json({ success: false, message: 'Account is deactivated. Contact support.' });
  }

  req.user = { id: payload.userId };
  req.sessionId = payload.sessionId;
  next();
}

function requireRole(allowedRoles = []) {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return (req, res, next) => {
    const authHeader = req.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Authorization required.' });
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      return res.status(401).json({ success: false, message: 'Invalid or missing token.' });
    }

    const payload = authService.verifyToken(token);
    if (!payload || !payload.role) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
    }

    if (roles.length > 0 && !roles.includes(payload.role)) {
      return res.status(403).json({ success: false, message: 'Forbidden: insufficient role.' });
    }

    req.auth = payload;
    next();
  };
}

const requireAdmin = requireRole(['admin', 'super_admin']);

module.exports = { requireAuth, requireRole, requireAdmin };
