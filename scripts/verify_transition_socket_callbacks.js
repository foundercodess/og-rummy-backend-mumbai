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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function resolveConnectionStatus(player = {}) {
  if (player.status === 'disconnected') return 'disconnected';
  if (player.metadata?.connection_status === 'disconnected') return 'disconnected';
  return 'connected';
}

function resolvePlayerStatus(player = {}) {
  const metadata = player.metadata || {};
  if (metadata.is_dropped || metadata.drop_status === 'dropped' || metadata.elimination_reason === 'dropped') {
    return 'dropped';
  }
  if (metadata.elimination_reason === 'timeout') {
    return 'timeout';
  }
  if (resolveConnectionStatus(player) === 'disconnected') {
    return 'disconnected';
  }
  if (player.status === 'eliminated') {
    return 'eliminated';
  }
  if (player.status === 'left') {
    return 'left';
  }
  return 'active';
}

function createBaseStore() {
  return {
    nextSessionId: 9000,
    sessionCounter: 1,
    sessions: new Map(),
    playersBySessionId: new Map(),
    eventsBySessionId: new Map(),
    createSessionPlans: [],
    startPregameCalls: [],
    setSocketIOCalls: 0,
    noticeCalls: 0,
  };
}

function addSession(store, session, players = []) {
  store.sessions.set(Number(session.id), clone(session));
  store.playersBySessionId.set(Number(session.id), clone(players));
  store.eventsBySessionId.set(Number(session.id), []);
}

function buildSessionState(store, sessionIdOrCode) {
  let session = null;
  if (Number.isInteger(sessionIdOrCode)) {
    session = store.sessions.get(Number(sessionIdOrCode)) || null;
  } else {
    session = Array.from(store.sessions.values()).find((item) => item.session_code === String(sessionIdOrCode)) || null;
  }

  if (!session) return null;

  const players = (store.playersBySessionId.get(Number(session.id)) || []).map((player) => ({
    ...clone(player),
    player_status: resolvePlayerStatus(player),
    connection_status: resolveConnectionStatus(player),
  }));

  return {
    id: session.id,
    session_code: session.session_code,
    game_id: session.game_id,
    contest_id: session.contest_id,
    host_user_id: session.host_user_id,
    status: session.status,
    max_players: session.max_players,
    current_turn_user_id: session.current_turn_user_id,
    metadata: clone(session.metadata || {}),
    started_at: session.started_at || null,
    ended_at: session.ended_at || null,
    created_at: session.created_at || createIso(-120000),
    updated_at: session.updated_at || createIso(-1000),
    game: clone(session.game || {
      id: session.game_id,
      turn_timer_seconds: 30,
      bonus_timer_seconds: 10,
      bonus_attempts_per_player: 2,
      point_value: 1,
    }),
    contest: clone(session.contest || {
      id: session.contest_id,
      game_id: session.game_id,
      player_count: session.max_players,
      point_value: 1,
    }),
    players,
    events: clone(store.eventsBySessionId.get(Number(session.id)) || []),
  };
}

function createSocketCallbackHarness(setupStore) {
  const store = createBaseStore();
  setupStore(store);

  const socketRegistryState = new Map();
  let lastIoInstance = null;

  class FakeServer {
    constructor() {
      this.handlers = new Map();
      this.middlewares = [];
      this.emitted = [];
      this.sockets = {
        adapter: {
          rooms: new Map(),
        },
      };
      lastIoInstance = this;
    }

    use(fn) {
      this.middlewares.push(fn);
    }

    on(event, handler) {
      this.handlers.set(event, handler);
    }

    to(room) {
      return {
        emit: (event, payload) => {
          this.emitted.push({ room, event, payload });
        },
      };
    }

    adapter() {}
  }

  class FakeSocket {
    constructor(io, user, socketId) {
      this.io = io;
      this.user = user;
      this.id = socketId;
      this.handlers = new Map();
      this.rooms = new Set([socketId]);
      this.data = {};
      this.emitted = [];
    }

    on(event, handler) {
      this.handlers.set(event, handler);
    }

    emit(event, payload) {
      this.emitted.push({ event, payload });
    }

    join(room) {
      this.rooms.add(room);
      if (!this.io.sockets.adapter.rooms.has(room)) {
        this.io.sockets.adapter.rooms.set(room, new Set());
      }
      this.io.sockets.adapter.rooms.get(room).add(this.id);
    }

    leave(room) {
      this.rooms.delete(room);
      const roomSet = this.io.sockets.adapter.rooms.get(room);
      if (!roomSet) return;
      roomSet.delete(this.id);
      if (roomSet.size === 0) {
        this.io.sockets.adapter.rooms.delete(room);
      }
    }

    async invoke(event, payload = {}) {
      const handler = this.handlers.get(event);
      if (!handler) {
        throw new Error(`Missing socket handler for ${event}`);
      }

      return new Promise((resolve, reject) => {
        const ack = (response) => resolve(response);
        Promise.resolve(handler(payload, ack)).catch(reject);
      });
    }
  }

  const gameplayService = {
    async getSessionState(sessionIdOrCode) {
      return buildSessionState(store, sessionIdOrCode);
    },

    async createSession({ gameId, contestId, hostUserId, maxPlayers, metadata = {} }) {
      const plan = store.createSessionPlans.shift() || {};
      const sessionId = Number(plan.id || store.nextSessionId++);
      const session = {
        id: sessionId,
        session_code: plan.session_code || `AUTO${String(store.sessionCounter++).padStart(4, '0')}`,
        game_id: Number(gameId),
        contest_id: Number(contestId),
        host_user_id: Number(hostUserId),
        status: plan.status || 'waiting',
        max_players: Number(maxPlayers) || Number(plan.max_players) || 2,
        current_turn_user_id: plan.current_turn_user_id || null,
        metadata: {
          ...(metadata || {}),
          ...(plan.metadata || {}),
        },
        game: plan.game || {
          id: Number(gameId),
          turn_timer_seconds: 30,
          bonus_timer_seconds: 10,
          bonus_attempts_per_player: 2,
          point_value: 1,
        },
        contest: plan.contest || {
          id: Number(contestId),
          game_id: Number(gameId),
          player_count: Number(maxPlayers) || 2,
          point_value: 1,
        },
        created_at: createIso(),
        updated_at: createIso(),
      };

      const players = Array.isArray(plan.players) && plan.players.length > 0
        ? clone(plan.players)
        : [{
          user_id: Number(hostUserId),
          seat_no: 1,
          status: 'joined',
          metadata: { ready: false, host: true },
          joined_at: createIso(),
          left_at: null,
          name: `User ${hostUserId}`,
          avatar: null,
          phone: null,
          view_id: `U${hostUserId}`,
        }];

      addSession(store, session, players);
      return buildSessionState(store, session.id);
    },

    async createOrJoinContinuationSession({ sourceSessionId, userId }) {
      const plan = typeof store.continuationHandler === 'function'
        ? await store.continuationHandler({ sourceSessionId, userId, store })
        : null;

      if (!plan) {
        throw new Error('Missing continuation test plan');
      }

      if (plan.session) {
        addSession(store, plan.session, plan.players || []);
      }

      return {
        session: plan.session ? buildSessionState(store, plan.session.id) : null,
        sourceSession: buildSessionState(store, sourceSessionId),
        eligibleUserIds: plan.eligibleUserIds || null,
        fallbackToMatchmaking: plan.fallbackToMatchmaking === true,
        reused: plan.reused === true,
      };
    },

    async leaveTableContinuation({ sourceSessionId, userId }) {
      const rawSession = store.sessions.get(Number(sourceSessionId));
      if (!rawSession) {
        const error = new Error('Source session not found');
        error.code = 'SESSION_NOT_FOUND';
        throw error;
      }

      const nextLeftUserIds = new Set(
        (Array.isArray(rawSession.metadata?.post_result_left_user_ids) ? rawSession.metadata.post_result_left_user_ids : [])
          .map((playerId) => Number(playerId))
      );
      nextLeftUserIds.add(Number(userId));
      rawSession.metadata = {
        ...(rawSession.metadata || {}),
        post_result_left_user_ids: Array.from(nextLeftUserIds),
      };
      rawSession.updated_at = createIso();
      return buildSessionState(store, rawSession.id);
    },
  };

  const gameSessionModel = {
    async findPlayer(sessionId, userId) {
      return (store.playersBySessionId.get(Number(sessionId)) || []).find((player) => Number(player.user_id) === Number(userId)) || null;
    },

    async updatePlayerState(sessionId, userId, fields = {}) {
      const players = store.playersBySessionId.get(Number(sessionId)) || [];
      const player = players.find((item) => Number(item.user_id) === Number(userId));
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

    async updateSessionStatus(sessionId, status, fields = {}) {
      const session = store.sessions.get(Number(sessionId));
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
      const rows = store.eventsBySessionId.get(Number(sessionId)) || [];
      const event = {
        id: rows.length + 1,
        game_session_id: Number(sessionId),
        user_id: userId,
        event_type: eventType,
        payload,
        created_at: createIso(),
      };
      rows.push(event);
      store.eventsBySessionId.set(Number(sessionId), rows);
      return event;
    },
  };

  const groupingService = {
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

  const noop = () => {};
  const filePath = path.join(__dirname, '..', 'realtime', 'socketServer.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    require(request) {
      switch (request) {
        case 'socket.io':
          return { Server: FakeServer };
        case '@socket.io/redis-adapter':
          return { createAdapter: noop };
        case '../services/gameplay.service':
          return gameplayService;
        case '../models/gameSession.model':
          return gameSessionModel;
        case '../services/grouping.service':
          return groupingService;
        case '../services/redisLock.service':
          return { claimEventIdempotency: async () => true };
        case '../db':
          return { pool: null };
        case '../services/redis.service':
          return { getSocketAdapterRedisClients: async () => null };
        case './socketRegistry':
          return {
            addSocket(userId, socketId) {
              if (!socketRegistryState.has(userId)) {
                socketRegistryState.set(userId, new Set());
              }
              socketRegistryState.get(userId).add(socketId);
            },
            removeSocket(userId, socketId) {
              const set = socketRegistryState.get(userId);
              if (!set) return;
              set.delete(socketId);
              if (set.size === 0) {
                socketRegistryState.delete(userId);
              }
            },
            getSocketIds(userId) {
              return Array.from(socketRegistryState.get(userId) || []);
            },
          };
        case './socketAuth':
          return { socketAuth: noop };
        case './socketBus':
          return {
            emitActiveNotices: async () => {
              store.noticeCalls += 1;
              return { notices: [] };
            },
            setSocketIO: () => {
              store.setSocketIOCalls += 1;
            },
          };
        case './pregameOrchestrator':
          return {
            startPregame: async (_io, sessionId) => {
              store.startPregameCalls.push(Number(sessionId));
            },
          };
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
    setTimeout(fn, delay, ...args) {
      return { fn, delay, args, cleared: false };
    },
    clearTimeout(handle) {
      if (handle) handle.cleared = true;
    },
    setInterval(fn, delay, ...args) {
      return { fn, delay, args, cleared: false };
    },
    clearInterval(handle) {
      if (handle) handle.cleared = true;
    },
    Buffer,
  };

  vm.runInNewContext(source, sandbox, { filename: filePath });
  const { registerSocketServer } = module.exports;
  const io = registerSocketServer({});
  const socket = new FakeSocket(io, { id: 10, name: 'Alpha' }, 'sock-10');
  const connectionHandler = io.handlers.get('connection');
  if (!connectionHandler) {
    throw new Error('Socket connection handler was not registered');
  }
  connectionHandler(socket);

  return { io, socket, store };
}

function sessionRoom(sessionId) {
  return `game-session:${sessionId}`;
}

function buildActiveSourceSession(sessionId = 8101) {
  const turn = {
    turn_id: 301,
    user_id: 10,
    type: 'normal',
    attempt_no: 0,
    max_bonus_attempts: 2,
    attempts_left: 2,
    has_picked: false,
    started_at: createIso(-5000),
    ends_at: createIso(25000),
    turn_timer_seconds: 30,
  };

  return {
    session: {
      id: sessionId,
      session_code: `SRC${sessionId}`,
      game_id: 101,
      contest_id: 201,
      host_user_id: 10,
      status: 'active',
      max_players: 3,
      current_turn_user_id: 10,
      metadata: {
        phase: 'active',
        distribution: {
          wild_joker: { card_uid: 'wj1', card_id: 'H5', rank: '5', suit: 'hearts', value: 5 },
          discard_pile: [],
          closed_deck: [],
          players: [
            { user_id: 10, cards: [{ card_uid: 'c1', value: 10 }], submitted_groups: [] },
            { user_id: 11, cards: [{ card_uid: 'c2', value: 7 }], submitted_groups: [] },
            { user_id: 12, cards: [{ card_uid: 'c3', value: 5 }], submitted_groups: [] },
          ],
        },
        turn,
        turn_bonus: {
          max_attempts_per_player: 2,
          attempts_used_by_user: {},
        },
        turn_eliminated_user_ids: [],
        turn_timeout_eliminated_user_ids: [],
      },
      game: { id: 101, turn_timer_seconds: 30, bonus_timer_seconds: 10, bonus_attempts_per_player: 2, point_value: 1 },
      contest: { id: 201, game_id: 101, player_count: 3, point_value: 1 },
      created_at: createIso(-60000),
      updated_at: createIso(-1000),
    },
    players: [
      { user_id: 10, seat_no: 1, status: 'joined', metadata: {}, joined_at: createIso(-58000), left_at: null, name: 'Alpha', avatar: null, phone: null, view_id: 'A10' },
      { user_id: 11, seat_no: 2, status: 'joined', metadata: {}, joined_at: createIso(-57000), left_at: null, name: 'Beta', avatar: null, phone: null, view_id: 'B11' },
      { user_id: 12, seat_no: 3, status: 'joined', metadata: {}, joined_at: createIso(-56000), left_at: null, name: 'Gamma', avatar: null, phone: null, view_id: 'C12' },
    ],
  };
}

function buildCompletedSourceSession(sessionId = 8201) {
  return {
    session: {
      id: sessionId,
      session_code: `FIN${sessionId}`,
      game_id: 101,
      contest_id: 201,
      host_user_id: 10,
      status: 'completed',
      max_players: 3,
      current_turn_user_id: 11,
      metadata: {
        phase: 'finished',
        result: {
          session_id: sessionId,
          event: 'game:result',
          winner_user_id: 11,
        },
      },
      game: { id: 101, turn_timer_seconds: 30, bonus_timer_seconds: 10, bonus_attempts_per_player: 2, point_value: 1 },
      contest: { id: 201, game_id: 101, player_count: 3, point_value: 1 },
      created_at: createIso(-120000),
      updated_at: createIso(-1000),
      ended_at: createIso(-10000),
    },
    players: [
      { user_id: 10, seat_no: 1, status: 'joined', metadata: {}, joined_at: createIso(-110000), left_at: null, name: 'Alpha', avatar: null, phone: null, view_id: 'A10' },
      { user_id: 11, seat_no: 2, status: 'joined', metadata: {}, joined_at: createIso(-109000), left_at: null, name: 'Beta', avatar: null, phone: null, view_id: 'B11' },
      { user_id: 12, seat_no: 3, status: 'joined', metadata: {}, joined_at: createIso(-108000), left_at: null, name: 'Gamma', avatar: null, phone: null, view_id: 'C12' },
    ],
  };
}

async function testDropAndSwitchSuccess() {
  const harness = createSocketCallbackHarness((store) => {
    const source = buildActiveSourceSession(8101);
    addSession(store, source.session, source.players);
    store.createSessionPlans.push({
      id: 9101,
      status: 'ready',
      max_players: 2,
      metadata: {
        phase: 'countdown',
        countdown: {
          sequence: 'cd-1',
          started_at: createIso(-500),
          ends_at: createIso(2500),
        },
      },
      players: [
        { user_id: 10, seat_no: 1, status: 'joined', metadata: { ready: false, host: true }, joined_at: createIso(), left_at: null, name: 'Alpha', avatar: null, phone: null, view_id: 'A10' },
      ],
    });
  });

  harness.socket.join(sessionRoom(8101));
  const ack = await harness.socket.invoke('player:drop_and_switch', { source_session_id: 8101 });

  assert(ack.success === true, 'Expected drop_and_switch ack success');
  assert(ack.data.target_session.id === 9101, 'Expected drop_and_switch to move player to target session 9101');
  assert(ack.data.phase === 'countdown', 'Expected drop_and_switch ack phase to be countdown');
  assert(ack.data.sync_event === 'game:countdown', 'Expected drop_and_switch sync_event to be game:countdown');
  assert(harness.socket.rooms.has(sessionRoom(9101)), 'Expected socket to join new target session room');
  assert(!harness.socket.rooms.has(sessionRoom(8101)), 'Expected socket to leave old source session room');
  assert(harness.socket.emitted.some((entry) => entry.event === 'game:countdown'), 'Expected countdown replay on drop_and_switch');
  assert(harness.io.emitted.some((entry) => entry.event === 'player:status' && entry.room === sessionRoom(8101)), 'Expected source room player:status emission on drop');
}

async function testPlayNowSuccessAndValidation() {
  const harness = createSocketCallbackHarness((store) => {
    store.createSessionPlans.push({
      id: 9102,
      status: 'ready',
      max_players: 2,
      metadata: {
        phase: 'countdown',
        countdown: {
          sequence: 'cd-2',
          started_at: createIso(-500),
          ends_at: createIso(2500),
        },
      },
      players: [
        { user_id: 10, seat_no: 1, status: 'joined', metadata: { ready: false, host: true }, joined_at: createIso(), left_at: null, name: 'Alpha', avatar: null, phone: null, view_id: 'A10' },
      ],
    });
  });

  const failureAck = await harness.socket.invoke('table:play_again', {});
  assert(failureAck.success === false, 'Expected play_again to reject missing game_id and contest_id');

  const successAck = await harness.socket.invoke('table:play_again', { game_id: 101, contest_id: 201, max_players: 2 });
  assert(successAck.success === true, 'Expected play_again ack success');
  assert(successAck.data.target_session.id === 9102, 'Expected play_again to create target session 9102');
  assert(successAck.data.phase === 'countdown', 'Expected play_again ack phase to be countdown');
  assert(successAck.data.sync_event === 'game:countdown', 'Expected play_again sync_event to be game:countdown');
  assert(harness.socket.emitted.some((entry) => entry.event === 'game:countdown'), 'Expected countdown replay on play_again');
}

async function testBackContinuationActiveReplay() {
  const harness = createSocketCallbackHarness((store) => {
    const source = buildCompletedSourceSession(8201);
    addSession(store, source.session, source.players);
    store.continuationHandler = async () => ({
      fallbackToMatchmaking: false,
      reused: true,
      eligibleUserIds: [10, 11, 12],
      session: {
        id: 9201,
        session_code: 'REM9201',
        game_id: 101,
        contest_id: 201,
        host_user_id: 10,
        status: 'active',
        max_players: 3,
        current_turn_user_id: 11,
        metadata: {
          phase: 'active',
          continuation_source_session_id: 8201,
          distribution: {
            wild_joker: { card_uid: 'jk-2' },
            players: [
              { user_id: 10, cards: [] },
              { user_id: 11, cards: [] },
            ],
            discard_pile: [],
            closed_deck: [],
          },
          toss: {
            sequence: 'ts-1',
            toss_winner_user_id: 11,
            started_at: createIso(-8000),
            deal_starts_at: createIso(-3000),
          },
          game_state: {
            current_turn_user_id: 11,
          },
          turn: {
            turn_id: 901,
            user_id: 11,
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
        game: { id: 101, turn_timer_seconds: 30, bonus_timer_seconds: 10, bonus_attempts_per_player: 2, point_value: 1 },
        contest: { id: 201, game_id: 101, player_count: 3, point_value: 1 },
      },
      players: [
        { user_id: 10, seat_no: 1, status: 'joined', metadata: {}, joined_at: createIso(), left_at: null, name: 'Alpha', avatar: null, phone: null, view_id: 'A10' },
        { user_id: 11, seat_no: 2, status: 'joined', metadata: {}, joined_at: createIso(), left_at: null, name: 'Beta', avatar: null, phone: null, view_id: 'B11' },
      ],
    });
  });

  harness.socket.join(sessionRoom(8201));
  const missingSourceAck = await harness.socket.invoke('table:back', {});
  assert(missingSourceAck.success === false, 'Expected table:back to reject missing source_session_id');

  const ack = await harness.socket.invoke('table:back', { source_session_id: 8201 });
  assert(ack.success === true, 'Expected table:back ack success');
  assert(ack.data.transition_type === 'same_table_continuation', 'Expected same-table continuation transition type');
  assert(ack.data.target_session.id === 9201, 'Expected table:back to join continuation session 9201');
  assert(ack.data.phase === 'active', 'Expected table:back ack phase to be active for live continuation');
  assert(ack.data.sync_event === 'game:deal', 'Expected table:back sync_event to be game:deal for live continuation');
  assert(harness.socket.emitted.some((entry) => entry.event === 'game:deal'), 'Expected game:deal replay on active continuation session');
  assert(harness.socket.emitted.some((entry) => entry.event === 'game:turn'), 'Expected game:turn replay on active continuation session');
  assert(!harness.socket.rooms.has(sessionRoom(8201)), 'Expected socket to leave completed source room after table:back');
}

async function testBackFallbackToMatchmaking() {
  const harness = createSocketCallbackHarness((store) => {
    const source = buildCompletedSourceSession(8202);
    addSession(store, source.session, source.players);
    store.continuationHandler = async () => ({
      fallbackToMatchmaking: true,
      reused: false,
      eligibleUserIds: [10],
      session: null,
    });
    store.createSessionPlans.push({
      id: 9202,
      status: 'ready',
      max_players: 2,
      metadata: {
        phase: 'countdown',
        countdown: {
          sequence: 'cd-3',
          started_at: createIso(-500),
          ends_at: createIso(2500),
        },
      },
      players: [
        { user_id: 10, seat_no: 1, status: 'joined', metadata: {}, joined_at: createIso(), left_at: null, name: 'Alpha', avatar: null, phone: null, view_id: 'A10' },
      ],
    });
  });

  const ack = await harness.socket.invoke('table:back', { source_session_id: 8202 });
  assert(ack.success === true, 'Expected table:back fallback ack success');
  assert(ack.data.fallback_to_matchmaking === true, 'Expected table:back fallback flag to be true');
  assert(ack.data.transition_type === 'same_table_fallback_matchmaking', 'Expected fallback transition type');
  assert(ack.data.target_session.id === 9202, 'Expected fallback to matchmaking session 9202');
  assert(ack.data.phase === 'countdown', 'Expected fallback table:back ack phase to be countdown');
  assert(ack.data.sync_event === 'game:countdown', 'Expected fallback table:back sync_event to be game:countdown');
  assert(harness.socket.emitted.some((entry) => entry.event === 'game:countdown'), 'Expected countdown replay on fallback matchmaking target');
}

async function testLeaveTableBroadcast() {
  const harness = createSocketCallbackHarness((store) => {
    const source = buildCompletedSourceSession(8203);
    addSession(store, source.session, source.players);
  });

  harness.socket.join(sessionRoom(8203));
  const ack = await harness.socket.invoke('table:leave', { source_session_id: 8203 });
  assert(ack.success === true, 'Expected table:leave ack success');
  assert(ack.data.left === true, 'Expected table:leave to return left=true');
  assert(!harness.socket.rooms.has(sessionRoom(8203)), 'Expected socket to leave source room after table:leave');
  assert(harness.io.emitted.some((entry) => entry.event === 'session:state' && entry.room === sessionRoom(8203)), 'Expected table:leave to broadcast updated session:state');
}

async function testBackInsufficientBalance() {
  const harness = createSocketCallbackHarness((store) => {
    const source = buildCompletedSourceSession(8204);
    addSession(store, source.session, source.players);
    store.continuationHandler = async () => {
      const error = new Error('Insufficient balance for continuation session');
      error.code = 'INSUFFICIENT_BALANCE';
      throw error;
    };
  });

  harness.socket.join(sessionRoom(8204));
  const ack = await harness.socket.invoke('table:back', { source_session_id: 8204 });
  assert(ack.success === false, 'Expected table:back to fail with insufficient balance');
  assert(ack.message.includes('balance') || ack.message.includes('Insufficient'), 'Expected balance-related error message');
}

async function testBackPlayerAlreadyLeft() {
  const harness = createSocketCallbackHarness((store) => {
    const source = buildCompletedSourceSession(8205);
    source.session.metadata.post_result_left_user_ids = [10];
    addSession(store, source.session, source.players);
    
    store.continuationHandler = async () => {
      const error = new Error('Player already left the table');
      error.code = 'PLAYER_LEFT_TABLE';
      throw error;
    };
  });

  harness.socket.join(sessionRoom(8205));
  const ack = await harness.socket.invoke('table:back', { source_session_id: 8205 });
  assert(ack.success === false, 'Expected table:back to fail for player who already left');
  assert(ack.message.includes('left') || ack.message.includes('not eligible'), 'Expected left-related error message');
}

async function testBackSessionCreationRaceCondition() {
  const harness = createSocketCallbackHarness((store) => {
    const source = buildCompletedSourceSession(8206);
    addSession(store, source.session, source.players);
    store.continuationHandler = async () => {
      const error = new Error('Failed to create continuation session after 5 retries');
      error.code = 'SESSION_CREATION_FAILED';
      throw error;
    };
  });

  harness.socket.join(sessionRoom(8206));
  const ack = await harness.socket.invoke('table:back', { source_session_id: 8206 });
  assert(ack.success === false, 'Expected table:back to fail on session creation failure');
  assert(ack.message.includes('continuation') || ack.message.includes('Failed'), 'Expected session creation error message');
}

async function testBackSocketAttachmentConflict() {
  const harness = createSocketCallbackHarness((store) => {
    const source = buildCompletedSourceSession(8207);
    addSession(store, source.session, source.players);
    store.continuationHandler = async () => ({
      fallbackToMatchmaking: false,
      reused: true,
      eligibleUserIds: [10, 11, 12],
      session: {
        id: 9207,
        session_code: 'REM9207',
        game_id: 101,
        contest_id: 201,
        host_user_id: 10,
        status: 'active',
        max_players: 3,
        current_turn_user_id: 11,
        metadata: {
          phase: 'active',
          continuation_source_session_id: 8207,
          distribution: {
            wild_joker: { card_uid: 'jk-2' },
            players: [
              { user_id: 10, cards: [] },
              { user_id: 11, cards: [] },
            ],
            discard_pile: [],
            closed_deck: [],
          },
          turn: {
            turn_id: 902,
            user_id: 11,
            started_at: createIso(-1000),
            ends_at: createIso(29000),
            turn_timer_seconds: 30,
            type: 'normal',
          },
        },
        game: { id: 101, turn_timer_seconds: 30, bonus_timer_seconds: 10, bonus_attempts_per_player: 2, point_value: 1 },
        contest: { id: 201, game_id: 101, player_count: 3, point_value: 1 },
      },
      players: [
        { user_id: 10, seat_no: 1, status: 'joined', metadata: {}, joined_at: createIso(), left_at: null, name: 'Alpha', avatar: null, phone: null, view_id: 'A10' },
        { user_id: 11, seat_no: 2, status: 'joined', metadata: {}, joined_at: createIso(), left_at: null, name: 'Beta', avatar: null, phone: null, view_id: 'B11' },
      ],
    });
  });

  harness.socket.join(sessionRoom(9999));
  harness.socket.join(sessionRoom(8207));
  
  const ack = await harness.socket.invoke('table:back', { source_session_id: 8207 });
  assert(ack.success === true, 'Expected table:back to succeed despite socket conflicts');
  assert(ack.data.target_session.id === 9207, 'Expected successful transition to continuation session');
  assert(!harness.socket.rooms.has(sessionRoom(8207)), 'Expected socket to leave source room');
  assert(harness.socket.rooms.has(sessionRoom(9207)), 'Expected socket to join target room');
}

async function testBackPhaseSyncCorruption() {
  const harness = createSocketCallbackHarness((store) => {
    const source = buildCompletedSourceSession(8208);
    addSession(store, source.session, source.players);
    store.continuationHandler = async () => ({
      fallbackToMatchmaking: false,
      reused: true,
      eligibleUserIds: [10, 11, 12],
      session: {
        id: 9208,
        session_code: 'REM9208',
        game_id: 101,
        contest_id: 201,
        host_user_id: 10,
        status: 'active',
        max_players: 3,
        current_turn_user_id: 11,
        metadata: {
          phase: 'active',
          continuation_source_session_id: 8208,
        },
        game: { id: 101, turn_timer_seconds: 30, bonus_timer_seconds: 10, bonus_attempts_per_player: 2, point_value: 1 },
        contest: { id: 201, game_id: 101, player_count: 3, point_value: 1 },
      },
      players: [
        { user_id: 10, seat_no: 1, status: 'joined', metadata: {}, joined_at: createIso(), left_at: null, name: 'Alpha', avatar: null, phone: null, view_id: 'A10' },
        { user_id: 11, seat_no: 2, status: 'joined', metadata: {}, joined_at: createIso(), left_at: null, name: 'Beta', avatar: null, phone: null, view_id: 'B11' },
      ],
    });
  });

  harness.socket.join(sessionRoom(8208));
  const ack = await harness.socket.invoke('table:back', { source_session_id: 8208 });
  assert(ack.success === true, 'Expected table:back to succeed even with phase sync issues');
}

async function testBackSourceSessionNotFound() {
  const harness = createSocketCallbackHarness((store) => {
  });

  const ack = await harness.socket.invoke('table:back', { source_session_id: 9999 });
  assert(ack.success === false, 'Expected table:back to fail for non-existent source session');
  assert(ack.message.includes('not found'), 'Expected not found error message');
}

async function testBackPlayerNotInSourceSession() {
  const harness = createSocketCallbackHarness((store) => {
    const source = buildCompletedSourceSession(8209);
    source.players = [
      { user_id: 11, seat_no: 1, status: 'joined', metadata: {}, joined_at: createIso(), left_at: null, name: 'Beta', avatar: null, phone: null, view_id: 'B11' },
      { user_id: 12, seat_no: 2, status: 'joined', metadata: {}, joined_at: createIso(), left_at: null, name: 'Gamma', avatar: null, phone: null, view_id: 'C12' },
    ];
    addSession(store, source.session, source.players);
  });

  const ack = await harness.socket.invoke('table:back', { source_session_id: 8209 });
  assert(ack.success === false, 'Expected table:back to fail for player not in source session');
  assert(ack.message.includes('not found'), 'Expected player not found error message');
}

async function testBackInvalidSessionId() {
  const harness = createSocketCallbackHarness((store) => {});

  const ack = await harness.socket.invoke('table:back', { source_session_id: 'invalid' });
  assert(ack.success === false, 'Expected table:back to fail for invalid session_id');
  assert(ack.message.includes('required'), 'Expected validation error message');
}

async function testBackContinuationWithOnlyOnePlayer() {
  const harness = createSocketCallbackHarness((store) => {
    const source = buildCompletedSourceSession(8210);
    source.session.metadata.post_result_left_user_ids = [11, 12];
    addSession(store, source.session, source.players);
    
    // When only one player is eligible, continuation handler returns fallback
    store.continuationHandler = async () => ({
      fallbackToMatchmaking: true,
      reused: false,
      eligibleUserIds: [10],
      session: null,
    });
    
    store.createSessionPlans.push({
      id: 9210,
      status: 'ready',
      max_players: 2,
      metadata: {
        phase: 'countdown',
        countdown: {
          sequence: 'cd-10',
          started_at: createIso(-500),
          ends_at: createIso(2500),
        },
      },
      players: [
        { user_id: 10, seat_no: 1, status: 'joined', metadata: {}, joined_at: createIso(), left_at: null, name: 'Alpha', avatar: null, phone: null, view_id: 'A10' },
      ],
    });
  });

  harness.socket.join(sessionRoom(8210));
  const ack = await harness.socket.invoke('table:back', { source_session_id: 8210 });
  assert(ack.success === true, 'Expected table:back to succeed with fallback for single player');
  assert(ack.data.fallback_to_matchmaking === true, 'Expected fallback due to insufficient players');
  assert(ack.data.transition_type === 'same_table_fallback_matchmaking', 'Expected fallback transition type');
}

async function main() {
  await testDropAndSwitchSuccess();
  await testPlayNowSuccessAndValidation();
  await testBackContinuationActiveReplay();
  await testBackFallbackToMatchmaking();
  await testLeaveTableBroadcast();
  
  // Comprehensive edge case tests
  await testBackInsufficientBalance();
  await testBackPlayerAlreadyLeft();
  await testBackSessionCreationRaceCondition();
  await testBackSocketAttachmentConflict();
  await testBackPhaseSyncCorruption();
  await testBackSourceSessionNotFound();
  await testBackPlayerNotInSourceSession();
  await testBackInvalidSessionId();
  await testBackContinuationWithOnlyOnePlayer();

  console.log('verify_transition_socket_callbacks: PASS');
}

main().catch((err) => {
  console.error('verify_transition_socket_callbacks: FAIL');
  console.error(err.stack || err.message);
  process.exit(1);
});