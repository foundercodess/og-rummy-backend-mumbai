'use strict';

const crypto = require('crypto');
const { RANKS, SUITS, decideOutcome } = require('./dtRules.service'); 

const DEFAULT_DECKS = 8;
// Reshuffle once fewer than this many cards remain (the "cut card").
const DEFAULT_CUT_REMAINING = 60;
const BIAS_SCAN_WINDOW = 60; 

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
  // drawPair() {
  //   if (this.remaining() < Math.max(2, this.cutRemaining)) this.reshuffle();
  //   const dragon = this.cards[this.position];
  //   const tiger = this.cards[this.position + 1];
  //   const position = this.position;
  //   this.position += 2;
  //   return { dragon, tiger, shoe_id: this.id, shoe_position: position };
  // }


    /**
   * @param {object} [opts]
   * @param {'dragon'|'tiger'|'tie'|null} [opts.targetOutcome] null → pure random
   */
    drawPair({ targetOutcome = null } = {}) {
      if (this.remaining() < Math.max(2, this.cutRemaining)) this.reshuffle();
  
      if (!targetOutcome) return this._drawAt(this.position, false);
  
      // Scan forward in pair-aligned steps. Each i and i+1 form one candidate pair.
      const max = Math.min(this.position + BIAS_SCAN_WINDOW, this.cards.length - 2);
      const matches = [];
      for (let i = this.position; i <= max; i += 2) {
        if (decideOutcome(this.cards[i], this.cards[i + 1]) === targetOutcome) {
          matches.push(i);
        }
      }
  
      if (matches.length === 0) {
        // No matching pair in the window → natural draw, no bias applied.
        return this._drawAt(this.position, false);
      }
  
      const pick = matches[crypto.randomInt(matches.length)];
      this._swapPair(pick, this.position);
      return this._drawAt(this.position, true);
    }

    _drawAt(pos, biased) {
      const dragon = this.cards[pos];
      const tiger = this.cards[pos + 1];
      this.position = pos + 2;
      return {
        dragon,
        tiger,
        shoe_id: this.id,
        shoe_position: pos,
        biased,
        outcome: decideOutcome(dragon, tiger),
      };
    }
  
    _swapPair(from, to) {
      if (from === to) return;
      for (let k = 0; k < 2; k += 1) {
        const tmp = this.cards[to + k];
        this.cards[to + k] = this.cards[from + k];
        this.cards[from + k] = tmp;
      }
    }
}

module.exports = {
  DragonTigerShoe,
  buildCards,
  shuffle,
};
