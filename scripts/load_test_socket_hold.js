#!/usr/bin/env node
'use strict';

/**
 * Simple socket CCU hold — login → connect → hold. No tables / gameplay.
 *
 * Smoke (300 sockets, 60s hold):
 *   node scripts/load_test_socket_hold.js --target 300 --hold-seconds 60
 *
 * 50k (run from a dedicated load machine, not API EC2):
 *   node scripts/load_test_socket_hold.js --target 50000 --hold-seconds 300 --concurrency 100
 *
 * Or:
 *   TARGET=50000 HOLD_SECONDS=300 ./scripts/run_socket_hold.sh
 */

const { io } = require('socket.io-client');
const loadHttp = require('./load_test_http');

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

if (flag('help')) {
  console.log(`
Usage:
  node scripts/load_test_socket_hold.js [options]

Options:
  --url              API base URL (default LOAD_TEST_URL or ALB)
  --target           Concurrent sockets to open (default 50000)
  --hold-seconds     Hold after ramp (default 300)
  --concurrency      Parallel login+connect workers (default 100)
  --ramp-seconds     Pace connects over this window (default 120; 0 = as fast as concurrency allows)
  --phone-prefix     OTP phones prefix (default 97000)
  --start            Phone index start (default 1)
  --otp              OTP (default 1111)
`);
  process.exit(0);
}

const baseUrl = String(
  arg('url', process.env.LOAD_TEST_URL || 'http://og-rummy-alb-791534744.ap-south-1.elb.amazonaws.com'),
).replace(/\/$/, '');
const target = Math.max(1, Number(arg('target', process.env.TARGET || '50000')) || 50000);
const holdSeconds = Math.max(0, Number(arg('hold-seconds', process.env.HOLD_SECONDS || '300')) || 0);
const concurrency = Math.max(1, Number(arg('concurrency', process.env.CONCURRENCY || '100')) || 100);
const rampSeconds = Math.max(0, Number(arg('ramp-seconds', process.env.RAMP_SECONDS || '120')) || 0);
const phonePrefix = String(arg('phone-prefix', process.env.LOAD_TEST_PHONE_PREFIX || '97000'));
const phoneStart = Math.max(1, Number(arg('start', '1')) || 1);
const loginOtp = String(arg('otp', loadHttp.DEFAULT_OTP) || loadHttp.DEFAULT_OTP);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function padPhone(index) {
  const body = String(index).padStart(Math.max(1, 10 - phonePrefix.length), '0');
  return `${phonePrefix}${body}`.slice(0, 10);
}

async function login(phone) {
  const sent = await loadHttp.sendOtp(baseUrl, phone);
  if (!sent.ok) return { ok: false, error: `send_otp:${sent.error || sent.status}` };
  const loginAttemptId = sent.json?.login_attempt_id ?? sent.json?.data?.login_attempt_id ?? null;
  const verified = await loadHttp.verifyOtp(baseUrl, phone, loginOtp, loginAttemptId);
  const token = verified.json?.token || verified.json?.data?.token || null;
  const user = verified.json?.user || verified.json?.data?.user || null;
  if (!verified.ok || !token) {
    return { ok: false, error: `verify_otp:${verified.error || 'failed'}` };
  }
  return {
    ok: true,
    token,
    user_id: Number(user?.id) || null,
    phone,
  };
}

function connectSocket(tokenRow) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = io(baseUrl, {
      auth: { token: tokenRow.token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 20000,
      forceNew: true,
    });

    const finish = (result) => {
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      socket.removeAllListeners();
      socket.close();
      finish({ ok: false, error: 'connect_timeout', ms: Date.now() - started, socket: null });
    }, 25000);

    socket.on('connect_error', (err) => {
      socket.removeAllListeners();
      socket.close();
      finish({
        ok: false,
        error: err.message || 'connect_error',
        ms: Date.now() - started,
        socket: null,
      });
    });

    socket.on('connection:ready', () => {
      finish({
        ok: true,
        error: null,
        ms: Date.now() - started,
        socket,
        user_id: tokenRow.user_id,
      });
    });
  });
}

async function runPool(count, limit, worker) {
  let next = 0;
  const runners = [];
  for (let w = 0; w < Math.min(limit, count); w += 1) {
    runners.push((async () => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= count) return;
        await worker(i);
      }
    })());
  }
  await Promise.all(runners);
}

(async () => {
  const t0 = Date.now();
  const sockets = [];
  const failReasons = new Map();
  let loginOk = 0;
  let loginFail = 0;
  let connectOk = 0;
  let connectFail = 0;
  let openNow = 0;
  let peakOpen = 0;
  let disconnects = 0;

  const bumpOpen = (delta) => {
    openNow += delta;
    if (openNow > peakOpen) peakOpen = openNow;
    if (delta < 0) disconnects += 1;
  };

  console.log('[SOCKET_HOLD] starting', {
    url: baseUrl,
    target,
    hold_seconds: holdSeconds,
    concurrency,
    ramp_seconds: rampSeconds,
    phone_prefix: phonePrefix,
    phone_start: phoneStart,
  });

  const batchSize = rampSeconds > 0
    ? Math.max(1, Math.ceil(target / rampSeconds))
    : target;

  for (let started = 0; started < target; started += batchSize) {
    const batchCount = Math.min(batchSize, target - started);
    const batchT0 = Date.now();

    await runPool(batchCount, concurrency, async (offset) => {
      const index = started + offset;
      const phone = padPhone(phoneStart + index);
      const logged = await login(phone);
      if (!logged.ok) {
        loginFail += 1;
        const key = logged.error || 'login_fail';
        failReasons.set(key, (failReasons.get(key) || 0) + 1);
        return;
      }
      loginOk += 1;

      const conn = await connectSocket(logged);
      if (!conn.ok || !conn.socket) {
        connectFail += 1;
        const key = conn.error || 'connect_fail';
        failReasons.set(key, (failReasons.get(key) || 0) + 1);
        return;
      }
      connectOk += 1;
      bumpOpen(1);
      conn.socket.once('disconnect', () => bumpOpen(-1));
      sockets.push(conn.socket);
    });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('[SOCKET_HOLD] progress', {
      attempted: Math.min(target, started + batchCount),
      login_ok: loginOk,
      login_fail: loginFail,
      connect_ok: connectOk,
      connect_fail: connectFail,
      open_now: openNow,
      peak_open: peakOpen,
      elapsed_s: Number(elapsed),
    });

    if (rampSeconds > 0) {
      const progress = Math.min(target, started + batchCount) / target;
      const expectedMs = progress * rampSeconds * 1000;
      const behind = expectedMs - (Date.now() - t0);
      if (behind > 20) await sleep(behind);
    } else if (Date.now() - batchT0 < 5) {
      // avoid tight spin when batch is tiny
      await sleep(5);
    }
  }

  console.log('[SOCKET_HOLD] ramp done', {
    login_ok: loginOk,
    login_fail: loginFail,
    connect_ok: connectOk,
    connect_fail: connectFail,
    open_now: openNow,
    peak_open: peakOpen,
    fail_reasons: Object.fromEntries([...failReasons.entries()].slice(0, 10)),
  });

  if (holdSeconds > 0) {
    console.log(`[SOCKET_HOLD] holding ${holdSeconds}s at ${openNow} open sockets…`);
    const holdUntil = Date.now() + holdSeconds * 1000;
    while (Date.now() < holdUntil) {
      await sleep(Math.min(15000, holdUntil - Date.now()));
      console.log('[SOCKET_HOLD] hold', {
        open_now: openNow,
        peak_open: peakOpen,
        disconnects,
        remaining_s: Math.max(0, Math.ceil((holdUntil - Date.now()) / 1000)),
      });
    }
  }

  for (const s of sockets) {
    try {
      s.removeAllListeners();
      s.close();
    } catch (_) {
      // ignore
    }
  }

  const elapsed_s = Number(((Date.now() - t0) / 1000).toFixed(1));
  const ok = peakOpen >= Math.floor(target * 0.95);
  console.log('========== SOCKET HOLD REPORT ==========');
  console.log({
    ok,
    target,
    peak_open: peakOpen,
    open_at_end_of_hold: openNow,
    login_ok: loginOk,
    login_fail: loginFail,
    connect_ok: connectOk,
    connect_fail: connectFail,
    disconnects_during_run: disconnects,
    elapsed_s,
  });
  console.log('========================================');
  process.exit(ok ? 0 : 2);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
