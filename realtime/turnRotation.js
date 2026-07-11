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

function resolveDealFirstTurnUserId(metadata = {}) {
  const fromMeta = Number(metadata?.first_turn_user_id);
  if (!Number.isNaN(fromMeta) && fromMeta > 0) return fromMeta;

  const fromGameState = Number(metadata?.game_state?.current_turn_user_id);
  if (!Number.isNaN(fromGameState) && fromGameState > 0) return fromGameState;

  const fromTurn = Number(metadata?.turn?.user_id);
  if (!Number.isNaN(fromTurn) && fromTurn > 0) return fromTurn;

  const fromToss = Number(metadata?.toss?.toss_winner_user_id || metadata?.toss?.winner_user_id);
  if (!Number.isNaN(fromToss) && fromToss > 0) return fromToss;

  return null;
}

/**
 * First turn of the next deal = anticlockwise next seat from previous deal's opener.
 */
function resolveNextDealFirstTurnUserId(session, players = []) {
  const anchorUserId = resolveDealFirstTurnUserId(session?.metadata || {});
  if (!anchorUserId) return null;
  return anticlockwiseNextTurnUserId(players, anchorUserId);
}

module.exports = {
  sortPlayersBySeat,
  anticlockwiseNextTurnUserId,
  resolveDealFirstTurnUserId,
  resolveNextDealFirstTurnUserId,
};
