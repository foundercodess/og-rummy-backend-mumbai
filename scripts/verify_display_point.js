const groupingService = require('../services/grouping.service');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function card(card_uid, rank, suit, value, is_joker = false) {
  return { card_uid, rank, suit, value, is_joker };
}

function verifyBestGroupingPriorityPrefersPure() {
  const hand = [
    card('h3', '3', 'hearts', 3),
    card('h4', '4', 'hearts', 4),
    card('h5', '5', 'hearts', 5),
    card('s5', '5', 'spades', 5),
    card('d5', '5', 'diamonds', 5),
    card('c7', '7', 'clubs', 7),
    card('d8', '8', 'diamonds', 8),
    card('s9', '9', 'spades', 9),
  ];

  const bestGrouping = groupingService.buildBestGrouping(hand, null);
  assert(bestGrouping.groups[0]?.type === 'pure_sequence', 'Expected bestGrouping to prioritize pure sequence over set');
  assert(
    (bestGrouping.groups[0]?.cards || []).map((c) => c.card_uid).join(',') === 'h3,h4,h5',
    'Expected pure sequence cards to be sorted in sequence order for bestGrouping'
  );
}

function verifyBestGroupingOrderingOnly() {
  const manualWildJoker = card('pj', 'JOKER', null, 0, true);
  const hand = [
    card('s9', '9', 'spades', 9),
    card('s7', '7', 'spades', 7),
    manualWildJoker,
    card('h3', '3', 'hearts', 3),
    card('h4', '4', 'hearts', 4),
    card('h5', '5', 'hearts', 5),
    card('dK', 'K', 'diamonds', 10),
    card('cK', 'K', 'clubs', 10),
    card('sK', 'K', 'spades', 10),
  ];

  const bestGrouping = groupingService.buildBestGrouping(hand, manualWildJoker);
  const bestTypes = bestGrouping.groups.filter((g) => g.is_valid_meld).map((g) => g.type);
  assert(
    bestTypes.join(',') === 'pure_sequence,impure_sequence,set',
    `Expected bestGrouping valid group order pure->impure->set, got ${bestTypes.join(',')}`
  );
  assert(
    (bestGrouping.groups[1]?.cards || []).map((c) => c.card_uid).join(',') === 's7,pj,s9',
    'Expected impure sequence cards to be ordered for bestGrouping'
  );

  const manualGrouping = groupingService.evaluateSubmittedGrouping(hand, manualWildJoker, [
    { group_id: 1, cards: ['h5', 'h3', 'h4'] },
    { group_id: 2, cards: ['s9', 'pj', 's7'] },
    { group_id: 3, cards: ['dK', 'sK', 'cK'] },
  ]);
  assert(
    (manualGrouping.groups[0]?.cards || []).map((c) => c.card_uid).join(',') === 'h5,h3,h4',
    'Expected submitted grouping order to remain unchanged'
  );
}

function verifyTwoSequencesWithPureRequiredForDeclare() {
  const hand = [
    card('h3', '3', 'hearts', 3),
    card('h4', '4', 'hearts', 4),
    card('h5', '5', 'hearts', 5),
    card('s7', '7', 'spades', 7),
    card('s8', '8', 'spades', 8),
    card('s9', '9', 'spades', 9),
  ];

  const grouping = groupingService.buildBestGrouping(hand, null);
  assert(grouping.summary.all_cards_grouped === true, 'Expected all cards to be grouped');
  assert(grouping.summary.pure_sequence_count === 2, 'Expected two pure sequences');
  assert(grouping.summary.valid_for_declare === true, 'Expected declare to be valid with two sequences and at least one pure sequence');
  assert(grouping.summary.display_point === 0, 'Expected display_point=0 for a valid declaration');
}

function verifyLongSequenceSupportsFinishAndDeclare() {
  const printedJoker = card('pj', 'JOKER', null, 0, true);
  const hand = [
    card('hA', 'A', 'hearts', 10),
    card('h2', '2', 'hearts', 2),
    card('h3', '3', 'hearts', 3),
    card('h4', '4', 'hearts', 4),
    card('h5', '5', 'hearts', 5),
    card('h6', '6', 'hearts', 6),
    card('s7', '7', 'spades', 7),
    card('s9', '9', 'spades', 9),
    printedJoker,
  ];

  const bestGrouping = groupingService.buildBestGrouping(hand, null);
  assert(bestGrouping.summary.valid_for_declare === true, 'Expected long pure plus impure to be valid for declare');
  assert(bestGrouping.groups[0]?.type === 'pure_sequence', 'Expected first best group to be pure sequence');
  assert((bestGrouping.groups[0]?.cards || []).length === 6, 'Expected long pure sequence to remain in one group');

  const submittedGrouping = groupingService.evaluateSubmittedGrouping(hand, null, [
    { group_id: 1, cards: ['hA', 'h2', 'h3', 'h4', 'h5', 'h6'] },
    { group_id: 2, cards: ['s7', 'pj', 's9'] },
  ]);
  assert(submittedGrouping.summary.valid_for_declare === true, 'Expected submitted long pure plus impure to be valid');
}

function verifySingleLeftoverJokerAllowsDeclare() {
  const printedJoker = card('pj', 'JOKER', null, 0, true);
  const hand = [
    card('h2', '2', 'hearts', 2),
    card('h3', '3', 'hearts', 3),
    card('h4', '4', 'hearts', 4),
    card('s7', '7', 'spades', 7),
    card('s8', '8', 'spades', 8),
    card('s9', '9', 'spades', 9),
    card('d10', '10', 'diamonds', 10),
    card('dJ', 'J', 'diamonds', 10),
    card('dQ', 'Q', 'diamonds', 10),
    card('c4', '4', 'clubs', 4),
    card('c5', '5', 'clubs', 5),
    card('c6', '6', 'clubs', 6),
    printedJoker,
  ];

  const submittedGrouping = groupingService.evaluateSubmittedGrouping(hand, null, [
    { group_id: 1, cards: ['h2', 'h3', 'h4'] },
    { group_id: 2, cards: ['s7', 's8', 's9'] },
    { group_id: 3, cards: ['d10', 'dJ', 'dQ'] },
    { group_id: 4, cards: ['c4', 'c5', 'c6'] },
  ]);
  assert(submittedGrouping.summary.ungrouped_cards_count === 1, 'Expected exactly one ungrouped leftover card');
  assert(submittedGrouping.summary.valid_for_declare === true, 'Expected single leftover joker to be valid for declare');
}

function verifyWildJokerInvalidSingleSubmittedStillAllowsDeclare() {
  const wildJoker = { rank: '6', card_id: 'S6' };
  const hand = [
    card('D2_clubs_9_101', '9', 'clubs', 9),
    card('D1_clubs_10_49', '10', 'clubs', 10),
    card('D2_clubs_J_103', 'J', 'clubs', 10),
    card('D1_clubs_Q_51', 'Q', 'clubs', 10),
    card('D1_clubs_K_52', 'K', 'clubs', 10),
    card('D2_spades_7_60', '7', 'spades', 7),
    card('D1_spades_8_8', '8', 'spades', 8),
    card('D1_spades_6_6', '6', 'spades', 6),
    card('D1_hearts_4_17', '4', 'hearts', 4),
    card('D1_diamonds_4_30', '4', 'diamonds', 4),
    card('D1_clubs_4_43', '4', 'clubs', 4),
    card('D2_spades_4_57', '4', 'spades', 4),
    card('D1_hearts_6_19', '6', 'hearts', 6),
  ];

  const bestGrouping = groupingService.buildBestGrouping(hand, wildJoker);
  assert(bestGrouping.summary.valid_for_declare === true, 'Expected valid declare with one zero-point wild joker leftover');

  const validMeldsOnly = (bestGrouping.groups || [])
    .filter((group) => group.is_valid_meld === true)
    .map((group, idx) => ({
      group_id: idx + 1,
      cards: (group.cards || []).map((c) => c.card_uid),
    }));
  const submittedGrouping = groupingService.evaluateSubmittedGrouping(hand, wildJoker, validMeldsOnly);
  assert(submittedGrouping.summary.valid_for_declare === true, 'Expected valid declare when only melds are submitted');
  assert(
    submittedGrouping.summary.ungrouped_cards_count === 1,
    'Expected wild joker to remain ungrouped after meld-only submission'
  );
  assert(submittedGrouping.summary.ungrouped_points === 0, 'Expected zero ungrouped points for wild joker leftover');

  const withExplicitZeroPointSingle = groupingService.evaluateSubmittedGrouping(hand, wildJoker, [
    ...validMeldsOnly,
    { group_id: 99, cards: ['D1_hearts_6_19'] },
  ]);
  assert(
    withExplicitZeroPointSingle.summary.valid_for_declare === true,
    'Expected explicit zero-point single-card group to be ignored for declare validity'
  );
}

function verifySingleLeftoverNonJokerStaysInvalid() {
  const hand = [
    card('h2', '2', 'hearts', 2),
    card('h3', '3', 'hearts', 3),
    card('h4', '4', 'hearts', 4),
    card('s7', '7', 'spades', 7),
    card('s8', '8', 'spades', 8),
    card('s9', '9', 'spades', 9),
    card('d10', '10', 'diamonds', 10),
    card('dJ', 'J', 'diamonds', 10),
    card('dQ', 'Q', 'diamonds', 10),
    card('c4', '4', 'clubs', 4),
    card('c5', '5', 'clubs', 5),
    card('c6', '6', 'clubs', 6),
    card('x', 'K', 'spades', 10),
  ];

  const submittedGrouping = groupingService.evaluateSubmittedGrouping(hand, null, [
    { group_id: 1, cards: ['h2', 'h3', 'h4'] },
    { group_id: 2, cards: ['s7', 's8', 's9'] },
    { group_id: 3, cards: ['d10', 'dJ', 'dQ'] },
    { group_id: 4, cards: ['c4', 'c5', 'c6'] },
  ]);
  assert(submittedGrouping.summary.ungrouped_cards_count === 1, 'Expected exactly one ungrouped leftover card');
  assert(submittedGrouping.summary.valid_for_declare === false, 'Expected single non-joker leftover to remain invalid');
}

function verifyUngroupedAutoBucketsPreferRank() {
  const hand = [
    card('h3a', '3', 'hearts', 3),
    card('h3b', '3', 'hearts', 3),
    card('s3', '3', 'spades', 3),
    card('c7', '7', 'clubs', 7),
  ];
  const grouped = groupingService.buildBestGrouping(hand, null);
  const invalidGroups = (grouped.groups || []).filter((group) => group.is_valid_meld !== true);
  const rank3Bucket = invalidGroups.find((group) => (group.cards || []).length === 3);
  assert(rank3Bucket, 'Expected rank bucket of 3 cards for leftover rank=3 cards');
  const uniqueRanks = new Set((rank3Bucket.cards || []).map((c) => c.rank));
  assert(uniqueRanks.size === 1 && uniqueRanks.has('3'), 'Expected grouped invalid bucket cards to share same rank');
}

function verifyWildJokerSplitLowersPenalty() {
  const wildJoker = card('W9', '9', null, 0, true);
  const hand = [
    card('h4', '4', 'hearts', 4),
    card('h5', '5', 'hearts', 5),
    card('h6', '6', 'hearts', 6),
    card('h7', '7', 'hearts', 7),
    card('h8', '8', 'hearts', 8),
    card('h9', '9', 'hearts', 9), // wild-rank card used contextually
    card('c8', '8', 'clubs', 8),
    card('c10', '10', 'clubs', 10),
    card('d2', '2', 'diamonds', 2),
    card('d3', '3', 'diamonds', 3),
    card('d4', '4', 'diamonds', 4),
    card('sK', 'K', 'spades', 10),
    card('cK', 'K', 'clubs', 10),
  ];

  const grouping = groupingService.buildBestGrouping(hand, wildJoker);
  const pureGroups = (grouping.groups || []).filter((group) => group.type === 'pure_sequence');
  const hasLockedLongPure = pureGroups.some((group) => (group.cards || []).length >= 6);
  assert(hasLockedLongPure === false, 'Expected optimizer to avoid locking long pure when a lower-penalty split exists');
  assert(
    Number(grouping.summary.display_point) <= 20,
    `Expected reduced display points (<=20), got ${grouping.summary.display_point}`
  );
}

function verifyNoPureSequenceKeepsFullDisplayPoint() {
  const hand = [
    card('s2', '2', 'spades', 2),
    card('s5', '5', 'spades', 5),
    card('s8', '8', 'spades', 8),
    card('dK', 'K', 'diamonds', 10),
    card('hQ', 'Q', 'hearts', 10),
    card('cJ', 'J', 'clubs', 10),
  ];

  const submittedGroups = [
    { group_id: 1, cards: ['s2', 's5', 's8'] },
    { group_id: 2, cards: ['dK'] },
    { group_id: 3, cards: ['hQ'] },
    { group_id: 4, cards: ['cJ'] },
  ];

  const submittedGrouping = groupingService.evaluateSubmittedGrouping(hand, null, submittedGroups);
  assert(submittedGrouping.summary.pure_sequence_count === 0, 'Expected no pure sequence');
  assert(submittedGrouping.summary.hand_points === 45, 'Expected hand_points=45');
  assert(
    submittedGrouping.summary.display_point === submittedGrouping.summary.hand_points,
    'Expected full hand_points as display_point when no pure sequence exists'
  );
}

function verifySinglePureSequenceReducesDisplayPoint() {
  const hand = [
    card('h2', '2', 'hearts', 2),
    card('h3', '3', 'hearts', 3),
    card('h4', '4', 'hearts', 4),
    card('sK', 'K', 'spades', 10),
    card('dQ', 'Q', 'diamonds', 10),
    card('cJ', 'J', 'clubs', 10),
  ];

  const bestGrouping = groupingService.buildBestGrouping(hand, null);
  assert(bestGrouping.summary.pure_sequence_count === 1, 'Expected one pure sequence');
  assert(bestGrouping.summary.sequence_count === 1, 'Expected only one sequence');
  assert(bestGrouping.summary.valid_for_declare === false, 'Expected declare to remain invalid with one sequence');
  assert(bestGrouping.summary.hand_points === 39, 'Expected hand_points=39');
  assert(
    bestGrouping.summary.display_point === 30,
    `Expected display_point=30 (invalid cards only), got ${bestGrouping.summary.display_point}`
  );

  const submittedGrouping = groupingService.evaluateSubmittedGrouping(hand, null, [
    { group_id: 1, cards: ['h2', 'h3', 'h4'] },
    { group_id: 2, cards: ['sK', 'dQ', 'cJ'] },
  ]);
  assert(submittedGrouping.summary.pure_sequence_count === 1, 'Expected submitted pure sequence');
  assert(submittedGrouping.summary.valid_for_declare === false, 'Expected submitted declare to remain invalid');
  assert(
    submittedGrouping.summary.display_point === 30,
    `Expected submitted display_point=30, got ${submittedGrouping.summary.display_point}`
  );
}

function main() {
  const wildJoker = card('WJ', '5', null, 0, true);

  const submittedHand = [
    card('dA', 'A', 'diamonds', 10),
    card('d2', '2', 'diamonds', 2),
    card('d3', '3', 'diamonds', 3),
    card('d4', '4', 'diamonds', 4),
    card('c2', '2', 'clubs', 2),
    card('c4', '4', 'clubs', 4),
    card('c10', '10', 'clubs', 10),
    card('cK', 'K', 'clubs', 10),
    card('cA', 'A', 'clubs', 10),
    card('s7', '7', 'spades', 7),
    card('sJ', 'J', 'spades', 10),
    card('h9', '9', 'hearts', 9),
    card('hJ', 'J', 'hearts', 10),
  ];

  const submittedGroups = [
    { group_id: 1, cards: ['dA', 'd2', 'd3', 'd4'] },
    { group_id: 2, cards: ['c2', 'c4', 'c10', 'cK', 'cA'] },
    { group_id: 3, cards: ['s7', 'sJ'] },
    { group_id: 4, cards: ['h9', 'hJ'] },
  ];

  const submittedGrouping = groupingService.evaluateSubmittedGrouping(submittedHand, wildJoker, submittedGroups);
  assert(submittedGrouping.summary.hand_points === 91, 'Expected submitted hand_points=91');
  assert(submittedGrouping.summary.ungrouped_points === 0, 'Expected submitted ungrouped_points=0');
  assert(submittedGrouping.summary.pure_sequence_count === 1, 'Expected one pure sequence in submitted grouping');
  assert(
    submittedGrouping.summary.display_point === 72,
    `Expected submitted display_point=72 when one pure sequence reduces penalty, got ${submittedGrouping.summary.display_point}`
  );

  const bestGrouping = groupingService.buildBestGrouping(submittedHand, wildJoker);
  assert(
    bestGrouping.summary.display_point < bestGrouping.summary.hand_points,
    'Expected bestGrouping display_point to be reduced when a pure sequence exists'
  );
  assert(
    bestGrouping.summary.pure_sequence_count >= 1,
    'Expected bestGrouping to include at least one pure sequence for reduction case'
  );

  const suitGroups = groupingService.buildSuitGroups(submittedHand, wildJoker);
  assert(
    suitGroups.summary.display_point === suitGroups.summary.grouped_points,
    'Expected suitGroups display_point to match grouped_points when all cards are in invalid groups'
  );

  verifyBestGroupingPriorityPrefersPure();
  verifyBestGroupingOrderingOnly();
  verifyTwoSequencesWithPureRequiredForDeclare();
  verifyLongSequenceSupportsFinishAndDeclare();
  verifySingleLeftoverJokerAllowsDeclare();
  verifyWildJokerInvalidSingleSubmittedStillAllowsDeclare();
  verifySingleLeftoverNonJokerStaysInvalid();
  verifyUngroupedAutoBucketsPreferRank();
  verifyWildJokerSplitLowersPenalty();
  verifyNoPureSequenceKeepsFullDisplayPoint();
  verifySinglePureSequenceReducesDisplayPoint();

  console.log('verify_display_point: PASS');
}

main();
