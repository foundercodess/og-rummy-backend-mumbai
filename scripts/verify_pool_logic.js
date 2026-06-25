const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function loadSocketPoolHarness() {
  const filePath = path.join(__dirname, '..', 'realtime', 'socketServer.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const instrumented = `${source}\nmodule.exports.__test = { resolvePoolLimit, buildPoolRoundProgress, buildPoolFinalResults };`;
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

function loadGameplayPoolHarness() {
  const filePath = path.join(__dirname, '..', 'services', 'gameplay.service.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const instrumented = `${source}\nmodule.exports.__test = { shouldDebitJoinEntry, resolveSessionGameMode };`;
  const module = { exports: {} };

  const sandbox = {
    module,
    exports: module.exports,
    require(request) {
      switch (request) {
        case '../models/game.model':
        case '../models/gameSession.model':
        case '../models/wallet.model':
          return {};
        case '../db':
          return { pool: null, query: async () => ({ rows: [] }) };
        default:
          return require(request);
      }
    },
    __dirname: path.dirname(filePath),
    __filename: filePath,
    process,
    console,
    Buffer,
  };

  vm.runInNewContext(instrumented, sandbox, { filename: filePath });
  return module.exports.__test;
}

function testPoolRoundProgress() {
  const harness = loadSocketPoolHarness();
  const session = {
    game: { name: '201 Pool' },
    metadata: {
      pool_round_no: 2,
      pool_scores_by_user: {
        '11': 180,
        '12': 160,
        '13': 30,
      },
      pool_eliminated_user_ids: [],
    },
    players: [
      { user_id: 11, seat_no: 1 },
      { user_id: 12, seat_no: 2 },
      { user_id: 13, seat_no: 3 },
    ],
  };
  const roundResults = [
    { user_id: 11, points: 25 }, // 205 -> eliminated at 201
    { user_id: 12, points: 20 }, // 180
    { user_id: 13, points: 50 }, // 80
  ];

  const poolLimit = harness.resolvePoolLimit(session);
  assert(poolLimit === 201, `Expected pool limit 201, got ${poolLimit}`);

  const progress = harness.buildPoolRoundProgress(session, roundResults);
  assert(progress.poolLimit === 201, 'Expected progress pool limit=201');
  assert(progress.scoresByUser['11'] === 205, 'Expected uid=11 cumulative points to be 205');
  assert(progress.scoresByUser['12'] === 180, 'Expected uid=12 cumulative points to be 180');
  assert(progress.scoresByUser['13'] === 80, 'Expected uid=13 cumulative points to be 80');
  assert(progress.eliminatedUserIds.includes(11), 'Expected uid=11 to be eliminated');
  assert(progress.activeUserIds.includes(12) && progress.activeUserIds.includes(13), 'Expected uid=12 and uid=13 active');
  assert(!progress.activeUserIds.includes(11), 'Expected uid=11 inactive after elimination');
  assert(progress.currentRoundNo === 2 && progress.nextRoundNo === 3, 'Expected pool round progression 2 -> 3');

  const finalRows = harness.buildPoolFinalResults(
    session,
    progress.scoresByUser,
    12,
    progress.eliminatedUserIds
  );
  const winnerRow = finalRows.find((row) => row.user_id === 12);
  const eliminatedRow = finalRows.find((row) => row.user_id === 11);
  assert(winnerRow && winnerRow.is_winner === true, 'Expected uid=12 to be final winner');
  assert(eliminatedRow && eliminatedRow.player_status === 'eliminated', 'Expected uid=11 status eliminated in final rows');
}

function testPoolJoinDebitEligibility() {
  const harness = loadGameplayPoolHarness();

  const shouldDebitPool = harness.shouldDebitJoinEntry({
    session: { metadata: { game_mode: 'pool' } },
    contest: { entry: 50 },
    game: { name: '201 Pool' },
    skipBalanceCheck: false,
  });
  assert(shouldDebitPool === true, 'Expected pool join debit to be enabled');

  const shouldDebitDeals = harness.shouldDebitJoinEntry({
    session: { metadata: { game_mode: 'deals_2' } },
    contest: { entry: 50 },
    game: { name: 'Deals' },
    skipBalanceCheck: false,
  });
  assert(shouldDebitDeals === true, 'Expected deals join debit to remain enabled');

  const shouldDebitPoints = harness.shouldDebitJoinEntry({
    session: { metadata: { game_mode: 'points' } },
    contest: { entry: 50 },
    game: { name: 'Points' },
    skipBalanceCheck: false,
  });
  assert(shouldDebitPoints === false, 'Expected points mode join debit to remain disabled');
}

function main() {
  testPoolRoundProgress();
  testPoolJoinDebitEligibility();
  console.log('verify_pool_logic: PASS');
}

try {
  main();
} catch (err) {
  console.error('verify_pool_logic: FAIL');
  console.error(err.stack || err.message);
  process.exit(1);
}
