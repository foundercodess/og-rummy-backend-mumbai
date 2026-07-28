#!/usr/bin/env node
'use strict';

/**
 * Socket.IO concurrency ramp for OG Rummy.
 *
 * Run from a SEPARATE machine against staging — never from the game server itself.
 *
 * Modes:
 *   connect  — open N websockets and hold (default; safest capacity probe)
 *   join     — after connect, emit session:join into shared waiting tables (heavier)
 *
 * Prep tokens first:
 *   node scripts/load_test_prepare_users.js --count 10000 --out load_tokens.jsonl
 *
 * Example (ramp to 2k over 60s, hold 2 minutes):
 *   node scripts/load_test_concurrency.js \
 *     --url http://staging.example.com \
 *     --tokens load_tokens.jsonl \
 *     --target 2000 \
 *     --ramp-seconds 60 \
 *     --hold-seconds 120
 *
 * Env / flags:
 *   --url            Base HTTP URL (default LOAD_TEST_URL or http://127.0.0.1:3000)
 *   --tokens         JSONL from prepare script (required)
 *   --target         Concurrent sockets to reach (default 100)
 *   --ramp-seconds   Seconds to ramp 0→target (default 30)
 *   --hold-seconds   Hold at target before disconnect (default 60)
 *   --mode           connect | join (default connect)
 *   --concurrency    Max in-flight connects at once (default 50)
 *   --game-id / --contest-id / --max-players  (join mode)
 */

const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

if (flag('help')) {
  console.log(fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1]);
  process.exit(0);
}

const baseUrl = String(arg('url', process.env.LOAD_TEST_URL || 'http://127.0.0.1:3000')).replace(/\/$/, '');
const tokensPath = path.resolve(arg('tokens', ''));
const target = Math.max(1, Number(arg('target', '100')) || 100);
const rampSeconds = Math.max(1, Number(arg('ramp-seconds', '30')) || 30);
const holdSeconds = Math.max(0, Number(arg('hold-seconds', '60')) || 60);
const mode = String(arg('mode', 'connect')).toLowerCase();
const connectConcurrency = Math.max(1, Number(arg('concurrency', '50')) || 50);
const gameId = arg('game-id', process.env.LOAD_TEST_GAME_ID);
const contestId = arg('contest-id', process.env.LOAD_TEST_CONTEST_ID);
const maxPlayers = Math.max(2, Number(arg('max-players', '2')) || 2);

if (!tokensPath || !fs.existsSync(tokensPath)) {
  console.error('Missing --tokens <load_tokens.jsonl> (run load_test_prepare_users.js first)');
  process.exit(1);
}

function loadTokens(file, limit) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (out.length >= limit) break;
    try {
      const row = JSON.parse(line);
      if (row && row.token) out.push(row);
    } catch (_) {
      // skip bad line
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function connectOne(tokenRow, label) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = io(baseUrl, {
      auth: { token: tokenRow.token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 15000,
      forceNew: true,
    });

    const done = (result) => {
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      socket.removeAllListeners();
      socket.close();
      done({
        ok: false,
        error: 'connect_timeout',
        ms: Date.now() - started,
        socket: null,
        user_id: tokenRow.user_id,
      });
    }, 20000);

    socket.on('connect_error', (err) => {
      socket.removeAllListeners();
      socket.close();
      done({
        ok: false,
        error: err.message || 'connect_error',
        ms: Date.now() - started,
        socket: null,
        user_id: tokenRow.user_id,
      });
    });

    socket.on('connection:ready', () => {
      done({
        ok: true,
        error: null,
        ms: Date.now() - started,
        socket,
        user_id: tokenRow.user_id,
        label,
      });
    });
  });
}

function emitAck(socket, event, payload, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'ack_timeout' }), timeoutMs);
    try {
      socket.emit(event, payload, (ack) => {
        clearTimeout(timer);
        resolve({ ok: true, ack });
      });
    } catch (err) {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    }
  });
}

async function postJson(urlPath, body, token) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function runPool(items, concurrency, worker) {
  let idx = 0;
  const results = new Array(items.length);
  async function runner() {
    while (idx < items.length) {
      const my = idx;
      idx += 1;
      results[my] = await worker(items[my], my);
    }
  }
  const runners = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i += 1) {
    runners.push(runner());
  }
  await Promise.all(runners);
  return results;
}

(async () => {
  const tokens = loadTokens(tokensPath, target);
  if (tokens.length < target) {
    console.error(`Need ${target} tokens, found ${tokens.length} in ${tokensPath}`);
    process.exit(1);
  }

  console.log(
    `[LOAD] url=${baseUrl} mode=${mode} target=${target} ramp=${rampSeconds}s hold=${holdSeconds}s`,
  );

  const connected = [];
  const failReasons = new Map();
  let connectOk = 0;
  let connectFail = 0;
  const latencies = [];

  const batchSize = Math.max(1, Math.ceil(target / Math.max(1, rampSeconds)));
  const t0 = Date.now();

  for (let started = 0; started < target; started += batchSize) {
    const slice = tokens.slice(started, Math.min(target, started + batchSize));
    const results = await runPool(slice, connectConcurrency, (row, i) =>
      connectOne(row, started + i),
    );

    for (const r of results) {
      latencies.push(r.ms);
      if (r.ok && r.socket) {
        connectOk += 1;
        connected.push(r);
      } else {
        connectFail += 1;
        const key = r.error || 'unknown';
        failReasons.set(key, (failReasons.get(key) || 0) + 1);
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `[LOAD] connected=${connectOk} failed=${connectFail} in_flight_target=${Math.min(target, started + batchSize)} elapsed=${elapsed}s`,
    );

    // Pace remaining ramp window
    const progress = Math.min(target, started + batchSize) / target;
    const expectedElapsedMs = progress * rampSeconds * 1000;
    const behind = expectedElapsedMs - (Date.now() - t0);
    if (behind > 20) await sleep(behind);
  }

  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] || null;

  console.log('[LOAD] connect summary', {
    ok: connectOk,
    failed: connectFail,
    p50_ms: pct(50),
    p95_ms: pct(95),
    p99_ms: pct(99),
    fail_reasons: Object.fromEntries(failReasons),
  });

  if (mode === 'join' && connected.length >= 2) {
    if (!gameId || !contestId) {
      console.warn('[LOAD] join mode needs --game-id and --contest-id; skipping join phase');
    } else {
      let joinOk = 0;
      let joinFail = 0;
      // Pair into tables of maxPlayers using first seat as table creator.
      for (let i = 0; i + maxPlayers - 1 < connected.length; i += maxPlayers) {
        const seats = connected.slice(i, i + maxPlayers);
        const creator = seats[0];
        const created = await postJson(
          '/api/gameplay/sessions',
          {
            game_id: Number(gameId),
            contest_id: Number(contestId),
            max_players: maxPlayers,
            metadata: { load_test: true },
          },
          tokens.find((t) => t.user_id === creator.user_id)?.token || tokens[i].token,
        );
        const sessionId = created.json?.session?.id;
        if (!sessionId) {
          joinFail += seats.length;
          continue;
        }
        for (const seat of seats) {
          const ack = await emitAck(seat.socket, 'session:join', { session_id: sessionId });
          if (ack.ok) joinOk += 1;
          else joinFail += 1;
        }
        if ((i / maxPlayers) % 25 === 0) {
          console.log(`[LOAD] join progress tables≈${Math.floor(i / maxPlayers) + 1} ok=${joinOk} fail=${joinFail}`);
        }
      }
      console.log('[LOAD] join summary', { ok: joinOk, failed: joinFail });
    }
  }

  console.log(`[LOAD] holding ${holdSeconds}s at ${connected.length} sockets…`);
  await sleep(holdSeconds * 1000);

  for (const c of connected) {
    try {
      c.socket.removeAllListeners();
      c.socket.close();
    } catch (_) {
      // ignore
    }
  }

  console.log('[LOAD] done — disconnected clients');
  process.exit(connectFail > connectOk * 0.05 ? 2 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
