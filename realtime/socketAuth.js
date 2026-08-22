const authService = require('../services/auth.service');
const loginAttemptModel = require('../models/loginAttempt.model');
const userModel = require('../models/user.model');
const requestContext = require('../services/requestContext.service');

async function socketAuth(socket, next) {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token
      ? String(socket.handshake.auth.token).trim()
      : socket.handshake.headers.authorization && socket.handshake.headers.authorization.startsWith('Bearer ')
        ? socket.handshake.headers.authorization.slice(7).trim()
        : '';

    if (!token) {
      return next(new Error('Authorization token required'));
    }

    const payload = authService.verifyToken(token);
    if (!payload || !payload.userId || !payload.sessionId) {
      return next(new Error('Invalid or expired token'));
    }

    // login_attempts / users reads must use the auth pool when DB_POOL_SPLIT=true
    // so handshake bursts do not steal gameplay connections from pick/discard.
    await requestContext.run({ db_pool: 'auth', event_name: 'socket:auth' }, async () => {
      const activeSession = await loginAttemptModel.findActiveBySessionId(payload.sessionId);
      if (!activeSession || activeSession.user_id !== payload.userId) {
        throw new Error('Session invalid or logged out');
      }

      const user = await userModel.findById(payload.userId);
      if (!user || user.active === false) {
        throw new Error('User not allowed');
      }

      socket.user = {
        id: payload.userId,
        sessionId: payload.sessionId,
        role: payload.role || 'user',
        name: user.name,
        avatar: user.avatar,
        viewId: user.view_id,
      };
    });

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { socketAuth };
