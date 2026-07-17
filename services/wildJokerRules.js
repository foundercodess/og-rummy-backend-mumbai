'use strict';

/**
 * Indian rummy: when the revealed wild indicator is a printed joker,
 * all Ace-rank cards are wild for that deal.
 */
const PRINTED_JOKER_WILD_RANK = 'A';

function isPrintedJokerIndicator(wildJoker) {
  if (!wildJoker || typeof wildJoker !== 'object') return false;
  if (wildJoker.is_joker === true) return true;
  const cardId = String(wildJoker.card_id || wildJoker.cardId || '').trim().toUpperCase();
  return cardId === 'JKR' || cardId.startsWith('JKR_');
}

/**
 * Effective wild rank used for melds / scoring / autogroup.
 * Printed-joker indicator → 'A'; otherwise the indicator card's rank.
 */
function resolveWildRank(wildJoker) {
  if (!wildJoker) return null;
  if (typeof wildJoker === 'string') {
    const trimmed = wildJoker.trim();
    if (!trimmed) return null;
    if (trimmed.toUpperCase().startsWith('JKR')) return PRINTED_JOKER_WILD_RANK;
    if (trimmed.length > 1) return trimmed.substring(1);
    return null;
  }
  const explicit = wildJoker.wild_rank ?? wildJoker.wildRank;
  if (explicit != null && String(explicit).trim()) {
    return String(explicit).trim();
  }
  if (isPrintedJokerIndicator(wildJoker)) {
    return PRINTED_JOKER_WILD_RANK;
  }
  const rank = wildJoker.rank;
  return rank != null && String(rank).trim() ? String(rank).trim() : null;
}

function isWildRankCard(card, wildJoker) {
  if (!card || card.is_joker === true) return false;
  const wildRank = resolveWildRank(wildJoker);
  return wildRank != null && card.rank != null && card.rank === wildRank;
}

function isJokerCard(card, wildJoker) {
  if (!card) return false;
  if (card.is_joker === true) return true;
  return isWildRankCard(card, wildJoker);
}

module.exports = {
  PRINTED_JOKER_WILD_RANK,
  isPrintedJokerIndicator,
  resolveWildRank,
  isWildRankCard,
  isJokerCard,
};
