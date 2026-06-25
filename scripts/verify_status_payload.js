const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadSocketServerInternals() {
  const filePath = path.join(__dirname, '..', 'realtime', 'socketServer.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const instrumented = `${source}\nmodule.exports.__test = {\n  resolvePlayerStatus,\n  resolveSubmissionStatus,\n  resolveStatusColor,\n  buildDeclarationTablePlayers\n};`;

  const module = { exports: {} };
  const noop = () => {};
  const requireStub = (request) => {
    switch (request) {
      case 'socket.io':
        return { Server: function Server() {} };
      case '@socket.io/redis-adapter':
        return { createAdapter: noop };
      case '../services/gameplay.service':
      case '../services/redisLock.service':
      case '../services/redis.service':
      case './socketRegistry':
      case './pregameOrchestrator':
      case './turnSchedulerBridge':
        return {};
      case '../models/gameSession.model':
        return {};
      case '../services/grouping.service':
        return {
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
          buildBestGrouping(cards = []) {
            return {
              groups: [],
              summary: {
                grouped_points: 0,
                ungrouped_points: cards.length,
                valid_for_declare: false,
                invalid_group_count: 1,
                all_cards_grouped: false,
              },
            };
          },
        };
      case '../db':
        return { pool: null };
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
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Buffer,
  };

  vm.runInNewContext(instrumented, sandbox, { filename: filePath });
  return module.exports.__test;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const {
    resolvePlayerStatus,
    resolveSubmissionStatus,
    resolveStatusColor,
    buildDeclarationTablePlayers,
  } = loadSocketServerInternals();

  assert(resolvePlayerStatus({ isFinal: false, submitted: false }) === 'pending', 'Expected pending player_status');
  assert(resolvePlayerStatus({ isFinal: false, submitted: true }) === 'submitted', 'Expected submitted player_status');
  assert(resolvePlayerStatus({ isFinal: true, isWinner: true }) === 'won', 'Expected won player_status');
  assert(
    resolvePlayerStatus({ isFinal: true, userId: 7, declareByUserId: 7, declarerValid: false }) === 'invalid_declaration',
    'Expected invalid_declaration player_status'
  );

  assert(resolveSubmissionStatus({ isFinal: false, submitted: false }) === 'pending', 'Expected pending submission_status');
  assert(resolveSubmissionStatus({ isFinal: false, submitted: true }) === 'submitted', 'Expected submitted submission_status');
  assert(resolveSubmissionStatus({ isFinal: true, submitted: true, submissionMode: 'manual' }) === 'manual', 'Expected manual submission_status');
  assert(resolveSubmissionStatus({ isFinal: true, submitted: false }) === 'not_submitted', 'Expected not_submitted submission_status');

  assert(resolveStatusColor('pending') === '#F59E0B', 'Expected pending color');
  assert(resolveStatusColor('submitted') === '#2563EB', 'Expected submitted color');
  assert(resolveStatusColor('won') === '#16A34A', 'Expected won color');
  assert(resolveStatusColor('lost') === '#DC2626', 'Expected lost color');
  assert(resolveStatusColor('invalid_declaration') === '#EA580C', 'Expected invalid declaration color');
  assert(resolveStatusColor('dropped') === '#6B7280', 'Expected dropped color');
  assert(resolveStatusColor('timeout') === '#7C3AED', 'Expected timeout color');

  const session = {
    players: [
      { user_id: 11, seat_no: 1, name: 'Ashu', phone: '98xxxx', avatar: null, view_id: '4235281' },
      { user_id: 12, seat_no: 2, name: 'P2', phone: null, avatar: null, view_id: null },
    ],
  };
  const distribution = {
    wild_joker: { rank: '5' },
    players: [
      { user_id: 11, cards: [{ card_uid: 'c1' }], submitted_groups: [{ group_id: 1, cards: ['c1'] }] },
      { user_id: 12, cards: [{ card_uid: 'c2' }], submitted_groups: [] },
    ],
  };
  const state = {
    declareByUserId: 11,
    responses: new Map([
      [11, { auto: false, groups: [{ group_id: 1, cards: ['c1'] }] }],
    ]),
  };

  const declaringRows = buildDeclarationTablePlayers({
    session,
    distribution,
    state,
    isFinal: false,
  });

  assert(declaringRows[0].player_status === 'submitted', 'Expected submitted row status during declaration');
  assert(declaringRows[0].status_color === '#2563EB', 'Expected submitted row color during declaration');
  assert(declaringRows[1].player_status === 'pending', 'Expected pending row status during declaration');
  assert(declaringRows[1].status_color === '#F59E0B', 'Expected pending row color during declaration');

  const finalRows = buildDeclarationTablePlayers({
    session,
    distribution,
    state,
    isFinal: true,
    winnerUserId: 12,
    declarerValid: false,
    finalizedResults: [
      {
        user_id: 11,
        seat_no: 1,
        points: 80,
        grouped_points: 1,
        ungrouped_points: 0,
        valid_for_declare: false,
        invalid_group_count: 1,
        all_cards_grouped: false,
        submission_mode: 'manual',
        player_status: 'invalid_declaration',
        status_color: '#EA580C',
        dropped: false,
        is_winner: false,
      },
      {
        user_id: 12,
        seat_no: 2,
        points: 0,
        grouped_points: 0,
        ungrouped_points: 0,
        valid_for_declare: false,
        invalid_group_count: 0,
        all_cards_grouped: false,
        submission_mode: 'auto',
        player_status: 'won',
        status_color: '#16A34A',
        dropped: false,
        is_winner: true,
      },
    ],
  });

  assert(finalRows[0].player_status === 'invalid_declaration', 'Expected invalid declarer in final rows');
  assert(finalRows[0].status_color === '#EA580C', 'Expected invalid declarer color in final rows');
  assert(finalRows[1].player_status === 'won', 'Expected winner status in final rows');
  assert(finalRows[1].status_color === '#16A34A', 'Expected winner color in final rows');

  const timeoutRows = buildDeclarationTablePlayers({
    session,
    distribution,
    state: { responses: new Map(), declareByUserId: null },
    isFinal: true,
    winnerUserId: 12,
    finalizedResults: [
      {
        user_id: 11,
        seat_no: 1,
        points: 40,
        grouped_points: 0,
        ungrouped_points: 40,
        valid_for_declare: false,
        invalid_group_count: 1,
        all_cards_grouped: false,
        submission_mode: 'auto',
        player_status: 'timeout',
        status_color: '#7C3AED',
        dropped: false,
        is_winner: false,
      },
      {
        user_id: 12,
        seat_no: 2,
        points: 0,
        grouped_points: 0,
        ungrouped_points: 0,
        valid_for_declare: false,
        invalid_group_count: 0,
        all_cards_grouped: false,
        submission_mode: 'auto',
        player_status: 'won',
        status_color: '#16A34A',
        dropped: false,
        is_winner: true,
      },
    ],
  });

  assert(timeoutRows[0].player_status === 'timeout', 'Expected timeout status in elimination-style rows');
  assert(timeoutRows[0].status_color === '#7C3AED', 'Expected timeout color in elimination-style rows');

  console.log('verify_status_payload: PASS');
}

main();