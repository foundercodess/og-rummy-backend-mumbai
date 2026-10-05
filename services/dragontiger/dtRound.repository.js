'use strict';

const { query } = require('../../db');
const { AREAS, roundCurrency, emptyTotals } = require('./dtRules.service');

const OPEN_STATUSES = ['betting', 'locked', 'settling'];

function totalsFromRow(row) {
  if (!row) return emptyTotals();
  return {
    dragon: roundCurrency(row.dragon_total),
    tiger: roundCurrency(row.tiger_total),
    tie: roundCurrency(row.tie_total),
  };
}

function historyEntry(row) {
  return {
    round_id: Number(row.id),
    result: row.result,
    dragon_card: row.dragon_card,
    tiger_card: row.tiger_card,
  };
}

async function findOpenRound() {
  const result = await query(
    `SELECT * FROM dt_rounds WHERE status = ANY($1::text[]) ORDER BY id DESC LIMIT 1`,
    [OPEN_STATUSES]
  );
  return result.rows[0] || null;
}

async function findLatestRound() {
  const result = await query('SELECT * FROM dt_rounds ORDER BY id DESC LIMIT 1');
  return result.rows[0] || null;
}

async function findRoundById(roundId) {
  const result = await query('SELECT * FROM dt_rounds WHERE id = $1', [roundId]);
  return result.rows[0] || null;
}

/** Returns null when another engine already holds an open round. */
async function createRound({ bettingEndsAt, commissionPercent, revealSeconds, resultSeconds, meta }) {
  try {
    const result = await query(
      `INSERT INTO dt_rounds (status, betting_ends_at, commission_percent, reveal_seconds, result_seconds, meta)
       VALUES ('betting', $1, $2, $3, $4, $5::jsonb)
       RETURNING *`,
      [bettingEndsAt, commissionPercent, revealSeconds, resultSeconds, JSON.stringify(meta || {})]
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === '23505') return null;
    throw err;
  }
}

/** Closes betting and records the cards. Idempotent: returns the stored row if already locked. */
async function lockAndReveal(roundId, { dragonCard, tigerCard, result, shoeId, shoePosition }) {
  const updated = await query(
    `UPDATE dt_rounds
     SET status = 'locked',
         locked_at = NOW(),
         dragon_card = $2,
         tiger_card = $3,
         result = $4,
         shoe_id = $5,
         shoe_position = $6
     WHERE id = $1 AND status = 'betting'
     RETURNING *`,
    [roundId, dragonCard, tigerCard, result, shoeId, shoePosition]
  );
  return updated.rows[0] || findRoundById(roundId);
}

async function markSettling(roundId) {
  await query(
    `UPDATE dt_rounds SET status = 'settling' WHERE id = $1 AND status = 'locked'`,
    [roundId]
  );
}

async function finalizeRound(roundId) {
  const result = await query(
    `UPDATE dt_rounds r
     SET status = 'settled',
         settled_at = NOW(),
         total_returned = COALESCE(s.returned, 0),
         total_commission = COALESCE(s.commission, 0)
     FROM (
       SELECT COALESCE(SUM(returned), 0) AS returned, COALESCE(SUM(commission), 0) AS commission
       FROM dt_round_settlements WHERE round_id = $1
     ) s
     WHERE r.id = $1 AND r.status IN ('locked', 'settling')
     RETURNING r.*`,
    [roundId]
  );
  return result.rows[0] || findRoundById(roundId);
}

/** Unsettled stakes per user for a round, with the wallet buckets they came from. */
async function aggregateOpenStakes(roundId) {
  const result = await query(
    `SELECT user_id,
            area,
            SUM(amount) AS amount,
            SUM(from_deposit) AS from_deposit,
            SUM(from_released_bonus) AS from_released_bonus,
            SUM(from_withdrawable) AS from_withdrawable
     FROM dt_bets
     WHERE round_id = $1 AND status = 'placed'
     GROUP BY user_id, area`,
    [roundId]
  );
  const byUser = new Map();
  for (const row of result.rows) {
    const userId = Number(row.user_id);
    if (!byUser.has(userId)) {
      byUser.set(userId, {
        user_id: userId,
        stakes: emptyTotals(),
        from_deposit: 0,
        from_released_bonus: 0,
        from_withdrawable: 0,
      });
    }
    const entry = byUser.get(userId);
    entry.stakes[row.area] = roundCurrency(entry.stakes[row.area] + Number(row.amount));
    entry.from_deposit = roundCurrency(entry.from_deposit + Number(row.from_deposit));
    entry.from_released_bonus = roundCurrency(entry.from_released_bonus + Number(row.from_released_bonus));
    entry.from_withdrawable = roundCurrency(entry.from_withdrawable + Number(row.from_withdrawable));
  }
  return [...byUser.values()];
}

async function getHistory(limit = 60) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 60));
  const result = await query(
    `SELECT id, result, dragon_card, tiger_card
     FROM dt_rounds
     WHERE status = 'settled'
     ORDER BY id DESC
     LIMIT $1`,
    [safeLimit]
  );
  return result.rows.map(historyEntry);
}

async function getUserRoundStakes(roundId, userId) {
  const totals = emptyTotals();
  if (!roundId || !userId) return totals;
  const result = await query(
    `SELECT area, SUM(amount) AS amount
     FROM dt_bets
     WHERE round_id = $1 AND user_id = $2 AND status IN ('placed', 'won', 'lost', 'half_back')
     GROUP BY area`,
    [roundId, userId]
  );
  for (const row of result.rows) {
    if (AREAS.includes(row.area)) totals[row.area] = roundCurrency(row.amount);
  }
  return totals;
}

async function getUserSettlement(roundId, userId) {
  const result = await query(
    'SELECT * FROM dt_round_settlements WHERE round_id = $1 AND user_id = $2',
    [roundId, userId]
  );
  return result.rows[0] || null;
}

async function getWalletBalance(userId) {
  const result = await query(
    `SELECT total_balance, deposit, released_bonus, withdrawable FROM wallets WHERE user_id = $1`,
    [userId]
  );
  const row = result.rows[0];
  if (!row) return { total_balance: 0, spendable: 0 };
  return {
    total_balance: roundCurrency(row.total_balance),
    spendable: roundCurrency(
      Number(row.deposit || 0) + Number(row.released_bonus || 0) + Number(row.withdrawable || 0)
    ),
  };
}

const ROUND_STATUSES = ['betting', 'locked', 'settling', 'settled', 'cancelled'];

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildRoundFilters({ result, status, user, from, to } = {}) {
  const where = [];
  const params = [];
  if (AREAS.includes(result)) {
    params.push(result);
    where.push(`r.result = $${params.length}`);
  }
  if (ROUND_STATUSES.includes(status)) {
    params.push(status);
    where.push(`r.status = $${params.length}`);
  }
  const userKey = String(user || '').trim();
  if (userKey) {
    params.push(userKey);
    where.push(`EXISTS (
      SELECT 1 FROM dt_bets fb JOIN users fu ON fu.id = fb.user_id
      WHERE fb.round_id = r.id AND (fu.id::text = $${params.length} OR fu.view_id::text = $${params.length})
    )`);
  }
  const fromDate = validDate(from);
  if (fromDate) {
    params.push(fromDate);
    where.push(`r.created_at >= $${params.length}`);
  }
  const toDate = validDate(to);
  if (toDate) {
    params.push(toDate);
    where.push(`r.created_at <= $${params.length}`);
  }
  return { whereClause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function houseResult(staked, returned, commission) {
  return roundCurrency(Number(staked || 0) - Number(returned || 0) + Number(commission || 0));
}

async function listRoundsForAdmin({ page = 1, limit = 20, ...filters } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safeLimit;
  const { whereClause, params } = buildRoundFilters(filters);
  const [rows, count] = await Promise.all([
    query(
      `SELECT r.id, r.status, r.result, r.dragon_card, r.tiger_card,
              r.dragon_total, r.tiger_total, r.tie_total,
              r.total_staked, r.total_returned, r.total_commission, r.commission_percent,
              r.created_at, r.locked_at, r.settled_at,
              (SELECT COUNT(DISTINCT b.user_id) FROM dt_bets b WHERE b.round_id = r.id AND b.status <> 'refunded') AS bettors
       FROM dt_rounds r
       ${whereClause}
       ORDER BY r.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, safeLimit, offset]
    ),
    query(`SELECT COUNT(*)::int AS total FROM dt_rounds r ${whereClause}`, params),
  ]);
  return {
    page: safePage,
    limit: safeLimit,
    total: count.rows[0]?.total || 0,
    rounds: rows.rows.map((row) => ({
      ...row,
      id: Number(row.id),
      bettors: Number(row.bettors || 0),
      house_result: houseResult(row.total_staked, row.total_returned, row.total_commission),
    })),
  };
}

async function getPeriodStatsForAdmin(since) {
  const [rounds, players] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS rounds,
              COUNT(*) FILTER (WHERE total_staked > 0)::int AS rounds_with_bets,
              COUNT(*) FILTER (WHERE result = 'dragon')::int AS dragon,
              COUNT(*) FILTER (WHERE result = 'tiger')::int AS tiger,
              COUNT(*) FILTER (WHERE result = 'tie')::int AS tie,
              COALESCE(SUM(total_staked), 0) AS staked,
              COALESCE(SUM(total_returned), 0) AS returned,
              COALESCE(SUM(total_commission), 0) AS commission
       FROM dt_rounds
       WHERE status = 'settled' AND ($1::timestamptz IS NULL OR settled_at >= $1)`,
      [since]
    ),
    query(
      `SELECT COUNT(DISTINCT user_id)::int AS players
       FROM dt_round_settlements
       WHERE ($1::timestamptz IS NULL OR created_at >= $1)`,
      [since]
    ),
  ]);
  const row = rounds.rows[0] || {};
  const staked = roundCurrency(row.staked);
  const returned = roundCurrency(row.returned);
  const commission = roundCurrency(row.commission);
  return {
    rounds: Number(row.rounds || 0),
    rounds_with_bets: Number(row.rounds_with_bets || 0),
    results: { dragon: Number(row.dragon || 0), tiger: Number(row.tiger || 0), tie: Number(row.tie || 0) },
    players: Number(players.rows[0]?.players || 0),
    staked,
    returned,
    commission,
    paid_out: roundCurrency(returned - commission),
    house_result: houseResult(staked, returned, commission),
  };
}

/** Admin overview: live round + today / last 7 days / all-time totals (UTC day) + top players. */
async function getAdminSummary() {
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [openRound, today, last7Days, allTime, topPlayers] = await Promise.all([
    findOpenRound(),
    getPeriodStatsForAdmin(todayStart),
    getPeriodStatsForAdmin(weekStart),
    getPeriodStatsForAdmin(null),
    query(
      `SELECT s.user_id, u.name, u.view_id,
              COUNT(*)::int AS rounds,
              COALESCE(SUM(s.staked), 0) AS staked,
              COALESCE(SUM(s.credited), 0) AS credited,
              COALESCE(SUM(s.commission), 0) AS commission,
              COALESCE(SUM(s.net), 0) AS net
       FROM dt_round_settlements s
       JOIN users u ON u.id = s.user_id
       WHERE s.created_at >= $1
       GROUP BY s.user_id, u.name, u.view_id
       ORDER BY SUM(s.staked) DESC
       LIMIT 10`,
      [weekStart]
    ),
  ]);

  let liveRound = null;
  if (openRound) {
    const bettors = await query(
      `SELECT COUNT(DISTINCT user_id)::int AS bettors
       FROM dt_bets WHERE round_id = $1 AND status <> 'refunded'`,
      [openRound.id]
    );
    liveRound = {
      id: Number(openRound.id),
      status: openRound.status,
      betting_ends_at: openRound.betting_ends_at,
      created_at: openRound.created_at,
      totals: totalsFromRow(openRound),
      total_staked: roundCurrency(openRound.total_staked),
      bettors: Number(bettors.rows[0]?.bettors || 0),
      result: openRound.result,
      dragon_card: openRound.dragon_card,
      tiger_card: openRound.tiger_card,
    };
  }

  return {
    timezone: 'UTC',
    as_of: now.toISOString(),
    live_round: liveRound,
    periods: { today, last_7_days: last7Days, all_time: allTime },
    top_players: topPlayers.rows.map((row) => ({
      user_id: Number(row.user_id),
      name: row.name,
      view_id: row.view_id,
      rounds: Number(row.rounds || 0),
      staked: roundCurrency(row.staked),
      credited: roundCurrency(row.credited),
      commission: roundCurrency(row.commission),
      net: roundCurrency(row.net),
    })),
  };
}

async function getRoundDetailForAdmin(roundId) {
  const round = await findRoundById(roundId);
  if (!round) return null;
  const [bets, settlements] = await Promise.all([
    query(
      `SELECT b.id, b.user_id, u.name, u.view_id, b.area, b.amount, b.status, b.payout,
              b.from_deposit, b.from_released_bonus, b.from_withdrawable, b.created_at, b.settled_at
       FROM dt_bets b
       JOIN users u ON u.id = b.user_id
       WHERE b.round_id = $1
       ORDER BY b.user_id, b.id`,
      [roundId]
    ),
    query(
      `SELECT s.user_id, u.name, u.view_id, s.staked, s.returned, s.commission, s.credited, s.net, s.created_at
       FROM dt_round_settlements s
       JOIN users u ON u.id = s.user_id
       WHERE s.round_id = $1
       ORDER BY s.user_id`,
      [roundId]
    ),
  ]);
  return {
    round: {
      ...round,
      id: Number(round.id),
      house_result: houseResult(round.total_staked, round.total_returned, round.total_commission),
    },
    bets: bets.rows.map((row) => ({ ...row, id: Number(row.id) })),
    settlements: settlements.rows,
  };
}

module.exports = {
  OPEN_STATUSES,
  totalsFromRow,
  findOpenRound,
  findLatestRound,
  findRoundById,
  createRound,
  lockAndReveal,
  markSettling,
  finalizeRound,
  aggregateOpenStakes,
  getHistory,
  getUserRoundStakes,
  getUserSettlement,
  getWalletBalance,
  listRoundsForAdmin,
  getAdminSummary,
  getRoundDetailForAdmin,
};
