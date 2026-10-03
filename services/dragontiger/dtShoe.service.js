'use strict';

const crypto = require('crypto');
const { RANKS, SUITS } = require('./dtRules.service');

const DEFAULT_DECKS = 8;
// Reshuffle once fewer than this many cards remain (the "cut card").
const DEFAULT_CUT_REMAINING = 60;

function buildCards(decks) {
  const cards = [];
  for (let d = 0; d < decks; d += 1) {
    for (const suit of SUITS) {
      for (const rank of RANKS) cards.push(`${suit}${rank}`);
    }
  }
  return cards;
}

/** Fisher–Yates with a CSPRNG. Outcomes never depend on bets. */
function shuffle(cards) {
  const out = cards.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

class DragonTigerShoe {
  constructor({ decks = DEFAULT_DECKS, cutRemaining = DEFAULT_CUT_REMAINING } = {}) {
    this.decks = decks;
    this.cutRemaining = cutRemaining;
    this.reshuffle();
  }

  reshuffle() {
    this.id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    this.cards = shuffle(buildCards(this.decks));
    this.position = 0;
  }

  remaining() {
    return this.cards.length - this.position;
  }

  /** Dragon card first, then Tiger card. */
  drawPair() {
    if (this.remaining() < Math.max(2, this.cutRemaining)) this.reshuffle();
    const dragon = this.cards[this.position];
    const tiger = this.cards[this.position + 1];
    const position = this.position;
    this.position += 2;
    return { dragon, tiger, shoe_id: this.id, shoe_position: position };
  }
}

module.exports = {
  DragonTigerShoe,
  buildCards,
  shuffle,
};
