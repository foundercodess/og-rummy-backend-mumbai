const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function loadSocketHarness() {
  const filePath = path.join(__dirname, '..', 'realtime', 'socketServer.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const instrumented = `${source}\nmodule.exports.__test = { resolveSessionGameMode, resolveTotalDeals, buildDealContextFields, buildJoinAckSessionPayload };`;
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

function loadGameplayHarness() {
  const filePath = path.join(__dirname, '..', 'services', 'gameplay.service.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const instrumented = `${source}\nmodule.exports.__test = { resolveSessionGameMode, buildSessionModeMetadata, shouldDebitJoinEntry };`;
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

function main() {
  const socketHarness = loadSocketHarness();
  const gameplayHarness = loadGameplayHarness();

  const spinSession = {
    game: { name: 'Spin & Go' },
    metadata: { game_mode: 'spin_go', current_deal: 1, total_deals: 1, deal_scores: [] },
    contest: { entry: 50, win_upto: 250 },
    players: [
      { user_id: 1, status: 'joined' },
      { user_id: 2, status: 'joined' },
      { user_id: 3, status: 'joined' },
    ],
  };

  assert(socketHarness.resolveSessionGameMode(spinSession) === 'spin_go', 'Expected socket mode spin_go');
  assert(socketHarness.resolveTotalDeals(spinSession) === 1, 'Expected spin_go total_deals to be 1');

  const dealContext = socketHarness.buildDealContextFields(spinSession);
  assert(dealContext.deal_no === 1, 'Expected spin_go deal_no=1');
  assert(dealContext.total_deals === 1, 'Expected spin_go total_deals=1');
  assert(dealContext.deal_base_score === 80, 'Expected spin_go base score 80');

  const joinAck = socketHarness.buildJoinAckSessionPayload(spinSession);
  assert(joinAck?.prize_pool?.winning_balance === 250, 'Expected spin_go winning_balance from win_upto');
  assert(joinAck?.prize_pool?.admin_commission_percent === null, 'Expected no commission percent for spin_go join ack');

  const gameplayMode = gameplayHarness.resolveSessionGameMode({
    metadata: {},
    game: { name: 'Spin & Go' },
  });
  assert(gameplayMode === 'spin_go', 'Expected gameplay mode spin_go');

  const modeMetadata = gameplayHarness.buildSessionModeMetadata({
    metadata: { total_deals: 99 },
    game: { name: 'Spin & Go' },
  });
  assert(Number(modeMetadata.total_deals) === 1, 'Expected session mode metadata to force total_deals=1');

  const shouldDebitSpin = gameplayHarness.shouldDebitJoinEntry({
    session: { metadata: { game_mode: 'spin_go' } },
    contest: { entry: 50 },
    game: { name: 'Spin & Go' },
    skipBalanceCheck: false,
  });
  assert(shouldDebitSpin === true, 'Expected spin_go join entry debit enabled');

  console.log('verify_spin_go_integration: PASS');
}

try {
  main();
} catch (err) {
  console.error('verify_spin_go_integration: FAIL');
  console.error(err.stack || err.message);
  process.exit(1);
}
