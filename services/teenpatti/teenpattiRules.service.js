'use strict';

/**
 * Classic Teen Patti ranking (Indian real-money convention):
 * trail > pure sequence > sequence > colour > pair > high card
 * A-K-Q is the highest sequence; A-2-3 is the lowest sequence.
 * Ties split (no suit ranking).
 */

const RANK_VALUE = {
  A: 14, K: 13, Q: 12, J: 11,
  10: 10, 9: 9, 8: 8, 7: 7, 6: 6, 5: 5, 4: 4, 3: 3, 2: 2,
};

const CATEGORY = {
  trail: 6,
  pure_sequence: 5,
  sequence: 4,
  colour: 3,
  pair: 2,
  high: 1,
};

const CATEGORY_LABEL = {
  6: 'Trail',
  5: 'Pure Sequence',
  4: 'Sequence',
  3: 'Colour',
  2: 'Pair',
  1: 'High Card',
};

function cardRankValue(card) {
  const rank = String(card?.rank || card?.value || '').toUpperCase();
  return RANK_VALUE[rank] || 0;
}

function cardSuit(card) {
  return String(card?.suit || '').toUpperCase().slice(0, 1);
}

function normalizeCards(cards = []) {
  if (!Array.isArray(cards) || cards.length !== 3) {
    const err = new Error('Teen Patti hand must have exactly 3 cards');
    err.code = 'INVALID_HAND';
    throw err;
  }
  return cards.map((card) => ({
    rank: String(card.rank || card.value || '').toUpperCase(),
    suit: cardSuit(card),
    card_id: card.card_id || `${cardSuit(card)}${String(card.rank || card.value || '').toUpperCase()}`,
    card_uid: card.card_uid || null,
  }));
}

function isConsecutive(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted[0] === 2 && sorted[1] === 3 && sorted[2] === 14) {
    return { consecutive: true, top: 3, wheel: true };
  }
  if (sorted[1] === sorted[0] + 1 && sorted[2] === sorted[1] + 1) {
    return { consecutive: true, top: sorted[2], wheel: false };
  }
  return { consecutive: false, top: 0, wheel: false };
}

function kickersDesc(values) {
  return [...values].sort((a, b) => b - a);
}

function evaluateHand(rawCards) {
  const cards = normalizeCards(rawCards);
  const values = cards.map(cardRankValue);
  const suits = cards.map((c) => c.suit);
  const sameSuit = suits[0] === suits[1] && suits[1] === suits[2];
  const seq = isConsecutive(values);

  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  const countEntries = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  let category = CATEGORY.high;
  let primary = 0;
  let secondary = 0;
  let tertiary = 0;
  const kickers = kickersDesc(values);

  if (countEntries[0][1] === 3) {
    category = CATEGORY.trail;
    primary = countEntries[0][0];
  } else if (seq.consecutive && sameSuit) {
    category = CATEGORY.pure_sequence;
    primary = seq.top;
  } else if (seq.consecutive) {
    category = CATEGORY.sequence;
    primary = seq.top;
  } else if (sameSuit) {
    category = CATEGORY.colour;
    primary = kickers[0];
    secondary = kickers[1];
    tertiary = kickers[2];
  } else if (countEntries[0][1] === 2) {
    category = CATEGORY.pair;
    primary = countEntries[0][0];
    secondary = countEntries[1][0];
  } else {
    category = CATEGORY.high;
    primary = kickers[0];
    secondary = kickers[1];
    tertiary = kickers[2];
  }

  const score = (category * 1e8)
    + (primary * 1e6)
    + (secondary * 1e4)
    + (tertiary * 1e2);

  return {
    category,
    category_key: Object.keys(CATEGORY).find((key) => CATEGORY[key] === category),
    category_label: CATEGORY_LABEL[category],
    score,
    primary,
    secondary,
    tertiary,
    cards,
  };
}

function compareHands(leftCards, rightCards) {
  const left = evaluateHand(leftCards);
  const right = evaluateHand(rightCards);
  if (left.score === right.score) return 0;
  return left.score > right.score ? 1 : -1;
}

function minChaalAmount({ lastBet, seen, boot }) {
  const base = Math.max(Number(lastBet) || 0, Number(boot) || 0);
  return seen ? base * 2 : base;
}

function maxChaalAmount({ minChaal, pot, potLimit }) {
  const min = Math.max(0, Number(minChaal) || 0);
  const limit = Number(potLimit);
  const potNow = Number(pot) || 0;
  const room = Number.isFinite(limit) && limit > 0 ? Math.max(0, limit - potNow) : min * 2;
  const doubled = min * 2;
  return Math.max(min, Math.min(doubled, room || doubled));
}

function legalActions({
  player,
  opponentsAlive = [],
  lastBet,
  boot,
  pot,
  potLimit,
  isTurn,
  bettingRound = 1,
  previousOpponent = null,
  sideShowPending = false,
}) {
  const state = String(player?.state || 'blind');
  const packed = state === 'packed' || state === 'show_lost';
  const seen = state === 'seen';
  const alive = opponentsAlive.filter((p) => p && p.state !== 'packed' && p.state !== 'show_lost');
  const minChaal = minChaalAmount({ lastBet, seen, boot });
  const maxChaal = maxChaalAmount({ minChaal, pot, potLimit });
  const limit = Number(potLimit);
  const potNow = Number(pot) || 0;
  const potAllowsChaal = !Number.isFinite(limit) || limit <= 0 || (potNow + minChaal) <= limit;
  const prevSeen = previousOpponent && previousOpponent.state === 'seen';
  const canAct = Boolean(isTurn) && !packed && !sideShowPending;

  return {
    can_pack: canAct,
    can_see: !packed && !seen,
    can_chaal: canAct && seen && potAllowsChaal,
    can_blind: canAct && !seen && potAllowsChaal,
    can_show: canAct && alive.length === 1,
    can_side_show: canAct && seen && bettingRound > 1 && alive.length >= 2 && Boolean(prevSeen),
    side_show_target_user_id: prevSeen ? Number(previousOpponent.user_id) : null,
    min_chaal: minChaal,
    max_chaal: maxChaal,
    bet_step: Math.max(1, Number(boot) || 1),
    seen,
    packed,
  };
}

function pickWinners(handsByUserId) {
  let bestScore = -1;
  const winners = [];
  for (const [userId, cards] of Object.entries(handsByUserId || {})) {
    const evaluated = evaluateHand(cards);
    if (evaluated.score > bestScore) {
      bestScore = evaluated.score;
      winners.length = 0;
      winners.push({ user_id: Number(userId), ...evaluated });
    } else if (evaluated.score === bestScore) {
      winners.push({ user_id: Number(userId), ...evaluated });
    }
  }
  return winners;
}

module.exports = {
  RANK_VALUE,
  CATEGORY,
  CATEGORY_LABEL,
  evaluateHand,
  compareHands,
  minChaalAmount,
  maxChaalAmount,
  legalActions,
  pickWinners,
};
