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
    sockets: {
      adapter: {
        rooms: new Map(),
      },
    },
    to(room) {
      return {
        emit(event, payload) {
          emitted.push({ room, event, payload });
        },
      };
    },
  };
}

function resolveConnectionStatus(player = {}) {
  if (player.status === 'disconnected') return 'disconnected';
  if (player.metadata && player.metadata.connection_status === 'disconnected') return 'disconnected';
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



function hydrateSessionPlayers(players = []) {
  return players.map((player) => ({
    ...player,
    metadata: player.metadata || {},
    player_status: resolvePlayerStatus(player),
    connection_status: resolveConnectionStatus(player),
  }));
}

function createSession() {
  return {
    id: 9101,
    status: 'active',
    current_turn_user_id: 21,
    game: {
      turn_timer_seconds: 30,
      bonus_timer_seconds: 10,
      bonus_attempts_per_player: 2,
      point_value: 0,
    },
    contest: null,
    players: hydrateSessionPlayers([
      { user_id: 21, seat_no: 1, name: 'Drop Player', status: 'joined', metadata: {} },
      { user_id: 22, seat_no: 2, name: 'Winner Player', status: 'joined', metadata: {} },
    ]),
    metadata: {
      distribution: {
        wild_joker: { rank: '5', suit: 'hearts', card_uid: 'joker' },
        discard_pile: [],
        closed_deck: [],
        players: [
          {
            user_id: 21,
            cards: [{ card_uid: 'c1', value: 10 }],
            submitted_groups: [],
          },
          {
            user_id: 22,
            cards: [{ card_uid: 'd1', value: 2 }],
            submitted_groups: [],
          },
        ],
      },
      turn: {
        turn_id: 500,
        user_id: 21,
        type: 'normal',
        attempt_no: 0,
        has_picked: false,
        started_at: new Date(Date.now() - 5000).toISOString(),
        ends_at: new Date(Date.now() + 25000).toISOString(),
        turn_timer_seconds: 30,
      },
      turn_bonus: {
        max_attempts_per_player: 2,
        attempts_used_by_user: {},
      },
      turn_eliminated_user_ids: [],
      turn_timeout_eliminated_user_ids: [],
    },
  };
}

function loadPresenceHarness(session) {
  const filePath = path.join(__dirname, '..', 'realtime', 'socketServer.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const instrumented = `${source}\nmodule.exports.__test = { setPlayerConnectionState, dropPlayerFromSession };`;

  const insertedEvents = [];
  const module = { exports: {} };
  const noop = () => {};

  const gameplayService = {
    async getSessionState(sessionId) {
      if (Number(sessionId) !== session.id) return null;
      session.players = hydrateSessionPlayers(session.players);
      return session;
    },
  };

  const gameSessionModel = {
    async findPlayer(sessionId, userId) {
      assert(Number(sessionId) === session.id, 'Unexpected session in findPlayer');
      return session.players.find((player) => Number(player.user_id) === Number(userId)) || null;
    },
    async updatePlayerState(sessionId, userId, fields = {}) {
      assert(Number(sessionId) === session.id, 'Unexpected session in updatePlayerState');
      session.players = session.players.map((player) => {
        if (Number(player.user_id) !== Number(userId)) return player;
        return {
          ...player,
          status: Object.prototype.hasOwnProperty.call(fields, 'status') ? fields.status : player.status,
          left_at: Object.prototype.hasOwnProperty.call(fields, 'leftAt') ? fields.leftAt : player.left_at,
          metadata: Object.prototype.hasOwnProperty.call(fields, 'metadata') ? fields.metadata : player.metadata,
        };
      });
      return this.findPlayer(sessionId, userId);
    },
    async updateSessionStatus(sessionId, status, patch = {}) {
      assert(Number(sessionId) === session.id, 'Unexpected session in updateSessionStatus');
      session.status = status;
      if (Object.prototype.hasOwnProperty.call(patch, 'currentTurnUserId')) {
        session.current_turn_user_id = patch.currentTurnUserId;
      }
      if (patch.metadata) {
        session.metadata = patch.metadata;
      }
      if (patch.endedAt) {
        session.ended_at = patch.endedAt;
      }
      return session;
    },
    async insertEvent(event) {
      insertedEvents.push(event);
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

  const requireStub = (request) => {
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
        return groupingService;
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
      case './turnSchedulerBridge':
        return {};
      default:
        return require(request);
    }
  };

  const sandbox = {
    module,
    exports: module.exports,
    require: requireStub,
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
    setPlayerConnectionState: module.exports.__test.setPlayerConnectionState,
    dropPlayerFromSession: module.exports.__test.dropPlayerFromSession,
    insertedEvents,
  };
}

async function main() {
  const session = createSession();
  const io = createIoCapture();
  const harness = loadPresenceHarness(session);

  const disconnectOutcome = await harness.setPlayerConnectionState(io, session.id, 21, false, 'socket_disconnect');
  assert(disconnectOutcome.changed === true, 'Expected disconnect presence update to change state');
  const disconnectedPlayer = disconnectOutcome.session.players.find((player) => player.user_id === 21);
  assert(disconnectedPlayer.status === 'disconnected', 'Expected player row status to become disconnected');
  assert(disconnectedPlayer.connection_status === 'disconnected', 'Expected connection_status=disconnected');
  assert(disconnectedPlayer.player_status === 'disconnected', 'Expected derived player_status=disconnected');
  assert(disconnectedPlayer.metadata?.is_connected === false, 'Expected metadata.is_connected=false');
  assert(io.emitted.some((entry) => entry.event === 'player:status' && entry.payload.player_status === 'disconnected'), 'Expected player:status disconnected event');
  assert(io.emitted.some((entry) => entry.event === 'player:status' && entry.payload.metadata?.is_connected === false), 'Expected player:status metadata.is_connected=false');
  assert(io.emitted.some((entry) => entry.event === 'session:state'), 'Expected session:state broadcast on disconnect');

  const reconnectOutcome = await harness.setPlayerConnectionState(io, session.id, 21, true, 'session_join');
  assert(reconnectOutcome.changed === true, 'Expected reconnect to change presence state');
  const reconnectedPlayer = reconnectOutcome.session.players.find((player) => player.user_id === 21);
  assert(reconnectedPlayer.status === 'joined', 'Expected player row status to return to joined');
  assert(reconnectedPlayer.connection_status === 'connected', 'Expected connection_status=connected');
  assert(reconnectedPlayer.player_status === 'active', 'Expected derived player_status=active');
  assert(reconnectedPlayer.metadata?.is_connected === true, 'Expected metadata.is_connected=true after reconnect');

  const dropOutcome = await harness.dropPlayerFromSession(io, session.id, 21);
  assert(session.status === 'completed', 'Expected 2-player drop to finish the session');
  assert(dropOutcome.result, 'Expected drop flow to finalize the game');
  assert(dropOutcome.result.winner_user_id === 22, 'Expected remaining player to win after drop');
  const droppedResult = dropOutcome.result.results.find((row) => row.user_id === 21);
  assert(droppedResult.player_status === 'dropped', 'Expected dropped player to remain dropped in final result');
  assert(droppedResult.status_color === '#6B7280', 'Expected dropped result color to be gray');
  assert(io.emitted.some((entry) => entry.event === 'game:result'), 'Expected game:result after final drop');
  assert(harness.insertedEvents.some((event) => event.eventType === 'player_disconnected'), 'Expected player_disconnected event');
  assert(harness.insertedEvents.some((event) => event.eventType === 'player_reconnected' || event.eventType === 'player_connected'), 'Expected player reconnect/connect event');
  assert(harness.insertedEvents.some((event) => event.eventType === 'player_dropped'), 'Expected player_dropped event');

  console.log('verify_player_presence: PASS');
}

main().catch((err) => {
  console.error('verify_player_presence: FAIL');
  console.error(err);
  process.exitCode = 1;
});
