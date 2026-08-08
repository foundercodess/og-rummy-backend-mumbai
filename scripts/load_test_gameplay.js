#!/usr/bin/env node
'use strict';

/**
 * Fully scripted gameplay stress test — no human players.
 *
 * Spawns N parallel tables (2–6 seats). Seats are JWT clients from
 * load_tokens.jsonl that auto pick/discard until game:result (or timeout → drop).
 *
 * Writes detailed per-table JSONL + summary JSON (errors, stolen games, root causes).
 *
 * Prep (fund wallets for entry fees):
 *   node scripts/load_test_prepare_users.js --allow-remote-db --count 200 --fund 10000 --out load_tokens.jsonl
 *   # 6P parallel run (separate users — do not reuse active 2P tokens):
 *   node scripts/load_test_prepare_users.js --allow-remote-db --start 1001 --count 600 --fund 10000 --out load_tokens_6p.jsonl
 *
 * Example (2P):
 *   node scripts/load_test_gameplay.js \
 *     --url http://og-rummy-alb-791534744.ap-south-1.elb.amazonaws.com \
 *     --tokens load_tokens.jsonl \
 *     --game-id 3 --contest-id 198 \
 *     --tables 200 --max-players 2 \
 *     --concurrency 80 --max-game-seconds 300 \
 *     --report-dir ./load_reports --report-prefix alb_200
 *
 * Example (6P Points — contest 199 is 6-seat twin of 198):
 *   node scripts/load_test_gameplay.js \
 *     --url http://og-rummy-alb-791534744.ap-south-1.elb.amazonaws.com \
 *     --tokens load_tokens_6p.jsonl \
 *     --game-id 3 --contest-id 199 \
 *     --tables 50 --max-players 6 \
 *     --concurrency 20 --hold-seconds 6 --target-active-tables 50 \
 *     --max-game-seconds 300 \
 *     --report-dir ./load_reports --report-prefix load_pts_6p_50
 *
 * Flags:
 *   --url                API base URL
 *   --tokens             JSONL from prepare script
 *   --game-id            Required
 *   --contest-id         Required (use contests.6 id for --max-players 6)
 *   --tables             Parallel tables (default 10)
 *   --concurrency        Tables started at once (default 5). Keep ≤100 on current ALB.
 *   --max-players        Seats per table (2–6, default 2)
 *   --max-game-seconds   Force drop if no result (default 300)
 *   --pick-delay-ms      Pause after turn start before pick (default 250)
 *   --discard-delay-ms   Pause before discard (default 350)
 *   --action-retries     Retries for pick/discard on transient errors (default 5)
 *   --create-retries     Retries for POST /sessions on timeout (default 4)
 *   --mode               dual (all seats scripted) | vs-bot (1 script + server bot fill)
 *   --target-active-tables  Ramp/hold mode: simultaneous active table target
 *   --hold-seconds       Hold full target before allowing finishes (default 120)
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
const targetActiveTables = Math.max(0, Number(arg('target-active-tables', '0')) || 0);
const holdSeconds = Math.max(0, Number(arg('hold-seconds', '120')) || 0);
const gameId = Number(arg('game-id', process.env.LOAD_TEST_GAME_ID));
const contestId = Number(arg('contest-id', process.env.LOAD_TEST_CONTEST_ID));
const mode = String(arg('mode', 'dual')).toLowerCase(); // dual | vs-bot
const reportDir = path.resolve(arg('report-dir', './load_reports'));
const reportPrefix = String(arg('report-prefix', 'gameplay') || 'gameplay').replace(/[^\w.-]+/g, '_');
const loadRuntime = {
  openSockets: 0,
  peakOpenSockets: 0,
  activeSessions: 0,
  peakActiveSessions: 0,
  sessionsStarted: 0,
  tablesCompleted: 0,
};
const rampControl = {
  enabled: targetActiveTables > 0,
  targetActiveTables,
  releaseFinishes: targetActiveTables <= 0,
  targetReachedAt: null,
  holdSeconds,
};

if (!tokensPath || !fs.existsSync(tokensPath)) {
  console.error('Missing --tokens <load_tokens.jsonl>');
  process.exit(1);
}
if (!Number.isFinite(gameId) || gameId <= 0 || !Number.isFinite(contestId) || contestId <= 0) {
  console.error('Required: --game-id and --contest-id (active contest with entry fee your wallets can pay)');
  process.exit(1);
}
if (maxPlayers < 2 || maxPlayers > 6) {
  console.error('--max-players must be between 2 and 6');
  process.exit(1);
}
if (mode === 'vs-bot' && maxPlayers < 2) {
  console.error('--mode vs-bot requires --max-players >= 2 (bots fill remaining seats)');
  process.exit(1);
}
if (targetActiveTables > tables) {
  console.error('--target-active-tables cannot be greater than --tables');
  process.exit(1);
}

const SEAT_LETTERS = 'ABCDEF';
function seatLabel(tableIndex, seatIndex) {
  const letter = SEAT_LETTERS[seatIndex] || String(seatIndex + 1);
  return `T${tableIndex}:${letter}`;
}
/** dual = fill every seat with scripted clients; vs-bot = 1 scripted + server bots. */
function seatsNeededPerTable() {
  return mode === 'vs-bot' ? 1 : maxPlayers;
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
  if (m.includes('no active declaration window') || m.includes('declaration window')) {
    return 'declaration_window_race';
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
      if (socket.__loadCounted !== true) {
        socket.__loadCounted = true;
        loadRuntime.openSockets += 1;
        loadRuntime.peakOpenSockets = Math.max(
          loadRuntime.peakOpenSockets,
          loadRuntime.openSockets,
        );
        socket.once('disconnect', () => {
          if (socket.__loadCounted === true) {
            socket.__loadCounted = false;
            loadRuntime.openSockets = Math.max(0, loadRuntime.openSockets - 1);
          }
        });
      }
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
  const groups = groupingFromAck(ack)?.groups || [];
  return (groups || []).map((g, idx) => ({
    group_id: g.group_id || idx + 1,
    cards: (g.cards || []).map((c) => (typeof c === 'string' ? c : c.card_uid)).filter(Boolean),
  })).filter((g) => g.cards.length > 0);
}

function groupingFromAck(ack) {
  const data = ack?.ack?.data;
  if (data?.grouping && typeof data.grouping === 'object') return data.grouping;
  if (Array.isArray(data?.groups)) {
    return {
      groups: data.groups,
      ungrouped_cards: data.ungrouped_cards || [],
      summary: data.summary || {},
    };
  }
  return null;
}

function cardUid(card) {
  return typeof card === 'string' ? card : card?.card_uid;
}

function estimatedCardPoints(card) {
  if (!card || typeof card === 'string') return 0;
  if (
    card.is_joker === true
    || card.is_wild_joker === true
    || card.is_printed_joker === true
    || String(card.suit || '').toLowerCase().includes('joker')
  ) {
    return -1; // retain zero-point jokers
  }
  const explicit = Number(card.points ?? card.point_value ?? card.card_points);
  if (Number.isFinite(explicit)) return explicit;
  const rank = String(card.rank ?? card.value ?? '').toUpperCase();
  if (rank === 'A' || rank === 'K' || rank === 'Q' || rank === 'J') return 10;
  const numeric = Number(rank);
  return Number.isFinite(numeric) ? Math.min(10, numeric) : 0;
}

function selectStrategicDiscard(ack, pickedUid) {
  const grouping = groupingFromAck(ack);
  if (!grouping) return { cardUid: pickedUid || null, reason: 'no_grouping_fallback' };

  // Best-grouping output explicitly exposes cards outside valid melds. Discard
  // the highest-cost one so the hand evolves instead of always throwing back
  // the card just picked.
  let candidates = Array.isArray(grouping.ungrouped_cards)
    ? grouping.ungrouped_cards.filter((card) => cardUid(card))
    : [];

  if (!candidates.length) {
    candidates = (grouping.groups || [])
      .filter((group) => group?.is_valid_meld !== true)
      .flatMap((group) => group?.cards || [])
      .filter((card) => cardUid(card));
  }

  if (!candidates.length) {
    return { cardUid: pickedUid || null, reason: 'no_ungrouped_fallback' };
  }

  candidates.sort((left, right) => {
    const pointsDiff = estimatedCardPoints(right) - estimatedCardPoints(left);
    if (pointsDiff !== 0) return pointsDiff;
    // On equal cost, retain the newly picked card so hands change over time.
    const leftPicked = cardUid(left) === pickedUid ? 1 : 0;
    const rightPicked = cardUid(right) === pickedUid ? 1 : 0;
    return leftPicked - rightPicked;
  });

  return {
    cardUid: cardUid(candidates[0]),
    reason: 'highest_point_ungrouped',
    points: estimatedCardPoints(candidates[0]),
  };
}

function finishPlanFromAck(ack) {
  const plan = ack?.ack?.data?.finish_plan;
  if (!plan || plan.valid_for_declare_after_finish !== true) return null;
  const finishCard = plan.finish_card;
  const finishCardUid = typeof finishCard === 'string'
    ? finishCard
    : finishCard?.card_uid;
  if (!finishCardUid || !Array.isArray(plan.submitted_groups) || !plan.submitted_groups.length) {
    return null;
  }
  return {
    finishCardUid,
    submittedGroups: plan.submitted_groups,
  };
}

function normalizeGroups(groups) {
  return (groups || []).map((g, idx) => ({
    group_id: g.group_id || idx + 1,
    cards: (g.cards || [])
      .map((c) => (typeof c === 'string' ? c : c?.card_uid))
      .filter(Boolean),
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
    // Opponent/bot win is normal in vs-bot; flag dual when winner is outside scripted seats.
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
  let declareResponseSent = false;
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
      let finishPlan = finishPlanFromAck(auto);
      let latestGroupingAck = auto;
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
            finishPlan = finishPlanFromAck(pickAck);
            latestGroupingAck = pickAck;
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

      // The server computes a valid finish plan after a pick. Use it instead of
      // endlessly discarding so scripted seats can naturally complete games.
      if (finishPlan && !rampControl.releaseFinishes) {
        // During ramp/hold, keep the table alive. The same hand continues
        // playing and can produce another finish plan after release.
        shared.finishSuppressed += 1;
      } else if (finishPlan) {
        const finishGroups = normalizeGroups(finishPlan.submittedGroups);
        lastHandGroups = finishGroups;
        shared.finishAttempts += 1;
        const finishAck = await emitAck(socket, 'player:finish', {
          session_id: sessionId,
          card_uid: finishPlan.finishCardUid,
          groups: finishGroups,
        });
        if (finishAck.ok) {
          shared.finishOk += 1;
          return;
        }

        shared.finishFail += 1;
        pushDetailedError(shared, {
          seat: label,
          event: 'player:finish',
          message: finishAck.error || 'finish_failed',
          turnId,
          attempt: 1,
          extra: { source, finish_card_uid: finishPlan.finishCardUid },
        });
        // If the finish raced with another terminal event, do not send a stale discard.
        if (isBenignRaceError(finishAck.error) || shared.done) return;
      }

      const discardDecision = selectStrategicDiscard(latestGroupingAck, pickedUid);
      let discardUid = discardDecision.cardUid;
      shared.discardStrategies[discardDecision.reason] =
        (shared.discardStrategies[discardDecision.reason] || 0) + 1;
      let allUids = cardUidsFromGroups(groups);
      if (!discardUid || !allUids.includes(discardUid)) {
        // The grouping response is authoritative, but retain a safe fallback if
        // an older deployment omits ungrouped card metadata.
        discardUid = pickedUid && allUids.includes(pickedUid)
          ? pickedUid
          : (allUids[allUids.length - 1] || allUids[0] || null);
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

  const submitDeclareResponse = async (source) => {
    if (declareResponseSent || shared.done) return;
    declareResponseSent = true;
    try {
      const response = await emitAck(socket, 'player:declare:response', {
        session_id: sessionId,
        groups: lastHandGroups,
      });
      if (!response.ok) {
        declareResponseSent = false;
        pushDetailedError(shared, {
          seat: label,
          event: 'player:declare:response',
          message: response.error || 'declare_response_failed',
          extra: { source },
        });
        return;
      }
      shared.declareResponsesOk += 1;
    } catch (err) {
      declareResponseSent = false;
      pushDetailedError(shared, {
        seat: label,
        event: 'player:declare:response',
        message: err.message,
        extra: { source },
      });
    }
    shared.declareEvents += 1;
  };

  socket.on('game:declare:requested', async (payload = {}) => {
    const pending = Array.isArray(payload.pending_user_ids)
      ? payload.pending_user_ids.map(Number)
      : null;
    const declareBy = Number(payload.declare_by_user_id);
    const shouldRespond = pending
      ? pending.includes(Number(userId))
      : (Number.isFinite(declareBy) ? declareBy === Number(userId) : payload.open_for_all === true);
    if (!shouldRespond) return;
    await submitDeclareResponse('game:declare:requested');
  });

  socket.on('game:declare:state', async (payload) => {
    const needsResponse = Array.isArray(payload?.pending_user_ids)
      ? payload.pending_user_ids.map(Number).includes(Number(userId))
      : true;
    if (!needsResponse) return;
    await submitDeclareResponse('game:declare:state');
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
    finishAttempts: 0,
    finishOk: 0,
    finishFail: 0,
    finishSuppressed: 0,
    declareEvents: 0,
    declareResponsesOk: 0,
    discardStrategies: {},
    errors: [],
    errorCounts: {},
    errorEvents: [],
    rootCauseCounts: {},
    sessionId: null,
    forcedDrop: false,
    seatUserIds: [],
  };
}

async function runOneTable(tableIndex, seatsTokens, lifecycle = {}) {
  const startedAt = Date.now();
  const shared = emptyShared();

  const seatsNeeded = seatsNeededPerTable();
  const clients = [];
  for (let i = 0; i < seatsNeeded; i += 1) {
    const label = seatLabel(tableIndex, i);
    const c = await connectClient(seatsTokens[i], label);
    if (!c.ok) {
      pushDetailedError(shared, {
        seat: label,
        event: 'connect',
        message: c.error || 'connect_failed',
      });
      for (const prior of clients) {
        try { prior.socket.close(); } catch (_) { /* ignore */ }
      }
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
  loadRuntime.sessionsStarted += 1;
  loadRuntime.activeSessions += 1;
  loadRuntime.peakActiveSessions = Math.max(
    loadRuntime.peakActiveSessions,
    loadRuntime.activeSessions,
  );

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

  if (typeof lifecycle.onStarted === 'function') {
    lifecycle.onStarted({
      table: tableIndex,
      sessionId,
      sockets: clients.length,
    });
  }

  // Play full game until result or max-game-seconds (bot-like loop).
  if (rampControl.enabled) {
    while (!shared.done && !rampControl.releaseFinishes) {
      await sleep(250);
    }
  }
  const deadline = rampControl.enabled
    ? Date.now() + maxGameSeconds * 1000
    : startedAt + maxGameSeconds * 1000;
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
  loadRuntime.activeSessions = Math.max(0, loadRuntime.activeSessions - 1);
  return buildTableResult({
    ok: Boolean(shared.result) && !stolen.stolen,
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
    finishAttempts: shared.finishAttempts,
    finishOk: shared.finishOk,
    finishFail: shared.finishFail,
    finishSuppressed: shared.finishSuppressed,
    declareEvents: shared.declareEvents,
    declareResponsesOk: shared.declareResponsesOk,
    discardStrategies: shared.discardStrategies,
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
      try {
        results[my] = await worker(items[my], my);
      } finally {
        loadRuntime.tablesCompleted += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runner()));
  return results;
}

/**
 * Admission concurrency limits only connection/session startup. Once a table
 * starts, its gameplay promise remains alive while the starter admits another
 * table. Finishes stay suppressed until the full target has been held.
 */
async function runRampHold(items, limit) {
  const targetItems = items.slice(0, targetActiveTables);
  const results = new Array(targetItems.length);
  const completions = [];
  let idx = 0;

  async function starter() {
    while (idx < targetItems.length) {
      const my = idx;
      idx += 1;

      let signalStarted;
      let signaled = false;
      const started = new Promise((resolve) => {
        signalStarted = () => {
          if (signaled) return;
          signaled = true;
          resolve();
        };
      });

      const completion = runOneTable(my + 1, targetItems[my], {
        onStarted: signalStarted,
      })
        .then((result) => {
          results[my] = result;
          return result;
        })
        .finally(() => {
          // Failed admission must release this starter slot too.
          signalStarted();
          loadRuntime.tablesCompleted += 1;
        });
      completions.push(completion);

      // Admit the next table as soon as this one is ready; do not wait for its
      // entire game to finish.
      await started;
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, targetItems.length) },
      () => starter(),
    ),
  );

  const reached = loadRuntime.activeSessions >= targetActiveTables;
  if (reached) {
    rampControl.targetReachedAt = new Date().toISOString();
    console.log('[LOAD_GAMEPLAY] target active tables reached', {
      target_active_tables: targetActiveTables,
      active_sessions: loadRuntime.activeSessions,
      open_sockets: loadRuntime.openSockets,
      hold_seconds: holdSeconds,
    });
    if (holdSeconds > 0) await sleep(holdSeconds * 1000);
  } else {
    console.warn('[LOAD_GAMEPLAY] target active tables not reached', {
      target_active_tables: targetActiveTables,
      active_sessions: loadRuntime.activeSessions,
      sessions_started: loadRuntime.sessionsStarted,
      admission_failures: targetActiveTables - loadRuntime.sessionsStarted,
    });
  }

  rampControl.releaseFinishes = true;
  console.log('[LOAD_GAMEPLAY] hold complete; natural finishes enabled', {
    active_sessions: loadRuntime.activeSessions,
    open_sockets: loadRuntime.openSockets,
  });

  await Promise.all(completions);
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
    finish_attempts: r.finishAttempts,
    finish_ok: r.finishOk,
    finish_fail: r.finishFail,
    finish_suppressed_during_hold: r.finishSuppressed,
    declare_events: r.declareEvents,
    declare_responses_ok: r.declareResponsesOk,
    discard_strategies: r.discardStrategies,
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
  const mergedDiscardStrategies = {};
  for (const r of results) {
    for (const [k, v] of Object.entries(r.errorCounts || {})) {
      mergedErrors[k] = (mergedErrors[k] || 0) + v;
    }
    for (const [k, v] of Object.entries(r.rootCauseCounts || {})) {
      mergedRootCauses[k] = (mergedRootCauses[k] || 0) + v;
    }
    for (const [k, v] of Object.entries(r.discardStrategies || {})) {
      mergedDiscardStrategies[k] = (mergedDiscardStrategies[k] || 0) + v;
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
    finish_attempts: results.reduce((s, r) => s + (r.finishAttempts || 0), 0),
    finish_ok: results.reduce((s, r) => s + (r.finishOk || 0), 0),
    finish_fail: results.reduce((s, r) => s + (r.finishFail || 0), 0),
    finish_suppressed_during_hold: results.reduce((s, r) => s + (r.finishSuppressed || 0), 0),
    declare_responses_ok: results.reduce((s, r) => s + (r.declareResponsesOk || 0), 0),
    discard_strategies: mergedDiscardStrategies,
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
  const seatsPerTable = seatsNeededPerTable();
  const effectiveTables = rampControl.enabled ? targetActiveTables : tables;
  const needTokens = effectiveTables * seatsPerTable;
  const tokens = loadTokens(tokensPath, needTokens);
  if (tokens.length < needTokens) {
    console.error(
      `Need ${needTokens} tokens for ${effectiveTables} tables `
      + `(mode=${mode}, max_players=${maxPlayers}, seats_per_table=${seatsPerTable}), `
      + `found ${tokens.length}`,
    );
    process.exit(1);
  }

  console.log('[LOAD_GAMEPLAY] starting', {
    url: baseUrl,
    mode,
    tables,
    maxPlayers,
    seatsPerTable,
    concurrency,
    gameId,
    contestId,
    maxGameSeconds,
    pickDelayMs,
    discardDelayMs,
    actionRetries,
    createRetries,
    rampHoldMode: rampControl.enabled,
    targetActiveTables: rampControl.enabled ? targetActiveTables : null,
    holdSeconds: rampControl.enabled ? holdSeconds : null,
    reportDir,
    reportPrefix,
    tokens: tokens.length,
  });

  const tableJobs = [];
  for (let t = 0; t < effectiveTables; t += 1) {
    const offset = t * seatsPerTable;
    tableJobs.push(tokens.slice(offset, offset + seatsPerTable));
  }

  const t0 = Date.now();
  const progressTimer = setInterval(() => {
    console.log('[LOAD_GAMEPLAY] progress', {
      sessions_started: loadRuntime.sessionsStarted,
      active_sessions: loadRuntime.activeSessions,
      peak_active_sessions: loadRuntime.peakActiveSessions,
      open_sockets: loadRuntime.openSockets,
      peak_open_sockets: loadRuntime.peakOpenSockets,
      tables_completed: loadRuntime.tablesCompleted,
      target_tables: effectiveTables,
    });
  }, 10000);
  progressTimer.unref?.();

  const results = rampControl.enabled
    ? await runRampHold(tableJobs, concurrency)
    : await runPool(tableJobs, concurrency, (seatTokens, index) =>
      runOneTable(index + 1, seatTokens),
    );
  clearInterval(progressTimer);

  const { jsonlPath, summaryPath, summary } = writeReports(results, {
    url: baseUrl,
    mode,
    game_id: gameId,
    contest_id: contestId,
    max_players: maxPlayers,
    seats_per_table: seatsPerTable,
    concurrency,
    max_game_seconds: maxGameSeconds,
    ramp_hold_mode: rampControl.enabled,
    target_active_tables: rampControl.enabled ? targetActiveTables : null,
    hold_seconds: rampControl.enabled ? holdSeconds : null,
    target_reached_at: rampControl.targetReachedAt,
    elapsed_s: Number(((Date.now() - t0) / 1000).toFixed(1)),
    started_at: new Date(t0).toISOString(),
    finished_at: new Date().toISOString(),
    peak_active_sessions: loadRuntime.peakActiveSessions,
    peak_open_sockets: loadRuntime.peakOpenSockets,
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
    finish_attempts: summary.finish_attempts,
    finish_ok: summary.finish_ok,
    finish_fail: summary.finish_fail,
    finish_suppressed_during_hold: summary.finish_suppressed_during_hold,
    declare_responses_ok: summary.declare_responses_ok,
    discard_strategies: summary.discard_strategies,
    avg_turns_per_table: summary.avg_turns_per_table,
    elapsed_s: summary.elapsed_s,
    game_ms_p50: summary.game_ms_p50,
    game_ms_p95: summary.game_ms_p95,
    game_ms_p99: summary.game_ms_p99,
    root_causes: summary.root_causes,
    top_errors: summary.top_errors,
    fail_samples: summary.fail_samples,
    stolen_samples: summary.stolen_samples,
    peak_active_sessions: summary.peak_active_sessions,
    peak_open_sockets: summary.peak_open_sockets,
    report_jsonl: jsonlPath,
    report_summary: summaryPath,
  });

  process.exit(summary.failed > effectiveTables * 0.2 ? 2 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
