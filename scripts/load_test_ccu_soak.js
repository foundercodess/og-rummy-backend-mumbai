#!/usr/bin/env node
'use strict';

/**
 * CCU soak load — stakeholder capacity report.
 *
 * Goal: prove concurrent capacity (default target 50,000 CCU) by:
 *   1) opening tables × seats (sockets) up to the target
 *   2) completing a short action window (pick + discard) per table
 *   3) holding live sockets for --hold-seconds (default 300)
 *   4) writing an executive report with an explicit SUCCESS / BELOW_TARGET conclusion
 *
 * Example (50k CCU @ 6P ≈ 8334 tables / 50004 sockets):
 *   node scripts/load_test_ccu_soak.js \
 *     --url http://og-rummy-alb-791534744.ap-south-1.elb.amazonaws.com \
 *     --target-ccu 50000 --max-players 6 --game-id 3 --contest-id 199 \
 *     --concurrency 50 --hold-seconds 300 --actions-per-table 1
 *
 * Or wrapper:
 *   ./scripts/run_ccu_soak_50k.sh
 *
 * Phone prefix must match server LOAD_TEST_PHONE_PREFIX (default 97000) or fund returns 403.
 * Optional: --no-fund | --soft-fund
 *
 * Run from a dedicated load machine (not the game API hosts).
 */

const fs = require('fs');
const path = require('path');
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
  console.log(fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1]);
  process.exit(0);
}

const baseUrl = String(
  arg('url', process.env.LOAD_TEST_URL || 'http://og-rummy-alb-791534744.ap-south-1.elb.amazonaws.com'),
).replace(/\/$/, '');
const targetCcu = Math.max(1, Number(arg('target-ccu', '50000')) || 50000);
const maxPlayers = Math.max(2, Math.min(6, Number(arg('max-players', '6')) || 6));
const tablesFromCcu = Math.ceil(targetCcu / maxPlayers);
const tables = Math.max(1, Number(arg('tables', String(tablesFromCcu))) || tablesFromCcu);
const concurrency = Math.max(1, Number(arg('concurrency', '50')) || 50);
const holdSeconds = Math.max(0, Number(arg('hold-seconds', '300')) || 0);
const actionsPerTable = Math.max(1, Number(arg('actions-per-table', '1')) || 1);
const actionDeadlineSeconds = Math.max(30, Number(arg('action-deadline-seconds', '180')) || 180);
const admitDeadlineSeconds = Math.max(60, Number(arg('admit-deadline-seconds', '900')) || 900);
const gameId = Number(arg('game-id', process.env.LOAD_TEST_GAME_ID || '3'));
const contestId = Number(arg('contest-id', process.env.LOAD_TEST_CONTEST_ID || (maxPlayers >= 6 ? '199' : '198')));
const fundAmount = Math.max(0, Number(arg('fund', '10000')) || 0);
const phonePrefix = String(arg('phone-prefix', process.env.LOAD_TEST_PHONE_PREFIX || '97000'));
const phoneStart = Math.max(1, Number(arg('start', '1')) || 1);
const loginOtp = String(arg('otp', loadHttp.DEFAULT_OTP) || loadHttp.DEFAULT_OTP);
const requireFund = !flag('no-fund') && fundAmount > 0;
const softFund = flag('soft-fund'); // continue even if fund fails (entry may still fail later)
const pickDelayMs = Math.max(0, Number(arg('pick-delay-ms', '150')) || 0);
const discardDelayMs = Math.max(0, Number(arg('discard-delay-ms', '200')) || 0);
const reportDir = path.resolve(arg('report-dir', './load_reports'));
const reportPrefix = String(arg('report-prefix', `ccu_soak_${Math.round(targetCcu / 1000)}k`) || 'ccu_soak')
  .replace(/[^\w.-]+/g, '_');
const successRatio = Math.min(1, Math.max(0.5, Number(arg('success-ratio', '0.95')) || 0.95));
const holdRetentionRatio = Math.min(1, Math.max(0.5, Number(arg('hold-retention-ratio', '0.90')) || 0.90));
const progressEverySec = Math.max(5, Number(arg('progress-every-sec', '15')) || 15);

const seatsNeeded = tables * maxPlayers;
const SEAT_LETTERS = 'ABCDEF';

const runtime = {
  openSockets: 0,
  peakOpenSockets: 0,
  activeSessions: 0,
  peakActiveSessions: 0,
  tablesStarted: 0,
  tablesActionOk: 0,
  tablesActionFail: 0,
  tablesAdmitFail: 0,
  authOk: 0,
  authFail: 0,
  fundOk: 0,
  fundFail: 0,
  connectFail: 0,
  createFail: 0,
  picksOk: 0,
  picksFail: 0,
  discardsOk: 0,
  discardsFail: 0,
  holdSamples: [],
  admitErrorSamples: [],
  phase: {
    send_otp: { ok: 0, fail: 0 },
    verify_otp: { ok: 0, fail: 0 },
    fund_wallet: { ok: 0, fail: 0 },
    socket_connect: { ok: 0, fail: 0 },
    create_session: { ok: 0, fail: 0 },
    session_join: { ok: 0, fail: 0 },
    player_ready: { ok: 0, fail: 0 },
  },
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function seatLabel(tableIndex, seatIndex) {
  return `T${tableIndex}:${SEAT_LETTERS[seatIndex] || seatIndex + 1}`;
}

function padPhone(index) {
  const body = String(index).padStart(Math.max(1, 10 - phonePrefix.length), '0');
  return `${phonePrefix}${body}`.slice(0, 10);
}

function notePhase(name, ok) {
  const bucket = runtime.phase[name];
  if (!bucket) return;
  if (ok) bucket.ok += 1;
  else bucket.fail += 1;
}

function bumpSockets(delta) {
  runtime.openSockets = Math.max(0, runtime.openSockets + delta);
  runtime.peakOpenSockets = Math.max(runtime.peakOpenSockets, runtime.openSockets);
}

function emitAck(socket, event, payload = {}, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setTimeout(() => {
      resolve({ ok: false, error: `${event}:ack_timeout`, ms: Date.now() - t0, data: null });
    }, timeoutMs);
    try {
      socket.timeout(timeoutMs).emit(event, payload, (res) => {
        clearTimeout(timer);
        const ok = res && res.success !== false;
        resolve({
          ok,
          error: ok ? null : (res?.message || res?.error || `${event}:failed`),
          ms: Date.now() - t0,
          data: res?.data || res || null,
          raw: res,
        });
      });
    } catch (err) {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message || `${event}:emit_failed`, ms: Date.now() - t0, data: null });
    }
  });
}

function noteAdmitError(sample) {
  if (runtime.admitErrorSamples.length >= 25) return;
  runtime.admitErrorSamples.push({
    ts: new Date().toISOString(),
    ...sample,
  });
  if (runtime.admitErrorSamples.length <= 5) {
    console.warn('[CCU_SOAK] admit_error', sample);
  }
}

async function loginSeat(phone) {
  const sent = await loadHttp.sendOtp(baseUrl, phone);
  notePhase('send_otp', sent.ok);
  if (!sent.ok) {
    runtime.authFail += 1;
    return { ok: false, error: `send_otp:${sent.error || sent.status}` };
  }
  const loginAttemptId = sent.json?.login_attempt_id ?? sent.json?.data?.login_attempt_id ?? null;
  const verified = await loadHttp.verifyOtp(baseUrl, phone, loginOtp, loginAttemptId);
  const token = verified.json?.token || verified.json?.data?.token || null;
  const user = verified.json?.user || verified.json?.data?.user || null;
  notePhase('verify_otp', Boolean(verified.ok && token));
  if (!verified.ok || !token) {
    runtime.authFail += 1;
    return { ok: false, error: `verify_otp:${verified.error || 'failed'}` };
  }
  const bootstrap = await loadHttp.bootstrapClient(baseUrl, token);
  if (!bootstrap.ok) {
    runtime.authFail += 1;
    return { ok: false, error: `bootstrap:${bootstrap.error}` };
  }
  if (requireFund) {
    const funded = await loadHttp.fundWallet(baseUrl, token, fundAmount);
    notePhase('fund_wallet', funded.ok);
    if (!funded.ok) {
      runtime.fundFail += 1;
      const detail = funded.error
        || funded.json?.message
        || `http_${funded.status}`;
      // Server only allows LOAD_TEST_PHONE_PREFIX (default 97000). Wrong --phone-prefix → 403.
      if (!softFund) {
        return { ok: false, error: `fund:${detail}` };
      }
      console.warn('[CCU_SOAK] fund soft-fail', { phone, detail });
    } else {
      runtime.fundOk += 1;
    }
  }
  runtime.authOk += 1;
  return {
    ok: true,
    token,
    user_id: Number(user?.id) || null,
    phone,
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
    const timer = setTimeout(() => {
      socket.removeAllListeners();
      socket.close();
      resolve({ ok: false, error: 'connect_timeout', ms: Date.now() - started, socket: null, label });
    }, 25000);

    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.close();
      resolve({
        ok: false,
        error: err.message || 'connect_error',
        ms: Date.now() - started,
        socket: null,
        label,
      });
    });

    socket.on('connection:ready', (data) => {
      clearTimeout(timer);
      bumpSockets(1);
      socket.once('disconnect', () => bumpSockets(-1));
      resolve({
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

async function postJson(urlPath, body, token, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    const ok = res.ok && json.success !== false && json.status !== false;
    return {
      ok,
      status: res.status,
      json,
      error: ok ? null : (json.message || json.error || `http_${res.status}`),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      json: {},
      error: err?.name === 'AbortError' ? 'headers_timeout' : (err.message || 'fetch_failed'),
    };
  } finally {
    clearTimeout(timer);
  }
}

function groupsFromAck(ack) {
  const data = ack?.data || ack?.raw?.data || {};
  const groups = data.grouping?.groups || data.groups || [];
  return Array.isArray(groups) ? groups : [];
}

function cardUidsFromGroups(groups) {
  const out = [];
  for (const g of groups || []) {
    for (const c of g.cards || []) {
      const uid = typeof c === 'string' ? c : c?.card_uid;
      if (uid) out.push(uid);
    }
  }
  return out;
}

function attachSoakPlayer(client, sessionId, tableState) {
  const socket = client.socket;
  let busy = false;
  let lastGroups = [];

  const playOneTurn = async (turnPayload) => {
    if (busy || tableState.actionDone || tableState.closed) return;
    const turnUser = Number(turnPayload?.user_id ?? turnPayload?.current_turn_user_id);
    if (Number.isFinite(turnUser) && turnUser !== Number(client.user_id)) return;
    if (tableState.actionCycles >= actionsPerTable) {
      tableState.actionDone = true;
      return;
    }

    busy = true;
    try {
      if (pickDelayMs) await sleep(pickDelayMs);
      if (tableState.actionDone || tableState.closed) return;

      let pickOk = false;
      let pickedUid = null;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const auto = await emitAck(socket, 'player:autogroup', { session_id: sessionId });
        lastGroups = groupsFromAck(auto);
        const pick = await emitAck(socket, 'player:pick', {
          session_id: sessionId,
          source: 'closed',
        });
        if (pick.ok) {
          pickOk = true;
          runtime.picksOk += 1;
          pickedUid = pick.data?.picked_card?.card_uid || null;
          const g = groupsFromAck(pick);
          if (g.length) lastGroups = g;
          break;
        }
        runtime.picksFail += 1;
        const msg = String(pick.error || '');
        if (/already picked|discard first|not your turn/i.test(msg)) break;
        await sleep(150 * attempt);
      }
      if (!pickOk) return;

      if (discardDelayMs) await sleep(discardDelayMs);
      if (tableState.actionDone || tableState.closed) return;

      let uids = cardUidsFromGroups(lastGroups);
      let discardUid = pickedUid && uids.includes(pickedUid)
        ? pickedUid
        : (uids[uids.length - 1] || uids[0] || null);

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        if (!discardUid) {
          const auto = await emitAck(socket, 'player:autogroup', { session_id: sessionId });
          lastGroups = groupsFromAck(auto);
          uids = cardUidsFromGroups(lastGroups);
          discardUid = uids[uids.length - 1] || uids[0] || null;
        }
        if (!discardUid) {
          runtime.discardsFail += 1;
          break;
        }
        const fromGroup = lastGroups.find((g) => (g.cards || []).some((c) => (
          (typeof c === 'string' ? c : c?.card_uid) === discardUid
        )));
        const discard = await emitAck(socket, 'player:discard', {
          session_id: sessionId,
          card_uid: discardUid,
          from_group_id: fromGroup?.group_id || null,
          groups: lastGroups,
        });
        if (discard.ok) {
          runtime.discardsOk += 1;
          tableState.actionCycles += 1;
          if (tableState.actionCycles >= actionsPerTable) {
            tableState.actionDone = true;
            tableState.actionOk = true;
          }
          return;
        }
        runtime.discardsFail += 1;
        const msg = String(discard.error || '');
        if (/not your turn|must pick|already/i.test(msg)) break;
        discardUid = null;
        await sleep(150 * attempt);
      }
    } finally {
      busy = false;
    }
  };

  socket.on('game:turn', (payload) => {
    playOneTurn(payload?.turn || payload).catch(() => {});
  });
  socket.on('game:deal', (payload) => {
    const turn = payload?.turn || payload?.game_state?.turn;
    if (turn) playOneTurn(turn).catch(() => {});
  });

  return {
    stop() {
      tableState.closed = true;
      try { socket.removeAllListeners('game:turn'); } catch (_) { /* ignore */ }
      try { socket.removeAllListeners('game:deal'); } catch (_) { /* ignore */ }
    },
  };
}

async function runOneTable(tableIndex) {
  const startedAt = Date.now();
  const tableState = {
    actionCycles: 0,
    actionDone: false,
    actionOk: false,
    closed: false,
    sessionId: null,
    clients: [],
  };

  const clients = [];
  for (let s = 0; s < maxPlayers; s += 1) {
    const phone = padPhone(phoneStart + (tableIndex - 1) * maxPlayers + s);
    const logged = await loginSeat(phone);
    if (!logged.ok) {
      runtime.tablesAdmitFail += 1;
      noteAdmitError({
        table: tableIndex,
        seat: s,
        phone,
        phase: 'login',
        error: logged.error,
      });
      return {
        table: tableIndex,
        ok: false,
        phase: 'login',
        error: logged.error,
        startedAt,
        clients: [],
        tableState,
      };
    }
    const conn = await connectClient(logged, seatLabel(tableIndex, s));
    notePhase('socket_connect', conn.ok);
    if (!conn.ok) {
      runtime.connectFail += 1;
      runtime.tablesAdmitFail += 1;
      for (const c of clients) {
        try { c.socket.close(); } catch (_) { /* ignore */ }
      }
      return {
        table: tableIndex,
        ok: false,
        phase: 'connect',
        error: conn.error,
        startedAt,
        clients: [],
        tableState,
      };
    }
    clients.push(conn);
  }

  const created = await postJson(
    '/api/gameplay/sessions',
    {
      game_id: gameId,
      contest_id: contestId,
      max_players: maxPlayers,
      metadata: { load_test_ccu_soak: true, table: tableIndex },
    },
    clients[0].token,
  );
  const sessionId = Number(created.json?.session?.id);
  notePhase('create_session', Boolean(created.ok && sessionId));
  if (!created.ok || !sessionId) {
    runtime.createFail += 1;
    runtime.tablesAdmitFail += 1;
    for (const c of clients) {
      try { c.socket.close(); } catch (_) { /* ignore */ }
    }
    return {
      table: tableIndex,
      ok: false,
      phase: 'create_session',
      error: created.error || 'create_failed',
      startedAt,
      clients: [],
      tableState,
    };
  }

  tableState.sessionId = sessionId;
  tableState.clients = clients;
  runtime.tablesStarted += 1;
  runtime.activeSessions += 1;
  runtime.peakActiveSessions = Math.max(runtime.peakActiveSessions, runtime.activeSessions);

  const controllers = clients.map((c) => attachSoakPlayer(c, sessionId, tableState));

  for (const c of clients) {
    const join = await emitAck(c.socket, 'session:join', { session_id: sessionId });
    notePhase('session_join', join.ok);
    const ready = await emitAck(c.socket, 'player:ready', { session_id: sessionId, ready: true });
    const readyOk = ready.ok || /managed automatically/i.test(String(ready.error || ''));
    notePhase('player_ready', readyOk);
  }

  const actionDeadline = Date.now() + actionDeadlineSeconds * 1000;
  while (!tableState.actionDone && Date.now() < actionDeadline) {
    await sleep(250);
  }

  if (tableState.actionOk) runtime.tablesActionOk += 1;
  else runtime.tablesActionFail += 1;

  return {
    table: tableIndex,
    ok: tableState.actionOk,
    phase: tableState.actionOk ? 'action_complete' : 'action_incomplete',
    error: tableState.actionOk ? null : 'action_deadline',
    startedAt,
    sessionId,
    clients,
    controllers,
    tableState,
  };
}

async function runPool(count, limit, worker) {
  const results = new Array(count);
  let idx = 0;
  async function runner() {
    while (idx < count) {
      const my = idx;
      idx += 1;
      results[my] = await worker(my + 1);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, count) }, () => runner()));
  return results;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function buildConclusion({ peakSockets, socketsAtHoldEnd }) {
  const ccuTarget = targetCcu;
  const ccuFloor = Math.ceil(ccuTarget * successRatio);
  const holdFloor = Math.ceil(peakSockets * holdRetentionRatio);
  const ccuOk = peakSockets >= ccuFloor;
  const holdOk = holdSeconds <= 0 || socketsAtHoldEnd >= holdFloor;
  const actionOkRate = runtime.tablesStarted > 0
    ? runtime.tablesActionOk / runtime.tablesStarted
    : 0;

  let overall = 'BELOW_TARGET';
  let headline = `Peak CCU ${peakSockets.toLocaleString()} did not meet ${ccuTarget.toLocaleString()} target (need ≥ ${ccuFloor.toLocaleString()}).`;

  if (ccuOk && holdOk) {
    overall = 'SUCCESS';
    headline = `SUCCESS — demonstrated ${peakSockets.toLocaleString()} concurrent users (CCU), meeting the ${ccuTarget.toLocaleString()} CCU capacity objective.`;
  } else if (ccuOk && !holdOk) {
    overall = 'PARTIAL';
    headline = `PARTIAL — peak CCU ${peakSockets.toLocaleString()} met target, but hold retention fell below ${(holdRetentionRatio * 100).toFixed(0)}% at end of ${holdSeconds}s soak.`;
  } else if (!ccuOk && peakSockets >= Math.ceil(ccuTarget * 0.8)) {
    overall = 'PARTIAL';
    headline = `PARTIAL — peak CCU ${peakSockets.toLocaleString()} reached ≥80% of ${ccuTarget.toLocaleString()} target.`;
  }

  return {
    overall_result: overall,
    headline,
    ok: overall === 'SUCCESS',
    ccu_target: ccuTarget,
    ccu_achieved_peak: peakSockets,
    ccu_success_threshold: ccuFloor,
    ccu_ok: ccuOk,
    hold_seconds: holdSeconds,
    sockets_at_hold_end: socketsAtHoldEnd,
    hold_retention_threshold: holdFloor,
    hold_ok: holdOk,
    tables_configured: tables,
    tables_started: runtime.tablesStarted,
    tables_action_ok: runtime.tablesActionOk,
    tables_action_ok_rate: Number(actionOkRate.toFixed(4)),
    max_players: maxPlayers,
    seats_configured: seatsNeeded,
  };
}

function writeReports(meta, conclusion) {
  ensureDir(reportDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const summaryPath = path.join(reportDir, `${reportPrefix}_${stamp}_summary.json`);
  const execPath = path.join(reportDir, `${reportPrefix}_${stamp}_executive.json`);
  const mdPath = path.join(reportDir, `${reportPrefix}_${stamp}_REPORT.md`);

  const summary = {
    ...meta,
    runtime: {
      peak_open_sockets: runtime.peakOpenSockets,
      peak_active_sessions: runtime.peakActiveSessions,
      open_sockets_end: runtime.openSockets,
      tables_started: runtime.tablesStarted,
      tables_action_ok: runtime.tablesActionOk,
      tables_action_fail: runtime.tablesActionFail,
      tables_admit_fail: runtime.tablesAdmitFail,
      picks_ok: runtime.picksOk,
      picks_fail: runtime.picksFail,
      discards_ok: runtime.discardsOk,
      discards_fail: runtime.discardsFail,
      auth_ok: runtime.authOk,
      auth_fail: runtime.authFail,
      fund_ok: runtime.fundOk,
      fund_fail: runtime.fundFail,
      connect_fail: runtime.connectFail,
      create_fail: runtime.createFail,
      phase_funnel: runtime.phase,
      hold_samples: runtime.holdSamples,
      admit_error_samples: runtime.admitErrorSamples,
    },
    conclusion,
  };

  const executive = {
    title: 'Concurrent User (CCU) Capacity Soak Report',
    generated_at: new Date().toISOString(),
    target_ccu: targetCcu,
    result: conclusion.overall_result,
    ok: conclusion.ok,
    headline: conclusion.headline,
    metrics: {
      peak_concurrent_users_ccu: runtime.peakOpenSockets,
      peak_active_tables: runtime.peakActiveSessions,
      hold_duration_seconds: holdSeconds,
      sockets_still_connected_after_hold: runtime.openSockets,
      tables_started: runtime.tablesStarted,
      tables_with_successful_pick_discard: runtime.tablesActionOk,
      pick_success: runtime.picksOk,
      discard_success: runtime.discardsOk,
    },
    configuration: {
      url: baseUrl,
      tables,
      max_players: maxPlayers,
      seats: seatsNeeded,
      concurrency,
      actions_per_table: actionsPerTable,
      game_id: gameId,
      contest_id: contestId,
    },
    conclusion,
  };

  const md = [
    `# Concurrent User (CCU) Capacity Soak Report`,
    ``,
    `**Result:** ${conclusion.overall_result}`,
    ``,
    `> ${conclusion.headline}`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Value |`,
    `| --- | ---: |`,
    `| Target CCU | ${targetCcu.toLocaleString()} |`,
    `| Peak CCU (open sockets) | **${runtime.peakOpenSockets.toLocaleString()}** |`,
    `| Peak active tables | ${runtime.peakActiveSessions.toLocaleString()} |`,
    `| Hold duration | ${holdSeconds}s |`,
    `| Sockets connected after hold | ${runtime.openSockets.toLocaleString()} |`,
    `| Tables started | ${runtime.tablesStarted.toLocaleString()} |`,
    `| Tables with successful pick+discard | ${runtime.tablesActionOk.toLocaleString()} |`,
    `| Pick OK | ${runtime.picksOk.toLocaleString()} |`,
    `| Discard OK | ${runtime.discardsOk.toLocaleString()} |`,
    `| Overall OK | **${conclusion.ok ? 'YES' : 'NO'}** |`,
    ``,
    `## Configuration`,
    ``,
    `- API: \`${baseUrl}\``,
    `- Tables × seats: ${tables} × ${maxPlayers} (= ${seatsNeeded} configured seats)`,
    `- Admission concurrency: ${concurrency}`,
    `- Actions per table before hold: ${actionsPerTable} pick+discard cycle(s)`,
    ``,
    `## Conclusion`,
    ``,
    conclusion.ok
      ? `The soak run **successfully demonstrated ${runtime.peakOpenSockets.toLocaleString()} concurrent users**, satisfying the **${targetCcu.toLocaleString()} CCU** capacity objective under live table load with a **${holdSeconds}s** connection hold.`
      : `The soak run recorded a peak of **${runtime.peakOpenSockets.toLocaleString()} CCU** against a target of **${targetCcu.toLocaleString()}**. See metrics above for the gap and retention profile.`,
    ``,
  ].join('\n');

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  fs.writeFileSync(execPath, `${JSON.stringify(executive, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, md, 'utf8');
  return { summaryPath, execPath, mdPath, summary, executive };
}

(async () => {
  if (!Number.isFinite(gameId) || !Number.isFinite(contestId)) {
    console.error('Required: --game-id and --contest-id');
    process.exit(1);
  }

  console.log('[CCU_SOAK] starting', {
    url: baseUrl,
    target_ccu: targetCcu,
    tables,
    max_players: maxPlayers,
    seats: seatsNeeded,
    concurrency,
    hold_seconds: holdSeconds,
    actions_per_table: actionsPerTable,
    success_ratio: successRatio,
    phone_prefix: phonePrefix,
    phone_start: phoneStart,
    fund: requireFund ? fundAmount : 0,
    soft_fund: softFund,
    game_id: gameId,
    contest_id: contestId,
    note: 'Fund API requires phones starting with server LOAD_TEST_PHONE_PREFIX (usually 97000)',
  });

  const t0 = Date.now();
  const progressTimer = setInterval(() => {
    console.log('[CCU_SOAK] progress', {
      open_sockets: runtime.openSockets,
      peak_ccu: runtime.peakOpenSockets,
      active_tables: runtime.activeSessions,
      peak_tables: runtime.peakActiveSessions,
      tables_started: runtime.tablesStarted,
      action_ok: runtime.tablesActionOk,
      picks_ok: runtime.picksOk,
      discards_ok: runtime.discardsOk,
      elapsed_s: Number(((Date.now() - t0) / 1000).toFixed(1)),
    });
  }, progressEverySec * 1000);
  if (progressTimer.unref) progressTimer.unref();

  const admitDeadline = Date.now() + admitDeadlineSeconds * 1000;
  const liveTables = [];

  const results = await runPool(tables, concurrency, async (tableIndex) => {
    if (Date.now() > admitDeadline) {
      runtime.tablesAdmitFail += 1;
      return {
        table: tableIndex,
        ok: false,
        phase: 'admit_deadline',
        error: 'admit_deadline',
        clients: [],
        tableState: { closed: true },
      };
    }
    const result = await runOneTable(tableIndex);
    if (result.clients?.length) liveTables.push(result);
    return result;
  });

  const peakAfterActions = runtime.peakOpenSockets;
  console.log('[CCU_SOAK] action phase complete', {
    tables_started: runtime.tablesStarted,
    action_ok: runtime.tablesActionOk,
    admit_fail: runtime.tablesAdmitFail,
    fund_fail: runtime.fundFail,
    auth_ok: runtime.authOk,
    peak_ccu: peakAfterActions,
    open_sockets: runtime.openSockets,
    admit_error_samples: runtime.admitErrorSamples.slice(0, 5),
  });

  if (runtime.tablesStarted === 0) {
    console.error(
      '[CCU_SOAK] No tables started. Common cause: --phone-prefix must match server '
      + 'LOAD_TEST_PHONE_PREFIX (default 97000) or fund returns 403.',
    );
  }

  if (holdSeconds > 0) {
    const holdUntil = Date.now() + holdSeconds * 1000;
    console.log('[CCU_SOAK] entering hold', {
      hold_seconds: holdSeconds,
      open_sockets: runtime.openSockets,
      peak_ccu: runtime.peakOpenSockets,
    });
    while (Date.now() < holdUntil) {
      runtime.holdSamples.push({
        ts: new Date().toISOString(),
        open_sockets: runtime.openSockets,
        active_sessions: runtime.activeSessions,
      });
      await sleep(5000);
    }
  }

  const socketsAtHoldEnd = runtime.openSockets;
  const conclusion = buildConclusion({
    peakSockets: runtime.peakOpenSockets,
    socketsAtHoldEnd,
  });

  // Soft teardown — close sockets after metrics captured.
  for (const t of liveTables) {
    try { t.controllers?.forEach((c) => c.stop()); } catch (_) { /* ignore */ }
    for (const c of t.clients || []) {
      try { c.socket.close(); } catch (_) { /* ignore */ }
    }
    if (t.sessionId) {
      runtime.activeSessions = Math.max(0, runtime.activeSessions - 1);
    }
  }

  clearInterval(progressTimer);

  const elapsedS = Number(((Date.now() - t0) / 1000).toFixed(1));
  const paths = writeReports({
    started_at: new Date(t0).toISOString(),
    ended_at: new Date().toISOString(),
    elapsed_s: elapsedS,
    url: baseUrl,
    target_ccu: targetCcu,
    tables,
    max_players: maxPlayers,
    seats: seatsNeeded,
    concurrency,
    hold_seconds: holdSeconds,
    actions_per_table: actionsPerTable,
    success_ratio: successRatio,
    hold_retention_ratio: holdRetentionRatio,
    game_id: gameId,
    contest_id: contestId,
    tables_attempted: results.length,
  }, conclusion);

  console.log('\n========== CCU SOAK REPORT ==========');
  console.log(conclusion.headline);
  console.log({
    overall_result: conclusion.overall_result,
    ok: conclusion.ok,
    target_ccu: targetCcu,
    peak_ccu: runtime.peakOpenSockets,
    sockets_after_hold: socketsAtHoldEnd,
    peak_active_tables: runtime.peakActiveSessions,
    tables_action_ok: runtime.tablesActionOk,
    picks_ok: runtime.picksOk,
    discards_ok: runtime.discardsOk,
    elapsed_s: elapsedS,
  });
  console.log('executive:', paths.execPath);
  console.log('markdown:', paths.mdPath);
  console.log('summary:', paths.summaryPath);
  console.log('=====================================\n');

  process.exit(conclusion.ok ? 0 : 2);
})().catch((err) => {
  console.error('[CCU_SOAK] fatal', err);
  process.exit(1);
});
