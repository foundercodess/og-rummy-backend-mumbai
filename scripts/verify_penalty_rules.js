const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createIso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function loadPenaltyHarness() {
  const filePath = path.join(__dirname, '..', 'realtime', 'socketServer.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const instrumented = `${source}\nmodule.exports.__test = { resolveDropLossPoints, buildPlayerStatusPayload, isFirstDropEligible, buildSessionPrizePoolFields };`;
  const noop = () => {};
  const module = { exports: {} };

  const sandbox = {
    module,
    exports: module.exports,
    require(request) {
      switch (request) {
        case 'socket.io':
          return { Server: function Server() {} };
        case '@socket.io/redis-adapter':
          return { createAdapter: noop };
        case '../services/gameplay.service':
        case '../models/gameSession.model':
        case '../services/grouping.service':
          return {};
        case '../services/redisLock.service':
          return { claimEventIdempotency: async () => true };
        case '../db':
          return { pool: null };
        case '../services/redis.service':
          return { getSocketAdapterRedisClients: async () => null };
        case './socketRegistry':
          return { getSocketIds: () => [], addSocket: noop, removeSocket: noop };
        case './socketAuth':
          return { socketAuth: noop };
        case './socketBus':
          return { emitActiveNotices: async () => {}, setSocketIO: noop };
        case './pregameOrchestrator':
          return { startPregame: async () => {} };
        case './socketTelemetry':
          return {
            traceSessionBroadcast: ({ payload }) => payload,
            traceAckResponse: (_traceId, ack) => ack,
          };
        case './turnSchedulerBridge':
          return { setTurnTimerStarter: noop };
        case '../services/botEngine/rummyBotStrategy':
          return {
            chooseBotPickSource: () => 'closed',
            chooseBotDiscardCard: () => null,
            getCardValue: () => 0,
            isCardIsolated: () => false,
          };
        default:
          return require(request);
      }
    },
    __dirname: path.dirname(filePath),
    __filename: filePath,
    process,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Buffer,
  };

  vm.runInNewContext(instrumented, sandbox, { filename: filePath });
  return module.exports.__test;
}

function createSession({
  mode = 'pool',
  gameName = '101 Pool',
  hasPicked = false,
  firstTurnCycleComplete = false,
  leftUserIds = [],
}) {
  return {
    id: 7710,
    game: { name: gameName },
    metadata: {
      game_mode: mode,
      distribution: {
        players: [
          {
            user_id: 11,
            has_picked: hasPicked,
            first_turn_cycle_complete: firstTurnCycleComplete,
          },
        ],
      },
      post_result_left_user_ids: leftUserIds,
      turn_timeout_eliminated_user_ids: [],
      turn_eliminated_user_ids: [],
      pool_eliminated_user_ids: [],
    },
    players: [
      {
        user_id: 11,
        seat_no: 1,
        status: 'joined',
        player_status: null,
        connection_status: 'connected',
        left_at: null,
        metadata: { connection_status: 'connected' },
      },
    ],
  };
}

function testPoolDropPenalties(harness) {
  const pool101First = createSession({ mode: 'pool', gameName: '101 Pool', hasPicked: false });
  const pool101Middle = createSession({ mode: 'pool', gameName: '101 Pool', hasPicked: true });
  const pool201First = createSession({ mode: 'pool', gameName: '201 Pool', hasPicked: false });
  const pool201Middle = createSession({ mode: 'pool', gameName: '201 Pool', hasPicked: true });

  assert(harness.resolveDropLossPoints(pool101First, 11) === 20, 'Expected 101 first drop = 20');
  assert(harness.resolveDropLossPoints(pool101Middle, 11) === 40, 'Expected 101 middle drop = 40');
  assert(harness.resolveDropLossPoints(pool201First, 11) === 25, 'Expected 201 first drop = 25');
  assert(harness.resolveDropLossPoints(pool201Middle, 11) === 50, 'Expected 201 middle drop = 50');
  assert(
    harness.resolveDropLossPoints(pool201First, 11, { forceMiddleDrop: true }) === 50,
    'Expected 201 forced middle drop = 50'
  );
}

function testPointsModeBackCompat(harness) {
  const pointsFirst = createSession({ mode: 'points', gameName: 'Points Rummy', hasPicked: false });
  const pointsMiddle = createSession({ mode: 'points', gameName: 'Points Rummy', hasPicked: true });
  const pointsAfterFirstTurn = createSession({
    mode: 'points',
    gameName: 'Points Rummy',
    hasPicked: false,
    firstTurnCycleComplete: true,
  });
  assert(harness.resolveDropLossPoints(pointsFirst, 11) === 20, 'Expected points first drop = 20');
  assert(harness.resolveDropLossPoints(pointsMiddle, 11) === 40, 'Expected points middle drop = 40');
  assert(
    harness.resolveDropLossPoints(pointsAfterFirstTurn, 11) === 40,
    'Expected middle drop after first turn cycle without pick = 40'
  );
  assert(
    harness.isFirstDropEligible(pointsAfterFirstTurn.metadata.distribution.players[0]) === false,
    'Expected first-turn cycle completion to block first drop'
  );
}

function testStatusPayloadPenaltyExposure(harness) {
  const pool201Session = createSession({ mode: 'pool', gameName: '201 Pool', hasPicked: false });
  const basePlayer = {
    user_id: 11,
    seat_no: 1,
    status: 'joined',
    player_status: null,
    connection_status: 'connected',
    left_at: null,
    metadata: { connection_status: 'connected', dropped_at: createIso(-1000), is_dropped: true },
  };

  const timeoutPayload = harness.buildPlayerStatusPayload(pool201Session, basePlayer, 'timeout_eliminated');
  assert(timeoutPayload.points_to_lose === 50, 'Expected timeout_eliminated to expose 201 middle drop = 50');

  const disconnectedPayload = harness.buildPlayerStatusPayload(pool201Session, {
    ...basePlayer,
    status: 'disconnected',
    metadata: { connection_status: 'disconnected' },
  }, 'player_disconnected');
  assert(disconnectedPayload.points_to_lose === 50, 'Expected player_disconnected to expose 201 middle drop = 50');
}

function testDealsDropPenalty(harness) {
  const dealsFirst = createSession({ mode: 'deals_2', gameName: 'Deals', hasPicked: false });
  const dealsMiddle = createSession({ mode: 'deals_2', gameName: 'Deals', hasPicked: true });
  assert(harness.resolveDropLossPoints(dealsFirst, 11) === 80, 'Expected deals first drop = 80');
  assert(harness.resolveDropLossPoints(dealsMiddle, 11) === 80, 'Expected deals middle drop = 80');
  assert(
    harness.resolveDropLossPoints(dealsFirst, 11, { forceMiddleDrop: true }) === 80,
    'Expected deals forced drop = 80'
  );
}

function testLeavePenalty(harness) {
  const leftPool = createSession({
    mode: 'pool',
    gameName: '201 Pool',
    hasPicked: false,
    leftUserIds: [11],
  });
  assert(harness.resolveDropLossPoints(leftPool, 11) === 80, 'Expected leave penalty = 80');
}

function testDealsPrizePoolUsesTableSeats(harness) {
  const session = {
    max_players: 2,
    contest: { entry: 5 },
    game: { name: 'Deals' },
    metadata: { game_mode: 'deals_2' },
    players: [
      { user_id: 11, status: 'joined' },
      { user_id: 12, status: 'eliminated' },
    ],
  };
  const fields = harness.buildSessionPrizePoolFields(session);
  assert(fields.winning_balance === 8.8, 'Expected deals prize pool to use table seats, not active joined count');
  assert(fields.prize_pool.player_count === 2, 'Expected deals prize pool player_count to match max_players');
}

function main() {
  const harness = loadPenaltyHarness();
  testPoolDropPenalties(harness);
  testDealsDropPenalty(harness);
  testDealsPrizePoolUsesTableSeats(harness);
  testLeavePenalty(harness);
  testPointsModeBackCompat(harness);
  testStatusPayloadPenaltyExposure(harness);
  console.log('verify_penalty_rules: PASS');
}

try {
  main();
} catch (err) {
  console.error('verify_penalty_rules: FAIL');
  console.error(err.stack || err.message);
  process.exit(1);
}
