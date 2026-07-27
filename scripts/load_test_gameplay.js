#!/usr/bin/env node
'use strict';

/**
 * Fully scripted gameplay stress test — no human players.
 *
 * Spawns N parallel 2-seat tables. Both seats are JWT clients from
 * load_tokens.jsonl that auto pick/discard until game:result (or timeout → drop).
 *
 * Prep (fund wallets for entry fees):
 *   node scripts/load_test_prepare_users.js --allow-remote-db --count 200 --fund 10000 --out load_tokens.jsonl
 *
 * Example (50 tables = 100 sockets):
 *   node scripts/load_test_gameplay.js \
 *     --url http://13.233.105.184 \
 *     --tokens load_tokens.jsonl \
 *     --game-id 1 \
 *     --contest-id 1 \
 *     --tables 50 \
 *     --concurrency 10 \
 *     --max-game-seconds 240
 *
 * Flags:
 *   --url                API base URL
 *   --tokens             JSONL from prepare script
 *   --game-id            Required
 *   --contest-id         Required
 *   --tables             Parallel tables (default 10)
 *   --concurrency        Tables started at once (default 5)
 *   --max-players        Seats per table (default 2; only 2 supported)
 *   --max-game-seconds   Force drop if no result (default 240)
 *   --pick-delay-ms      Pause after turn start before pick (default 250)
 *   --discard-delay-ms   Pause before discard (default 350)
 *   --action-retries     Retries for pick/discard on transient errors (default 5)
 *   --mode               dual (2 scripts) | vs-bot (1 script + server bot fill)
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
const tables = Math.max(1, Number(arg('tables', '10')) || 10);
const concurrency = Math.max(1, Number(arg('concurrency', '5')) || 5);
const maxPlayers = Math.max(2, Number(arg('max-players', '2')) || 2);
const maxGameSeconds = Math.max(30, Number(arg('max-game-seconds', '240')) || 240);
const pickDelayMs = Math.max(0, Number(arg('pick-delay-ms', '250')) || 0);
const discardDelayMs = Math.max(0, Number(arg('discard-delay-ms', '350')) || 0);
const actionRetries = Math.max(1, Number(arg('action-retries', '5')) || 5);
const gameId = Number(arg('game-id', process.env.LOAD_TEST_GAME_ID));
const contestId = Number(arg('contest-id', process.env.LOAD_TEST_CONTEST_ID));
const mode = String(arg('mode', 'dual')).toLowerCase(); // dual | vs-bot

if (!tokensPath || !fs.existsSync(tokensPath)) {
  console.error('Missing --tokens <load_tokens.jsonl>');
  process.exit(1);
}
if (!Number.isFinite(gameId) || gameId <= 0 || !Number.isFinite(contestId) || contestId <= 0) {
  console.error('Required: --game-id and --contest-id (active contest with entry fee your wallets can pay)');
  process.exit(1);
}
if (maxPlayers !== 2) {
  console.error('Only --max-players 2 is supported in this script');
  process.exit(1);
}

function loadTokens(file, limit) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (out.length >= limit) break;
    try {
      const row = JSON.parse(line);
      if (row?.token && row?.user_id != null) out.push(row);
    } catch (_) {
      // skip
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitAck(socket, event, payload, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'ack_timeout', event }), timeoutMs);
    try {
      socket.emit(event, payload, (ack) => {
        clearTimeout(timer);
        if (ack && ack.success === false) {
          resolve({ ok: false, error: ack.message || 'ack_failed', event, ack });
          return;
        }
        resolve({ ok: true, ack, event });
      });
    } catch (err) {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, event });
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

function connectClient(tokenRow, label) {
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
      finish({
        ok: false,
        error: 'connect_timeout',
        ms: Date.now() - started,
        socket: null,
        user_id: tokenRow.user_id,
        label,
      });
    }, 25000);

    socket.on('connect_error', (err) => {
      socket.removeAllListeners();
      socket.close();
      finish({
        ok: false,
        error: err.message || 'connect_error',
        ms: Date.now() - started,
        socket: null,
        user_id: tokenRow.user_id,
        label,
      });
    });

    socket.on('connection:ready', (data) => {
      finish({
        ok: true,
        error: null,
        ms: Date.now() - started,
        socket,
        user_id: Number(data?.user?.id || tokenRow.user_id),
        token: tokenRow.token,
        label,
      });
    });
  });
}

function groupsFromAck(ack) {
  const groups = ack?.ack?.data?.groups
    || ack?.ack?.data?.grouping?.groups
    || [];
  return (groups || []).map((g, idx) => ({
    group_id: g.group_id || idx + 1,
    cards: (g.cards || []).map((c) => (typeof c === 'string' ? c : c.card_uid)).filter(Boolean),
  })).filter((g) => g.cards.length > 0);
}

function cardUidsFromGroups(groups) {
  const out = [];
  for (const g of groups || []) {
    for (const uid of g.cards || []) out.push(uid);
  }
  return out;
}

function pushError(shared, key) {
  shared.errors.push(key);
  shared.errorCounts[key] = (shared.errorCounts[key] || 0) + 1;
}

async function waitUntilTurnStarted(turnPayload) {
  const startedAt = Date.parse(turnPayload?.started_at || '');
  if (Number.isNaN(startedAt)) return;
  const waitMs = startedAt - Date.now() + 75;
  if (waitMs > 0) await sleep(Math.min(waitMs, 8000));
}

function isRetryableActionError(msg) {
  const m = String(msg || '').toLowerCase();
  return m.includes('not started')
    || m.includes('retry')
    || m.includes('in progress')
    || m.includes('ack_timeout')
    || m.includes('try again');
}

function isAlreadyPickedError(msg) {
  const m = String(msg || '').toLowerCase();
  return m.includes('already picked') || m.includes('discard first');
}

/**
 * Auto-play one seat until game ends or deadline.
 */
function attachAutoPlayer(seat, sessionId, shared) {
  const { socket, user_id: userId, label } = seat;
  let busy = false;
  let turns = 0;
  let lastHandGroups = [];
  let activeTurnId = null;

  const playTurn = async (turnPayload) => {
    if (shared.done) return;
    const turnUser = Number(turnPayload?.user_id ?? turnPayload?.turn?.user_id);
    if (turnUser !== Number(userId)) return;

    const turnId = Number(turnPayload?.turn_id ?? turnPayload?.turn?.turn_id ?? 0) || null;
    if (busy) return;
    if (turnId != null && activeTurnId === turnId && turns > 0) {
      // Same turn already handled (deal + game:turn double fire).
      return;
    }

    busy = true;
    if (turnId != null) activeTurnId = turnId;
    turns += 1;
    shared.turns += 1;

    try {
      await waitUntilTurnStarted(turnPayload);
      if (shared.done) return;
      if (pickDelayMs) await sleep(pickDelayMs);

      const auto = await emitAck(socket, 'player:autogroup', { session_id: sessionId });
      let groups = groupsFromAck(auto);
      if (!groups.length && lastHandGroups.length) groups = lastHandGroups;

      let hasPicked = turnPayload?.has_picked === true || turnPayload?.turn?.has_picked === true;
      let pickedUid = turnPayload?.picked_card_uid || turnPayload?.turn?.picked_card_uid || null;

      if (!hasPicked) {
        let pickOk = false;
        for (let attempt = 1; attempt <= actionRetries; attempt += 1) {
          if (shared.done) return;
          const pickAck = await emitAck(socket, 'player:pick', {
            session_id: sessionId,
            source: 'closed',
            groups,
          });
          if (pickAck.ok) {
            pickOk = true;
            shared.picksOk += 1;
            pickedUid = pickAck.ack?.data?.picked_card?.card_uid || null;
            const afterPickGroups = groupsFromAck(pickAck);
            if (afterPickGroups.length) {
              groups = afterPickGroups;
              lastHandGroups = afterPickGroups;
            }
            hasPicked = true;
            break;
          }

          const errMsg = pickAck.error || 'pick_failed';
          if (isAlreadyPickedError(errMsg)) {
            hasPicked = true;
            pickOk = true;
            break;
          }

          pushError(shared, `${label}:pick:${errMsg}`);
          shared.picksFail += 1;
          if (!isRetryableActionError(errMsg) || attempt >= actionRetries) break;
          await sleep(200 * attempt);
          await waitUntilTurnStarted(turnPayload);
        }
        if (!pickOk && !hasPicked) return;
      }

      if (discardDelayMs) await sleep(discardDelayMs);
      if (shared.done) return;

      let discardUid = pickedUid;
      let allUids = cardUidsFromGroups(groups);
      if (!discardUid || !allUids.includes(discardUid)) {
        discardUid = allUids[allUids.length - 1] || allUids[0] || null;
      }

      for (let attempt = 1; attempt <= actionRetries; attempt += 1) {
        if (shared.done) return;
        if (!discardUid) {
          // Refresh groups once if we somehow have no card uid.
          const auto2 = await emitAck(socket, 'player:autogroup', { session_id: sessionId });
          groups = groupsFromAck(auto2);
          allUids = cardUidsFromGroups(groups);
          discardUid = allUids[allUids.length - 1] || allUids[0] || null;
          if (!discardUid) {
            pushError(shared, `${label}:discard:no_card`);
            shared.discardsFail += 1;
            return;
          }
        }

        const fromGroup = groups.find((g) => (g.cards || []).includes(discardUid));
        const discardAck = await emitAck(socket, 'player:discard', {
          session_id: sessionId,
          card_uid: discardUid,
          from_group_id: fromGroup?.group_id || null,
          groups,
        });
        if (discardAck.ok) {
          shared.discardsOk += 1;
          const after = groupsFromAck(discardAck);
          if (after.length) lastHandGroups = after;
          return;
        }

        const errMsg = discardAck.error || 'discard_failed';
        pushError(shared, `${label}:discard:${errMsg}`);
        shared.discardsFail += 1;
        if (!isRetryableActionError(errMsg) || attempt >= actionRetries) return;
        await sleep(250 * attempt);
      }
    } catch (err) {
      pushError(shared, `${label}:turn:${err.message}`);
    } finally {
      busy = false;
    }
  };

  socket.on('game:turn', (payload) => {
    playTurn(payload?.turn || payload).catch(() => {});
  });

  socket.on('game:deal', (payload) => {
    const turn = payload?.turn || payload?.game_state?.turn;
    if (turn) playTurn(turn).catch(() => {});
  });

  socket.on('game:declare:requested', async () => {
    try {
      await emitAck(socket, 'player:declare:response', {
        session_id: sessionId,
        groups: lastHandGroups,
      });
    } catch (_) {
      // ignore
    }
    shared.declareEvents += 1;
  });

  socket.on('game:declare:state', async (payload) => {
    const needsResponse = Array.isArray(payload?.pending_user_ids)
      ? payload.pending_user_ids.map(Number).includes(Number(userId))
      : true;
    if (!needsResponse) return;
    try {
      await emitAck(socket, 'player:declare:response', {
        session_id: sessionId,
        groups: lastHandGroups,
      });
    } catch (_) {
      // ignore
    }
  });

  socket.on('game:result', (payload) => {
    if (shared.done) return;
    shared.done = true;
    shared.result = payload;
    shared.endedAt = Date.now();
    shared.endReason = payload?.reason || payload?.result_reason || 'game:result';
  });

  return {
    getTurns: () => turns,
    forceDrop: async () => {
      await emitAck(socket, 'player:drop', { session_id: sessionId });
    },
  };
}

async function runOneTable(tableIndex, seatsTokens) {
  const startedAt = Date.now();
  const shared = {
    done: false,
    result: null,
    endReason: null,
    endedAt: null,
    turns: 0,
    picksOk: 0,
    picksFail: 0,
    discardsOk: 0,
    discardsFail: 0,
    declareEvents: 0,
    errors: [],
    errorCounts: {},
    sessionId: null,
  };

  const seatsNeeded = mode === 'vs-bot' ? 1 : 2;
  const clients = [];
  for (let i = 0; i < seatsNeeded; i += 1) {
    const c = await connectClient(seatsTokens[i], `T${tableIndex}:${i === 0 ? 'A' : 'B'}`);
    if (!c.ok) {
      return {
        ok: false,
        table: tableIndex,
        error: `connect_failed:${c.error}`,
        ms: Date.now() - startedAt,
        shared,
      };
    }
    clients.push(c);
  }

  const creator = clients[0];
  const created = await postJson(
    '/api/gameplay/sessions',
    {
      game_id: gameId,
      contest_id: contestId,
      max_players: maxPlayers,
      metadata: { load_test_gameplay: true, table: tableIndex, mode },
    },
    creator.token,
  );

  const sessionId = Number(created.json?.session?.id);
  if (!sessionId) {
    for (const c of clients) c.socket.close();
    return {
      ok: false,
      table: tableIndex,
      error: `create_session:${created.status}:${created.json?.message || JSON.stringify(created.json).slice(0, 120)}`,
      ms: Date.now() - startedAt,
      shared,
    };
  }
  shared.sessionId = sessionId;

  // Attach listeners before ready so we never miss game:deal / first game:turn.
  const controllers = clients.map((c) => attachAutoPlayer(c, sessionId, shared));

  for (const c of clients) {
    const join = await emitAck(c.socket, 'session:join', { session_id: sessionId });
    if (!join.ok) {
      pushError(shared, `${c.label}:join:${join.error}`);
    }
    const ready = await emitAck(c.socket, 'player:ready', { session_id: sessionId, ready: true });
    if (!ready.ok) {
      const msg = String(ready.error || '');
      // Pregame orchestrator often owns ready — not a hard failure.
      if (!/managed automatically/i.test(msg)) {
        pushError(shared, `${c.label}:ready:${ready.error}`);
      }
    }
  }

  // vs-bot: wait for server bot inject + deal; dual: both ready should start countdown/deal
  const deadline = startedAt + maxGameSeconds * 1000;
  while (!shared.done && Date.now() < deadline) {
    await sleep(500);
  }

  if (!shared.done) {
    // Force end so we don't leave zombie tables under load.
    for (const ctrl of controllers) {
      try {
        await ctrl.forceDrop();
      } catch (_) {
        // ignore
      }
    }
    const dropWaitUntil = Date.now() + 20000;
    while (!shared.done && Date.now() < dropWaitUntil) {
      await sleep(300);
    }
    if (!shared.done) {
      shared.endReason = 'timeout_no_result';
    }
  }

  for (const c of clients) {
    try {
      c.socket.removeAllListeners();
      c.socket.close();
    } catch (_) {
      // ignore
    }
  }

  const ok = Boolean(shared.result) || shared.endReason === 'timeout_no_result';
  // timeout_no_result counts as soft-fail for summary
  return {
    ok: Boolean(shared.result),
    softTimeout: !shared.result && shared.endReason === 'timeout_no_result',
    table: tableIndex,
    sessionId,
    ms: Date.now() - startedAt,
    turns: shared.turns,
    picksOk: shared.picksOk,
    picksFail: shared.picksFail,
    discardsOk: shared.discardsOk,
    discardsFail: shared.discardsFail,
    declareEvents: shared.declareEvents,
    endReason: shared.endReason || (shared.result ? 'result' : 'unknown'),
    errors: shared.errors.slice(0, 12),
    errorCounts: shared.errorCounts,
  };
}

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function runner() {
    while (idx < items.length) {
      const my = idx;
      idx += 1;
      results[my] = await worker(items[my], my);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runner()));
  return results;
}

(async () => {
  const seatsPerTable = mode === 'vs-bot' ? 1 : 2;
  const needTokens = tables * seatsPerTable;
  const tokens = loadTokens(tokensPath, needTokens);
  if (tokens.length < needTokens) {
    console.error(`Need ${needTokens} tokens for ${tables} tables (mode=${mode}), found ${tokens.length}`);
    process.exit(1);
  }

  console.log('[LOAD_GAMEPLAY] starting', {
    url: baseUrl,
    mode,
    tables,
    concurrency,
    gameId,
    contestId,
    maxGameSeconds,
    pickDelayMs,
    discardDelayMs,
    actionRetries,
    tokens: tokens.length,
  });

  const tableJobs = [];
  for (let t = 0; t < tables; t += 1) {
    const offset = t * seatsPerTable;
    tableJobs.push(tokens.slice(offset, offset + seatsPerTable));
  }

  const t0 = Date.now();
  const results = await runPool(tableJobs, concurrency, (seatTokens, index) =>
    runOneTable(index + 1, seatTokens),
  );

  const ok = results.filter((r) => r.ok).length;
  const softTimeout = results.filter((r) => r.softTimeout).length;
  const failed = results.length - ok;
  const durations = results.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => durations[Math.min(durations.length - 1, Math.floor((p / 100) * durations.length))] || null;
  const totalTurns = results.reduce((s, r) => s + (r.turns || 0), 0);
  const picksOk = results.reduce((s, r) => s + (r.picksOk || 0), 0);
  const picksFail = results.reduce((s, r) => s + (r.picksFail || 0), 0);
  const discardsOk = results.reduce((s, r) => s + (r.discardsOk || 0), 0);
  const discardsFail = results.reduce((s, r) => s + (r.discardsFail || 0), 0);

  const mergedErrors = {};
  for (const r of results) {
    for (const [k, v] of Object.entries(r.errorCounts || {})) {
      mergedErrors[k] = (mergedErrors[k] || 0) + v;
    }
  }
  const topErrors = Object.entries(mergedErrors)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([error, count]) => ({ error, count }));

  const failSamples = results.filter((r) => !r.ok).slice(0, 15).map((r) => ({
    table: r.table,
    error: r.error || r.endReason,
    errors: r.errors,
    sessionId: r.sessionId,
  }));

  console.log('[LOAD_GAMEPLAY] summary', {
    tables,
    ok,
    failed,
    soft_timeout_drop: softTimeout,
    total_turns: totalTurns,
    picks_ok: picksOk,
    picks_fail: picksFail,
    discards_ok: discardsOk,
    discards_fail: discardsFail,
    avg_turns_per_table: Number((totalTurns / Math.max(1, tables)).toFixed(1)),
    elapsed_s: Number(((Date.now() - t0) / 1000).toFixed(1)),
    game_ms_p50: pct(50),
    game_ms_p95: pct(95),
    game_ms_p99: pct(99),
    top_errors: topErrors,
    fail_samples: failSamples,
  });

  process.exit(failed > tables * 0.2 ? 2 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
