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

function createExpiredTurn(turnId, userId, attemptNo = 2) {
  return {
    turn_id: turnId,
    user_id: userId,
    type: 'bonus',
    attempt_no: attemptNo,
    has_picked: false,
    started_at: new Date(Date.now() - 15000).toISOString(),
    ends_at: new Date(Date.now() - 1000).toISOString(),
    turn_timer_seconds: 10,
  };
}

function createScenarioSession({
  sessionId,
  currentTurnUserId,
  players,
  distributionPlayers,
  turnId,
}) {
  return {
    id: sessionId,
    status: 'active',
    current_turn_user_id: currentTurnUserId,
    game: {
      turn_timer_seconds: 30,
      bonus_timer_seconds: 10,
      bonus_attempts_per_player: 2,
      point_value: 0,
    },
    contest: null,
    players,
    metadata: {
      distribution: {
        wild_joker: { rank: '5', suit: 'hearts', card_uid: 'joker' },
        discard_pile: [],
        closed_deck: [],
        players: distributionPlayers,
      },
      turn: createExpiredTurn(turnId, currentTurnUserId, 2),
      turn_bonus: {
        max_attempts_per_player: 2,
        attempts_used_by_user: {
          [String(currentTurnUserId)]: 2,
        },
      },
      turn_eliminated_user_ids: [],
      turn_timeout_eliminated_user_ids: [],
    },
  };
}

function loadTimeoutHarness(session) {
  const filePath = path.join(__dirname, '..', 'realtime', 'socketServer.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const instrumented = `${source}\nmodule.exports.__test = { onTurnTimeout };`;

  const insertedEvents = [];
  const scheduledTimeouts = [];
  const noop = () => {};
  const module = { exports: {} };

  const gameplayService = {
    async getSessionState(sessionId) {
      return Number(sessionId) === session.id ? session : null;
    },
  };

  const gameSessionModel = {
    async updateSessionStatus(sessionId, status, patch = {}) {
      assert(Number(sessionId) === session.id, 'Unexpected session id in updateSessionStatus');
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

  const redisLockService = {
    async claimEventIdempotency() {
      return true;
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
        return redisLockService;
      case '../db':
        return { pool: null };
      case '../services/redis.service':
      case './socketRegistry':
      case './pregameOrchestrator':
      case './turnSchedulerBridge':
        return {};
      case './socketAuth':
        return { socketAuth: noop };
      case './socketBus':
        return { emitActiveNotices: async () => {}, setSocketIO: noop };
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
    setTimeout(fn, delay, ...args) {
      const handle = { fn, delay, args, cleared: false };
      scheduledTimeouts.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      if (handle) {
        handle.cleared = true;
      }
    },
    setInterval,
    clearInterval,
    Buffer,
  };

  vm.runInNewContext(instrumented, sandbox, { filename: filePath });

  return {
    onTurnTimeout: module.exports.__test.onTurnTimeout,
    session,
    insertedEvents,
    scheduledTimeouts,
  };
}

async function main() {
  const finishScenario = createScenarioSession({
    sessionId: 9001,
    currentTurnUserId: 11,
    turnId: 100,
    players: [
      { user_id: 11, seat_no: 1, name: 'Timed Out Player', metadata: {} },
      { user_id: 12, seat_no: 2, name: 'Winner Player', metadata: {} },
    ],
    distributionPlayers: [
      { user_id: 11, cards: [{ card_uid: 'a1', value: 10 }], submitted_groups: [] },
      { user_id: 12, cards: [{ card_uid: 'b1', value: 5 }], submitted_groups: [] },
    ],
  });
  const finishIo = createIoCapture();
  const finishHarness = loadTimeoutHarness(finishScenario);

  await finishHarness.onTurnTimeout(finishIo, finishScenario.id, 100);

  assert(finishScenario.status === 'completed', 'Expected 2-player session to be completed');
  assert(finishScenario.current_turn_user_id === 12, 'Expected remaining player to become winner');
  assert(finishScenario.metadata?.result?.winner_user_id === 12, 'Expected result winner to be uid=12');
  assert(Array.isArray(finishScenario.metadata?.turn_eliminated_user_ids), 'Expected eliminated ids to be stored');
  assert(finishScenario.metadata.turn_eliminated_user_ids.includes(11), 'Expected timed-out player to be eliminated');
  assert(Array.isArray(finishScenario.metadata?.turn_timeout_eliminated_user_ids), 'Expected timeout eliminated ids to be stored');
  assert(finishScenario.metadata.turn_timeout_eliminated_user_ids.includes(11), 'Expected timed-out player to be marked as timeout eliminated');

  const resultEvent = finishIo.emitted.find((entry) => entry.event === 'game:result');
  assert(resultEvent, 'Expected game:result to be emitted for 2-player finish');
  assert(resultEvent.payload.winner_user_id === 12, 'Expected emitted result winner to be uid=12');
  assert(resultEvent.payload.eliminated_user_ids.includes(11), 'Expected emitted result to include eliminated player');
  assert(resultEvent.payload.timeout_eliminated_user_ids.includes(11), 'Expected emitted result to include timeout eliminated player');

  const timeoutRow = resultEvent.payload.results.find((row) => row.user_id === 11);
  const winnerRow = resultEvent.payload.results.find((row) => row.user_id === 12);
  assert(timeoutRow?.player_status === 'timeout', 'Expected eliminated player status to be timeout');
  assert(timeoutRow?.status_color === '#7C3AED', 'Expected timeout player color to be #7C3AED');
  assert(winnerRow?.player_status === 'won', 'Expected remaining player status to be won');

  const completionEvent = finishHarness.insertedEvents.find((event) => event.eventType === 'game_completed_by_elimination');
  assert(completionEvent, 'Expected elimination completion event to be inserted for 2-player finish');

  const continueScenario = createScenarioSession({
    sessionId: 9002,
    currentTurnUserId: 11,
    turnId: 200,
    players: [
      { user_id: 11, seat_no: 1, name: 'Timed Out Player', metadata: {} },
      { user_id: 12, seat_no: 2, name: 'Next Player', metadata: {} },
      { user_id: 13, seat_no: 3, name: 'Third Player', metadata: {} },
    ],
    distributionPlayers: [
      { user_id: 11, cards: [{ card_uid: 'a1', value: 10 }], submitted_groups: [] },
      { user_id: 12, cards: [{ card_uid: 'b1', value: 5 }], submitted_groups: [] },
      { user_id: 13, cards: [{ card_uid: 'c1', value: 7 }], submitted_groups: [] },
    ],
  });
  const continueIo = createIoCapture();
  const continueHarness = loadTimeoutHarness(continueScenario);

  await continueHarness.onTurnTimeout(continueIo, continueScenario.id, 200);

  assert(continueScenario.status === 'active', 'Expected 3-player session to remain active');
  assert(continueScenario.current_turn_user_id === 12, 'Expected next live player to receive the turn');
  assert(!continueScenario.metadata?.result, 'Expected no final result for continuing game');
  assert(continueScenario.metadata.turn_eliminated_user_ids.includes(11), 'Expected timed-out player to be eliminated in continuing game');
  assert(continueScenario.metadata.turn_timeout_eliminated_user_ids.includes(11), 'Expected timeout elimination to be tracked in continuing game');
  assert(Number(continueScenario.metadata.turn.user_id) === 12, 'Expected metadata turn user to be uid=12');
  assert(continueScenario.metadata.turn.type === 'normal', 'Expected next turn type to reset to normal');

  const continuedTurnEvent = continueIo.emitted.find((entry) => entry.event === 'game:turn');
  assert(continuedTurnEvent, 'Expected game:turn to be emitted for continuing game');
  assert(continuedTurnEvent.payload.turn.user_id === 12, 'Expected emitted next turn user to be uid=12');
  assert(continuedTurnEvent.payload.eliminated_user_id === 11, 'Expected emitted turn payload to include eliminated user');
  assert(Array.isArray(continuedTurnEvent.payload.eliminated_user_ids), 'Expected emitted turn payload to list eliminated users');
  assert(continuedTurnEvent.payload.eliminated_user_ids.includes(11), 'Expected emitted turn payload to include timed-out user');

  const noResultEvent = continueIo.emitted.find((entry) => entry.event === 'game:result');
  assert(!noResultEvent, 'Did not expect game:result when more than one player remains');

  const autoActionEvent = continueHarness.insertedEvents.find((event) => event.eventType === 'turn_timeout_auto_action');
  assert(autoActionEvent, 'Expected timeout auto-action event for continuing game');
  assert(autoActionEvent.payload.next_turn_user_id === 12, 'Expected continuing game to move turn to uid=12');
  assert(continueHarness.scheduledTimeouts.length >= 1, 'Expected next turn timeout to be scheduled for continuing game');

  console.log('verify_timeout_elimination: PASS');
}

main().catch((err) => {
  console.error('verify_timeout_elimination: FAIL');
  console.error(err.stack || err.message);
  process.exitCode = 1;
});