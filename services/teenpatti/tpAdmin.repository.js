'use strict';

const { query } = require('../../db');
const { roundCurrency } = require('../walletDebitSplit');
const { evaluateHand } = require('./teenpattiRules.service');

const LIVE_STATUSES = ['waiting', 'ready', 'active'];
const SESSION_STATUS_FILTERS = {
  live: LIVE_STATUSES,
  completed: ['completed'],
  cancelled: ['cancelled'],
};

// Ledger rows written by services/teenpatti/wallet.service.js (boot / blind / chaal debits, win credits).
const TP_LEDGER_JOIN = `
  JOIN wallet_transactions wt
    ON wt.reference_type = 'game_session'
   AND wt.reference_id = gs.id
   AND wt.metadata->>'game_family' = 'teenpatti'
   AND wt.transaction_type IN ('game_entry_debit', 'game_win_credit')`;

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function money(staked, paidOut) {
  const s = roundCurrency(staked || 0);
  const p = roundCurrency(paidOut || 0);
  return { staked: s, paid_out: p, house_result: roundCurrency(s - p) };
}

async function listTeenPattiGames() {
  const result = await query(
    `SELECT id, name, active, sort_order, dashboard_banner, side_banner
     FROM games
     WHERE game_family = 'teenpatti'
     ORDER BY sort_order, id`
  );
  return result.rows;
}

async function getPeriodMoney(since) {
  const result = await query(
    `SELECT COALESCE(SUM(-wt.amount) FILTER (WHERE wt.transaction_type = 'game_entry_debit'), 0) AS staked,
            COALESCE(SUM(wt.amount) FILTER (WHERE wt.transaction_type = 'game_win_credit'), 0) AS paid_out,
            COUNT(DISTINCT wt.user_id)::int AS players,
            COUNT(DISTINCT gs.id)::int AS tables,
            COUNT(DISTINCT gs.id::text || ':' || COALESCE(wt.metadata->>'round_no', '0'))::int AS hands
     FROM game_sessions gs
     JOIN games g ON g.id = gs.game_id AND g.game_family = 'teenpatti'
     ${TP_LEDGER_JOIN}
     WHERE ($1::timestamptz IS NULL OR wt.created_at >= $1)`,
    [since]
  );
  const row = result.rows[0] || {};
  return {
    tables: toInt(row.tables),
    hands: toInt(row.hands),
    players: toInt(row.players),
    ...money(row.staked, row.paid_out),
  };
}

async function getTableCounts(todayStart) {
  const [tables, players] = await Promise.all([
    query(
      `SELECT COUNT(*) FILTER (WHERE gs.status = ANY($1::text[]))::int AS live_tables,
              COUNT(*) FILTER (WHERE gs.status = 'completed' AND gs.ended_at >= $2)::int AS completed_today,
              COUNT(*) FILTER (WHERE gs.created_at >= $2)::int AS created_today,
              COUNT(*)::int AS total_tables
       FROM game_sessions gs
       JOIN games g ON g.id = gs.game_id AND g.game_family = 'teenpatti'`,
      [LIVE_STATUSES, todayStart]
    ),
    query(
      `SELECT COUNT(DISTINCT gsp.user_id)::int AS live_players
       FROM game_session_players gsp
       JOIN game_sessions gs ON gs.id = gsp.game_session_id
       JOIN games g ON g.id = gs.game_id AND g.game_family = 'teenpatti'
       JOIN users u ON u.id = gsp.user_id
       WHERE gs.status = ANY($1::text[])
         AND gsp.left_at IS NULL
         AND gsp.status IN ('joined', 'disconnected')
         AND gsp.metadata->>'table_left' IS DISTINCT FROM 'true'
         AND gsp.metadata->>'is_bot' IS DISTINCT FROM 'true'
         AND u.is_bot = false`,
      [LIVE_STATUSES]
    ),
  ]);
  const row = tables.rows[0] || {};
  return {
    live_tables: toInt(row.live_tables),
    live_players: toInt(players.rows[0]?.live_players),
    completed_today: toInt(row.completed_today),
    created_today: toInt(row.created_today),
    total_tables: toInt(row.total_tables),
  };
}

async function listContestsWithStats() {
  const result = await query(
    `SELECT c.id, c.game_id, c.player_count, c.entry, c.win_upto, c.active, c.sort_order,
            COUNT(gs.id) FILTER (WHERE gs.status = ANY($1::text[]))::int AS live_tables,
            COUNT(gs.id)::int AS total_tables
     FROM contests c
     JOIN games g ON g.id = c.game_id AND g.game_family = 'teenpatti'
     LEFT JOIN game_sessions gs ON gs.contest_id = c.id
     GROUP BY c.id
     ORDER BY c.player_count, NULLIF(regexp_replace(c.entry, '[^0-9.]', '', 'g'), '')::numeric NULLS LAST, c.id`,
    [LIVE_STATUSES]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    game_id: Number(row.game_id),
    player_count: Number(row.player_count),
    boot: row.entry,
    pot_limit: row.win_upto,
    active: row.active !== false,
    sort_order: row.sort_order,
    live_tables: toInt(row.live_tables),
    total_tables: toInt(row.total_tables),
  }));
}

/** Admin overview: catalog rows, boot tables, live counts and money for today / 7 days / all time (UTC day). */
async function getOverview() {
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [games, contests, tables, today, last7Days, allTime] = await Promise.all([
    listTeenPattiGames(),
    listContestsWithStats(),
    getTableCounts(todayStart),
    getPeriodMoney(todayStart),
    getPeriodMoney(weekStart),
    getPeriodMoney(null),
  ]);

  return {
    timezone: 'UTC',
    as_of: now.toISOString(),
    games: games.map((game) => ({ ...game, id: Number(game.id), active: game.active !== false })),
    contests,
    tables,
    periods: { today, last_7_days: last7Days, all_time: allTime },
  };
}

function buildSessionFilters({ status, contestId, user, from, to } = {}) {
  const where = [];
  const params = [];
  const statuses = SESSION_STATUS_FILTERS[status];
  if (statuses) {
    params.push(statuses);
    where.push(`gs.status = ANY($${params.length}::text[])`);
  }
  const contest = Number(contestId);
  if (Number.isInteger(contest) && contest > 0) {
    params.push(contest);
    where.push(`gs.contest_id = $${params.length}`);
  }
  const userKey = String(user || '').trim();
  if (userKey) {
    params.push(userKey);
    where.push(`EXISTS (
      SELECT 1 FROM game_session_players fp JOIN users fu ON fu.id = fp.user_id
      WHERE fp.game_session_id = gs.id AND (fu.id::text = $${params.length} OR fu.view_id::text = $${params.length})
    )`);
  }
  const fromDate = validDate(from);
  if (fromDate) {
    params.push(fromDate);
    where.push(`gs.created_at >= $${params.length}`);
  }
  const toDate = validDate(to);
  if (toDate) {
    params.push(toDate);
    where.push(`gs.created_at <= $${params.length}`);
  }
  return { whereSql: where.length ? `AND ${where.join(' AND ')}` : '', params };
}

function formatSessionRow(row) {
  const tp = row.metadata?.teenpatti || {};
  return {
    id: Number(row.id),
    session_code: row.session_code,
    status: row.status,
    contest_id: row.contest_id == null ? null : Number(row.contest_id),
    player_count: row.player_count == null ? null : Number(row.player_count),
    max_players: row.max_players == null ? null : Number(row.max_players),
    boot: Number(tp.boot) || Number(String(row.entry || '').replace(/[^0-9.]/g, '')) || null,
    pot_limit: Number(tp.pot_limit) || Number(String(row.win_upto || '').replace(/[^0-9.]/g, '')) || null,
    phase: tp.phase || row.metadata?.phase || null,
    hands_played: toInt(tp.round_no),
    current_pot: Number(tp.pot) || 0,
    practice: row.metadata?.practice_mode === true || row.metadata?.practice_bot_only === true,
    ended_reason: tp.ended_reason || row.metadata?.ended_reason || null,
    humans: toInt(row.humans),
    bots: toInt(row.bots),
    created_at: row.created_at,
    started_at: row.started_at,
    ended_at: row.ended_at,
    ...money(row.staked, row.paid_out),
  };
}

async function listSessions({ page = 1, limit = 20, ...filters } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safeLimit;
  const { whereSql, params } = buildSessionFilters(filters);

  const [rows, count] = await Promise.all([
    query(
      `SELECT gs.id, gs.session_code, gs.status, gs.contest_id, gs.max_players, gs.metadata,
              gs.created_at, gs.started_at, gs.ended_at,
              c.player_count, c.entry, c.win_upto,
              seats.humans, seats.bots,
              ledger.staked, ledger.paid_out
       FROM game_sessions gs
       JOIN games g ON g.id = gs.game_id AND g.game_family = 'teenpatti'
       LEFT JOIN contests c ON c.id = gs.contest_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE u.is_bot = false AND gsp.metadata->>'is_bot' IS DISTINCT FROM 'true')::int AS humans,
                COUNT(*) FILTER (WHERE u.is_bot = true OR gsp.metadata->>'is_bot' = 'true')::int AS bots
         FROM game_session_players gsp
         JOIN users u ON u.id = gsp.user_id
         WHERE gsp.game_session_id = gs.id
       ) seats ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(-wt.amount) FILTER (WHERE wt.transaction_type = 'game_entry_debit'), 0) AS staked,
                COALESCE(SUM(wt.amount) FILTER (WHERE wt.transaction_type = 'game_win_credit'), 0) AS paid_out
         FROM wallet_transactions wt
         WHERE wt.reference_type = 'game_session'
           AND wt.reference_id = gs.id
           AND wt.metadata->>'game_family' = 'teenpatti'
           AND wt.transaction_type IN ('game_entry_debit', 'game_win_credit')
       ) ledger ON true
       WHERE true ${whereSql}
       ORDER BY gs.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, safeLimit, offset]
    ),
    query(
      `SELECT COUNT(*)::int AS total
       FROM game_sessions gs
       JOIN games g ON g.id = gs.game_id AND g.game_family = 'teenpatti'
       WHERE true ${whereSql}`,
      params
    ),
  ]);

  return {
    page: safePage,
    limit: safeLimit,
    total: count.rows[0]?.total || 0,
    sessions: rows.rows.map(formatSessionRow),
  };
}

function publicCard(card) {
  if (!card) return null;
  if (typeof card === 'string') return card;
  return card.card_id || `${card.suit || ''}${card.rank || ''}`;
}

function handLabel(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) return null;
  try {
    return evaluateHand(cards).category_label;
  } catch (_) {
    return null;
  }
}

function currentHand(tp) {
  if (!tp || !tp.round_no) return null;
  return {
    round_no: toInt(tp.round_no),
    phase: tp.phase || null,
    boot: Number(tp.boot) || 0,
    pot: Number(tp.pot) || 0,
    pot_limit: Number(tp.pot_limit) || null,
    last_bet: Number(tp.last_bet) || 0,
    dealer_user_id: tp.dealer_user_id == null ? null : Number(tp.dealer_user_id),
    current_turn_user_id: tp.current_turn_user_id == null ? null : Number(tp.current_turn_user_id),
    players: (tp.players || []).map((p) => ({
      user_id: Number(p.user_id),
      state: p.state,
      total_invested: Number(p.total_invested) || 0,
      cards: (p.cards || []).map(publicCard),
      hand_label: handLabel(p.cards),
    })),
    result: tp.result
      ? {
        reason: tp.result.reason || null,
        pot: Number(tp.result.pot) || 0,
        winners: (tp.result.winners || []).map((w) => ({
          user_id: Number(w.user_id),
          hand_label: w.category_label || w.category_key || null,
        })),
      }
      : null,
  };
}

async function getSessionDetail(sessionId) {
  const sessionRes = await query(
    `SELECT gs.*, c.player_count, c.entry, c.win_upto
     FROM game_sessions gs
     JOIN games g ON g.id = gs.game_id AND g.game_family = 'teenpatti'
     LEFT JOIN contests c ON c.id = gs.contest_id
     WHERE gs.id = $1`,
    [sessionId]
  );
  const row = sessionRes.rows[0];
  if (!row) return null;

  const [playersRes, handsRes] = await Promise.all([
    query(
      `SELECT gsp.user_id, gsp.seat_no, gsp.status, gsp.joined_at, gsp.left_at, gsp.metadata,
              u.name, u.view_id, u.avatar, u.is_bot
       FROM game_session_players gsp
       JOIN users u ON u.id = gsp.user_id
       WHERE gsp.game_session_id = $1
       ORDER BY gsp.seat_no, gsp.id`,
      [sessionId]
    ),
    query(
      `SELECT NULLIF(wt.metadata->>'round_no', '')::int AS round_no,
              wt.user_id, u.name, u.view_id,
              COALESCE(SUM(-wt.amount) FILTER (WHERE wt.transaction_type = 'game_entry_debit'), 0) AS staked,
              COALESCE(SUM(wt.amount) FILTER (WHERE wt.transaction_type = 'game_win_credit'), 0) AS won,
              MIN(wt.created_at) AS first_at,
              MAX(wt.created_at) AS last_at
       FROM wallet_transactions wt
       JOIN users u ON u.id = wt.user_id
       WHERE wt.reference_type = 'game_session'
         AND wt.reference_id = $1
         AND wt.metadata->>'game_family' = 'teenpatti'
         AND wt.transaction_type IN ('game_entry_debit', 'game_win_credit')
       GROUP BY 1, wt.user_id, u.name, u.view_id
       ORDER BY 1 DESC NULLS LAST, wt.user_id`,
      [sessionId]
    ),
  ]);

  const hands = new Map();
  const perUser = new Map();
  for (const h of handsRes.rows) {
    const key = h.round_no == null ? 0 : Number(h.round_no);
    if (!hands.has(key)) {
      hands.set(key, { round_no: key || null, started_at: h.first_at, ended_at: h.last_at, staked: 0, paid_out: 0, players: [] });
    }
    const hand = hands.get(key);
    const staked = roundCurrency(h.staked);
    const won = roundCurrency(h.won);
    hand.staked = roundCurrency(hand.staked + staked);
    hand.paid_out = roundCurrency(hand.paid_out + won);
    if (h.first_at < hand.started_at) hand.started_at = h.first_at;
    if (h.last_at > hand.ended_at) hand.ended_at = h.last_at;
    hand.players.push({
      user_id: Number(h.user_id),
      name: h.name,
      view_id: h.view_id,
      staked,
      won,
      net: roundCurrency(won - staked),
    });

    const totals = perUser.get(Number(h.user_id)) || { staked: 0, won: 0 };
    totals.staked = roundCurrency(totals.staked + staked);
    totals.won = roundCurrency(totals.won + won);
    perUser.set(Number(h.user_id), totals);
  }

  const session = formatSessionRow({
    ...row,
    humans: playersRes.rows.filter((p) => !p.is_bot && p.metadata?.is_bot !== true).length,
    bots: playersRes.rows.filter((p) => p.is_bot || p.metadata?.is_bot === true).length,
    staked: [...perUser.values()].reduce((sum, t) => sum + t.staked, 0),
    paid_out: [...perUser.values()].reduce((sum, t) => sum + t.won, 0),
  });

  return {
    session,
    players: playersRes.rows.map((p) => {
      const totals = perUser.get(Number(p.user_id)) || { staked: 0, won: 0 };
      return {
        user_id: Number(p.user_id),
        name: p.name,
        view_id: p.view_id,
        avatar: p.avatar,
        seat_no: p.seat_no,
        status: p.status,
        is_bot: p.is_bot === true || p.metadata?.is_bot === true,
        table_left: p.metadata?.table_left === true,
        joined_at: p.joined_at,
        left_at: p.left_at,
        staked: totals.staked,
        won: totals.won,
        net: roundCurrency(totals.won - totals.staked),
      };
    }),
    current_hand: currentHand(row.metadata?.teenpatti),
    hands: [...hands.values()].map((hand) => ({
      ...hand,
      house_result: roundCurrency(hand.staked - hand.paid_out),
    })),
  };
}

module.exports = {
  getOverview,
  listSessions,
  getSessionDetail,
};
