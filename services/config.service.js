const avatarModel = require('../models/avatar.model');
const stateModel = require('../models/state.model');
const addCashOptionModel = require('../models/addCashOption.model');
const withdrawOptionModel = require('../models/withdrawOption.model');
const faqModel = require('../models/faq.model');
const supportLinkModel = require('../models/supportLink.model');
const maintenanceModeModel = require('../models/maintenanceMode.model');
const appUpdateConfigModel = require('../models/appUpdateConfig.model');
const walletService = require('./wallet.service');
const authService = require('./auth.service');
const loginAttemptModel = require('../models/loginAttempt.model');
const userModel = require('../models/user.model');


function toIso(value) {
  if (!value) return null;
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}


function formatMaintenanceForConfig(row) {
  const current = maintenanceModeModel.formatForResponse(row) || {
    enabled: false,
    title: 'Scheduled Maintenance',
    message: 'We are currently under maintenance. Please try again shortly.',
    start_at: null,
    end_at: null,
    metadata: {},
  };

  const serverTime = new Date();
  const startAt = current.start_at ? new Date(current.start_at) : null;
  const endAt = current.end_at ? new Date(current.end_at) : null;

  const startsInSeconds = startAt && startAt.getTime() > serverTime.getTime()
    ? Math.max(0, Math.floor((startAt.getTime() - serverTime.getTime()) / 1000))
    : 0;
  const endsInSeconds = endAt && endAt.getTime() > serverTime.getTime()
    ? Math.max(0, Math.floor((endAt.getTime() - serverTime.getTime()) / 1000))
    : 0;

  return {
    enabled: current.enabled === true,
    title: current.title,
    message: current.message,
    start_at: toIso(current.start_at),
    end_at: toIso(current.end_at),
    server_time: serverTime.toISOString(),
    starts_in_seconds: startsInSeconds,
    ends_in_seconds: endsInSeconds,
    timing_message: (
      current.enabled
        ? (endsInSeconds > 0 ? `Maintenance is active. Estimated end in ${endsInSeconds} seconds.` : 'Maintenance is active.')
        : (startsInSeconds > 0 ? `Maintenance is scheduled to start in ${startsInSeconds} seconds.` : 'Maintenance is not active.')
    ),
    metadata: current.metadata || {},
  };
}

function normalizeVersion(version) {
  const source = String(version || '').trim().toLowerCase().replace(/^v/, '');
  if (!source) return null;
  const parts = source.split('.');
  const normalized = [];
  for (let i = 0; i < 3; i += 1) {
    const part = parts[i] == null ? '0' : parts[i];
    if (!/^\d+$/.test(part)) return null;
    normalized.push(Number(part));
  }
  return normalized;
}

function compareVersions(a, b) {
  const vA = normalizeVersion(a);
  const vB = normalizeVersion(b);
  if (!vA || !vB) return null;
  for (let i = 0; i < 3; i += 1) {
    if (vA[i] > vB[i]) return 1;
    if (vA[i] < vB[i]) return -1;
  }
  return 0;
}

function normalizePlatform(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'android' || normalized === 'ios') return normalized;
  return null;
}

function toAppUpdatePayload(rows, platform, appVersion) {
  const defaults = {
    latest: '1.0.0',
    minimum: '1.0.0',
    url: '',
    release_notes: '',
    enabled: false,
    force_download: false,
  };

  const map = new Map(rows.map((row) => [row.platform, row]));
  const android = map.get('android') || { platform: 'android', ...defaults };
  const ios = map.get('ios') || { platform: 'ios', ...defaults };
  const currentPlatform = platform && map.get(platform) ? map.get(platform) : null;

  let forceDownload = false;
  if (currentPlatform && currentPlatform.enabled === true) {
    const compareResult = compareVersions(appVersion, currentPlatform.minimum);
    forceDownload = compareResult == null || compareResult < 0;
  }

  return {
    android: {
      latest: android.latest || defaults.latest,
      minimum: android.minimum || defaults.minimum,
      url: android.url || defaults.url,
      release_notes: android.release_notes || defaults.release_notes,
      enabled: android.enabled === true,
    },
    ios: {
      latest: ios.latest || defaults.latest,
      minimum: ios.minimum || defaults.minimum,
      url: ios.url || defaults.url,
      release_notes: ios.release_notes || defaults.release_notes,
      enabled: ios.enabled === true,
    },
    platform: currentPlatform ? currentPlatform.platform : null,
    force_download: forceDownload,
  };
}

function extractTokenClaims(payload = null) {
  if (!payload || typeof payload !== 'object') return null;
  const userId = Number(payload.userId);
  const sessionId = String(payload.sessionId || '').trim();
  if (Number.isNaN(userId) || !sessionId) return null;
  return {
    userId,
    sessionId,
    role: payload.role || 'user',
    exp: Number(payload.exp) || null,
    iat: Number(payload.iat) || null,
  };
}

async function buildAuthValidation(token) {
  const providedToken = String(token || '').trim();
  if (!providedToken) {
    return {
      provided: false,
      valid: false,
      reason: 'token_not_provided',
      user_id: null,
      session_id: null,
      role: null,
    };
  }

  const payload = authService.verifyToken(providedToken);
  const claims = extractTokenClaims(payload);
  if (!claims) {
    return {
      provided: true,
      valid: false,
      reason: 'invalid_or_expired_token',
      user_id: null,
      session_id: null,
      role: null,
    };
  }

  const activeSession = await loginAttemptModel.findActiveBySessionId(claims.sessionId);
  if (!activeSession || Number(activeSession.user_id) !== Number(claims.userId)) {
    return {
      provided: true,
      valid: false,
      reason: 'session_invalid_or_logged_out',
      user_id: claims.userId,
      session_id: claims.sessionId,
      role: claims.role,
    };
  }

  const user = await userModel.findById(claims.userId);
  if (!user || user.active === false) {
    return {
      provided: true,
      valid: false,
      reason: 'user_not_allowed',
      user_id: claims.userId,
      session_id: claims.sessionId,
      role: claims.role,
    };
  }

  return {
    provided: true,
    valid: true,
    reason: null,
    user_id: claims.userId,
    session_id: claims.sessionId,
    role: claims.role,
    exp: claims.exp,
    iat: claims.iat,
  };
}

async function getConfig({ platform = null, appVersion = null, token = null } = {}) {
  const [avatars, states, addCashOptions, withdrawOptions, faqs, supports, maintenanceMode, appUpdateRows] = await Promise.all([
    avatarModel.getActiveForConfig(),
    stateModel.getActiveForConfig(),
    addCashOptionModel.getActiveForConfig(),
    withdrawOptionModel.getActiveForConfig(),
    faqModel.getActiveForConfig(),
    supportLinkModel.getActiveForConfig(),
    maintenanceModeModel.getCurrent(),
    appUpdateConfigModel.listAll(),
  ]);
  const authValidation = await buildAuthValidation(token);
  const bypassWithdrawalBalanceCheck = 
  process.env.BYPASS_WITHDRAWAL_BALANCE_CHECK === 'true'
    && process.env.NODE_ENV !== 'production';
  return {
    avatars,
    states,
    addCashOptions,
    withdrawOptions,
    accountStatementFilters: walletService.getAccountStatementFilters(),
    faqs,
    supports,
    maintenanceMode: formatMaintenanceForConfig(maintenanceMode),
    appUpdate: toAppUpdatePayload(appUpdateRows, normalizePlatform(platform), appVersion),
    authValidation,
    withdrawalTesting: {
      bypassBalanceCheck: bypassWithdrawalBalanceCheck,
    },
  };
}

module.exports = {
  getConfig,
};
