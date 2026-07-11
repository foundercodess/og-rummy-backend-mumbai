const assert = require('assert');
const { tryBuildBotFinishPlan, tryBuildFinishPlan } = require('../realtime/socketServer');

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

function runUngroupedFinishCardPrefersTwoDiamonds() {
  const cards = [
    { rank: '7', suit: 'diamonds', value: 7, card_id: 'D7', card_uid: 'd7', is_joker: false },
    { rank: '8', suit: 'diamonds', value: 8, card_id: 'D8', card_uid: 'd8', is_joker: false },
    { rank: '9', suit: 'diamonds', value: 9, card_id: 'D9', card_uid: 'd9', is_joker: false },
    { rank: 'A', suit: 'hearts', value: 10, card_id: 'HA', card_uid: 'ha', is_joker: false },
    { rank: 'K', suit: 'hearts', value: 10, card_id: 'HK', card_uid: 'hk', is_joker: false },
    { rank: '3', suit: 'hearts', value: 3, card_id: 'H3', card_uid: 'h3', is_joker: false },
    { rank: '4', suit: 'hearts', value: 4, card_id: 'H4', card_uid: 'h4', is_joker: false },
    { rank: 'A', suit: 'clubs', value: 10, card_id: 'CA', card_uid: 'ca', is_joker: false },
    { rank: 'K', suit: 'clubs', value: 10, card_id: 'CK', card_uid: 'ck', is_joker: false },
    { rank: 'Q', suit: 'diamonds', value: 10, card_id: 'DQ', card_uid: 'dq', is_joker: true },
    { rank: '3', suit: 'spades', value: 3, card_id: 'S3', card_uid: 's3', is_joker: false },
    { rank: '3', suit: 'diamonds', value: 3, card_id: 'D3', card_uid: 'd3', is_joker: false },
    { rank: '3', suit: 'clubs', value: 3, card_id: 'C3', card_uid: 'c3', is_joker: false },
    { rank: '2', suit: 'diamonds', value: 2, card_id: 'D2', card_uid: 'd2_finish', is_joker: false },
  ];
  const wildJoker = { rank: 'K', card_id: 'HK' };
  const submittedGroups = [
    { group_id: 1, cards: ['d7', 'd8', 'd9'] },
    { group_id: 2, cards: ['ha', 'hk', 'h3', 'h4'] },
    { group_id: 3, cards: ['ca', 'ck', 'dq'] },
    { group_id: 4, cards: ['s3', 'd3', 'c3'] },
  ];

  const plan = tryBuildFinishPlan(cards, wildJoker, {
    submittedGroups,
    sessionId: 'verify',
    userId: 1,
    turnId: 1,
  });

  assert(plan, 'expected finish plan from submitted groups');
  assert.strictEqual(plan.finishCard?.card_uid, 'd2_finish', 'expected ungrouped 2D as finish card');
  assert.strictEqual(plan.explain?.source, 'submitted_groups');
  assert.strictEqual(plan.preview?.summary?.valid_for_declare, true);
}

function runUngroupedInvalidLayoutSkipsBotFallback() {
  const cards = [
    { rank: '9', suit: 'clubs', value: 9, card_uid: 'D2_clubs_9_101', is_joker: false },
    { rank: '10', suit: 'clubs', value: 10, card_uid: 'D1_clubs_10_49', is_joker: false },
    { rank: 'J', suit: 'clubs', value: 10, card_uid: 'D2_clubs_J_103', is_joker: false },
    { rank: 'Q', suit: 'clubs', value: 10, card_uid: 'D1_clubs_Q_51', is_joker: false },
    { rank: 'K', suit: 'clubs', value: 10, card_uid: 'D1_clubs_K_52', is_joker: false },
    { rank: '7', suit: 'spades', value: 7, card_uid: 'D2_spades_7_60', is_joker: false },
    { rank: '8', suit: 'spades', value: 8, card_uid: 'D1_spades_8_8', is_joker: false },
    { rank: '6', suit: 'spades', value: 6, card_uid: 'D1_spades_6_6', is_joker: false },
    { rank: '4', suit: 'spades', value: 4, card_uid: 'D1_spades_4_4', is_joker: false },
    { rank: '4', suit: 'hearts', value: 4, card_uid: 'D1_hearts_4_17', is_joker: false },
    { rank: '4', suit: 'diamonds', value: 4, card_uid: 'D1_diamonds_4_30', is_joker: false },
    { rank: '4', suit: 'clubs', value: 4, card_uid: 'D1_clubs_4_43', is_joker: false },
    { rank: '4', suit: 'spades', value: 4, card_uid: 'D2_spades_4_57', is_joker: false },
    { rank: '6', suit: 'hearts', value: 6, card_uid: 'D1_hearts_6_19', is_joker: false },
  ];
  const wildJoker = { rank: '6', card_id: 'S6' };
  const submittedGroups = [
    { group_id: 1, cards: ['D2_clubs_9_101', 'D1_clubs_10_49', 'D2_clubs_J_103', 'D1_clubs_Q_51'] },
    { group_id: 2, cards: ['D2_spades_7_60', 'D1_spades_8_8'] },
    { group_id: 3, cards: ['D1_spades_4_4', 'D1_hearts_4_17', 'D1_spades_6_6'] },
    { group_id: 4, cards: ['D2_spades_4_57', 'D1_diamonds_4_30', 'D1_clubs_4_43'] },
  ];

  const botPlan = tryBuildBotFinishPlan(cards, wildJoker, {
    sessionId: 'verify',
    userId: 'bot',
    turnId: 3,
  });
  assert(botPlan, 'bot heuristic should still find a finish card');

  const plan = tryBuildFinishPlan(cards, wildJoker, {
    submittedGroups,
    sessionId: 'verify',
    userId: 1,
    turnId: 3,
  });
  assert.strictEqual(plan, null, 'invalid manual layout with leftovers must not fall back to bot finish');
}

function runScreenshotStyleFinishPlan() {
  const cards = [
    { rank: '4', suit: 'spades', value: 4, card_uid: 'ps4', is_joker: false },
    { rank: '5', suit: 'spades', value: 5, card_uid: 'ps5', is_joker: false },
    { rank: '6', suit: 'spades', value: 6, card_uid: 'ps6', is_joker: false },
    { rank: '10', suit: 'diamonds', value: 10, card_uid: 'd10', is_joker: false },
    { rank: 'A', suit: 'spades', value: 10, card_uid: 'jas', is_joker: true },
    { rank: 'Q', suit: 'diamonds', value: 10, card_uid: 'dq', is_joker: false },
    { rank: 'K', suit: 'diamonds', value: 10, card_uid: 'dk', is_joker: false },
    { rank: '2', suit: 'spades', value: 2, card_uid: 's2', is_joker: false },
    { rank: '2', suit: 'diamonds', value: 2, card_uid: 'd2', is_joker: false },
    { rank: '2', suit: 'clubs', value: 2, card_uid: 'c2', is_joker: false },
    { rank: '5', suit: 'hearts', value: 5, card_uid: 'h5', is_joker: false },
    { rank: '5', suit: 'clubs', value: 5, card_uid: 'c5', is_joker: false },
    { rank: 'A', suit: 'diamonds', value: 10, card_uid: 'jad', is_joker: true },
    { rank: '4', suit: 'clubs', value: 4, card_uid: 'c4lone', is_joker: false },
  ];
  const wildJoker = { rank: '7', card_id: 'h7' };
  const groupingService = require('../services/grouping.service');

  const bestGrouping = groupingService.buildBestGrouping(cards, wildJoker);
  assert(
    bestGrouping.summary.can_finish_after_one_discard === true,
    'expected finish-ready best grouping on 14-card turn'
  );
  assert.strictEqual(bestGrouping.summary.declare_display_after_finish, 0);
  assert(
    ['h5', 'c4lone'].includes(bestGrouping.summary.finish_card_uid),
    `expected a valid finish card, got ${bestGrouping.summary.finish_card_uid}`
  );
  assert(
    bestGrouping.summary.display_point <= 10,
    `expected finish layout display to stay reasonable, got ${bestGrouping.summary.display_point}`
  );
  assert(
    bestGrouping.summary.sequence_count >= 2,
    `expected at least two sequences in best grouping, got ${bestGrouping.summary.sequence_count}`
  );

  const plan = tryBuildBotFinishPlan(cards, wildJoker, {
    tieBreakSeed: 'verify:finish:screenshot',
    sessionId: 'verify',
    userId: 1,
    turnId: 4,
  });
  assert(plan, 'expected finish plan for screenshot-style hand');
  assert(
    ['h5', 'c4lone'].includes(plan.finishCard?.card_uid),
    `expected a valid finish card from bot plan, got ${plan.finishCard?.card_uid}`
  );
  assert.strictEqual(plan.preview?.summary?.valid_for_declare, true);
}

function run() {
  runOversizedMeldScenario();
  runSession558WildJokerScenario();
  runScreenshotStyleFinishPlan();
  runThirteenCardHandReturnsNull();
  runUngroupedFinishCardPrefersTwoDiamonds();
  runUngroupedInvalidLayoutSkipsBotFallback();
  console.log('Finish plan checks passed');
}

run();

