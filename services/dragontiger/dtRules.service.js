'use strict';

/**
 * Dragon Tiger rules (pure functions, no I/O).
 *
 * - One card to Dragon, one to Tiger. Higher rank wins; equal rank is a Tie.
 * - Rank order: A (1) low ... K (13) high. Suits do not matter.
 * - Dragon / Tiger pay 1:1. Tie pays 8:1.
 * - On a Tie, Dragon and Tiger bets get half their stake back.
 * - Commission is taken from a user's positive net result for the round.
 */

const AREAS = Object.freeze(['dragon', 'tiger', 'tie']);
const RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
const SUITS = Object.freeze(['S', 'H', 'D', 'C']);

const PAYOUT_ODDS = Object.freeze({ dragon: 1, tiger: 1, tie: 8 });
const TIE_HALF_BACK_RATIO = 0.5;

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function isArea(value) {
  return AREAS.includes(value);
}

function parseCard(cardId) {
  const id = String(cardId || '').toUpperCase();
  const suit = id.slice(0, 1);
  const rank = id.slice(1);
  if (!SUITS.includes(suit) || !RANKS.includes(rank)) {
    const err = new Error(`Invalid card id: ${cardId}`);
    err.code = 'DT_INVALID_CARD';
    throw err;
  }
  return { suit, rank, value: RANKS.indexOf(rank) + 1, card_id: `${suit}${rank}` };
}

function cardValue(cardId) {
  return parseCard(cardId).value;
}

function decideOutcome(dragonCard, tigerCard) {
  const d = cardValue(dragonCard);
  const t = cardValue(tigerCard);
  if (d > t) return 'dragon';
  if (t > d) return 'tiger';
  return 'tie';
}

/** Gross amount returned for one stake on `area` (stake included). */
function grossReturn(area, amount, outcome) {
  const stake = roundCurrency(amount);
  if (!(stake > 0) || !isArea(area) || !isArea(outcome)) return 0;
  if (area === outcome) return roundCurrency(stake * (1 + PAYOUT_ODDS[area]));
  if (outcome === 'tie') return roundCurrency(stake * TIE_HALF_BACK_RATIO);
  return 0;
}

function betStatusFor(area, outcome) {
  if (area === outcome) return 'won';
  if (outcome === 'tie') return 'half_back';
  return 'lost';
}

function emptyTotals() {
  return { dragon: 0, tiger: 0, tie: 0 };
}

/**
 * Settle one user's stakes for a round.
 * @param {{dragon:number,tiger:number,tie:number}} stakes summed per area
 */
function settleUser(stakes, outcome, commissionPercent) {
  let staked = 0;
  let returned = 0;
  for (const area of AREAS) {
    const amount = roundCurrency(stakes?.[area] || 0);
    staked += amount;
    returned += grossReturn(area, amount, outcome);
  }
  staked = roundCurrency(staked);
  returned = roundCurrency(returned);
  const winnings = roundCurrency(returned - staked);
  const pct = Math.max(0, Number(commissionPercent) || 0);
  const commission = winnings > 0 ? roundCurrency(Math.floor(winnings * pct) / 100) : 0;
  const credited = roundCurrency(returned - commission);
  return {
    staked,
    returned,
    commission,
    credited,
    net: roundCurrency(credited - staked),
  };
}

/**
 * Split `credited` back into wallet buckets. The returned stake goes back to the
 * buckets it came from (proportionally), only winnings go to withdrawable.
 */
function splitCredit({ staked, credited, fromDeposit, fromReleasedBonus, fromWithdrawable }) {
  const stake = roundCurrency(staked);
  const total = roundCurrency(credited);
  if (!(total > 0) || !(stake > 0)) {
    return { toDeposit: 0, toReleasedBonus: 0, toWithdrawable: roundCurrency(Math.max(0, total)) };
  }
  const stakeBack = Math.min(total, stake);
  const ratio = stakeBack / stake;
  const toDeposit = roundCurrency(Number(fromDeposit || 0) * ratio);
  const toReleasedBonus = roundCurrency(Number(fromReleasedBonus || 0) * ratio);
  const toWithdrawable = roundCurrency(total - toDeposit - toReleasedBonus);
  return { toDeposit, toReleasedBonus, toWithdrawable };
}

/** Gross payout the house owes for each possible outcome, given area totals. */
function payoutByOutcome(totals) {
  const d = roundCurrency(totals?.dragon || 0);
  const t = roundCurrency(totals?.tiger || 0);
  const tie = roundCurrency(totals?.tie || 0);
  return {
    dragon: grossReturn('dragon', d, 'dragon'),
    tiger: grossReturn('tiger', t, 'tiger'),
    tie: roundCurrency(
      grossReturn('tie', tie, 'tie')
      + grossReturn('dragon', d, 'tie')
      + grossReturn('tiger', t, 'tie')
    ),
  };
}

function worstCasePayout(totals) {
  const byOutcome = payoutByOutcome(totals);
  return Math.max(byOutcome.dragon, byOutcome.tiger, byOutcome.tie);
}

// Must match `dtPeriodNo` in Flutter (dragon_tiger_models.dart) and the admin panel.
const PERIOD_NO_BASE = 1000000000;

/** 10-digit display id for a round (round id 1234 → "1000001234"). */
function periodNo(roundId) {
  const id = Number(roundId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return String(PERIOD_NO_BASE + id);
}

module.exports = {
  AREAS,
  RANKS,
  SUITS,
  PAYOUT_ODDS,
  TIE_HALF_BACK_RATIO,
  roundCurrency,
  isArea,
  parseCard,
  cardValue,
  decideOutcome,
  grossReturn,
  betStatusFor,
  emptyTotals,
  settleUser,
  splitCredit,
  payoutByOutcome,
  worstCasePayout,
  periodNo,
};
