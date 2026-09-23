const assert = require('assert');
const {
  evaluateHand,
  compareHands,
  minChaalAmount,
  pickWinners,
} = require('../services/teenpatti/teenpattiRules.service');

function c(rank, suit) {
  return { rank, suit, card_id: `${suit}${rank}` };
}

function main() {
  const trailA = evaluateHand([c('A', 'H'), c('A', 'S'), c('A', 'D')]);
  const trail2 = evaluateHand([c('2', 'H'), c('2', 'S'), c('2', 'D')]);
  assert.strictEqual(trailA.category_key, 'trail');
  assert.ok(compareHands([c('A', 'H'), c('A', 'S'), c('A', 'D')], [c('2', 'H'), c('2', 'S'), c('2', 'D')]) > 0);

  const akqPure = evaluateHand([c('A', 'H'), c('K', 'H'), c('Q', 'H')]);
  const wheelPure = evaluateHand([c('A', 'S'), c('2', 'S'), c('3', 'S')]);
  assert.strictEqual(akqPure.category_key, 'pure_sequence');
  assert.strictEqual(wheelPure.category_key, 'pure_sequence');
  assert.ok(compareHands([c('A', 'H'), c('K', 'H'), c('Q', 'H')], [c('A', 'S'), c('2', 'S'), c('3', 'S')]) > 0);

  const seq = evaluateHand([c('9', 'H'), c('8', 'D'), c('7', 'C')]);
  assert.strictEqual(seq.category_key, 'sequence');

  const colour = evaluateHand([c('A', 'H'), c('9', 'H'), c('4', 'H')]);
  assert.strictEqual(colour.category_key, 'colour');

  const pair = evaluateHand([c('K', 'H'), c('K', 'S'), c('3', 'D')]);
  assert.strictEqual(pair.category_key, 'pair');

  const high = evaluateHand([c('A', 'H'), c('K', 'S'), c('9', 'D')]);
  assert.strictEqual(high.category_key, 'high');

  assert.ok(compareHands(
    [c('A', 'H'), c('A', 'S'), c('A', 'D')],
    [c('A', 'H'), c('K', 'H'), c('Q', 'H')],
  ) > 0);
  assert.ok(compareHands(
    [c('A', 'H'), c('K', 'H'), c('Q', 'H')],
    [c('9', 'H'), c('8', 'D'), c('7', 'C')],
  ) > 0);

  assert.strictEqual(minChaalAmount({ lastBet: 10, seen: false, boot: 10 }), 10);
  assert.strictEqual(minChaalAmount({ lastBet: 10, seen: true, boot: 10 }), 20);

  const winners = pickWinners({
    1: [c('A', 'H'), c('A', 'S'), c('9', 'D')],
    2: [c('K', 'H'), c('K', 'S'), c('9', 'C')],
  });
  assert.strictEqual(winners.length, 1);
  assert.strictEqual(winners[0].user_id, 1);

  const split = pickWinners({
    1: [c('A', 'H'), c('K', 'S'), c('9', 'D')],
    2: [c('A', 'C'), c('K', 'D'), c('9', 'H')],
  });
  assert.strictEqual(split.length, 2);

  console.log('verify_teenpatti_rules: PASS');
}

try {
  main();
} catch (err) {
  console.error('verify_teenpatti_rules: FAIL');
  console.error(err.stack || err.message);
  process.exit(1);
}
