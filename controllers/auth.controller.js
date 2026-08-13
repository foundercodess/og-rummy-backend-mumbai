const authService = require('../services/auth.service');
const userService = require('../services/user.service');
const socketRegistry = require('../realtime/socketRegistry');
const { getSocketIO } = require('../realtime/socketBus');
const SESSION_REPLACED_DISCONNECT_DELAY_MS = Math.max(
  0,
  Number(process.env.SESSION_REPLACED_DISCONNECT_DELAY_MS) || 150
);

function delay(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, safeMs));
}

async function sendOtp(req, res) {
  try {
    const { phone, device_info: deviceInfo } = req.body;
    const normalizedPhone = authService.normalizePhone(phone || '');
    if (!phone || normalizedPhone.length < 10) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit phone required' });
    }

    const { otp, expiresAt, login_attempt_id } = await authService.sendOtp(phone, deviceInfo, req);
    console.log('deviceInfo', deviceInfo);
    if (process.env.NODE_ENV === 'development') {
      console.log(`[DEV] OTP for ${normalizedPhone}: ${otp}`);
    }

    res.json({
      success: true,
      message: 'OTP sent successfully',
      login_attempt_id,
      ...(process.env.NODE_ENV === 'development' && { devOtp: otp }),
    });
  } catch (err) {
    console.error('sendOtp error:', err);
    if (err.message === 'INVALID_PHONE') {
      return res.status(400).json({ success: false, message: 'Valid phone required' });
    }
    if (err.message === 'USER_BLOCKED') {
      return res.status(403).json({ success: false, message: "User has been blocked by admin and can't proceed with OTP verification" });
    }
    if (err.code === 'OTP_PROVIDER_INVALID_INPUTS') {
      return res.status(400).json({ success: false, message: err.message });
    }
    if (err.code === 'OTP_PROVIDER_LIMIT_EXHAUSTED') {
      return res.status(429).json({
        success: false,
        message: err.message,
        ...(typeof err.remaining === 'number' && { remaining: err.remaining }),
      });
    }
    if (err.code === 'OTP_PROVIDER_INVALID_KEY' || err.code === 'OTP_PROVIDER_ACCOUNT_INACTIVE') {
      return res.status(502).json({ success: false, message: err.message });
    }
    if (
      err.code === 'OTP_PROVIDER_NOT_CONFIGURED' ||
      err.code === 'OTP_PROVIDER_UNAVAILABLE' ||
      err.code === 'OTP_PROVIDER_INVALID_RESPONSE' ||
      err.code === 'OTP_PROVIDER_ERROR'
    ) {
      return res.status(502).json({ success: false, message: 'OTP service is currently unavailable' });
    }
    res.status(500).json({ success: false, message: 'Failed to send OTP' });
  }
}

async function verifyOtp(req, res) {
  try {
    const { phone, otp, login_attempt_id: requestId } = req.body;
    if (!phone || !otp) {
      return res.status(400).json({ success: false, message: 'Phone and OTP required' });
    }

    const result = await authService.verifyOtp(phone, otp, requestId, req);

    const io = getSocketIO();
    const replacedSessions = Array.isArray(result.replaced_sessions) ? result.replaced_sessions : [];
    if (io && replacedSessions.length > 0) {
      const socketIds = socketRegistry.getSocketIds(result.user?.id);
      const replacedSessionIds = new Set(
        replacedSessions
          .map((session) => String(session?.session_id || '').trim())
          .filter(Boolean)
      );
      const replacementPayload = {
        event: 'auth:session_replaced',
        server_time: new Date().toISOString(),
        message: 'Your account was logged in on another device. Please login again.',
        logged_out_reason: 'session_replaced',
        new_session_id: result.session_id || null,
        new_device: result.login_context || null,
        replaced_sessions: replacedSessions.map((session) => ({
          session_id: session.session_id,
          device_info: session.device_info || null,
          ip: session.ip || null,
          user_agent: session.user_agent || null,
          logged_out_at: session.updated_at || null,
        })),
      };

      const staleSockets = [];
      socketIds.forEach((socketId) => {
        const sock = io?.sockets?.sockets?.get(socketId);
        if (!sock) return;
        const socketSessionId = String(sock?.user?.sessionId || '').trim();
        if (!socketSessionId || !replacedSessionIds.has(socketSessionId)) return;
        sock.emit('auth:session_replaced', replacementPayload);
        staleSockets.push(sock);
      });

      if (staleSockets.length > 0) {
        if (SESSION_REPLACED_DISCONNECT_DELAY_MS > 0) {
          await delay(SESSION_REPLACED_DISCONNECT_DELAY_MS);
        }
        staleSockets.forEach((sock) => {
          try {
            if (sock.connected) {
              sock.disconnect(true);
            }
          } catch (disconnectErr) {
            console.error('[AUTH] Failed to disconnect replaced-session socket:', disconnectErr.message);
          }
        });
      }
    }

    res.json({
      success: true,
      message: 'OTP verified successfully',
      user: result.user,
      token: result.token,
      expires_in: result.expiresIn,
      login_attempt_id: result.login_attempt_id,
      session_id: result.session_id || null,
    });
  } catch (err) {
    console.error('verifyOtp error:', err);
    if (err.message === 'USER_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (err.message === 'USER_BLOCKED') {
      return res.status(403).json({ success: false, message: "User has been blocked by admin and can't proceed with OTP verification" });
    }
    if (err.message === 'INVALID_OTP') {
      return res.status(400).json({ success: false, message: 'Invalid OTP' });
    }
    if (err.message === 'OTP_EXPIRED') {
      return res.status(400).json({ success: false, message: 'OTP expired' });
    }
    if (err.message === 'INVALID_REQUEST_ID' || err.message === 'REQUEST_ALREADY_USED') {
      return res.status(400).json({ success: false, message: err.message === 'INVALID_REQUEST_ID' ? 'Invalid or mismatched request_id' : 'This OTP request was already used' });
    }
    res.status(500).json({ success: false, message: 'Failed to verify OTP' });
  }
}

async function logout(req, res) {
  try {
    const sessionId = req.sessionId;
    if (!sessionId) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    const deactivated = await authService.logout(sessionId);
    res.json({
      success: true,
      message: deactivated ? 'Logged out successfully' : 'Session already invalid',
    });
  } catch (err) {
    console.error('logout error:', err);
    res.status(500).json({ success: false, message: 'Failed to logout' });
  }
}

async function adminLogin(req, res) {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }

    const result = await authService.adminLogin(email, password);

    return res.json({
      success: true,
      message: 'Admin login successful',
      admin: result.admin,
      token: result.token,
      expires_in: result.expiresIn,
    });
  } catch (err) {
    console.error('adminLogin error:', err);
    if (err.message === 'INVALID_ADMIN_CREDENTIALS') {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }
    if (err.message === 'ADMIN_ROLE_INACTIVE') {
      return res.status(403).json({ success: false, message: 'Admin role is inactive. Contact an owner.' });
    }
    if (err.message === 'ADMIN_RBAC_UNAVAILABLE') {
      return res.status(503).json({
        success: false,
        message: 'Admin access setup incomplete. Run RBAC migration and restart API.',
      });
    }
    return res.status(500).json({ success: false, message: 'Failed to login admin' });
  }
}

async function adminMe(req, res) {
  try {
    const admin = req.admin;
    if (!admin) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    return res.json({
      success: true,
      message: 'Admin authenticated',
      admin: {
        id: admin.id,
        email: admin.email,
        role: admin.role?.code,
        role_id: admin.role?.id,
        role_name: admin.role?.name,
        level: admin.role?.level,
        is_root: admin.is_root === true,
        permissions: admin.permissions || [],
      },
    });
  } catch (err) {
    console.error('adminMe error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch admin profile' });
  }
}

module.exports = {
  sendOtp,
  verifyOtp,
  logout,
  adminLogin,
  adminMe,
};
