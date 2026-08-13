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

  const [liveStats, totals, userCounts, weekly, today, cashFlowAll, cashFlowToday] = await Promise.all([
    getLivePlayStats(),
    sumLedgerByEvent(),
    getUserCounts(),
    getWeeklySeries(),
    sumLedgerByEvent({ since: todayIso }),
    getCashFlowStats(),
    getCashFlowStats({ since: todayIso }),
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
  recordCommission,
  recordBotWinCredit,
  recordBotLossDebit,
  loadSessionPlayerBotFlags,
  isUserBotFromMap,
  countPlayingNowPlayers,
  sumLedgerByEvent,
  getDashboardPayload,
  getWeeklySeries,
  getUserCounts,
  getCashFlowStats,
  listLedgerEntries,
  deriveProfitFields,
  emptyCashFlowBucket,
};
