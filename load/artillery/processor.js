'use strict';

/**
 * Artillery processor: real app login (OTP 1111) + HTTP bootstrap + socket hold.
 *
 *   cd og_rummy_backend
 *   LOAD_TEST_URL=http://og-rummy-alb-791534744.ap-south-1.elb.amazonaws.com \
 *     npx artillery run load/artillery/login-connect.yml
 */

const { io } = require('socket.io-client');
const loadHttp = require('../../scripts/load_test_http');

function loadPhonesFromJsonl(filePath, limit) {
  const fs = require('fs');
  if (!filePath || !fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  const phones = [];
  for (const line of lines) {
    if (phones.length >= limit) break;
    try {
      const row = JSON.parse(line);
      if (row?.phone) phones.push(String(row.phone));
    } catch (_) {
      // skip
    }
  }
  return phones;
}

const phones = loadPhonesFromJsonl(
  process.env.LOAD_TOKENS || require('path').resolve(__dirname, '../../load_tokens.jsonl'),
  50000,
);
let phoneCursor = 0;

function nextPhone() {
  if (!phones.length) return null;
  const phone = phones[phoneCursor % phones.length];
  phoneCursor += 1;
  return phone;
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

async function fullCycleUntilSocket(context, events, done) {
  const baseUrl = String(context.vars.target || process.env.LOAD_TEST_URL || '').replace(/\/$/, '');
  const phone = context.vars.phone || nextPhone();
  if (!baseUrl) return done(new Error('LOAD_TEST_URL / target missing'));
  if (!phone) return done(new Error('No phone in load_tokens.jsonl (need phone field)'));

  const started = Date.now();
  const auth = await loadHttp.fullLoginCycle(baseUrl, phone, { otp: process.env.LOAD_TEST_OTP || '1111' });
  events.emit('histogram', 'login_ms', auth.ms || (Date.now() - started));
  if (!auth.ok) {
    events.emit('counter', `login_fail_${auth.phase || 'auth'}`, 1);
    return done(new Error(`${auth.phase}:${auth.error}`));
  }
  events.emit('counter', 'login_ok', 1);

  const hold = await connectSocket(baseUrl, auth.token);
  if (!hold.ok) {
    events.emit('counter', 'socket_connect_fail', 1);
    return done(new Error(hold.error || 'connect_failed'));
  }
  events.emit('counter', 'socket_connect_ok', 1);
  context.vars.__socket = hold.socket;
  const holdMs = Math.max(1000, Number(process.env.LOAD_SOCKET_HOLD_MS) || 15000);
  setTimeout(() => {
    try { hold.socket.close(); } catch (_) { /* ignore */ }
    done();
  }, holdMs);
}

module.exports = { fullCycleUntilSocket };
