const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function loadHarness() {
  const filePath = path.join(__dirname, '..', 'realtime', 'socketServer.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const instrumented = `${source}\nmodule.exports.__test = { computeDealScoreboardTimeline, buildAggregateResultsFromDealScores, buildPoolFinalResults };`;
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

function testDealsScoreboardModel(harness) {
  const session = {
    game: { name: '2 Deal Rummy' },
    metadata: { game_mode: 'deals_2', total_deals: 2 },
    players: [
      { user_id: 1, seat_no: 1 },
      { user_id: 2, seat_no: 2 },
    ],
  };

  const dealScores = [
    {
      deal_no: 1,
      winner_user_id: 2,
      results: [
        { user_id: 1, seat_no: 1, points: 20, is_winner: false },
        { user_id: 2, seat_no: 2, points: 0, is_winner: true },
      ],
    },
    {
      deal_no: 2,
      winner_user_id: 1,
      results: [
        { user_id: 1, seat_no: 1, points: 0, is_winner: true },
        { user_id: 2, seat_no: 2, points: 30, is_winner: false },
      ],
    },
  ];

  const timeline = harness.computeDealScoreboardTimeline(session, dealScores);
  assert(timeline.dealBaseScore === 160, 'Expected deal base score 160');
  assert(Number(timeline.scoreTotalsByUser['1']) === 170, 'Expected uid=1 total_score 170');
  assert(Number(timeline.scoreTotalsByUser['2']) === 150, 'Expected uid=2 total_score 150');

  const dealOneUserOne = timeline.enrichedDealScores[0].results.find((row) => Number(row.user_id) === 1);
  const dealOneUserTwo = timeline.enrichedDealScores[0].results.find((row) => Number(row.user_id) === 2);
  assert(dealOneUserOne.round_points === 20, 'Expected deal1 uid=1 round_points 20');
  assert(dealOneUserOne.total_score === 140, 'Expected deal1 uid=1 total_score 140');
  assert(dealOneUserTwo.total_score === 180, 'Expected deal1 uid=2 total_score 180');

  const aggregate = harness.buildAggregateResultsFromDealScores(session, dealScores);
  const aggregateOne = aggregate.finalizedResults.find((row) => Number(row.user_id) === 1);
  const aggregateTwo = aggregate.finalizedResults.find((row) => Number(row.user_id) === 2);
  assert(aggregate.winnerUserId === 1, 'Expected aggregate winner uid=1 by highest total_score');
  assert(aggregateOne.points === 20, 'Expected aggregate uid=1 points (cumulative loss) = 20');
  assert(aggregateOne.total_score === 170, 'Expected aggregate uid=1 total_score = 170');
  assert(aggregateTwo.points === 30, 'Expected aggregate uid=2 points (cumulative loss) = 30');
  assert(aggregateTwo.total_score === 150, 'Expected aggregate uid=2 total_score = 150');
}

function testPoolScoreboardModel(harness) {
  const session = {
    players: [
      { user_id: 7, seat_no: 1 },
      { user_id: 8, seat_no: 2 },
    ],
  };

  const rows = harness.buildPoolFinalResults(
    session,
    { '7': 45, '8': 130 },
    7,
    [8]
  );

  const p7 = rows.find((row) => Number(row.user_id) === 7);
  const p8 = rows.find((row) => Number(row.user_id) === 8);
  assert(p7.total_score === 45 && p7.score_model === 'pool_loss_cumulative', 'Expected pool winner score model fields');
  assert(p8.total_score === 130 && p8.player_status === 'eliminated', 'Expected pool loser cumulative and eliminated');
}

function main() {
  const harness = loadHarness();
  testDealsScoreboardModel(harness);
  testPoolScoreboardModel(harness);
  console.log('verify_scoreboard_models: PASS');
}

try {
  main();
} catch (err) {
  console.error('verify_scoreboard_models: FAIL');
  console.error(err.stack || err.message);
  process.exit(1);
}
