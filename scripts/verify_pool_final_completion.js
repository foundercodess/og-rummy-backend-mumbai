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
    id: 7501,
    status: 'active',
    current_turn_user_id: 52,
    game: {
      name: 'Pool 101',
      point_value: 1,
    },
    contest: {
      id: 3101,
      entry: 100,
      player_count: 4,
    },
    players: [
      { user_id: 51, seat_no: 1, status: 'joined', metadata: {} },
      { user_id: 52, seat_no: 2, status: 'joined', metadata: {} },
      { user_id: 53, seat_no: 3, status: 'joined', metadata: {} },
      { user_id: 54, seat_no: 4, status: 'joined', metadata: {} },
    ],
    metadata: {
      phase: 'active',
      game_mode: 'pool',
      pool_scores_by_user: {
        '51': 20,
        '52': 110,
        '53': 70,
        '54': 130,
      },
      pool_eliminated_user_ids: [54],
      distribution: {
        wild_joker: { card_uid: 'jk1', rank: '7', suit: 'hearts', value: 7 },
        players: [
          { user_id: 51, cards: [{ card_uid: 'a1', value: 4 }] },
          { user_id: 52, cards: [{ card_uid: 'b1', value: 30 }] },
          { user_id: 53, cards: [{ card_uid: 'c1', value: 12 }] },
          { user_id: 54, cards: [{ card_uid: 'd1', value: 22 }] },
        ],
      },
      turn_eliminated_user_ids: [54],
      turn_timeout_eliminated_user_ids: [],
    },
  };
}

function loadFinalizeHarness(session, io) {
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
        return {
          rows: [{ id: 9901, deposit: 500 }],
        };
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
  const harness = loadFinalizeHarness(session, io);

  const result = await harness.finalizeGameByElimination(
    io,
    session,
    51,
    [52],
    'elimination_last_player',
    [53]
  );

  // Result payload shape.
  assert(result.event === 'game:result', 'Expected event=game:result');
  assert(result.status === 'completed', 'Expected status=completed');
  assert(result.is_final === true, 'Expected final pool result');
  assert(result.winner_user_id === 51, 'Expected winner uid=51');
  assert(result.tie_break_policy === 'pool_limit_then_last_player_standing', 'Expected pool tie break policy');
  assert(result.deal_no === null && result.total_deals === null, 'Expected deal context to stay null for pool');
  assert(Array.isArray(result.results), 'Expected results array');
  assert(Array.isArray(result.pool_eliminated_user_ids), 'Expected pool_eliminated_user_ids array');
  assert(result.pool_eliminated_user_ids.includes(52), 'Expected function arg eliminated user to be included');
  assert(result.pool_eliminated_user_ids.includes(53), 'Expected timeout eliminated user to be included');
  assert(result.pool_eliminated_user_ids.includes(54), 'Expected pre-existing eliminated user to be included');

  // Settlement hook behavior.
  assert(result.settlement, 'Expected non-null pool settlement');
  assert(result.settlement.settlement_type === 'pool_pot', 'Expected pool_pot settlement');
  assert(result.settlement.winner_user_id === 51, 'Expected settlement winner uid=51');
  assert(result.settlement.total_entry === 400, 'Expected total_entry from entry*players');
  assert(result.settlement.winner_gain === 352, 'Expected winner_gain after 12% commission');

  const hasCommit = harness.walletQueries.some((q) => /COMMIT/i.test(q.sql));
  const hasInsertTxn = harness.walletQueries.some((q) => /INSERT INTO wallet_transactions/i.test(q.sql));
  assert(hasCommit, 'Expected settlement transaction COMMIT');
  assert(hasInsertTxn, 'Expected settlement wallet transaction insert');
  assert(harness.wasReleased(), 'Expected DB client release to be called');

  // Session mutation + event emission.
  assert(session.status === 'completed', 'Expected session to be completed');
  assert(session.current_turn_user_id === 51, 'Expected current_turn_user_id set to winner');
  assert(session.metadata.phase === 'finished', 'Expected metadata phase=finished');
  assert(session.metadata.result?.is_final === true, 'Expected metadata.result is_final=true');
  assert(session.metadata.result?.winner_user_id === 51, 'Expected metadata.result winner uid=51');

  const completionEvent = harness.insertedEvents.find((event) => event.eventType === 'pool_game_completed_by_elimination');
  assert(completionEvent, 'Expected pool_game_completed_by_elimination event insertion');

  const emittedResult = io.emitted.find((entry) => entry.event === 'game:result');
  assert(emittedResult, 'Expected game:result emission');
  assert(emittedResult.payload.is_final === true, 'Expected emitted payload is_final=true');

  assert(harness.sessionUpdates.length === 1, 'Expected one session update call');

  console.log('verify_pool_final_completion: PASS');
}

main().catch((err) => {
  console.error('verify_pool_final_completion: FAIL');
  console.error(err.stack || err.message);
  process.exit(1);
});
