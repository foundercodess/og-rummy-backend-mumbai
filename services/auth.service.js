const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const userModel = require('../models/user.model');
const adminModel = require('../models/admin.model');
const userService = require('./user.service');
const loginAttemptModel = require('../models/loginAttempt.model');
const avatarModel = require('../models/avatar.model');
const walletModel = require('../models/wallet.model');
const notificationService = require('./notification.service');

const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
// const OTP_PROVIDER_URL = process.env.OTP_PROVIDER_URL || 'https://indopay.cloud/otp/newsend_otp.php';
// const OTP_MERCHANT_KEY = process.env.OTP_MERCHANT_KEY || '689744ecd79d75849010c9ebc13605eb122e943d7851f868';
// const OTP_DIGITS = String(Number(process.env.OTP_DIGITS) || 4);
const OTP_PROVIDER_URL = 'https://indopay.cloud/otp/newsend_otp.php';
const OTP_MERCHANT_KEY = '689744ecd79d75849010c9ebc13605eb122e943d7851f868';
const OTP_DIGITS = String(Number(4));
const OTP_EXPIRY_MINUTES = Math.max(1, Number(process.env.OTP_EXPIRY_MINUTES) || 10);

function generateRandomUsername() {
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes, (b) => ALPHANUMERIC[b % ALPHANUMERIC.length]).join('');
}

function generateSessionId() {
  return crypto.randomUUID && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
}

function hashPassword(plainPassword, salt) {
  return crypto.scryptSync(String(plainPassword || ''), String(salt || ''), 64).toString('hex');
}

function safeEqualHex(leftHex, rightHex) {
  if (!leftHex || !rightHex) return false;
  const left = Buffer.from(String(leftHex), 'hex');
  const right = Buffer.from(String(rightHex), 'hex');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function generateUniqueViewId() {
  const min = 100000;
  const max = 999999;
  const maxAttempts = 20;
  for (let i = 0; i < maxAttempts; i++) {
    const viewId = String(Math.floor(min + Math.random() * (max - min + 1)));
    const exists = await userModel.viewIdExists(viewId);
    if (!exists) return viewId;
  }
  throw new Error('Could not generate unique view_id');
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/** Normalize device_info from frontend: object or string -> JSON string for storage. */
function normalizeDeviceInfo(deviceInfo) {
  if (deviceInfo == null) return null;
  if (typeof deviceInfo === 'string') return deviceInfo.trim() || null;
  if (typeof deviceInfo === 'object') return JSON.stringify(deviceInfo);
  return null;
}

/** Extract IP and User-Agent from request. */
function getRequestContext(req) {
  const ip = (req && (req.ip || req.get('x-forwarded-for') || req.get('x-real-ip'))) || null;
  const userAgent = (req && req.get('user-agent')) || null;
  return { ip, userAgent };
}

function createOtpProviderError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

async function requestProviderOtp(phone) {
  if (!OTP_MERCHANT_KEY) {
    throw createOtpProviderError('OTP_PROVIDER_NOT_CONFIGURED', 'OTP provider key is not configured');
  }

  const url = new URL(OTP_PROVIDER_URL);
  url.searchParams.set('merchant_key', OTP_MERCHANT_KEY);
  url.searchParams.set('mobile_no', phone);
  url.searchParams.set('digit', OTP_DIGITS);

  let response;
  try {
    const requestOptions = { method: 'GET' };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      requestOptions.signal = AbortSignal.timeout(10000);
    }
    response = await fetch(url, requestOptions);
  } catch (error) {
    throw createOtpProviderError('OTP_PROVIDER_UNAVAILABLE', 'Unable to reach OTP provider', {
      cause: error,
    });
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw createOtpProviderError('OTP_PROVIDER_INVALID_RESPONSE', 'OTP provider returned an invalid response', {
      cause: error,
      httpStatus: response.status,
    });
  }

  if (!response.ok || payload.status !== 'success') {
    const providerCode = String(payload.error || response.status || 'UNKNOWN');
    const providerMessage = payload.msg || 'OTP provider request failed';
    switch (providerCode) {
      case '400':
        throw createOtpProviderError('OTP_PROVIDER_INVALID_INPUTS', providerMessage, { providerCode });
      case '401':
        throw createOtpProviderError('OTP_PROVIDER_INVALID_KEY', providerMessage, { providerCode });
      case '403':
        throw createOtpProviderError('OTP_PROVIDER_ACCOUNT_INACTIVE', providerMessage, { providerCode });
      case '429':
        throw createOtpProviderError('OTP_PROVIDER_LIMIT_EXHAUSTED', providerMessage, {
          providerCode,
          remaining: typeof payload.remaining === 'number' ? payload.remaining : Number(payload.remaining) || 0,
        });
      default:
        throw createOtpProviderError('OTP_PROVIDER_ERROR', providerMessage, {
          providerCode,
          httpStatus: response.status,
        });
    }
  }

  const otp = String(payload.otp || '').trim();
  if (!/^\d+$/.test(otp)) {
    throw createOtpProviderError('OTP_PROVIDER_INVALID_RESPONSE', 'OTP provider did not return a valid OTP', {
      payload,
    });
  }

  return {
    otp,
    providerResponse: payload,
  };
}

async function sendOtp(phone, deviceInfo, req) {
  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone.length < 10) throw new Error('INVALID_PHONE');

  const existingUser = await userModel.findByPhone(normalizedPhone);
  if (existingUser && existingUser.active === false) {
    throw new Error('USER_BLOCKED');
  }

  const { otp } = await requestProviderOtp(normalizedPhone);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
  await userModel.upsertOtp(normalizedPhone, otp, expiresAt);

  const { ip, userAgent } = getRequestContext(req);
  const deviceInfoStr = normalizeDeviceInfo(deviceInfo);
  const attempt = await loginAttemptModel.create({
    phone: normalizedPhone,
    deviceInfo: deviceInfoStr,
    ip,
    userAgent,
  });

  return { otp, expiresAt, login_attempt_id: attempt.id };
}

async function verifyOtp(phone, otp, requestId, req) {
  const normalizedPhone = normalizePhone(phone);
  const user = await userModel.findByPhone(normalizedPhone);

  if (!user) throw new Error('USER_NOT_FOUND');
  if (user.active === false) throw new Error('USER_BLOCKED');
  if (user.otp !== otp) throw new Error('INVALID_OTP');
  if (!user.otp_expires_at || new Date(user.otp_expires_at) < new Date()) {
    throw new Error('OTP_EXPIRED');
  }

  let name = user.name;
  let viewId = user.view_id;
  let avatar = user.avatar;
  const isNewUser = !name || name.trim() === '';
  if (!viewId || viewId.trim() === '') {
    viewId = await generateUniqueViewId();
  }
  if (!name || name.trim() === '') {
    name = generateRandomUsername();
    if (!avatar || avatar.trim() === '') {
      avatar = await avatarModel.getRandomAvatarUrl();
    }
    await userModel.verifyOtpAndMarkVerified(normalizedPhone, name, viewId, avatar);
  } else {
    await userModel.verifyOtpAndMarkVerified(normalizedPhone, null, viewId);
  }

  const userProfile = userService.formatProfile({
    ...user,
    name,
    avatar: avatar || user.avatar,
    view_id: viewId,
    is_verified: true,
  });

  // Ensure wallet exists for this user (creates if missing).
  const wallet = await walletModel.getOrCreateByUserId(user.id);

  // Create notification for new user or login
  try {
    if (isNewUser) {
      await notificationService.createNotification(user.id, {
        title: 'Welcome to OG Rummy',
        content: 'Your account has been created successfully. Start playing and enjoy!',
        type: 'welcome',
      });
    } else {
      await notificationService.createNotification(user.id, {
        title: 'Login successful',
        content: 'You have logged in to your OG Rummy account.',
        type: 'system',
      });
    }
  } catch (e) {
    console.error('createNotification on login error:', e);
  }

  const sessionId = generateSessionId();
  const { ip, userAgent } = getRequestContext(req);
  const requestBodyDeviceInfo = normalizeDeviceInfo(req && req.body && req.body.device_info);
  let activationOutcome;
  let sourceAttemptDeviceInfo = null;
  if (requestId != null && String(requestId).trim() !== '') {
    const attemptId = parseInt(requestId, 10);
    const attempt = await loginAttemptModel.findByIdAndPhone(attemptId, normalizedPhone);
    if (!attempt) throw new Error('INVALID_REQUEST_ID');
    if (attempt.status !== loginAttemptModel.STATUS.REQ) throw new Error('REQUEST_ALREADY_USED');
    sourceAttemptDeviceInfo = attempt.device_info || null;
    activationOutcome = await loginAttemptModel.promoteToActive(attemptId, user.id, sessionId);
  } else {
    sourceAttemptDeviceInfo = requestBodyDeviceInfo;
    activationOutcome = await loginAttemptModel.createActiveSession({
      userId: user.id,
      phone: normalizedPhone,
      deviceInfo: requestBodyDeviceInfo,
      ip,
      userAgent,
      sessionId,
    });
  }
  const attemptRow = activationOutcome?.attempt || null;
  const replacedSessions = Array.isArray(activationOutcome?.replacedSessions)
    ? activationOutcome.replacedSessions
    : [];
  const resolvedDeviceInfo = requestBodyDeviceInfo || sourceAttemptDeviceInfo || null;

  const token = jwt.sign(
    { userId: user.id, sessionId, role: 'user' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  const expiresInSeconds = typeof JWT_EXPIRES_IN === 'string' && JWT_EXPIRES_IN.endsWith('d')
    ? parseInt(JWT_EXPIRES_IN, 10) * 24 * 60 * 60
    : 7 * 24 * 60 * 60;
    console.log('resolvedDeviceInfo', resolvedDeviceInfo);
  return {
    user: userProfile,
    token,
    expiresIn: expiresInSeconds,
    login_attempt_id: attemptRow ? attemptRow.id : null,
    session_id: sessionId,
    replaced_sessions: replacedSessions,
    login_context: {
      device_info: resolvedDeviceInfo,
      ip,
      user_agent: userAgent,
      logged_in_at: new Date().toISOString(),
    },
  };
}

async function adminLogin(email, password) {
  const admin = await adminModel.findByEmail(email);
  if (!admin || !admin.active) {
    throw new Error('INVALID_ADMIN_CREDENTIALS');
  } 

  const computed = hashPassword(password, admin.password_salt);
  const matches = safeEqualHex(admin.password_hash, computed);
  if (!matches) {
    throw new Error('INVALID_ADMIN_CREDENTIALS');
  }

  const token = jwt.sign(
    { adminId: admin.id, role: admin.role || 'admin' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  const expiresInSeconds = typeof JWT_EXPIRES_IN === 'string' && JWT_EXPIRES_IN.endsWith('d')
    ? parseInt(JWT_EXPIRES_IN, 10) * 24 * 60 * 60
    : 7 * 24 * 60 * 60;

  return {
    admin: {
      id: admin.id,
      email: admin.email,
      role: admin.role,
    },
    token,
    expiresIn: expiresInSeconds,
  };
}

function verifyToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload;
  } catch {
    return null;
  }
}

async function logout(sessionId) {
  return loginAttemptModel.deactivateBySessionId(sessionId);
}

module.exports = {
  JWT_SECRET,
  JWT_EXPIRES_IN,
  sendOtp,
  verifyOtp,
  adminLogin,
  verifyToken,
  logout,
  normalizePhone,
  normalizeDeviceInfo,
  getRequestContext,
};
