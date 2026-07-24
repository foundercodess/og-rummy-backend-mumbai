/**
 * Platform admin ledger: commission (rake) and bot_win_credit (funds credited to bot wallets).
 * Inserts use ON CONFLICT (idempotency_key) DO NOTHING so retries never double-count.
 */

const { query } = require('../db');
const { getLivePlayStats } = require('./livePlayStats.service');

function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
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
  const out = { commission: 0, bot_win_credit: 0 };
  for (const row of res.rows || []) {
    const t = String(row.event_type || '');
    const val = round2(Number(row.total));
    if (t === 'commission') out.commission = val;
    if (t === 'bot_win_credit') out.bot_win_credit = val;
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
  const botByDay = Object.fromEntries(dayKeys.map((k) => [k, 0]));
  const playsByDay = Object.fromEntries(dayKeys.map((k) => [k, 0]));

  for (const row of ledgerRes.rows || []) {
    const day = String(row.day || '');
    if (!(day in commissionByDay)) continue;
    const amount = round2(Number(row.total));
    if (row.event_type === 'commission') commissionByDay[day] = amount;
    if (row.event_type === 'bot_win_credit') botByDay[day] = amount;
  }

  for (const row of gamesRes.rows || []) {
    const day = String(row.day || '');
    if (day in playsByDay) playsByDay[day] = Number(row.plays) || 0;
  }

  const commission = dayKeys.map((k) => commissionByDay[k]);
  const botWinnings = dayKeys.map((k) => botByDay[k]);
  const combined = dayKeys.map((k) => round2(commissionByDay[k] + botByDay[k]));
  const gameplay = dayKeys.map((k) => playsByDay[k]);

  return {
    labels,
    days: dayKeys,
    gameplay,
    revenue: {
      commission,
      bot_winnings: botWinnings,
      combined,
    },
  };
}

async function getUserCounts() {
  const res = await query(
    `SELECT
       COUNT(*)::int AS total_users,
       COUNT(*) FILTER (WHERE active IS DISTINCT FROM false)::int AS active_users,
       COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS newly_onboarded_7d
     FROM users`
  );
  const row = res.rows[0] || {};
  return {
    total_users: Number(row.total_users) || 0,
    active_users: Number(row.active_users) || 0,
    newly_onboarded_7d: Number(row.newly_onboarded_7d) || 0,
  };
}

/** @deprecated Use telemetryService.getGlobalTelemetryReport() instead. */
async function getDashboardPayload() {
  const [liveStats, totals, userCounts, weekly] = await Promise.all([
    getLivePlayStats(),
    sumLedgerByEvent(),
    getUserCounts(),
    getWeeklySeries(),
  ]);
  const startOfUtcDay = new Date();
  startOfUtcDay.setUTCHours(0, 0, 0, 0);
  const today = await sumLedgerByEvent({ since: startOfUtcDay.toISOString() });

  const revenueCombined = round2(totals.commission + totals.bot_win_credit);
  const todayCombined = round2(today.commission + today.bot_win_credit);

  return {
    currency: 'INR',
    users: {
      total: userCounts.total_users,
      active: userCounts.active_users,
      newly_onboarded_7d: userCounts.newly_onboarded_7d,
    },
    revenue: {
      /** Total recorded commission (platform rake) — primary “house” revenue line. */
      total_commission: totals.commission,
      /** Sum of amounts credited to bot wallets as wins (exposure / liability). */
      total_bot_winnings: totals.bot_win_credit,
      /** Commission + bot win credits (single number for dashboards that want one total). */
      combined_total: revenueCombined,
    },
    today: {
      /** Commission recorded since UTC midnight. */
      commission: today.commission,
      bot_winnings: today.bot_win_credit,
      /** Commission + bot win credits since UTC midnight. */
      combined_total: todayCombined,
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

async function listLedgerEntries({
  limit = 50,
  offset = 0,
  eventType = null,
  fromDate = null,
  toDate = null,
}) {
  const safeLimit = Number.isNaN(Number(limit)) ? 50 : Math.min(Number(limit), 200);
  const safeOffset = Number.isNaN(Number(offset)) ? 0 : Math.max(Number(offset), 0);

  const params = [];
  const where = [];
  let idx = 0;

  if (eventType && ['commission', 'bot_win_credit'].includes(String(eventType))) {
    idx += 1;
    where.push(`event_type = $${idx}`);
    params.push(eventType);
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

  const countRes = await query(
    `SELECT COUNT(*)::int AS c FROM admin_ledger ${whereSql}`,
    params.slice(0, params.length - 2)
  );

  return {
    rows: (rowsRes.rows || []).map((r) => ({
      id: r.id,
      event_type: r.event_type,
      amount: round2(Number(r.amount)),
      game_session_id: r.game_session_id,
      idempotency_key: r.idempotency_key,
      metadata: r.metadata || {},
      created_at: r.created_at,
    })),
    total: Number(countRes.rows[0]?.c || 0),
    limit: safeLimit,
    offset: safeOffset,
  };
}

module.exports = {
  round2,
  recordCommission,
  recordBotWinCredit,
  loadSessionPlayerBotFlags,
  isUserBotFromMap,
  countPlayingNowPlayers,
  sumLedgerByEvent,
  getDashboardPayload,
  getWeeklySeries,
  getUserCounts,
  listLedgerEntries,
};
