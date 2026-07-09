const assert = require('assert');
const groupingService = require('../services/grouping.service');
const { __testHooks } = require('../realtime/socketServer');

function card(uid, rank, suit, value, is_joker = false) {
  return {
    card_uid: uid,
    rank,
    suit,
    value,
    is_joker,
  };
}

function makeSession({
  mode = 'pool',
  entry = 10,
  poolScores = {},
  poolLimit = 101,
  userId = 777,
  hasPicked = false,
} = {}) {
  return {
    contest: { entry },
    metadata: {
      game_mode: mode,
      pool_limit: poolLimit,
      pool_scores_by_user: poolScores,
      distribution: {
        players: [{ user_id: userId, has_picked: hasPicked, cards: [] }],
      },
    },
  };
}

function makeDistribution({ discardTop = null, closedDeck = [] } = {}) {
  return {
    discard_pile: discardTop ? [discardTop] : [],
    closed_deck: closedDeck,
  };
}

function runEarlyDropTests() {
  const userId = 777;
  const wildJoker = null;

  const structuredHand = [
    card('h4', '4', 'hearts', 4),
    card('h5', '5', 'hearts', 5),
    card('h6', '6', 'hearts', 6),
    card('cQ', 'Q', 'clubs', 10),
    card('dK', 'K', 'diamonds', 10),
    card('s2', '2', 'spades', 2),
    card('c8', '8', 'clubs', 8),
    card('d3', '3', 'diamonds', 3),
    card('s9', '9', 'spades', 9),
    card('hJ', 'J', 'hearts', 10),
    card('c4', '4', 'clubs', 4),
    card('d7', '7', 'diamonds', 7),
    card('sK', 'K', 'spades', 10),
  ];
  const structuredDist = makeDistribution({
    discardTop: card('x1', 'A', 'spades', 10),
    closedDeck: [
      card('x2', '10', 'hearts', 10),
      card('x3', '7', 'clubs', 7),
    ],
  });
  assert(
    __testHooks.hasAnyValidMeld(structuredHand, wildJoker) === true,
    'Expected structured hand to already have a valid meld'
  );
  assert.strictEqual(
    __testHooks.shouldBotTakeEarlyDrop(
      makeSession({ mode: 'pool', poolScores: { [String(userId)]: 0 } }),
      userId,
      structuredHand,
      structuredDist,
      wildJoker
    ),
    false,
    'Bot must not first-drop when a set/sequence/pure already exists'
  );

  const noMeldButOpenPotential = [
    card('h3', '3', 'hearts', 3),
    card('h4', '4', 'hearts', 4),
    card('cQ2', 'Q', 'clubs', 10),
    card('dK2', 'K', 'diamonds', 10),
    card('s2b', '2', 'spades', 2),
    card('c8b', '8', 'clubs', 8),
    card('d3b', '3', 'diamonds', 3),
    card('s9b', '9', 'spades', 9),
    card('hJb', 'J', 'hearts', 10),
    card('c4b', '4', 'clubs', 4),
    card('d7b', '7', 'diamonds', 7),
    card('sKb', 'K', 'spades', 10),
    card('c2b', '2', 'clubs', 2),
  ];
  const openPotentialDist = makeDistribution({
    discardTop: card('open-h5', '5', 'hearts', 5),
    closedDeck: [
      card('x22', '10', 'hearts', 10),
      card('x23', '7', 'clubs', 7),
    ],
  });
  assert(
    __testHooks.hasAnyValidMeld(noMeldButOpenPotential, wildJoker) === false,
    'Expected hand to start without valid meld'
  );
  assert.strictEqual(
    __testHooks.shouldBotTakeEarlyDrop(
      makeSession({ mode: 'pool', poolScores: { [String(userId)]: 0 } }),
      userId,
      noMeldButOpenPotential,
      openPotentialDist,
      wildJoker
    ),
    false,
    'Bot must not first-drop when open pile can meaningfully improve the hand'
  );

  const deadHand = [
    card('a1', '2', 'hearts', 2),
    card('a2', '4', 'clubs', 4),
    card('a3', '6', 'spades', 6),
    card('a4', '8', 'diamonds', 8),
    card('a5', '10', 'clubs', 10),
    card('a6', 'Q', 'hearts', 10),
    card('a7', 'A', 'spades', 10),
    card('a8', '3', 'diamonds', 3),
    card('a9', '5', 'hearts', 5),
    card('a10', '7', 'clubs', 7),
    card('a11', '9', 'spades', 9),
    card('a12', 'J', 'diamonds', 10),
    card('a13', 'K', 'clubs', 10),
  ];
  const deadDist = makeDistribution({
    discardTop: card('dtop', 'A', 'spades', 10),
    closedDeck: [],
  });
  assert(
    __testHooks.hasAnyValidMeld(deadHand, wildJoker) === false,
    'Expected dead hand to have no valid meld'
  );
  assert.strictEqual(
    __testHooks.shouldBotTakeEarlyDrop(
      makeSession({ mode: 'pool', poolScores: { [String(userId)]: 78 }, poolLimit: 101 }),
      userId,
      deadHand,
      deadDist,
      wildJoker
    ),
    true,
    'Bot should first-drop for dead hand near elimination with no meaningful pick potential'
  );

  assert.strictEqual(
    __testHooks.shouldBotTakeEarlyDrop(
      makeSession({ mode: 'pool', poolScores: { [String(userId)]: 0 }, poolLimit: 101 }),
      userId,
      deadHand,
      deadDist,
      wildJoker
    ),
    false,
    'Bot should keep playing on comfortable pool score even with a dead hand'
  );

  assert.strictEqual(
    __testHooks.shouldBotTakeEarlyDrop(
      makeSession({ mode: 'pool', poolScores: { [String(userId)]: 85 }, poolLimit: 101 }),
      userId,
      deadHand,
      deadDist,
      wildJoker
    ),
    false,
    'Bot must not drop in pool 101 when cumulative score is above 80'
  );

  assert.strictEqual(
    __testHooks.shouldBotTakeEarlyDrop(
      makeSession({ mode: 'pool', poolScores: { [String(userId)]: 170 }, poolLimit: 201 }),
      userId,
      deadHand,
      deadDist,
      wildJoker
    ),
    false,
    'Bot must not drop in pool 201 when cumulative score is above 160'
  );
}

function runStrategicDropTests() {
  const userId = 888;
  const session = makeSession({
    mode: 'pool',
    poolScores: { [String(userId)]: 78 },
    poolLimit: 101,
    userId,
    hasPicked: true,
  });
  const wildJoker = { rank: '5', card_id: 'H5' };

  const hopelessHand = [
    card('h2', '2', 'hearts', 2),
    card('h4', '4', 'hearts', 4),
    card('h7', '7', 'hearts', 7),
    card('h9', '9', 'hearts', 9),
    card('hJ', 'J', 'hearts', 10),
    card('cA', 'A', 'clubs', 10),
    card('c3', '3', 'clubs', 3),
    card('c8', '8', 'clubs', 8),
    card('cQ', 'Q', 'clubs', 10),
    card('d2', '2', 'diamonds', 2),
    card('d6', '6', 'diamonds', 6),
    card('dK', 'K', 'diamonds', 10),
    card('s9', '9', 'spades', 9),
    card('sK', 'K', 'spades', 10),
  ];

  const hopelessSummary = groupingService.buildBestGrouping(hopelessHand, wildJoker).summary;
  assert.strictEqual(hopelessSummary.pure_sequence_count, 0, 'hopeless hand should have no pure sequence');
  assert(
    hopelessSummary.display_point >= 58,
    `hopeless hand display_point should be high, got ${hopelessSummary.display_point}`
  );
  assert(
    __testHooks.isHopelessHandForDrop(hopelessSummary, 6) === true,
    'expected hopeless classification after turn gate'
  );

  const weakStructureOnly = [
    card('b1', '4', 'hearts', 4),
    card('b2', '5', 'hearts', 5),
    card('b3', '6', 'hearts', 6),
    card('b4', 'A', 'clubs', 10),
    card('b5', 'K', 'clubs', 10),
    card('b6', 'Q', 'diamonds', 10),
    card('b7', '2', 'spades', 2),
    card('b8', '7', 'diamonds', 7),
    card('b9', '8', 'clubs', 8),
    card('b10', '9', 'spades', 9),
    card('b11', 'J', 'hearts', 10),
    card('b12', '3', 'diamonds', 3),
    card('b13', '10', 'clubs', 10),
    card('b14', '5', 'spades', 5),
  ];
  const weakSummary = groupingService.buildBestGrouping(weakStructureOnly, wildJoker).summary;
  assert(
    __testHooks.doesStructureBlockStrategicDrop(weakSummary) === false,
    'single weak sequence with high deadwood should not block strategic drop'
  );

  assert.strictEqual(
    __testHooks.shouldBotStrategicallyDrop(
      session,
      userId,
      hopelessHand,
      wildJoker,
      {
        turn: { turn_id: 6 },
        playerDistribution: { has_picked: true },
        decisionSeed: 'verify:hopeless-drop',
        seededRoll: 0.2,
      }
    ),
    true,
    'Bot should strategically drop hopeless no-pure hand after turn 4'
  );

  const blockedScoreSession = makeSession({
    mode: 'pool',
    poolScores: { [String(userId)]: 85 },
    poolLimit: 101,
    userId,
    hasPicked: true,
  });
  assert.strictEqual(
    __testHooks.shouldBotStrategicallyDrop(
      blockedScoreSession,
      userId,
      hopelessHand,
      wildJoker,
      {
        turn: { turn_id: 8 },
        playerDistribution: { has_picked: true },
        seededRoll: 0.01,
      }
    ),
    false,
    'Bot must not strategically drop in pool 101 when cumulative score is above 80'
  );

  const blockedScore201Session = makeSession({
    mode: 'pool',
    poolScores: { [String(userId)]: 165 },
    poolLimit: 201,
    userId,
    hasPicked: true,
  });
  assert.strictEqual(
    __testHooks.shouldBotStrategicallyDrop(
      blockedScore201Session,
      userId,
      hopelessHand,
      wildJoker,
      {
        turn: { turn_id: 8 },
        playerDistribution: { has_picked: true },
        seededRoll: 0.01,
      }
    ),
    false,
    'Bot must not strategically drop in pool 201 when cumulative score is above 160'
  );

  const firstDealSession = makeSession({
    mode: 'pool',
    poolScores: { [String(userId)]: 78 },
    poolLimit: 101,
    userId,
    hasPicked: false,
  });
  const prePickHopelessHand = hopelessHand.slice(0, 13);
  assert.strictEqual(
    __testHooks.shouldBotStrategicallyDrop(
      firstDealSession,
      userId,
      prePickHopelessHand,
      wildJoker,
      {
        turn: { turn_id: 6 },
        playerDistribution: { has_picked: false },
        decisionSeed: 'verify:hopeless-first-pick',
        seededRoll: 0.2,
      }
    ),
    true,
    'Bot should evaluate strategic drop before first pick in deal (first-drop penalty)'
  );

  assert.strictEqual(
    __testHooks.shouldBotStrategicallyDrop(
      session,
      userId,
      weakStructureOnly,
      wildJoker,
      {
        turn: { turn_id: 3 },
        playerDistribution: { has_picked: true },
        decisionSeed: 'verify:early-turn',
        seededRoll: 0.1,
      }
    ),
    false,
    'Bot should not strategically drop structured hand before turn gate'
  );

  const comfortablePool = makeSession({
    mode: 'pool',
    poolScores: { [String(userId)]: 5 },
    poolLimit: 101,
    userId,
    hasPicked: true,
  });
  assert.strictEqual(
    __testHooks.shouldBotStrategicallyDrop(
      comfortablePool,
      userId,
      hopelessHand,
      wildJoker,
      {
        turn: { turn_id: 8 },
        playerDistribution: { has_picked: true },
        seededRoll: 0.01,
      }
    ),
    false,
    'Comfortable pool score should discourage hopeless strategic drop unless loss is extreme'
  );

  const dealsSession = makeSession({ mode: 'deals_2', userId: 999 });
  const deadDist = makeDistribution({ closedDeck: [] });
  assert.strictEqual(
    __testHooks.shouldBotStrategicallyDrop(
      dealsSession,
      999,
      hopelessHand,
      wildJoker,
      { turn: { turn_id: 8 }, playerDistribution: { has_picked: true }, seededRoll: 0.01 }
    ),
    false,
    'Deals bots should never strategically drop'
  );
}

function run() {
  assert(__testHooks, 'Expected socketServer __testHooks to be exported');
  assert(typeof __testHooks.hasAnyValidMeld === 'function', 'Expected hasAnyValidMeld test hook');
  assert(typeof __testHooks.shouldBotTakeEarlyDrop === 'function', 'Expected shouldBotTakeEarlyDrop test hook');
  assert(typeof __testHooks.shouldBotStrategicallyDrop === 'function', 'Expected shouldBotStrategicallyDrop test hook');

  runEarlyDropTests();
  runStrategicDropTests();
  console.log('verify_bot_drop_policy: PASS');
}

run();
