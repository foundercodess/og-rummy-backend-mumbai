'use strict';

const assert = require('assert');
const {
  resolveWildRank,
  isJokerCard,
  PRINTED_JOKER_WILD_RANK,
} = require('../services/wildJokerRules');
const groupingService = require('../services/grouping.service');

function card(uid, rank, suit, value = 10, isJoker = false) {
  const suitLetter = suit ? String(suit)[0].toUpperCase() : '';
  return {
    card_uid: uid,
    card_id: isJoker ? 'JKR' : `${suitLetter}${rank}`,
    suit,
    rank: isJoker ? null : rank,
    value,
    is_joker: isJoker,
  };
}

function verifyPrintedJokerIndicatorUsesAceWild() {
  const printedIndicator = card('jk1', null, null, 0, true);
  assert.strictEqual(resolveWildRank(printedIndicator), PRINTED_JOKER_WILD_RANK);
  assert.strictEqual(isJokerCard(card('ha', 'A', 'hearts'), printedIndicator), true);
  assert.strictEqual(isJokerCard(card('h7', '7', 'hearts'), printedIndicator), false);
  assert.strictEqual(isJokerCard(card('pj', null, null, 0, true), printedIndicator), true);
}

function verifyNormalIndicatorUnchanged() {
  const wildSeven = { card_id: 'H7', rank: '7', suit: 'hearts', is_joker: false };
  assert.strictEqual(resolveWildRank(wildSeven), '7');
  assert.strictEqual(isJokerCard(card('h7b', '7', 'hearts'), wildSeven), true);
  assert.strictEqual(isJokerCard(card('ha', 'A', 'hearts'), wildSeven), false);
}

function verifyAutogroupWithPrintedIndicator() {
  const printedIndicator = card('jk1', null, null, 0, true);
  const hand = [
    card('h9', '9', 'hearts'),
    card('h10', '10', 'hearts'),
    card('hJ', 'J', 'hearts'),
    card('s9', '9', 'spades'),
    card('s10', '10', 'spades'),
    card('sJ', 'J', 'spades'),
    card('c9', '9', 'clubs'),
    card('c10', '10', 'clubs'),
    card('cJ', 'J', 'clubs'),
    card('d9', '9', 'diamonds'),
    card('d10', '10', 'diamonds'),
    card('dJ', 'J', 'diamonds'),
    card('ha', 'A', 'hearts'),
  ];
  const grouping = groupingService.buildBestGrouping(hand, printedIndicator);
  const aceUsedAsJoker = (grouping.groups || []).some((group) =>
    (group.cards || []).some((c) => c.card_uid === 'ha')
  );
  assert.strictEqual(aceUsedAsJoker, true, 'Ace should participate in best grouping as wild');
  assert.strictEqual(Number(grouping.summary?.display_point) >= 0, true);
}

verifyPrintedJokerIndicatorUsesAceWild();
verifyNormalIndicatorUnchanged();
verifyAutogroupWithPrintedIndicator();
console.log('verify_wild_joker_rules: ok');
