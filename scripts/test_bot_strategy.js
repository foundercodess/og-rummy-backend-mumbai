const assert = require('assert');
const { chooseBotPickSource, chooseBotDiscardCard } = require('../services/botEngine/rummyBotStrategy');

function card(rank, suit, extra = {}) {
  const points = {
    A: 10,
    J: 10,
    Q: 10,
    K: 10,
  };

  return {
    card_uid: extra.card_uid || `${rank}-${suit}-${Math.random().toString(36).slice(2, 8)}`,
    rank,
    suit,
    value: points[rank] || Number(rank) || 0,
    is_joker: extra.is_joker === true,
  };
}

function run() {
  const jokerTop = chooseBotPickSource({
    discard_pile: [card('J', 'joker', { is_joker: true, card_uid: 'joker-top' })],
  }, [
    card('5', 'hearts', { card_uid: 'h5' }),
    card('6', 'hearts', { card_uid: 'h6' }),
    card('K', 'clubs', { card_uid: 'cK' }),
  ], null);
  assert.strictEqual(jokerTop, 'discard', 'bot should always pick a visible joker from the open pile');

  const sequenceUpgradePick = chooseBotPickSource({
    discard_pile: [card('8', 'hearts', { card_uid: 'h8' })],
  }, [
    card('5', 'hearts', { card_uid: 'h5' }),
    card('6', 'hearts', { card_uid: 'h6' }),
    card('7', 'hearts', { card_uid: 'h7' }),
    card('Q', 'clubs', { card_uid: 'cQ' }),
    card('2', 'spades', { card_uid: 's2' }),
  ], null);
  assert.strictEqual(sequenceUpgradePick, 'discard', 'bot should take an open card that extends a pure sequence');

  const preserveUsefulPairDiscard = chooseBotDiscardCard([
    card('Q', 'clubs', { card_uid: 'cQ' }),
    card('Q', 'hearts', { card_uid: 'hQ' }),
    card('5', 'spades', { card_uid: 's5' }),
    card('6', 'spades', { card_uid: 's6' }),
    card('2', 'diamonds', { card_uid: 'd2' }),
  ], null);
  assert.strictEqual(
    preserveUsefulPairDiscard?.card_uid,
    'd2',
    'bot should keep a promising pair and near-sequence, and discard the isolated low-value card'
  );

  const irrelevantOpenCard = chooseBotPickSource({
    discard_pile: [card('K', 'diamonds', { card_uid: 'dK' })],
  }, [
    card('3', 'clubs', { card_uid: 'c3' }),
    card('5', 'hearts', { card_uid: 'h5b' }),
    card('8', 'spades', { card_uid: 's8' }),
  ], null);
  assert.strictEqual(irrelevantOpenCard, 'closed', 'bot should ignore irrelevant open cards');

  const finishEnablerPick = chooseBotPickSource({
    discard_pile: [card('6', 'hearts', { card_uid: 'h6f' })],
  }, [
    card('3', 'hearts', { card_uid: 'h3f' }),
    card('4', 'hearts', { card_uid: 'h4f' }),
    card('5', 'hearts', { card_uid: 'h5f' }),
    card('7', 'spades', { card_uid: 's7f' }),
    card('8', 'spades', { card_uid: 's8f' }),
    card('9', 'spades', { card_uid: 's9f' }),
    card('Q', 'clubs', { card_uid: 'cQf' }),
  ], null);
  assert.strictEqual(
    finishEnablerPick,
    'discard',
    'bot should take discard top when it enables immediate finish after one discard'
  );

  console.log('Bot strategy checks passed');
}

run();
