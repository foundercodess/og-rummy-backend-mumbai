'use strict';

function sortPlayersBySeat(players = []) {
  return [...players].sort((a, b) => Number(a.seat_no) - Number(b.seat_no));
}

/**
 * Advance turn in game anticlockwise order.
 *
 * Seat numbers increase clockwise around the table; anticlockwise *play*
 * passes to the player on your right, which is the next higher seat_no
 * (wrapping from highest back to seat 1). Matches legacy nextTurnUserId.
 */
function anticlockwiseNextTurnUserId(players, currentUserId, options = {}) {
  const seats = sortPlayersBySeat(players);
  if (seats.length === 0) return null;

  const currentId = Number(currentUserId);
  const idx = seats.findIndex((p) => Number(p.user_id) === currentId);
  if (idx >= 0) {
    return seats[(idx + 1) % seats.length].user_id;
  }

  // Current player may already be removed (drop/pack/timeout) — advance from their seat.
  const pivotSeat = Number(options.currentSeatNo);
  if (Number.isFinite(pivotSeat)) {
    const next = seats.find((p) => Number(p.seat_no) > pivotSeat);
    return (next ?? seats[0]).user_id;
  }

  return seats[0].user_id;
}

/**
 * Previous seat in anticlockwise play order (the player who acts last before the opener).
 */
function anticlockwisePreviousTurnUserId(players, currentUserId) {
  const seats = sortPlayersBySeat(players);
  if (seats.length === 0) return null;

  const currentId = Number(currentUserId);
  const idx = seats.findIndex((p) => Number(p.user_id) === currentId);
  if (idx < 0) return null;
  return seats[(idx - 1 + seats.length) % seats.length].user_id;
}

function resolveDealFirstTurnUserId(metadata = {}) {
  const fromMeta = Number(metadata?.first_turn_user_id);
  if (!Number.isNaN(fromMeta) && fromMeta > 0) return fromMeta;

  const dealScores = Array.isArray(metadata?.deal_scores) ? metadata.deal_scores : [];
  for (let i = dealScores.length - 1; i >= 0; i -= 1) {
    const fromDeal = Number(dealScores[i]?.first_turn_user_id);
    if (!Number.isNaN(fromDeal) && fromDeal > 0) return fromDeal;
  }

  const fromToss = Number(metadata?.toss?.toss_winner_user_id || metadata?.toss?.winner_user_id);
  if (!Number.isNaN(fromToss) && fromToss > 0) return fromToss;

  return null;
}

/**
 * Turn-eligible roster fixed at deal start (excludes pool eliminated, dropped, left, etc.).
 */
function filterTurnEligibleAtDealStart(players = [], options = {}) {
  const poolEliminated = new Set(
    (Array.isArray(options.poolEliminatedUserIds) ? options.poolEliminatedUserIds : [])
      .map((id) => Number(id))
      .filter((id) => !Number.isNaN(id))
  );
  const turnEliminated = new Set(
    (Array.isArray(options.turnEliminatedUserIds) ? options.turnEliminatedUserIds : [])
      .map((id) => Number(id))
      .filter((id) => !Number.isNaN(id))
  );

  return sortPlayersBySeat(players).filter((player) => {
    const userId = Number(player?.user_id);
    if (Number.isNaN(userId)) return false;
    if (poolEliminated.has(userId)) return false;
    if (turnEliminated.has(userId)) return false;
    if (player?.status === 'left' || player?.status === 'eliminated') return false;
    if (player?.metadata?.is_dropped === true) return false;
    if (String(player?.metadata?.drop_status || '').toLowerCase() === 'dropped') return false;
    return true;
  });
}

/**
 * Last player in the deal turn cycle — fixed at deal start, does not change on mid-deal drop.
 */
function resolveLastTurnUserId(players = [], firstTurnUserId = null) {
  const seats = filterTurnEligibleAtDealStart(players);
  if (seats.length === 0) return null;
  const openerId = Number(firstTurnUserId);
  if (Number.isNaN(openerId) || openerId <= 0) return seats[seats.length - 1]?.user_id ?? null;
  return anticlockwisePreviousTurnUserId(seats, openerId);
}

/**
 * First turn of the next deal = anticlockwise next seat from previous deal's opener.
 */
function resolveNextDealFirstTurnUserId(session, players = []) {
  const anchorUserId = resolveDealFirstTurnUserId(session?.metadata || {});
  const seats = filterTurnEligibleAtDealStart(players, {
    poolEliminatedUserIds: session?.metadata?.pool_eliminated_user_ids || [],
    turnEliminatedUserIds: session?.metadata?.turn_eliminated_user_ids || [],
  });
  if (seats.length === 0) return null;
  if (!anchorUserId) return seats[0]?.user_id ?? null;

  const next = anticlockwiseNextTurnUserId(seats, anchorUserId);
  if (next && Number(next) !== Number(anchorUserId)) return next;

  if (seats.length === 2) {
    const other = seats.find((p) => Number(p.user_id) !== Number(anchorUserId));
    return other?.user_id ?? null;
  }

  return next || seats[0]?.user_id || null;
}

module.exports = {
  sortPlayersBySeat,
  anticlockwiseNextTurnUserId,
  anticlockwisePreviousTurnUserId,
  resolveDealFirstTurnUserId,
  filterTurnEligibleAtDealStart,
  resolveLastTurnUserId,
  resolveNextDealFirstTurnUserId,
};
