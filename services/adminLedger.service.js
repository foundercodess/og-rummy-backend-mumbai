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

/** @deprecated Use telemetryService.getGlobalTelemetryReport() instead. */
async function getDashboardPayload() {
  const [liveStats, totals] = await Promise.all([
    getLivePlayStats(),
    sumLedgerByEvent(),
  ]);
  const startOfUtcDay = new Date();
  startOfUtcDay.setUTCHours(0, 0, 0, 0);
  const today = await sumLedgerByEvent({ since: startOfUtcDay.toISOString() });

  const revenueCombined = round2(totals.commission + totals.bot_win_credit);
  const todayCombined = round2(today.commission + today.bot_win_credit);

  return {
    currency: 'INR',
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
  listLedgerEntries,
};
