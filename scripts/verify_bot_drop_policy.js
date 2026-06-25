const assert = require('assert');
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

function makeSession({ mode = 'pool', entry = 10, poolScores = {}, poolLimit = 101 } = {}) {
  return {
    contest: { entry },
    metadata: {
      game_mode: mode,
      pool_limit: poolLimit,
      pool_scores_by_user: poolScores,
    },
  };
}

function makeDistribution({ discardTop = null, closedDeck = [] } = {}) {
  return {
    discard_pile: discardTop ? [discardTop] : [],
    closed_deck: closedDeck,
  };
}

function run() {
  assert(__testHooks, 'Expected socketServer __testHooks to be exported');
  assert(typeof __testHooks.hasAnyValidMeld === 'function', 'Expected hasAnyValidMeld test hook');
  assert(typeof __testHooks.shouldBotTakeEarlyDrop === 'function', 'Expected shouldBotTakeEarlyDrop test hook');

  const userId = 777;
  const wildJoker = null;

  // Case 1: Has an existing pure sequence -> first drop must be blocked.
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

  // Case 2: No current meld, but open pile can create one -> first drop must be blocked.
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
    'Bot must not first-drop when open pile can form a meld'
  );

  // Case 3: No current meld, no open/closed potential, and projected loss >> first drop -> allow first drop.
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
      makeSession({ mode: 'pool', poolScores: { [String(userId)]: 0 }, poolLimit: 101 }),
      userId,
      deadHand,
      deadDist,
      wildJoker
    ),
    true,
    'Bot should first-drop only for dead hand with no one-pick meld potential and clear loss advantage'
  );

  console.log('verify_bot_drop_policy: PASS');
}

run();
