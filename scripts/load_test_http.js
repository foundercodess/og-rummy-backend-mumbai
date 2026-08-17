'use strict';

/**
 * HTTP helpers for the full client cycle used by load scripts / Artillery.
 *
 * Login matches the app: POST send-otp → POST verify-otp with OTP 1111.
 */

const DEFAULT_OTP = '1111';
const DEVICE_INFO = {
  load_test: true,
  platform: 'load_script',
  app: 'og_rummy_load',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(baseUrl, method, urlPath, { token, body, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${String(baseUrl).replace(/\/$/, '')}${urlPath}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    const success = json.success !== false && json.status !== false && res.status < 500;
    return {
      ok: success && res.ok,
      status: res.status,
      json,
      error: success
        ? null
        : (json.message || json.error || `http_${res.status}`),
      ms: null,
    };
  } catch (err) {
    const message = err?.name === 'AbortError' ? 'headers_timeout' : (err.message || 'fetch_failed');
    return { ok: false, status: 0, json: {}, error: message, ms: null };
  } finally {
    clearTimeout(timer);
  }
}

async function timed(fn) {
  const t0 = Date.now();
  const result = await fn();
  result.ms = Date.now() - t0;
  return result;
}

async function sendOtp(baseUrl, phone, options = {}) {
  return timed(() => requestJson(baseUrl, 'POST', '/api/auth/send-otp', {
    body: {
      phone: String(phone),
      device_info: options.deviceInfo || DEVICE_INFO,
    },
    timeoutMs: options.timeoutMs || 20000,
  }));
}

async function verifyOtp(baseUrl, phone, otp, loginAttemptId, options = {}) {
  return timed(() => requestJson(baseUrl, 'POST', '/api/auth/verify-otp', {
    body: {
      phone: String(phone),
      otp: String(otp || DEFAULT_OTP),
      login_attempt_id: loginAttemptId,
      device_info: options.deviceInfo || DEVICE_INFO,
    },
    timeoutMs: options.timeoutMs || 20000,
  }));
}

async function loginWithOtp(baseUrl, phone, options = {}) {
  const otp = String(options.otp || DEFAULT_OTP);
  const started = Date.now();
  const sent = await sendOtp(baseUrl, phone, options);
  if (!sent.ok) {
    return {
      ok: false,
      phase: 'send_otp',
      error: sent.error || 'send_otp_failed',
      status: sent.status,
      ms: Date.now() - started,
      send_ms: sent.ms,
      verify_ms: null,
      token: null,
      user: null,
    };
  }
  const loginAttemptId = sent.json?.login_attempt_id ?? sent.json?.data?.login_attempt_id ?? null;
  const verified = await verifyOtp(baseUrl, phone, otp, loginAttemptId, options);
  const token = verified.json?.token || verified.json?.data?.token || null;
  const user = verified.json?.user || verified.json?.data?.user || null;
  if (!verified.ok || !token) {
    return {
      ok: false,
      phase: 'verify_otp',
      error: verified.error || 'verify_otp_failed',
      status: verified.status,
      ms: Date.now() - started,
      send_ms: sent.ms,
      verify_ms: verified.ms,
      token: null,
      user: null,
    };
  }
  return {
    ok: true,
    phase: 'auth',
    error: null,
    status: 200,
    ms: Date.now() - started,
    send_ms: sent.ms,
    verify_ms: verified.ms,
    token,
    user,
    user_id: Number(user?.id || 0) || null,
    session_id: verified.json?.session_id || null,
    login_attempt_id: loginAttemptId,
  };
}

async function bootstrapClient(baseUrl, token, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const started = Date.now();
  const steps = [
    ['config', () => requestJson(baseUrl, 'GET', '/api/config', { token, timeoutMs })],
    ['profile', () => requestJson(baseUrl, 'GET', '/api/user/profile', { token, timeoutMs })],
    ['games', () => requestJson(baseUrl, 'GET', '/api/games', { token, timeoutMs })],
    ['active_sessions', () => requestJson(baseUrl, 'GET', '/api/gameplay/sessions/active', { token, timeoutMs })],
  ];
  const timings = {};
  for (const [name, fn] of steps) {
    const result = await timed(fn);
    timings[name] = result.ms;
    if (!result.ok && result.status >= 500) {
      return {
        ok: false,
        phase: name,
        error: result.error || `${name}_failed`,
        status: result.status,
        ms: Date.now() - started,
        timings,
      };
    }
  }
  return {
    ok: true,
    phase: 'bootstrap',
    error: null,
    status: 200,
    ms: Date.now() - started,
    timings,
  };
}

async function fullLoginCycle(baseUrl, phone, options = {}) {
  const auth = await loginWithOtp(baseUrl, phone, options);
  if (!auth.ok) return { ...auth, bootstrap: null };
  const bootstrap = await bootstrapClient(baseUrl, auth.token, options);
  return {
    ...auth,
    ok: bootstrap.ok,
    phase: bootstrap.ok ? 'ready' : bootstrap.phase,
    error: bootstrap.ok ? null : bootstrap.error,
    bootstrap,
    ms: (auth.ms || 0) + (bootstrap.ms || 0),
  };
}

async function fundWallet(baseUrl, token, amount = 10000, options = {}) {
  return timed(() => requestJson(baseUrl, 'POST', '/api/wallet/load-test/fund', {
    token,
    body: { amount: Number(amount) || 10000 },
    timeoutMs: options.timeoutMs || 20000,
  }));
}

module.exports = {
  DEFAULT_OTP,
  DEVICE_INFO,
  sleep,
  requestJson,
  sendOtp,
  verifyOtp,
  loginWithOtp,
  bootstrapClient,
  fullLoginCycle,
  fundWallet,
};
