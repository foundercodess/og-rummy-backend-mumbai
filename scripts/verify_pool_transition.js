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
    id: 7401,
    status: 'active',
    current_turn_user_id: 41,
    metadata: {
      phase: 'declare',
      game_mode: 'pool',
      pool_round_no: 1,
      pool_scores_by_user: {
        '41': 85,
        '42': 95,
        '43': 10,
      },
      declaration: { status: 'in_progress' },
      distribution: { players: [] },
      discard_history: [{ user_id: 41 }],
      game_state: { current_turn_user_id: 41 },
      turn: { turn_id: 999 },
      toss: { toss_winner_user_id: 43 },
      countdown: { ends_at: createIso(5000) },
      turn_eliminated_user_ids: [],
      turn_timeout_eliminated_user_ids: [],
    },
    players: [
      { user_id: 41, status: 'joined', metadata: { connection_status: 'connected', custom: 'x' } },
      { user_id: 42, status: 'joined', metadata: { connection_status: 'connected' } },
      { user_id: 43, status: 'disconnected', metadata: { connection_status: 'disconnected' } },
    ],
  };
}

function loadTransitionHarness(session, io) {
  const filePath = path.join(__dirname, '..', 'realtime', 'socketServer.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const instrumented = `${source}\nmodule.exports.__test = { transitionToNextPoolRound };`;

  const playerStateUpdates = [];
  const sessionStateUpdates = [];
  const insertedEvents = [];
  const startPregameCalls = [];
  const noop = () => {};
  const module = { exports: {} };

  const gameplayService = {
    async getSessionState(sessionId) {
      assert(Number(sessionId) === Number(session.id), 'Unexpected session id in getSessionState');
      return {
        ...session,
        players: session.players.map((player) => ({ ...player })),
      };
    },
  };

  const gameSessionModel = {
    async updatePlayerState(sessionId, userId, fields = {}) {
      assert(Number(sessionId) === Number(session.id), 'Unexpected session id in updatePlayerState');
      const player = session.players.find((row) => Number(row.user_id) === Number(userId));
      assert(Boolean(player), `Missing player for uid=${userId}`);
      if (Object.prototype.hasOwnProperty.call(fields, 'status')) {
        player.status = fields.status;
      }
      if (Object.prototype.hasOwnProperty.call(fields, 'metadata')) {
        player.metadata = fields.metadata;
      }
      if (Object.prototype.hasOwnProperty.call(fields, 'leftAt')) {
        player.left_at = fields.leftAt;
      }
      playerStateUpdates.push({ sessionId, userId, fields });
      return player;
    },
    async updateSessionStatus(sessionId, status, patch = {}) {
      assert(Number(sessionId) === Number(session.id), 'Unexpected session id in updateSessionStatus');
      session.status = status;
      if (Object.prototype.hasOwnProperty.call(patch, 'currentTurnUserId')) {
        session.current_turn_user_id = patch.currentTurnUserId;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'endedAt')) {
        session.ended_at = patch.endedAt;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'metadata')) {
        session.metadata = patch.metadata;
      }
      sessionStateUpdates.push({ sessionId, status, patch });
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
          return gameplayService;
        case '../models/gameSession.model':
          return gameSessionModel;
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
          return {
            startPregame: async (_io, sid) => {
              startPregameCalls.push(Number(sid));
            },
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

  return {
    transitionToNextPoolRound: module.exports.__test.transitionToNextPoolRound,
    playerStateUpdates,
    sessionStateUpdates,
    insertedEvents,
    startPregameCalls,
    io,
  };
}

async function main() {
  const session = createSessionFixture();
  const io = createIoCapture();
  const harness = loadTransitionHarness(session, io);

  const payload = {
    session_id: session.id,
    event: 'game:result',
    status: 'round_completed',
    is_final: false,
    winner_user_id: 41,
    pool_round_no: 1,
    pool_limit: 101,
    results: [
      { user_id: 41, points: 0 },
      { user_id: 42, points: 20 },
      { user_id: 43, points: 80 },
    ],
  };

  const roundProgress = {
    poolLimit: 101,
    currentRoundNo: 1,
    nextRoundNo: 2,
    scoresByUser: {
      '41': 85,
      '42': 115,
      '43': 90,
    },
    eliminatedUserIds: [42],
    activeUserIds: [41, 43],
  };

  const returned = await harness.transitionToNextPoolRound(io, session, payload, roundProgress);
  assert(returned === payload, 'Expected transitionToNextPoolRound to return payload');

  // Player status transitions: eliminated -> eliminated, disconnected remains disconnected, active stays joined.
  const p41 = session.players.find((row) => Number(row.user_id) === 41);
  const p42 = session.players.find((row) => Number(row.user_id) === 42);
  const p43 = session.players.find((row) => Number(row.user_id) === 43);
  assert(p41.status === 'joined', 'Expected active player uid=41 to stay joined');
  assert(p42.status === 'eliminated', 'Expected eliminated player uid=42 to become eliminated');
  assert(p42.metadata?.elimination_reason === 'pool_limit', 'Expected eliminated uid=42 reason=pool_limit');
  assert(p43.status === 'disconnected', 'Expected disconnected player uid=43 to remain disconnected');

  // Session transitions to inter-deal + ready and clears active-round payload fields.
  assert(session.status === 'ready', 'Expected session status to move to ready');
  assert(session.current_turn_user_id === null, 'Expected current_turn_user_id to reset');
  assert(session.metadata.phase === 'inter_deal', 'Expected metadata.phase=inter_deal');
  assert(session.metadata.pool_limit === 101, 'Expected pool_limit to be persisted');
  assert(session.metadata.pool_round_no === 2, 'Expected pool_round_no to advance to next round');
  assert(session.metadata.pool_scores_by_user['42'] === 115, 'Expected cumulative score persistence');
  assert(Array.isArray(session.metadata.pool_eliminated_user_ids), 'Expected pool_eliminated_user_ids array');
  assert(session.metadata.pool_eliminated_user_ids.includes(42), 'Expected eliminated user persisted in metadata');
  assert(!('declaration' in session.metadata), 'Expected declaration to be removed before next round');
  assert(!('distribution' in session.metadata), 'Expected distribution to be removed before next round');
  assert(!('turn' in session.metadata), 'Expected turn to be removed before next round');
  assert(!('countdown' in session.metadata), 'Expected countdown to be removed before next round');

  // Event and emissions.
  const insertedRoundEvent = harness.insertedEvents.find((event) => event.eventType === 'pool_round_completed');
  assert(insertedRoundEvent, 'Expected pool_round_completed event insertion');
  assert(insertedRoundEvent.payload === payload, 'Expected inserted payload reference to match intermediate payload');

  const gameResultEmission = io.emitted.find((entry) => entry.event === 'game:result');
  assert(gameResultEmission, 'Expected game:result emission for intermediate pool round');
  assert(gameResultEmission.payload.is_final === false, 'Expected intermediate game:result is_final=false');

  const sessionStateEmission = io.emitted.find((entry) => entry.event === 'session:state');
  assert(sessionStateEmission, 'Expected session:state emission after transition');

  assert(harness.startPregameCalls.length === 1, 'Expected one pregame call for next pool round');
  assert(harness.startPregameCalls[0] === session.id, 'Expected pregame to target current session id');
  assert(harness.playerStateUpdates.length === 3, 'Expected each player to be updated once');
  assert(harness.sessionStateUpdates.length === 1, 'Expected a single session status update');

  console.log('verify_pool_transition: PASS');
}

main().catch((err) => {
  console.error('verify_pool_transition: FAIL');
  console.error(err.stack || err.message);
  process.exit(1);
});
