const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createIoCapture() {
  const emitted = [];
  return {
    emitted,
    to(room) {
      return {
        emit(event, payload) {
          emitted.push({ room, event, payload });
        },
      };
    },
  };
}

function createSessionFixture() {
  return {
    id: 8701,
    status: 'active',
    current_turn_user_id: 101,
    game: {
      name: 'Spin & Go',
      point_value: null,
    },
    contest: {
      id: 7101,
      entry: 50,
      win_upto: 350,
      player_count: 3,
    },
    players: [
      { user_id: 101, seat_no: 1, status: 'joined', metadata: {} },
      { user_id: 102, seat_no: 2, status: 'joined', metadata: {} },
      { user_id: 103, seat_no: 3, status: 'joined', metadata: {} },
    ],
    metadata: {
      phase: 'active',
      game_mode: 'spin_go',
      total_deals: 1,
      current_deal: 1,
      distribution: {
        wild_joker: { card_uid: 'jk1', rank: '7', suit: 'spades', value: 7 },
        players: [
          { user_id: 101, cards: [{ card_uid: 'a1', value: 4 }] },
          { user_id: 102, cards: [{ card_uid: 'b1', value: 22 }] },
          { user_id: 103, cards: [{ card_uid: 'c1', value: 40 }] },
        ],
      },
      turn_eliminated_user_ids: [],
      turn_timeout_eliminated_user_ids: [],
    },
  };
}

function loadHarness(session, io) {
  const filePath = path.join(__dirname, '..', 'realtime', 'socketServer.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const instrumented = `${source}\nmodule.exports.__test = { finalizeGameByElimination };`;

  const sessionUpdates = [];
  const insertedEvents = [];
  const walletQueries = [];
  let released = false;
  const noop = () => {};
  const module = { exports: {} };

  const fakeClient = {
    async query(sql, params = []) {
      walletQueries.push({ sql, params });
      if (/SELECT id,\s*deposit FROM wallets WHERE user_id = \$1 FOR UPDATE/i.test(sql)) {
        return { rows: [{ id: 9907, deposit: 100 }] };
      }
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };

  const gameSessionModel = {
    async updateSessionStatus(sessionId, status, patch = {}) {
      assert(Number(sessionId) === Number(session.id), 'Unexpected session id in updateSessionStatus');
      session.status = status;
      if (Object.prototype.hasOwnProperty.call(patch, 'currentTurnUserId')) {
        session.current_turn_user_id = patch.currentTurnUserId;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'metadata')) {
        session.metadata = patch.metadata;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'endedAt')) {
        session.ended_at = patch.endedAt;
      }
      sessionUpdates.push({ sessionId, status, patch });
      return session;
    },
    async insertEvent(event) {
      insertedEvents.push(event);
      return event;
    },
  };

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
          return {};
        case '../models/gameSession.model':
          return gameSessionModel;
        case '../services/grouping.service':
          return {
            buildBestGrouping(cards = []) {
              return {
                groups: [],
                summary: {
                  grouped_points: 0,
                  ungrouped_points: cards.reduce((sum, card) => sum + (Number(card?.value) || 0), 0),
                  valid_for_declare: false,
                  invalid_group_count: 1,
                  all_cards_grouped: false,
                },
              };
            },
            evaluateSubmittedGrouping(cards = []) {
              return {
                groups: [],
                summary: {
                  grouped_points: cards.length,
                  ungrouped_points: 0,
                  valid_for_declare: true,
                  invalid_group_count: 0,
                  all_cards_grouped: true,
                },
              };
            },
          };
        case '../services/redisLock.service':
          return { claimEventIdempotency: async () => true };
        case '../db':
          return {
            pool: {
              async connect() {
                return fakeClient;
              },
            },
          };
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

  return {
    finalizeGameByElimination: module.exports.__test.finalizeGameByElimination,
    sessionUpdates,
    insertedEvents,
    walletQueries,
    wasReleased: () => released,
    io,
  };
}

async function main() {
  const session = createSessionFixture();
  const io = createIoCapture();
  const harness = loadHarness(session, io);

  const result = await harness.finalizeGameByElimination(
    io,
    session,
    101,
    [102, 103],
    'elimination_last_player',
    []
  );

  assert(result.event === 'game:result', 'Expected game:result payload');
  assert(result.is_final === true, 'Expected final result for spin_go');
  assert(result.settlement, 'Expected settlement object for spin_go');
  assert(result.settlement.settlement_type === 'spin_go_multiplier', 'Expected spin_go settlement type');
  assert(Number(result.settlement.winner_gain) === 350, 'Expected winner_gain to match contest.win_upto');
  assert(Number(result.players.find((p) => Number(p.user_id) === 101)?.won_amount) === 350, 'Expected winner won_amount to map from settlement');

  const hasInsertTxn = harness.walletQueries.some((q) => /INSERT INTO wallet_transactions/i.test(q.sql));
  const hasCommit = harness.walletQueries.some((q) => /COMMIT/i.test(q.sql));
  assert(hasInsertTxn, 'Expected wallet transaction insert');
  assert(hasCommit, 'Expected settlement commit');
  assert(harness.wasReleased(), 'Expected DB client release');

  const emittedResult = io.emitted.find((entry) => entry.event === 'game:result');
  assert(emittedResult, 'Expected game:result emission');
  assert(Number(emittedResult.payload?.settlement?.winner_gain) === 350, 'Expected emitted winner_gain == win_upto');

  const insertedCompletionEvent = harness.insertedEvents.find((event) => event.eventType === 'game_completed_by_elimination');
  assert(insertedCompletionEvent, 'Expected completion event insert');
  assert(Number(insertedCompletionEvent.payload?.settlement?.winner_gain) === 350, 'Expected completion payload winner_gain == win_upto');

  console.log('verify_spin_go_settlement_runtime: PASS');
}

main().catch((err) => {
  console.error('verify_spin_go_settlement_runtime: FAIL');
  console.error(err.stack || err.message);
  process.exit(1);
});
