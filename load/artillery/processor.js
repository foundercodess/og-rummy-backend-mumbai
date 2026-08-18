'use strict';

/**
 * Artillery processor: real app login (OTP 1111) + HTTP bootstrap + socket hold.
 *
 *   cd og_rummy_backend
 *   npx artillery@2 run load/artillery/login-connect.local.yml
 *   LOAD_TEST_URL=http://og-rummy-alb-791534744.ap-south-1.elb.amazonaws.com \
 *     npx artillery@2 run load/artillery/login-connect.yml
 */

const { randomBytes } = require('crypto');
const { io } = require('socket.io-client');
const loadHttp = require('../../scripts/load_test_http');

const PHONE_PREFIX = String(process.env.LOAD_TEST_PHONE_PREFIX || '97000');

function nextPhone() {
  // Exactly 15 numeric digits, prefix 97000 (skip-SMS + OTP 1111).
  // Hex strings were stripped of a–f and either failed "10-digit" or overflowed users.phone VARCHAR(15).
  const n = randomBytes(6).readUIntBE(0, 6);
  const body = String(n).padStart(10, '0').slice(-10);
  return `${PHONE_PREFIX}${body}`.slice(0, 15);
}

function connectSocket(url, token, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const socket = io(url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: timeoutMs,
      forceNew: true,
    });
    const timer = setTimeout(() => {
      socket.close();
      resolve({ ok: false, error: 'connect_timeout', socket: null });
    }, timeoutMs + 5000);
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      socket.close();
      resolve({ ok: false, error: err.message || 'connect_error', socket: null });
    });
    socket.on('connection:ready', () => {
      clearTimeout(timer);
      resolve({ ok: true, error: null, socket });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Artillery 2 workers do not pass `done` for async functions — return a Promise / throw.
async function fullCycleUntilSocket(context, events) {
  const baseUrl = String(context.vars.target || process.env.LOAD_TEST_URL || '').replace(/\/$/, '');
  const phone = context.vars.phone || nextPhone();
  if (!baseUrl) throw new Error('LOAD_TEST_URL / target missing');
  if (!phone) throw new Error('failed to allocate load-test phone');

  const started = Date.now();
  const auth = await loadHttp.fullLoginCycle(baseUrl, phone, { otp: process.env.LOAD_TEST_OTP || '1111' });
  events.emit('histogram', 'login_ms', auth.ms || (Date.now() - started));
  if (!auth.ok) {
    events.emit('counter', `login_fail_${auth.phase || 'auth'}`, 1);
    throw new Error(`${auth.phase}:${auth.error}`);
  }
  events.emit('counter', 'login_ok', 1);

  const hold = await connectSocket(baseUrl, auth.token);
  if (!hold.ok) {
    events.emit('counter', 'socket_connect_fail', 1);
    throw new Error(hold.error || 'connect_failed');
  }
  events.emit('counter', 'socket_connect_ok', 1);
  context.vars.__socket = hold.socket;
  const holdMs = Math.max(1000, Number(process.env.LOAD_SOCKET_HOLD_MS) || 15000);
  await sleep(holdMs);
  try { hold.socket.close(); } catch (_) { /* ignore */ }
}

module.exports = { fullCycleUntilSocket };
