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

function createGameplayState() {
  const users = {
    1: { id: 1, name: 'Alpha', phone: '1111', avatar: 'a.png', view_id: 'A1' },
    2: { id: 2, name: 'Beta', phone: '2222', avatar: 'b.png', view_id: 'B2' },
    3: { id: 3, name: 'Gamma', phone: '3333', avatar: 'c.png', view_id: 'C3' },
  };

  const sessions = new Map([
    [
      5001,
      {
        id: 5001,
        session_code: 'SRC5001',
        game_id: 101,
        contest_id: 201,
        host_user_id: 1,
        status: 'completed',
        max_players: 3,
        current_turn_user_id: 2,
        metadata: {
          phase: 'finished',
        },
        started_at: createIso(-60000),
        ended_at: createIso(-30000),
        created_at: createIso(-120000),
        updated_at: createIso(-30000),
      },
    ],
  ]);

  const players = new Map([
    [
      5001,
      [
        { game_session_id: 5001, user_id: 1, seat_no: 3, status: 'joined', metadata: {}, joined_at: createIso(-120000), left_at: null },
        { game_session_id: 5001, user_id: 2, seat_no: 1, status: 'joined', metadata: {}, joined_at: createIso(-119000), left_at: null },
        { game_session_id: 5001, user_id: 3, seat_no: 2, status: 'joined', metadata: {}, joined_at: createIso(-118000), left_at: null },
      ],
    ],
  ]);

  const events = new Map([[5001, []]]);

  return {
    nextSessionId: 6000,
    users,
    sessions,
    players,
    events,
  };
}

function loadGameplayHarness(state) {
  const filePath = path.join(__dirname, '..', 'services', 'gameplay.service.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const instrumented = `${source}\nmodule.exports.__test = { joinSession, getSessionState, createOrJoinContinuationSession, leaveTableContinuation };`;

  const gameModel = {
    async getAllWithContests() {
      return [
        {
          game_id: 101,
          name: 'Points Rummy',
          dashboard_banner: null,
          side_banner: null,
          badge: null,
          turn_timer_seconds: 30,
          bonus_timer_seconds: 10,
          game_sort: 1,
          game_active: true,
          contest_id: 201,
          player_count: 3,
          entry_fee: 0,
          point_value: 1,
          contest_active: true,
          play_type: 2,
        },
      ];
    },
  };

  const gameSessionModel = {
    async createSession({ sessionCode, gameId, contestId, hostUserId, maxPlayers, metadata = {} }) {
      const id = state.nextSessionId++;
      const session = {
        id,
        session_code: sessionCode,
        game_id: gameId,
        contest_id: contestId,
        host_user_id: hostUserId,
        status: 'waiting',
        max_players: maxPlayers,
        current_turn_user_id: null,
        metadata,
        started_at: null,
        ended_at: null,
        created_at: createIso(),
        updated_at: createIso(),
      };
      state.sessions.set(id, session);
      state.players.set(id, []);
      state.events.set(id, []);
      return session;
    },
    async findSessionById(sessionId) {
      return state.sessions.get(Number(sessionId)) || null;
    },
    async findSessionByCode(sessionCode) {
      return Array.from(state.sessions.values()).find((session) => session.session_code === sessionCode) || null;
    },
    async findOpenWaitingSession() {
      return null;
    },
    async findReservedContinuationSession(sourceSessionId) {
      return Array.from(state.sessions.values()).find((session) => (
        Number(session.metadata?.continuation_source_session_id) === Number(sourceSessionId)
        && session.metadata?.rematch_reserved === true
        && ['waiting', 'ready', 'active'].includes(session.status)
      )) || null;
    },
    async listStaleWaitingSessions() {
      return [];
    },
    async listSessionPlayers(sessionId) {
      return (state.players.get(Number(sessionId)) || []).map((player) => ({
        ...player,
        ...(state.users[player.user_id] || {}),
      }));
    },
    async addPlayer({ sessionId, userId, seatNo, metadata = {} }) {
      const row = {
        game_session_id: Number(sessionId),
        user_id: Number(userId),
        seat_no: Number(seatNo),
        status: 'joined',
        metadata,
        joined_at: createIso(),
        left_at: null,
      };
      const sessionPlayers = state.players.get(Number(sessionId)) || [];
      sessionPlayers.push(row);
      state.players.set(Number(sessionId), sessionPlayers);
      return row;
    },
    async findPlayer(sessionId, userId) {
      return (state.players.get(Number(sessionId)) || []).find((player) => Number(player.user_id) === Number(userId)) || null;
    },
    async updatePlayerMetadata(sessionId, userId, metadata = {}) {
      const sessionPlayers = state.players.get(Number(sessionId)) || [];
      const player = sessionPlayers.find((item) => Number(item.user_id) === Number(userId));
      if (!player) return null;
      player.metadata = metadata;
      return player;
    },
    async updatePlayerState(sessionId, userId, fields = {}) {
      const sessionPlayers = state.players.get(Number(sessionId)) || [];
      const player = sessionPlayers.find((item) => Number(item.user_id) === Number(userId));
      if (!player) return null;
      if (Object.prototype.hasOwnProperty.call(fields, 'status')) {
        player.status = fields.status;
      }
      if (Object.prototype.hasOwnProperty.call(fields, 'leftAt')) {
        player.left_at = fields.leftAt;
      }
      if (Object.prototype.hasOwnProperty.call(fields, 'metadata')) {
        player.metadata = fields.metadata;
      }
      return player;
    },
    async countJoinedPlayers(sessionId) {
      return (state.players.get(Number(sessionId)) || []).filter((player) => ['joined', 'disconnected'].includes(player.status)).length;
    },
    async updateSessionStatus(sessionId, status, fields = {}) {
      const session = state.sessions.get(Number(sessionId));
      if (!session) return null;
      session.status = status;
      if (Object.prototype.hasOwnProperty.call(fields, 'currentTurnUserId')) {
        session.current_turn_user_id = fields.currentTurnUserId;
      }
      if (Object.prototype.hasOwnProperty.call(fields, 'startedAt')) {
        session.started_at = fields.startedAt;
      }
      if (Object.prototype.hasOwnProperty.call(fields, 'endedAt')) {
        session.ended_at = fields.endedAt;
      }
      if (Object.prototype.hasOwnProperty.call(fields, 'metadata')) {
        session.metadata = fields.metadata;
      }
      session.updated_at = createIso();
      return session;
    },
    async insertEvent({ sessionId, userId = null, eventType, payload = {} }) {
      const row = {
        id: (state.events.get(Number(sessionId)) || []).length + 1,
        game_session_id: Number(sessionId),
        user_id: userId,
        event_type: eventType,
        payload,
        created_at: createIso(),
      };
      const sessionEvents = state.events.get(Number(sessionId)) || [];
      sessionEvents.push(row);
      state.events.set(Number(sessionId), sessionEvents);
      return row;
    },
    async listRecentEvents(sessionId) {
      return state.events.get(Number(sessionId)) || [];
    },
  };

  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    require(request) {
      switch (request) {
        case '../models/game.model':
          return gameModel;
        case '../models/gameSession.model':
          return gameSessionModel;
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

function loadSocketHarness() {
  const filePath = path.join(__dirname, '..', 'realtime', 'socketServer.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const instrumented = `${source}\nmodule.exports.__test = { syncSocketToSessionPhase };`;
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

async function main() {
  const gameplayState = createGameplayState();
  const gameplayHarness = loadGameplayHarness(gameplayState);

  const continuation = await gameplayHarness.createOrJoinContinuationSession({ sourceSessionId: 5001, userId: 1 });
  assert(continuation.session, 'Expected continuation session to be created');
  assert(continuation.session.metadata.rematch_reserved === true, 'Expected continuation session to be reserved');
  assert(continuation.session.max_players === 3, 'Expected continuation session to use eligible player count');

  const createdHost = continuation.session.players.find((player) => Number(player.user_id) === 1);
  assert(createdHost && createdHost.seat_no === 3, 'Expected host to keep original seat number in continuation session');

  const joinedSecond = await gameplayHarness.joinSession({ sessionIdOrCode: continuation.session.id, userId: 2 });
  const secondPlayer = joinedSecond.players.find((player) => Number(player.user_id) === 2);
  assert(secondPlayer && secondPlayer.seat_no === 1, 'Expected continuation join to preserve original seat for user 2');

  await gameplayHarness.joinSession({ sessionIdOrCode: continuation.session.id, userId: 3 });
  const readyContinuation = await gameplayHarness.getSessionState(continuation.session.id);
  assert(readyContinuation.status === 'ready', 'Expected continuation session to become ready when all reserved players rejoin');

  const fallbackState = createGameplayState();
  const fallbackHarness = loadGameplayHarness(fallbackState);
  await fallbackHarness.leaveTableContinuation({ sourceSessionId: 5001, userId: 2 });
  await fallbackHarness.leaveTableContinuation({ sourceSessionId: 5001, userId: 3 });
  const fallback = await fallbackHarness.createOrJoinContinuationSession({ sourceSessionId: 5001, userId: 1 });
  assert(fallback.fallbackToMatchmaking === true, 'Expected continuation flow to fallback when fewer than 2 players remain');
  assert(fallback.session === null, 'Expected no reserved continuation session when fallback is required');

  const socketHarness = loadSocketHarness();
  const socket = {
    emitted: [],
    emit(event, payload) {
      this.emitted.push({ event, payload });
    },
  };

  const countdownResult = socketHarness.syncSocketToSessionPhase(socket, {
    id: 7001,
    session_code: 'COUNT1',
    status: 'ready',
    metadata: {
      phase: 'countdown',
      countdown: {
        sequence: 1,
        started_at: createIso(-1000),
        ends_at: createIso(2500),
      },
    },
    players: [{ user_id: 1, seat_no: 1, name: 'Alpha', avatar: null, metadata: {} }],
  }, 'countdown_test');
  assert(countdownResult.phase === 'countdown', 'Expected countdown phase sync to report countdown');
  assert(socket.emitted.some((entry) => entry.event === 'game:countdown'), 'Expected countdown sync to emit game:countdown');

  socket.emitted.length = 0;
  const activeResult = socketHarness.syncSocketToSessionPhase(socket, {
    id: 7002,
    session_code: 'ACT1',
    status: 'active',
    game: { turn_timer_seconds: 30 },
    metadata: {
      phase: 'active',
      toss: { sequence: 3, toss_winner_user_id: 1, started_at: createIso(-8000), deal_starts_at: createIso(-3000) },
      distribution: {
        wild_joker: { card_uid: 'jk1' },
        players: [{ user_id: 1, cards: [] }],
        discard_pile: [],
        closed_deck: [],
      },
      game_state: {
        current_turn_user_id: 1,
      },
      turn: {
        turn_id: 99,
        user_id: 1,
        started_at: createIso(-1000),
        ends_at: createIso(29000),
        turn_timer_seconds: 30,
        type: 'normal',
        attempt_no: 0,
        max_bonus_attempts: 2,
        attempts_left: 2,
        has_picked: false,
      },
    },
    players: [{ user_id: 1, seat_no: 1, name: 'Alpha', avatar: null, metadata: {} }],
  }, 'active_test');
  assert(activeResult.phase === 'active', 'Expected active phase sync to report active');
  assert(socket.emitted.some((entry) => entry.event === 'game:deal'), 'Expected active sync to emit game:deal');
  assert(socket.emitted.some((entry) => entry.event === 'game:turn'), 'Expected active sync to emit game:turn');

  socket.emitted.length = 0;
  const finishedResult = socketHarness.syncSocketToSessionPhase(socket, {
    id: 7003,
    session_code: 'DONE1',
    status: 'completed',
    metadata: {
      phase: 'finished',
      result: {
        session_id: 7003,
        event: 'game:result',
        winner_user_id: 2,
      },
    },
    players: [],
  }, 'finished_test');
  assert(finishedResult.phase === 'finished', 'Expected finished phase sync to report finished');
  assert(socket.emitted.some((entry) => entry.event === 'game:result'), 'Expected finished sync to emit game:result');

  console.log('verify_transition_flows: PASS');
}

main().catch((err) => {
  console.error('verify_transition_flows: FAIL');
  console.error(err.stack || err.message);
  process.exit(1);
});