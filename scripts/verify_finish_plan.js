const assert = require('assert');
const { tryBuildBotFinishPlan } = require('../realtime/socketServer');

function runOversizedMeldScenario() {
  const cards = [
    { rank: '7', suit: 'clubs', value: 7, card_id: 'C7', card_uid: 'D2_clubs_7_99', is_joker: false },
    { rank: '8', suit: 'clubs', value: 8, card_id: 'C8', card_uid: 'D2_clubs_8_100', is_joker: false },
    { rank: '9', suit: 'clubs', value: 9, card_id: 'C9', card_uid: 'D1_clubs_9_48', is_joker: false },
    { rank: '5', suit: 'spades', value: 5, card_id: 'S5', card_uid: 'D1_spades_5_5', is_joker: false },
    { rank: '6', suit: 'spades', value: 6, card_id: 'S6', card_uid: 'D2_spades_6_59', is_joker: false },
    { rank: '7', suit: 'spades', value: 7, card_id: 'S7', card_uid: 'D1_spades_7_7', is_joker: false },
    { rank: '9', suit: 'hearts', value: 9, card_id: 'H9', card_uid: 'D2_hearts_9_75', is_joker: false },
    { rank: '10', suit: 'hearts', value: 10, card_id: 'H10', card_uid: 'D2_hearts_10_76', is_joker: false },
    { rank: 'J', suit: 'hearts', value: 10, card_id: 'HJ', card_uid: 'D2_hearts_J_77', is_joker: false },
    { rank: '4', suit: 'clubs', value: 4, card_id: 'C4', card_uid: 'D2_clubs_4_96', is_joker: false },
    { rank: 'K', suit: 'hearts', value: 10, card_id: 'HK', card_uid: 'D2_hearts_K_79', is_joker: false },
    { rank: '3', suit: 'spades', value: 3, card_id: 'S3', card_uid: 'D1_spades_3_3', is_joker: false },
    { rank: '3', suit: 'hearts', value: 3, card_id: 'H3', card_uid: 'D1_hearts_3_16', is_joker: false },
    { rank: '4', suit: 'diamonds', value: 4, card_id: 'D4', card_uid: 'D1_diamonds_4_30', is_joker: false },
  ];
  const wildJoker = { rank: '4', card_id: 'D4' };

  const plan = tryBuildBotFinishPlan(cards, wildJoker, {
    tieBreakSeed: 'verify:finish:oversized',
    sessionId: 'verify',
    userId: 'bot',
    turnId: 1,
  });

  assert(plan, 'expected finish plan for declare-valid 14-card hand');
  assert.strictEqual(
    plan.finishCard?.card_uid,
    'D2_hearts_K_79',
    'expected discard from oversized meld to be HK'
  );
  assert.strictEqual(
    plan?.preview?.summary?.valid_for_declare,
    true,
    'post-discard hand should remain valid declare'
  );
}

function runSession558WildJokerScenario() {
  const cards = [
    { rank: '9', suit: 'clubs', value: 9, card_id: 'C9', card_uid: 'D2_clubs_9_101', is_joker: false },
    { rank: '10', suit: 'clubs', value: 10, card_id: 'C10', card_uid: 'D1_clubs_10_49', is_joker: false },
    { rank: 'J', suit: 'clubs', value: 10, card_id: 'CJ', card_uid: 'D2_clubs_J_103', is_joker: false },
    { rank: 'Q', suit: 'clubs', value: 10, card_id: 'CQ', card_uid: 'D1_clubs_Q_51', is_joker: false },
    { rank: 'K', suit: 'clubs', value: 10, card_id: 'CK', card_uid: 'D1_clubs_K_52', is_joker: false },
    { rank: '7', suit: 'spades', value: 7, card_id: 'S7', card_uid: 'D2_spades_7_60', is_joker: false },
    { rank: '8', suit: 'spades', value: 8, card_id: 'S8', card_uid: 'D1_spades_8_8', is_joker: false },
    { rank: '6', suit: 'spades', value: 6, card_id: 'S6', card_uid: 'D1_spades_6_6', is_joker: false },
    { rank: '4', suit: 'spades', value: 4, card_id: 'S4', card_uid: 'D1_spades_4_4', is_joker: false },
    { rank: '4', suit: 'hearts', value: 4, card_id: 'H4', card_uid: 'D1_hearts_4_17', is_joker: false },
    { rank: '4', suit: 'diamonds', value: 4, card_id: 'D4', card_uid: 'D1_diamonds_4_30', is_joker: false },
    { rank: '4', suit: 'clubs', value: 4, card_id: 'C4', card_uid: 'D1_clubs_4_43', is_joker: false },
    { rank: '4', suit: 'spades', value: 4, card_id: 'S4', card_uid: 'D2_spades_4_57', is_joker: false },
    { rank: '6', suit: 'hearts', value: 6, card_id: 'H6', card_uid: 'D1_hearts_6_19', is_joker: false },
  ];
  const wildJoker = { rank: '6', card_id: 'S6' };
  const groupingService = require('../services/grouping.service');

  const plan = tryBuildBotFinishPlan(cards, wildJoker, {
    tieBreakSeed: 'verify:finish:session558',
    sessionId: '558',
    userId: 3,
    turnId: 1778836859971,
  });

  assert(plan, 'expected finish plan for session-558 style hand');
  assert.strictEqual(plan.preview?.summary?.valid_for_declare, true, 'preview should stay declare-valid');

  const submittedGrouping = groupingService.evaluateSubmittedGrouping(
    plan.nextHandCards,
    wildJoker,
    plan.submittedGroups
  );
  assert.strictEqual(
    submittedGrouping.summary.valid_for_declare,
    true,
    'submitted melds should match preview declare validity with zero-point wild joker leftover'
  );
  assert.strictEqual(submittedGrouping.summary.ungrouped_points, 0, 'wild joker leftover should score 0');
}

function runThirteenCardHandReturnsNull() {
  const cards = [
    { rank: '7', suit: 'clubs', value: 7, card_id: 'C7', card_uid: 'D2_clubs_7_99', is_joker: false },
    { rank: '8', suit: 'clubs', value: 8, card_id: 'C8', card_uid: 'D2_clubs_8_100', is_joker: false },
    { rank: '9', suit: 'clubs', value: 9, card_id: 'C9', card_uid: 'D1_clubs_9_48', is_joker: false },
    { rank: '5', suit: 'spades', value: 5, card_id: 'S5', card_uid: 'D1_spades_5_5', is_joker: false },
    { rank: '6', suit: 'spades', value: 6, card_id: 'S6', card_uid: 'D2_spades_6_59', is_joker: false },
    { rank: '7', suit: 'spades', value: 7, card_id: 'S7', card_uid: 'D1_spades_7_7', is_joker: false },
    { rank: '9', suit: 'hearts', value: 9, card_id: 'H9', card_uid: 'D2_hearts_9_75', is_joker: false },
    { rank: '10', suit: 'hearts', value: 10, card_id: 'H10', card_uid: 'D2_hearts_10_76', is_joker: false },
    { rank: 'J', suit: 'hearts', value: 10, card_id: 'HJ', card_uid: 'D2_hearts_J_77', is_joker: false },
    { rank: '4', suit: 'clubs', value: 4, card_id: 'C4', card_uid: 'D2_clubs_4_96', is_joker: false },
    { rank: 'K', suit: 'hearts', value: 10, card_id: 'HK', card_uid: 'D2_hearts_K_79', is_joker: false },
    { rank: '3', suit: 'spades', value: 3, card_id: 'S3', card_uid: 'D1_spades_3_3', is_joker: false },
    { rank: '3', suit: 'hearts', value: 3, card_id: 'H3', card_uid: 'D1_hearts_3_16', is_joker: false },
  ];
  const wildJoker = { rank: '4', card_id: 'D4' };

  const plan = tryBuildBotFinishPlan(cards, wildJoker, {
    tieBreakSeed: 'verify:finish:13cards',
    sessionId: 'verify',
    userId: 'bot',
    turnId: 2,
  });

  assert.strictEqual(plan, null, '13-card hand must not produce finish plan');
}

function run() {
  runOversizedMeldScenario();
  runSession558WildJokerScenario();
  runThirteenCardHandReturnsNull();
  console.log('Finish plan checks passed');
}

run();

