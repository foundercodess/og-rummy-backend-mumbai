/**
 * Platform admin ledger:
 * - commission (rake) — always beneficial (>= 0)
 * - bot_win_credit — human money captured when bots win
 * - bot_loss_debit — admin downside when bots lose to humans
 *
 * Net profit = commission + bot_wins - bot_losses
 * Inserts use ON CONFLICT (idempotency_key) DO NOTHING so retries never double-count.
 */

const { query } = require('../db');
const { getLivePlayStats } = require('./livePlayStats.service');

const LEDGER_EVENT_TYPES = ['commission', 'bot_win_credit', 'bot_loss_debit'];

function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

function emptyLedgerTotals() {
  return { commission: 0, bot_win_credit: 0, bot_loss_debit: 0 };
}

function deriveProfitFields(totals = emptyLedgerTotals()) {
  const commission = round2(totals.commission);
  const botWins = round2(totals.bot_win_credit);
  const botLosses = round2(totals.bot_loss_debit);
  const botPnl = round2(botWins - botLosses);
  const netProfit = round2(commission + botPnl);
  return {
    commission,
    bot_wins: botWins,
    bot_losses: botLosses,
    bot_pnl: botPnl,
    net_profit: netProfit,
    /** @deprecated Prefer net_profit. Kept for older admin clients. */
    combined_total: netProfit,
    /** @deprecated Prefer bot_wins. */
    bot_winnings: botWins,
  };
}

async function recordCommission(client, { sessionId, amount, mode }) {
  const amt = round2(amount);
  if (!(amt > 0)) return;
  const sid = Number(sessionId);
  if (!Number.isFinite(sid)) return;

  await client.query(
    `INSERT INTO admin_ledger (event_type, amount, game_session_id, idempotency_key, metadata)
     VALUES ('commission', $1, $2, $3, $4::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [amt, sid, `commission:${sid}:${mode}`, JSON.stringify({ mode })]
  );
}

async function recordBotWinCredit(client, { sessionId, userId, amount, mode }) {
  const amt = round2(amount);
  if (!(amt > 0)) return;
  const sid = Number(sessionId);
  const uid = Number(userId);
  if (!Number.isFinite(sid) || !Number.isFinite(uid)) return;

  await client.query(
    `INSERT INTO admin_ledger (event_type, amount, game_session_id, idempotency_key, metadata)
     VALUES ('bot_win_credit', $1, $2, $3, $4::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [amt, sid, `bot_win:${sid}:${uid}`, JSON.stringify({ mode, user_id: uid })]
  );
}

async function recordBotLossDebit(client, { sessionId, userId, amount, mode }) {
  const amt = round2(amount);
  if (!(amt > 0)) return;
  const sid = Number(sessionId);
  const uid = Number(userId);
  if (!Number.isFinite(sid) || !Number.isFinite(uid)) return;

  await client.query(
    `INSERT INTO admin_ledger (event_type, amount, game_session_id, idempotency_key, metadata)
     VALUES ('bot_loss_debit', $1, $2, $3, $4::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [amt, sid, `bot_loss:${sid}:${uid}`, JSON.stringify({ mode, user_id: uid })]
  );
}

/** Load session player rows inside the same transaction (for bot detection in settleGameResult). */
async function loadSessionPlayerBotFlags(client, sessionId) {
  const sid = Number(sessionId);
  if (!Number.isFinite(sid)) return new Map();
  const res = await client.query(
    `SELECT user_id, metadata FROM game_session_players WHERE game_session_id = $1`,
    [sid]
  );
  const map = new Map();
  for (const row of res.rows || []) {
    const uid = Number(row.user_id);
    const isBot = row.metadata?.is_bot === true;
    map.set(uid, isBot);
  }
  return map;
}

function isUserBotFromMap(botMap, userId) {
  const uid = Number(userId);
  return botMap.get(uid) === true;
}

/**
 * Human players currently at live (non-practice) tables.
 * Kept for callers that only need a single number; prefer getLivePlayStats().
 */
async function countPlayingNowPlayers() {
  const stats = await getLivePlayStats();
  return stats.humans;
}

async function sumLedgerByEvent({ since = null } = {}) {
  const params = [];
  let where = '';
  if (since) {
    params.push(since);
    where = `WHERE created_at >= $${params.length}`;
  }
  const res = await query(
    `SELECT event_type, COALESCE(SUM(amount), 0)::numeric(14,2) AS total
     FROM admin_ledger
     ${where}
     GROUP BY event_type`,
    params
  );
  const out = emptyLedgerTotals();
  for (const row of res.rows || []) {
    const t = String(row.event_type || '');
    const val = round2(Number(row.total));
    if (t === 'commission') out.commission = val;
    if (t === 'bot_win_credit') out.bot_win_credit = val;
    if (t === 'bot_loss_debit') out.bot_loss_debit = val;
  }
  return out;
}

function buildLast7DayBuckets() {
  const labels = [];
  const dayKeys = [];
  const now = new Date();
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - i
    ));
    const key = d.toISOString().slice(0, 10);
    dayKeys.push(key);
    labels.push(d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }));
  }
  return { labels, dayKeys };
}

async function getWeeklySeries() {
  const { labels, dayKeys } = buildLast7DayBuckets();
  const since = `${dayKeys[0]}T00:00:00.000Z`;

  const [ledgerRes, gamesRes] = await Promise.all([
    query(
      `SELECT
         (created_at AT TIME ZONE 'UTC')::date::text AS day,
         event_type,
         COALESCE(SUM(amount), 0)::numeric(14,2) AS total
       FROM admin_ledger
       WHERE created_at >= $1
       GROUP BY day, event_type
       ORDER BY day ASC`,
      [since]
    ),
    query(
      `SELECT
         (COALESCE(ended_at, updated_at, created_at) AT TIME ZONE 'UTC')::date::text AS day,
         COUNT(*)::int AS plays
       FROM game_sessions
       WHERE status = 'completed'
         AND COALESCE(ended_at, updated_at, created_at) >= $1
         AND COALESCE((metadata->>'practice_mode')::boolean, false) = false
         AND COALESCE((metadata->>'practice_bot_only')::boolean, false) = false
       GROUP BY day
       ORDER BY day ASC`,
      [since]
    ),
  ]);

  const commissionByDay = Object.fromEntries(dayKeys.map((k) => [k, 0]));
  const botWinByDay = Object.fromEntries(dayKeys.map((k) => [k, 0]));
  const botLossByDay = Object.fromEntries(dayKeys.map((k) => [k, 0]));
  const playsByDay = Object.fromEntries(dayKeys.map((k) => [k, 0]));

  for (const row of ledgerRes.rows || []) {
    const day = String(row.day || '');
    if (!(day in commissionByDay)) continue;
    const amount = round2(Number(row.total));
    if (row.event_type === 'commission') commissionByDay[day] = amount;
    if (row.event_type === 'bot_win_credit') botWinByDay[day] = amount;
    if (row.event_type === 'bot_loss_debit') botLossByDay[day] = amount;
  }

  for (const row of gamesRes.rows || []) {
    const day = String(row.day || '');
    if (day in playsByDay) playsByDay[day] = Number(row.plays) || 0;
  }

  const commission = dayKeys.map((k) => commissionByDay[k]);
  const botWinnings = dayKeys.map((k) => botWinByDay[k]);
  const botLosses = dayKeys.map((k) => botLossByDay[k]);
  const botPnl = dayKeys.map((k) => round2(botWinByDay[k] - botLossByDay[k]));
  const netProfit = dayKeys.map((k) => round2(commissionByDay[k] + botWinByDay[k] - botLossByDay[k]));
  const gameplay = dayKeys.map((k) => playsByDay[k]);

  return {
    labels,
    days: dayKeys,
    gameplay,
    revenue: {
      commission,
      bot_winnings: botWinnings,
      bot_losses: botLosses,
      bot_pnl: botPnl,
      /** Net admin profit = commission + bot wins − bot losses */
      net_profit: netProfit,
      /** @deprecated Prefer net_profit */
      combined: netProfit,
    },
  };
}

const ANALYTICS_MAX_DAYS = 90;

function utcDateOnly(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function formatUtcYmd(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Build inclusive UTC day buckets from fromDate → toDate (Date objects).
 */
function buildDayBuckets(fromDate, toDate) {
  const start = utcDateOnly(fromDate);
  const end = utcDateOnly(toDate);
  const dayKeys = [];
  const labels = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const key = formatUtcYmd(cursor);
    dayKeys.push(key);
    labels.push(
      cursor.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        timeZone: 'UTC',
      })
    );
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { labels, dayKeys, fromKey: dayKeys[0], toKey: dayKeys[dayKeys.length - 1] };
}

/**
 * Parse analytics range query. Defaults to last 7 UTC days (inclusive of today).
 * @returns {{ fromDate: Date, toDate: Date, dayCount: number } | { error: string }}
 */
function parseAnalyticsRange({ from = null, to = null, days = null } = {}) {
  const today = utcDateOnly(new Date());
  let toDate = today;
  let fromDate = null;

  if (to) {
    const parsedTo = new Date(to);
    if (Number.isNaN(parsedTo.getTime())) return { error: 'to must be a valid date' };
    toDate = utcDateOnly(parsedTo);
  }

  if (from) {
    const parsedFrom = new Date(from);
    if (Number.isNaN(parsedFrom.getTime())) return { error: 'from must be a valid date' };
    fromDate = utcDateOnly(parsedFrom);
  } else {
    const span = Number(days);
    const safeSpan = Number.isFinite(span) && span > 0 ? Math.min(Math.floor(span), ANALYTICS_MAX_DAYS) : 7;
    fromDate = new Date(toDate);
    fromDate.setUTCDate(fromDate.getUTCDate() - (safeSpan - 1));
  }

  if (fromDate > toDate) return { error: 'from must be on or before to' };

  const dayCount = Math.floor((toDate - fromDate) / 86400000) + 1;
  if (dayCount > ANALYTICS_MAX_DAYS) {
    return { error: `Date range cannot exceed ${ANALYTICS_MAX_DAYS} days` };
  }

  return { fromDate, toDate, dayCount };
}

function sumSeries(arr) {
  return round2((arr || []).reduce((acc, v) => acc + (Number(v) || 0), 0));
}

/**
 * Date-range analytics series for admin charts.
 * Includes gameplay, unique human players, new users, P&L, cashflow, and mode splits.
 */
async function getAnalyticsSeries({ from = null, to = null, days = null } = {}) {
  const parsed = parseAnalyticsRange({ from, to, days });
  if (parsed.error) {
    const err = new Error(parsed.error);
    err.code = 'INVALID_RANGE';
    throw err;
  }

  const { fromDate, toDate, dayCount } = parsed;
  const { labels, dayKeys, fromKey, toKey } = buildDayBuckets(fromDate, toDate);
  const sinceIso = `${fromKey}T00:00:00.000Z`;
  const untilIso = `${toKey}T23:59:59.999Z`;

  const zeroByDay = () => Object.fromEntries(dayKeys.map((k) => [k, 0]));

  const [
    ledgerRes,
    gamesRes,
    playersRes,
    newUsersRes,
    depositsRes,
    withdrawalsRes,
    playsByModeRes,
    revenueByModeRes,
  ] = await Promise.all([
    query(
      `SELECT
         (created_at AT TIME ZONE 'UTC')::date::text AS day,
         event_type,
         COALESCE(SUM(amount), 0)::numeric(14,2) AS total
       FROM admin_ledger
       WHERE created_at >= $1 AND created_at <= $2
       GROUP BY day, event_type
       ORDER BY day ASC`,
      [sinceIso, untilIso]
    ),
    query(
      `SELECT
         (COALESCE(ended_at, updated_at, created_at) AT TIME ZONE 'UTC')::date::text AS day,
         COUNT(*)::int AS plays
       FROM game_sessions
       WHERE status = 'completed'
         AND COALESCE(ended_at, updated_at, created_at) >= $1
         AND COALESCE(ended_at, updated_at, created_at) <= $2
         AND COALESCE((metadata->>'practice_mode')::boolean, false) = false
         AND COALESCE((metadata->>'practice_bot_only')::boolean, false) = false
       GROUP BY day
       ORDER BY day ASC`,
      [sinceIso, untilIso]
    ),
    query(
      `SELECT
         (COALESCE(gs.ended_at, gs.updated_at, gs.created_at) AT TIME ZONE 'UTC')::date::text AS day,
         COUNT(DISTINCT gsp.user_id)::int AS players
       FROM game_sessions gs
       INNER JOIN game_session_players gsp ON gsp.game_session_id = gs.id
       INNER JOIN users u ON u.id = gsp.user_id
       WHERE gs.status = 'completed'
         AND COALESCE(gs.ended_at, gs.updated_at, gs.created_at) >= $1
         AND COALESCE(gs.ended_at, gs.updated_at, gs.created_at) <= $2
         AND COALESCE((gs.metadata->>'practice_mode')::boolean, false) = false
         AND COALESCE((gs.metadata->>'practice_bot_only')::boolean, false) = false
         AND COALESCE(u.is_bot, false) = false
       GROUP BY day
       ORDER BY day ASC`,
      [sinceIso, untilIso]
    ),
    query(
      `SELECT
         (created_at AT TIME ZONE 'UTC')::date::text AS day,
         COUNT(*)::int AS count
       FROM users
       WHERE COALESCE(is_bot, false) = false
         AND created_at >= $1
         AND created_at <= $2
       GROUP BY day
       ORDER BY day ASC`,
      [sinceIso, untilIso]
    ),
    query(
      `SELECT
         (COALESCE(completed_at, updated_at, requested_at) AT TIME ZONE 'UTC')::date::text AS day,
         COUNT(*)::int AS count,
         COALESCE(SUM(amount), 0)::numeric(14,2) AS amount
       FROM recharge_transactions
       WHERE status = 'payment_success'
         AND COALESCE(completed_at, updated_at, requested_at) >= $1
         AND COALESCE(completed_at, updated_at, requested_at) <= $2
       GROUP BY day
       ORDER BY day ASC`,
      [sinceIso, untilIso]
    ),
    query(
      `SELECT
         (COALESCE(completed_at, updated_at, requested_at) AT TIME ZONE 'UTC')::date::text AS day,
         COUNT(*)::int AS count,
         COALESCE(SUM(amount), 0)::numeric(14,2) AS amount
       FROM withdrawal_transactions
       WHERE status = 'successful'
         AND COALESCE(completed_at, updated_at, requested_at) >= $1
         AND COALESCE(completed_at, updated_at, requested_at) <= $2
       GROUP BY day
       ORDER BY day ASC`,
      [sinceIso, untilIso]
    ),
    query(
      `SELECT
         LOWER(COALESCE(NULLIF(TRIM(metadata->>'mode'), ''), 'unknown')) AS mode,
         COUNT(*)::int AS plays
       FROM game_sessions
       WHERE status = 'completed'
         AND COALESCE(ended_at, updated_at, created_at) >= $1
         AND COALESCE(ended_at, updated_at, created_at) <= $2
         AND COALESCE((metadata->>'practice_mode')::boolean, false) = false
         AND COALESCE((metadata->>'practice_bot_only')::boolean, false) = false
       GROUP BY mode
       ORDER BY plays DESC`,
      [sinceIso, untilIso]
    ),
    query(
      `SELECT
         LOWER(COALESCE(NULLIF(TRIM(metadata->>'mode'), ''), 'unknown')) AS mode,
         event_type,
         COALESCE(SUM(amount), 0)::numeric(14,2) AS total
       FROM admin_ledger
       WHERE created_at >= $1 AND created_at <= $2
       GROUP BY mode, event_type
       ORDER BY mode ASC`,
      [sinceIso, untilIso]
    ),
  ]);

  const commissionByDay = zeroByDay();
  const botWinByDay = zeroByDay();
  const botLossByDay = zeroByDay();
  const playsByDay = zeroByDay();
  const playersByDay = zeroByDay();
  const newUsersByDay = zeroByDay();
  const depositAmtByDay = zeroByDay();
  const depositCntByDay = zeroByDay();
  const withdrawAmtByDay = zeroByDay();
  const withdrawCntByDay = zeroByDay();

  for (const row of ledgerRes.rows || []) {
    const day = String(row.day || '');
    if (!(day in commissionByDay)) continue;
    const amount = round2(Number(row.total));
    if (row.event_type === 'commission') commissionByDay[day] = amount;
    if (row.event_type === 'bot_win_credit') botWinByDay[day] = amount;
    if (row.event_type === 'bot_loss_debit') botLossByDay[day] = amount;
  }
  for (const row of gamesRes.rows || []) {
    const day = String(row.day || '');
    if (day in playsByDay) playsByDay[day] = Number(row.plays) || 0;
  }
  for (const row of playersRes.rows || []) {
    const day = String(row.day || '');
    if (day in playersByDay) playersByDay[day] = Number(row.players) || 0;
  }
  for (const row of newUsersRes.rows || []) {
    const day = String(row.day || '');
    if (day in newUsersByDay) newUsersByDay[day] = Number(row.count) || 0;
  }
  for (const row of depositsRes.rows || []) {
    const day = String(row.day || '');
    if (!(day in depositAmtByDay)) continue;
    depositAmtByDay[day] = round2(Number(row.amount));
    depositCntByDay[day] = Number(row.count) || 0;
  }
  for (const row of withdrawalsRes.rows || []) {
    const day = String(row.day || '');
    if (!(day in withdrawAmtByDay)) continue;
    withdrawAmtByDay[day] = round2(Number(row.amount));
    withdrawCntByDay[day] = Number(row.count) || 0;
  }

  const series = {
    gameplay: dayKeys.map((k) => playsByDay[k]),
    unique_players: dayKeys.map((k) => playersByDay[k]),
    new_users: dayKeys.map((k) => newUsersByDay[k]),
    commission: dayKeys.map((k) => commissionByDay[k]),
    bot_winnings: dayKeys.map((k) => botWinByDay[k]),
    bot_losses: dayKeys.map((k) => botLossByDay[k]),
    bot_pnl: dayKeys.map((k) => round2(botWinByDay[k] - botLossByDay[k])),
    net_profit: dayKeys.map((k) =>
      round2(commissionByDay[k] + botWinByDay[k] - botLossByDay[k])
    ),
    deposits_amount: dayKeys.map((k) => depositAmtByDay[k]),
    deposits_count: dayKeys.map((k) => depositCntByDay[k]),
    withdrawals_amount: dayKeys.map((k) => withdrawAmtByDay[k]),
    withdrawals_count: dayKeys.map((k) => withdrawCntByDay[k]),
  };

  const modeMap = new Map();
  for (const row of playsByModeRes.rows || []) {
    const mode = String(row.mode || 'unknown');
    if (!modeMap.has(mode)) {
      modeMap.set(mode, {
        mode,
        plays: 0,
        commission: 0,
        bot_wins: 0,
        bot_losses: 0,
        bot_pnl: 0,
        net_profit: 0,
      });
    }
    modeMap.get(mode).plays = Number(row.plays) || 0;
  }
  for (const row of revenueByModeRes.rows || []) {
    const mode = String(row.mode || 'unknown');
    if (!modeMap.has(mode)) {
      modeMap.set(mode, {
        mode,
        plays: 0,
        commission: 0,
        bot_wins: 0,
        bot_losses: 0,
        bot_pnl: 0,
        net_profit: 0,
      });
    }
    const entry = modeMap.get(mode);
    const amount = round2(Number(row.total));
    if (row.event_type === 'commission') entry.commission = amount;
    if (row.event_type === 'bot_win_credit') entry.bot_wins = amount;
    if (row.event_type === 'bot_loss_debit') entry.bot_losses = amount;
  }
  const byMode = [...modeMap.values()].map((m) => {
    const botPnl = round2(m.bot_wins - m.bot_losses);
    return {
      ...m,
      bot_pnl: botPnl,
      net_profit: round2(m.commission + botPnl),
    };
  });
  byMode.sort((a, b) => b.plays - a.plays || b.net_profit - a.net_profit);

  const summary = {
    games_played: series.gameplay.reduce((a, b) => a + b, 0),
    unique_players: series.unique_players.reduce((a, b) => Math.max(a, b), 0),
    unique_players_note: 'Peak daily unique human players in range (not de-duplicated across days)',
    new_users: series.new_users.reduce((a, b) => a + b, 0),
    commission: sumSeries(series.commission),
    bot_winnings: sumSeries(series.bot_winnings),
    bot_losses: sumSeries(series.bot_losses),
    bot_pnl: sumSeries(series.bot_pnl),
    net_profit: sumSeries(series.net_profit),
    deposits_amount: sumSeries(series.deposits_amount),
    deposits_count: series.deposits_count.reduce((a, b) => a + b, 0),
    withdrawals_amount: sumSeries(series.withdrawals_amount),
    withdrawals_count: series.withdrawals_count.reduce((a, b) => a + b, 0),
    net_cash_in: round2(sumSeries(series.deposits_amount) - sumSeries(series.withdrawals_amount)),
  };

  // True unique humans across the whole range (better summary metric).
  try {
    const uniqRes = await query(
      `SELECT COUNT(DISTINCT gsp.user_id)::int AS players
       FROM game_sessions gs
       INNER JOIN game_session_players gsp ON gsp.game_session_id = gs.id
       INNER JOIN users u ON u.id = gsp.user_id
       WHERE gs.status = 'completed'
         AND COALESCE(gs.ended_at, gs.updated_at, gs.created_at) >= $1
         AND COALESCE(gs.ended_at, gs.updated_at, gs.created_at) <= $2
         AND COALESCE((gs.metadata->>'practice_mode')::boolean, false) = false
         AND COALESCE((gs.metadata->>'practice_bot_only')::boolean, false) = false
         AND COALESCE(u.is_bot, false) = false`,
      [sinceIso, untilIso]
    );
    summary.unique_players = Number(uniqRes.rows[0]?.players) || 0;
    summary.unique_players_note = 'Distinct human players who completed a non-practice game in range';
  } catch {
    // keep peak-daily fallback
  }

  return {
    currency: 'INR',
    range: {
      from: fromKey,
      to: toKey,
      days: dayCount,
      timezone: 'UTC',
    },
    labels,
    days: dayKeys,
    series,
    summary,
    by_mode: byMode,
  };
}

async function getUserCounts() {
  const res = await query(
    `SELECT
       COUNT(*)::int AS total_users,
       COUNT(*) FILTER (WHERE active IS DISTINCT FROM false)::int AS active_users,
       COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS newly_onboarded_7d
     FROM users
     WHERE COALESCE(is_bot, false) = false`
  );
  const row = res.rows[0] || {};
  return {
    total_users: Number(row.total_users) || 0,
    active_users: Number(row.active_users) || 0,
    newly_onboarded_7d: Number(row.newly_onboarded_7d) || 0,
  };
}

/** KYC queue counts for dashboard action tiles. pending = status 'submitted'. */
async function getKycCounts() {
  const res = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'submitted')::int AS pending,
       COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
       COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected
     FROM kyc`
  );
  const row = res.rows[0] || {};
  return {
    total: Number(row.total) || 0,
    pending: Number(row.pending) || 0,
    approved: Number(row.approved) || 0,
    rejected: Number(row.rejected) || 0,
  };
}

function emptyCashFlowBucket() {
  return {
    completed: { count: 0, amount: 0 },
    pending: { count: 0, amount: 0 },
    failed: { count: 0, amount: 0 },
    total_count: 0,
    total_amount: 0,
  };
}

function mapCashFlowRow(row = {}) {
  const completedCount = Number(row.completed_count || 0);
  const pendingCount = Number(row.pending_count || 0);
  const failedCount = Number(row.failed_count || 0);
  const completedAmount = round2(row.completed_amount);
  const pendingAmount = round2(row.pending_amount);
  const failedAmount = round2(row.failed_amount);
  return {
    completed: { count: completedCount, amount: completedAmount },
    pending: { count: pendingCount, amount: pendingAmount },
    failed: { count: failedCount, amount: failedAmount },
    total_count: completedCount + pendingCount + failedCount,
    total_amount: round2(completedAmount + pendingAmount + failedAmount),
  };
}

/**
 * Add-cash + withdrawal status buckets (completed / pending / failed) with counts + money.
 * @param {{ since?: string|null }} options
 */
async function getCashFlowStats({ since = null } = {}) {
  const params = [];
  let rechargeWhere = '';
  let withdrawalWhere = '';
  if (since) {
    params.push(since);
    rechargeWhere = `WHERE requested_at >= $1`;
    withdrawalWhere = `WHERE requested_at >= $1`;
  }

  const [rechargeRes, withdrawalRes] = await Promise.all([
    query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'payment_success')::int AS completed_count,
         COALESCE(SUM(CASE WHEN status = 'payment_success' THEN amount ELSE 0 END), 0)::numeric(14,2) AS completed_amount,
         COUNT(*) FILTER (WHERE status IN ('init', 'not_paid'))::int AS pending_count,
         COALESCE(SUM(CASE WHEN status IN ('init', 'not_paid') THEN amount ELSE 0 END), 0)::numeric(14,2) AS pending_amount,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN amount ELSE 0 END), 0)::numeric(14,2) AS failed_amount
       FROM recharge_transactions
       ${rechargeWhere}`,
      params
    ),
    query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'successful')::int AS completed_count,
         COALESCE(SUM(CASE WHEN status = 'successful' THEN amount ELSE 0 END), 0)::numeric(14,2) AS completed_amount,
         COUNT(*) FILTER (WHERE status IN ('init', 'pending', 'processing'))::int AS pending_count,
         COALESCE(SUM(CASE WHEN status IN ('init', 'pending', 'processing') THEN amount ELSE 0 END), 0)::numeric(14,2) AS pending_amount,
         COUNT(*) FILTER (WHERE status IN ('failed', 'rejected'))::int AS failed_count,
         COALESCE(SUM(CASE WHEN status IN ('failed', 'rejected') THEN amount ELSE 0 END), 0)::numeric(14,2) AS failed_amount
       FROM withdrawal_transactions
       ${withdrawalWhere}`,
      params
    ),
  ]);

  return {
    add_cash: mapCashFlowRow(rechargeRes.rows[0]),
    withdrawals: mapCashFlowRow(withdrawalRes.rows[0]),
  };
}

/** @deprecated Use telemetryService.getGlobalTelemetryReport() instead. */
async function getDashboardPayload() {
  const startOfUtcDay = new Date();
  startOfUtcDay.setUTCHours(0, 0, 0, 0);
  const todayIso = startOfUtcDay.toISOString();

  const [liveStats, totals, userCounts, weekly, today, cashFlowAll, cashFlowToday, kycCounts] =
    await Promise.all([
      getLivePlayStats(),
      sumLedgerByEvent(),
      getUserCounts(),
      getWeeklySeries(),
      sumLedgerByEvent({ since: todayIso }),
      getCashFlowStats(),
      getCashFlowStats({ since: todayIso }),
      getKycCounts(),
    ]);

  const allTime = deriveProfitFields(totals);
  const todayFields = deriveProfitFields(today);

  return {
    currency: 'INR',
    users: {
      total: userCounts.total_users,
      active: userCounts.active_users,
      newly_onboarded_7d: userCounts.newly_onboarded_7d,
    },
    kyc: kycCounts,
    revenue: {
      total_commission: allTime.commission,
      total_bot_winnings: allTime.bot_wins,
      total_bot_losses: allTime.bot_losses,
      bot_pnl: allTime.bot_pnl,
      net_profit: allTime.net_profit,
      /** @deprecated Prefer net_profit */
      combined_total: allTime.net_profit,
    },
    today: {
      commission: todayFields.commission,
      bot_winnings: todayFields.bot_wins,
      bot_losses: todayFields.bot_losses,
      bot_pnl: todayFields.bot_pnl,
      net_profit: todayFields.net_profit,
      /** @deprecated Prefer net_profit */
      combined_total: todayFields.net_profit,
    },
    cash_flow: {
      all_time: cashFlowAll,
      today: cashFlowToday,
    },
    weekly,
    // Additive fields only — existing `players` key kept for older admin clients.
    playing_now: {
      /** @deprecated Prefer `humans`. Same value: live human players. */
      players: liveStats.humans,
      humans: liveStats.humans,
      bots: liveStats.bots,
      tables: liveStats.tables,
      total: liveStats.total,
      updated_at: liveStats.updated_at,
    },
  };
}

function signedAmountForEvent(eventType, amount) {
  const amt = round2(amount);
  if (eventType === 'bot_loss_debit') return round2(-amt);
  return amt;
}

async function listLedgerEntries({
  limit = 50,
  offset = 0,
  eventType = null,
  mode = null,
  sessionId = null,
  fromDate = null,
  toDate = null,
}) {
  const safeLimit = Number.isNaN(Number(limit)) ? 50 : Math.min(Number(limit), 200);
  const safeOffset = Number.isNaN(Number(offset)) ? 0 : Math.max(Number(offset), 0);

  const params = [];
  const where = [];
  let idx = 0;

  if (eventType && LEDGER_EVENT_TYPES.includes(String(eventType))) {
    idx += 1;
    where.push(`event_type = $${idx}`);
    params.push(eventType);
  }
  if (mode) {
    idx += 1;
    where.push(`metadata->>'mode' = $${idx}`);
    params.push(String(mode));
  }
  if (sessionId != null && sessionId !== '') {
    const sid = Number(sessionId);
    if (Number.isFinite(sid)) {
      idx += 1;
      where.push(`game_session_id = $${idx}`);
      params.push(sid);
    }
  }
  if (fromDate) {
    idx += 1;
    where.push(`created_at >= $${idx}`);
    params.push(fromDate);
  }
  if (toDate) {
    idx += 1;
    where.push(`created_at <= $${idx}`);
    params.push(toDate);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  params.push(safeLimit, safeOffset);
  const limIdx = idx + 1;
  const offIdx = idx + 2;

  const rowsRes = await query(
    `SELECT id, event_type, amount, game_session_id, idempotency_key, metadata, created_at
     FROM admin_ledger
     ${whereSql}
     ORDER BY created_at DESC, id DESC
     LIMIT $${limIdx} OFFSET $${offIdx}`,
    params
  );

  const countParams = params.slice(0, params.length - 2);
  const [countRes, sumRes] = await Promise.all([
    query(`SELECT COUNT(*)::int AS c FROM admin_ledger ${whereSql}`, countParams),
    query(
      `SELECT
         event_type,
         COALESCE(SUM(amount), 0)::numeric(14,2) AS total
       FROM admin_ledger
       ${whereSql}
       GROUP BY event_type`,
      countParams
    ),
  ]);

  const filteredTotals = emptyLedgerTotals();
  for (const row of sumRes.rows || []) {
    const t = String(row.event_type || '');
    const val = round2(Number(row.total));
    if (t === 'commission') filteredTotals.commission = val;
    if (t === 'bot_win_credit') filteredTotals.bot_win_credit = val;
    if (t === 'bot_loss_debit') filteredTotals.bot_loss_debit = val;
  }

  return {
    rows: (rowsRes.rows || []).map((r) => ({
      id: r.id,
      event_type: r.event_type,
      amount: round2(Number(r.amount)),
      signed_amount: signedAmountForEvent(r.event_type, r.amount),
      game_session_id: r.game_session_id,
      idempotency_key: r.idempotency_key,
      metadata: r.metadata || {},
      created_at: r.created_at,
    })),
    total: Number(countRes.rows[0]?.c || 0),
    limit: safeLimit,
    offset: safeOffset,
    summary: deriveProfitFields(filteredTotals),
  };
}

module.exports = {
  round2,
  LEDGER_EVENT_TYPES,
  ANALYTICS_MAX_DAYS,
  recordCommission,
  recordBotWinCredit,
  recordBotLossDebit,
  loadSessionPlayerBotFlags,
  isUserBotFromMap,
  countPlayingNowPlayers,
  sumLedgerByEvent,
  getDashboardPayload,
  getWeeklySeries,
  getAnalyticsSeries,
  parseAnalyticsRange,
  getUserCounts,
  getKycCounts,
  getCashFlowStats,
  listLedgerEntries,
  deriveProfitFields,
  emptyCashFlowBucket,
};
