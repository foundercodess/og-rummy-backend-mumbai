#!/usr/bin/env node
'use strict';

/**
 * Fully scripted gameplay stress test — no human players.
 *
 * Spawns N parallel 2-seat tables. Both seats are JWT clients from
 * load_tokens.jsonl that auto pick/discard until game:result (or timeout → drop).
 *
 * Writes detailed per-table JSONL + summary JSON (errors, stolen games, root causes).
 *
 * Prep (fund wallets for entry fees):
 *   node scripts/load_test_prepare_users.js --allow-remote-db --count 200 --fund 10000 --out load_tokens.jsonl
 *
 * Example:
 *   node scripts/load_test_gameplay.js \
 *     --url http://og-rummy-alb-791534744.ap-south-1.elb.amazonaws.com \
 *     --tokens load_tokens.jsonl \
 *     --game-id 3 \
 *     --contest-id 198 \
 *     --tables 200 \
 *     --concurrency 80 \
 *     --max-game-seconds 300 \
 *     --report-dir ./load_reports \
 *     --report-prefix alb_200
 *
 * Flags:
 *   --url                API base URL
 *   --tokens             JSONL from prepare script
 *   --game-id            Required
 *   --contest-id         Required
 *   --tables             Parallel tables (default 10)
 *   --concurrency        Tables started at once (default 5). Keep ≤100 on current ALB.
 *   --max-players        Seats per table (default 2; only 2 supported)
 *   --max-game-seconds   Force drop if no result (default 300)
 *   --pick-delay-ms      Pause after turn start before pick (default 250)
 *   --discard-delay-ms   Pause before discard (default 350)
 *   --action-retries     Retries for pick/discard on transient errors (default 5)
 *   --create-retries     Retries for POST /sessions on timeout (default 4)
 *   --mode               dual (2 scripts) | vs-bot (1 script + server bot fill)
 *   --report-dir         Directory for JSONL + summary (default ./load_reports)
 *   --report-prefix      Filename prefix (default gameplay)
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
const maxGameSeconds = Math.max(30, Number(arg('max-game-seconds', '300')) || 300);
const pickDelayMs = Math.max(0, Number(arg('pick-delay-ms', '250')) || 0);
const discardDelayMs = Math.max(0, Number(arg('discard-delay-ms', '350')) || 0);
const actionRetries = Math.max(1, Number(arg('action-retries', '5')) || 5);
const createRetries = Math.max(1, Number(arg('create-retries', '4')) || 4);
const gameId = Number(arg('game-id', process.env.LOAD_TEST_GAME_ID));
const contestId = Number(arg('contest-id', process.env.LOAD_TEST_CONTEST_ID));
const mode = String(arg('mode', 'dual')).toLowerCase(); // dual | vs-bot
const reportDir = path.resolve(arg('report-dir', './load_reports'));
const reportPrefix = String(arg('report-prefix', 'gameplay') || 'gameplay').replace(/[^\w.-]+/g, '_');

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

function classifyRootCause(message, event = '') {
  const m = String(message || '').toLowerCase();
  const ev = String(event || '').toLowerCase();
  if (
    m.includes('headers_timeout')
    || m.includes('und_err_headers_timeout')
    || m.includes('fetch failed')
    || (ev.includes('create') && (m.includes('timeout') || m.includes('econnreset') || m.includes('socket hang')))
  ) {
    return 'admit_overload';
  }
  if (m.includes('ack_timeout')) return 'server_backpressure';
  if (m.includes('connect_timeout') || m.includes('connect_error') || m.includes('websocket error')) {
    return 'connect_failure';
  }
  if (m.includes('not your turn') || m.includes('already picked') || m.includes('discard first')) {
    return 'stale_turn_race';
  }
  if (m.includes('session is not active') || m.includes('session not found') || m.includes('not active')) {
    return 'session_already_ended';
  }
  if (m.includes('must pick') || m.includes('before discarding') || m.includes('no_card')) {
    return 'action_order';
  }
  if (m.includes('session is full')) return 'matchmaking_conflict';
  if (m.includes('insufficient') || m.includes('balance')) return 'wallet_balance';
  if (m.includes('timeout_no_result') || m.includes('forced_drop')) return 'game_timeout';
  return 'unknown';
}

function isBenignRaceError(msg) {
  const m = String(msg || '').toLowerCase();
  return m.includes('not your turn')
    || m.includes('already picked')
    || m.includes('discard first')
    || m.includes('session is not active');
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

function isRetryableCreateError(err) {
  const m = String(err || '').toLowerCase();
  return m.includes('timeout')
    || m.includes('fetch failed')
    || m.includes('econnreset')
    || m.includes('socket hang')
    || m.includes('network')
    || m.includes('503')
    || m.includes('502')
    || m.includes('504');
}

function pushDetailedError(shared, {
  seat = null,
  event = null,
  message,
  turnId = null,
  attempt = null,
  extra = null,
}) {
  const rootCause = classifyRootCause(message, event);
  const entry = {
    ts: new Date().toISOString(),
    seat,
    event,
    message: String(message || 'unknown'),
    root_cause: rootCause,
    turn_id: turnId,
    attempt,
    ...(extra && typeof extra === 'object' ? { extra } : {}),
  };
  shared.errorEvents.push(entry);
  shared.rootCauseCounts[rootCause] = (shared.rootCauseCounts[rootCause] || 0) + 1;

  const key = `${seat || 'T'}:${event || 'err'}:${message}`;
  shared.errors.push(key);
  shared.errorCounts[key] = (shared.errorCounts[key] || 0) + 1;
  return entry;
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

async function postJson(urlPath, body, token, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok || res.status < 500, status: res.status, json, error: null };
  } catch (err) {
    const cause = err?.cause?.code || err?.cause?.message || '';
    const message = err?.name === 'AbortError'
      ? 'headers_timeout'
      : `${err.message}${cause ? `:${cause}` : ''}`;
    return { ok: false, status: 0, json: {}, error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function createSessionWithRetry(token, tableIndex, shared) {
  let last = null;
  for (let attempt = 1; attempt <= createRetries; attempt += 1) {
    last = await postJson(
      '/api/gameplay/sessions',
      {
        game_id: gameId,
        contest_id: contestId,
        max_players: maxPlayers,
        metadata: { load_test_gameplay: true, table: tableIndex, mode },
      },
      token,
      30000,
    );
    const sessionId = Number(last.json?.session?.id);
    if (sessionId) return { ok: true, sessionId, status: last.status, attempt };

    const errMsg = last.error
      || last.json?.message
      || `http_${last.status}`
      || 'create_failed';
    pushDetailedError(shared, {
      seat: `T${tableIndex}:A`,
      event: 'create_session',
      message: errMsg,
      attempt,
    });
    if (!isRetryableCreateError(errMsg) && last.status > 0 && last.status < 500) {
      break;
    }
    await sleep(250 * attempt);
  }
  return {
    ok: false,
    sessionId: null,
    status: last?.status || 0,
    error: last?.error || last?.json?.message || 'create_failed',
  };
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

async function waitUntilTurnStarted(turnPayload) {
  const startedAt = Date.parse(turnPayload?.started_at || '');
  if (Number.isNaN(startedAt)) return;
  const waitMs = startedAt - Date.now() + 75;
  if (waitMs > 0) await sleep(Math.min(waitMs, 8000));
}

function summarizeResult(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const players = payload.players || payload.results || payload.scoreboard || null;
  return {
    reason: payload.reason || payload.result_reason || payload.end_reason || null,
    winner_user_id: payload.winner_user_id ?? payload.winner?.user_id ?? payload.winner_id ?? null,
    declared_by: payload.declared_by ?? payload.declarer_user_id ?? null,
    players: Array.isArray(players)
      ? players.slice(0, 8).map((p) => ({
        user_id: p.user_id ?? p.id ?? null,
        points: p.points ?? p.score ?? p.display_points ?? null,
        status: p.status ?? p.result ?? null,
        is_bot: p.is_bot ?? p.bot ?? null,
      }))
      : null,
    raw_keys: Object.keys(payload).slice(0, 24),
  };
}

function detectStolen(shared, seatUserIds) {
  const end = String(shared.endReason || '').toLowerCase();
  const hasResult = Boolean(shared.result);
  const forcedTimeout = !hasResult && (
    end === 'timeout_no_result' || shared.forcedDrop === true
  );

  if (forcedTimeout) {
    return {
      stolen: true,
      stolen_reason: 'timeout_no_result',
      root_cause: 'game_timeout',
    };
  }

  if (shared.forcedDrop && hasResult) {
    return {
      stolen: true,
      stolen_reason: 'forced_drop_before_natural_end',
      root_cause: 'game_timeout',
    };
  }

  const winner = Number(
    shared.result?.winner_user_id
    ?? shared.result?.winner?.user_id
    ?? shared.result?.winner_id
    ?? NaN,
  );
  if (hasResult && Number.isFinite(winner) && seatUserIds.length && !seatUserIds.includes(winner)) {
    // Opponent/bot win is normal in vs-bot; only flag dual when winner is outside both seats.
    if (mode === 'dual') {
      return {
        stolen: true,
        stolen_reason: 'winner_outside_scripted_seats',
        root_cause: 'unexpected_winner',
      };
    }
  }

  const severe = (shared.errorEvents || []).filter((e) => (
    e.root_cause === 'admit_overload'
    || e.root_cause === 'server_backpressure'
    || e.root_cause === 'connect_failure'
  ));
  if (!hasResult && severe.length > 0) {
    return {
      stolen: true,
      stolen_reason: 'ended_without_result_after_infra_errors',
      root_cause: severe[0].root_cause,
    };
  }

  return { stolen: false, stolen_reason: null, root_cause: null };
}

/**
 * Auto-play one seat until game ends or deadline (bot-like pick/discard loop).
 */
function attachAutoPlayer(seat, sessionId, shared) {
  const { socket, user_id: userId, label } = seat;
  let busy = false;
  let turns = 0;
  let lastHandGroups = [];
  let activeTurnId = null;
  const handledTurnIds = new Set();

  const playTurn = async (turnPayload, source) => {
    if (shared.done) return;
    const turnUser = Number(turnPayload?.user_id ?? turnPayload?.turn?.user_id);
    if (turnUser !== Number(userId)) return;

    const turnId = Number(turnPayload?.turn_id ?? turnPayload?.turn?.turn_id ?? 0) || null;
    if (busy) return;
    if (turnId != null) {
      if (handledTurnIds.has(turnId)) return;
      // Reserve immediately to avoid deal+turn double fire.
      handledTurnIds.add(turnId);
      activeTurnId = turnId;
    } else if (activeTurnId != null && turns > 0) {
      return;
    }

    busy = true;
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

          // Benign races: log once, do not spam retries.
          if (isBenignRaceError(errMsg)) {
            pushDetailedError(shared, {
              seat: label,
              event: 'player:pick',
              message: errMsg,
              turnId,
              attempt,
              extra: { source },
            });
            shared.picksFail += 1;
            return;
          }

          pushDetailedError(shared, {
            seat: label,
            event: 'player:pick',
            message: errMsg,
            turnId,
            attempt,
            extra: { source },
          });
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
          const auto2 = await emitAck(socket, 'player:autogroup', { session_id: sessionId });
          groups = groupsFromAck(auto2);
          allUids = cardUidsFromGroups(groups);
          discardUid = allUids[allUids.length - 1] || allUids[0] || null;
          if (!discardUid) {
            pushDetailedError(shared, {
              seat: label,
              event: 'player:discard',
              message: 'no_card',
              turnId,
              attempt,
            });
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
        if (isBenignRaceError(errMsg)) {
          pushDetailedError(shared, {
            seat: label,
            event: 'player:discard',
            message: errMsg,
            turnId,
            attempt,
            extra: { source },
          });
          shared.discardsFail += 1;
          return;
        }

        pushDetailedError(shared, {
          seat: label,
          event: 'player:discard',
          message: errMsg,
          turnId,
          attempt,
          extra: { source },
        });
        shared.discardsFail += 1;
        if (!isRetryableActionError(errMsg) || attempt >= actionRetries) return;
        await sleep(250 * attempt);
      }
    } catch (err) {
      pushDetailedError(shared, {
        seat: label,
        event: 'turn',
        message: err.message,
        turnId,
      });
    } finally {
      busy = false;
    }
  };

  socket.on('game:turn', (payload) => {
    playTurn(payload?.turn || payload, 'game:turn').catch(() => {});
  });

  socket.on('game:deal', (payload) => {
    const turn = payload?.turn || payload?.game_state?.turn;
    if (turn) playTurn(turn, 'game:deal').catch(() => {});
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
    shared.resultSummary = summarizeResult(payload);
    shared.endedAt = Date.now();
    shared.endReason = payload?.reason || payload?.result_reason || 'game:result';
  });

  return {
    getTurns: () => turns,
    forceDrop: async () => {
      shared.forcedDrop = true;
      await emitAck(socket, 'player:drop', { session_id: sessionId });
    },
  };
}

function emptyShared() {
  return {
    done: false,
    result: null,
    resultSummary: null,
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
    errorEvents: [],
    rootCauseCounts: {},
    sessionId: null,
    forcedDrop: false,
    seatUserIds: [],
  };
}

async function runOneTable(tableIndex, seatsTokens) {
  const startedAt = Date.now();
  const shared = emptyShared();

  const seatsNeeded = mode === 'vs-bot' ? 1 : 2;
  const clients = [];
  for (let i = 0; i < seatsNeeded; i += 1) {
    const c = await connectClient(seatsTokens[i], `T${tableIndex}:${i === 0 ? 'A' : 'B'}`);
    if (!c.ok) {
      pushDetailedError(shared, {
        seat: `T${tableIndex}:${i === 0 ? 'A' : 'B'}`,
        event: 'connect',
        message: c.error || 'connect_failed',
      });
      const stolen = detectStolen(shared, []);
      return buildTableResult({
        ok: false,
        table: tableIndex,
        sessionId: null,
        startedAt,
        shared,
        error: `connect_failed:${c.error}`,
        stolen,
      });
    }
    clients.push(c);
  }
  shared.seatUserIds = clients.map((c) => Number(c.user_id));

  const creator = clients[0];
  const created = await createSessionWithRetry(creator.token, tableIndex, shared);
  if (!created.ok || !created.sessionId) {
    for (const c of clients) {
      try { c.socket.close(); } catch (_) { /* ignore */ }
    }
    const stolen = detectStolen(shared, shared.seatUserIds);
    return buildTableResult({
      ok: false,
      table: tableIndex,
      sessionId: null,
      startedAt,
      shared,
      error: `create_session:${created.status}:${created.error || 'failed'}`,
      stolen: {
        stolen: true,
        stolen_reason: 'create_session_failed',
        root_cause: classifyRootCause(created.error || '', 'create_session'),
      },
    });
  }

  const sessionId = created.sessionId;
  shared.sessionId = sessionId;

  const controllers = clients.map((c) => attachAutoPlayer(c, sessionId, shared));

  for (const c of clients) {
    const join = await emitAck(c.socket, 'session:join', { session_id: sessionId });
    if (!join.ok) {
      pushDetailedError(shared, {
        seat: c.label,
        event: 'session:join',
        message: join.error || 'join_failed',
      });
    }
    const ready = await emitAck(c.socket, 'player:ready', { session_id: sessionId, ready: true });
    if (!ready.ok) {
      const msg = String(ready.error || '');
      if (!/managed automatically/i.test(msg)) {
        pushDetailedError(shared, {
          seat: c.label,
          event: 'player:ready',
          message: ready.error || 'ready_failed',
        });
      }
    }
  }

  // Play full game until result or max-game-seconds (bot-like loop).
  const deadline = startedAt + maxGameSeconds * 1000;
  while (!shared.done && Date.now() < deadline) {
    await sleep(500);
  }

  if (!shared.done) {
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
      pushDetailedError(shared, {
        seat: `T${tableIndex}`,
        event: 'timeout',
        message: 'timeout_no_result',
      });
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

  const stolen = detectStolen(shared, shared.seatUserIds);
  return buildTableResult({
    ok: Boolean(shared.result),
    table: tableIndex,
    sessionId,
    startedAt,
    shared,
    error: shared.result ? null : (shared.endReason || 'unknown'),
    stolen,
  });
}

function buildTableResult({ ok, table, sessionId, startedAt, shared, error, stolen }) {
  return {
    ok,
    softTimeout: !shared.result && shared.endReason === 'timeout_no_result',
    table,
    sessionId,
    ms: Date.now() - startedAt,
    turns: shared.turns,
    picksOk: shared.picksOk,
    picksFail: shared.picksFail,
    discardsOk: shared.discardsOk,
    discardsFail: shared.discardsFail,
    declareEvents: shared.declareEvents,
    endReason: shared.endReason || (shared.result ? 'result' : 'unknown'),
    forcedDrop: Boolean(shared.forcedDrop),
    stolen: Boolean(stolen?.stolen),
    stolenReason: stolen?.stolen_reason || null,
    stolenRootCause: stolen?.root_cause || null,
    resultSummary: shared.resultSummary,
    seatUserIds: shared.seatUserIds || [],
    errorEvents: shared.errorEvents.slice(0, 80),
    rootCauseCounts: shared.rootCauseCounts,
    errors: shared.errors.slice(0, 24),
    errorCounts: shared.errorCounts,
    error: error || null,
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

function ensureReportDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeReports(results, meta) {
  ensureReportDir(reportDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonlPath = path.join(reportDir, `${reportPrefix}_${stamp}.jsonl`);
  const summaryPath = path.join(reportDir, `${reportPrefix}_${stamp}_summary.json`);

  const lines = results.map((r) => JSON.stringify({
    table: r.table,
    session_id: r.sessionId,
    ok: r.ok,
    soft_timeout: r.softTimeout,
    stolen: r.stolen,
    stolen_reason: r.stolenReason,
    stolen_root_cause: r.stolenRootCause,
    end_reason: r.endReason,
    forced_drop: r.forcedDrop,
    duration_ms: r.ms,
    turns: r.turns,
    picks_ok: r.picksOk,
    picks_fail: r.picksFail,
    discards_ok: r.discardsOk,
    discards_fail: r.discardsFail,
    declare_events: r.declareEvents,
    seat_user_ids: r.seatUserIds,
    result: r.resultSummary,
    error: r.error,
    root_cause_counts: r.rootCauseCounts,
    errors: r.errorEvents,
  }));
  fs.writeFileSync(jsonlPath, `${lines.join('\n')}\n`, 'utf8');

  const ok = results.filter((r) => r.ok).length;
  const softTimeout = results.filter((r) => r.softTimeout).length;
  const stolen = results.filter((r) => r.stolen).length;
  const failed = results.length - ok;
  const durations = results.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => durations[Math.min(durations.length - 1, Math.floor((p / 100) * durations.length))] || null;

  const mergedErrors = {};
  const mergedRootCauses = {};
  for (const r of results) {
    for (const [k, v] of Object.entries(r.errorCounts || {})) {
      mergedErrors[k] = (mergedErrors[k] || 0) + v;
    }
    for (const [k, v] of Object.entries(r.rootCauseCounts || {})) {
      mergedRootCauses[k] = (mergedRootCauses[k] || 0) + v;
    }
  }

  const stolenReasons = {};
  for (const r of results.filter((x) => x.stolen)) {
    const key = r.stolenReason || 'unknown';
    stolenReasons[key] = (stolenReasons[key] || 0) + 1;
  }

  const topErrors = Object.entries(mergedErrors)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([error, count]) => ({ error, count, root_cause: classifyRootCause(error) }));

  const rootCauses = Object.entries(mergedRootCauses)
    .sort((a, b) => b[1] - a[1])
    .map(([root_cause, count]) => ({ root_cause, count }));

  const failSamples = results.filter((r) => !r.ok).slice(0, 20).map((r) => ({
    table: r.table,
    session_id: r.sessionId,
    error: r.error || r.endReason,
    stolen: r.stolen,
    stolen_reason: r.stolenReason,
    top_root_causes: Object.entries(r.rootCauseCounts || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([root_cause, count]) => ({ root_cause, count })),
    sample_errors: (r.errorEvents || []).slice(0, 5),
  }));

  const stolenSamples = results.filter((r) => r.stolen).slice(0, 20).map((r) => ({
    table: r.table,
    session_id: r.sessionId,
    stolen_reason: r.stolenReason,
    stolen_root_cause: r.stolenRootCause,
    end_reason: r.endReason,
    result: r.resultSummary,
  }));

  const summary = {
    ...meta,
    tables: results.length,
    ok,
    failed,
    soft_timeout_drop: softTimeout,
    stolen_games: stolen,
    stolen_reasons: stolenReasons,
    total_turns: results.reduce((s, r) => s + (r.turns || 0), 0),
    picks_ok: results.reduce((s, r) => s + (r.picksOk || 0), 0),
    picks_fail: results.reduce((s, r) => s + (r.picksFail || 0), 0),
    discards_ok: results.reduce((s, r) => s + (r.discardsOk || 0), 0),
    discards_fail: results.reduce((s, r) => s + (r.discardsFail || 0), 0),
    avg_turns_per_table: Number((results.reduce((s, r) => s + (r.turns || 0), 0) / Math.max(1, results.length)).toFixed(1)),
    game_ms_p50: pct(50),
    game_ms_p95: pct(95),
    game_ms_p99: pct(99),
    root_causes: rootCauses,
    top_errors: topErrors,
    fail_samples: failSamples,
    stolen_samples: stolenSamples,
    report_jsonl: jsonlPath,
    report_summary: summaryPath,
  };

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return { jsonlPath, summaryPath, summary };
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
    createRetries,
    reportDir,
    reportPrefix,
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

  const { jsonlPath, summaryPath, summary } = writeReports(results, {
    url: baseUrl,
    mode,
    game_id: gameId,
    contest_id: contestId,
    concurrency,
    max_game_seconds: maxGameSeconds,
    elapsed_s: Number(((Date.now() - t0) / 1000).toFixed(1)),
    started_at: new Date(t0).toISOString(),
    finished_at: new Date().toISOString(),
  });

  console.log('[LOAD_GAMEPLAY] summary', {
    tables: summary.tables,
    ok: summary.ok,
    failed: summary.failed,
    soft_timeout_drop: summary.soft_timeout_drop,
    stolen_games: summary.stolen_games,
    stolen_reasons: summary.stolen_reasons,
    total_turns: summary.total_turns,
    picks_ok: summary.picks_ok,
    picks_fail: summary.picks_fail,
    discards_ok: summary.discards_ok,
    discards_fail: summary.discards_fail,
    avg_turns_per_table: summary.avg_turns_per_table,
    elapsed_s: summary.elapsed_s,
    game_ms_p50: summary.game_ms_p50,
    game_ms_p95: summary.game_ms_p95,
    game_ms_p99: summary.game_ms_p99,
    root_causes: summary.root_causes,
    top_errors: summary.top_errors,
    fail_samples: summary.fail_samples,
    stolen_samples: summary.stolen_samples,
    report_jsonl: jsonlPath,
    report_summary: summaryPath,
  });

  process.exit(summary.failed > tables * 0.2 ? 2 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
