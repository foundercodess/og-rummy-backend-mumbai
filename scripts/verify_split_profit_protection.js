#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { __testHooks } = require('../realtime/socketServer');

const {
  evaluateAdminProfitProtection,
  resolvePoolSplitDropsRemaining,
  resolvePoolSplitWeight,
  buildPoolSplitPlan,
  shouldBotAcceptSplitOffer,
} = __testHooks;

function run() {
  // Legacy drops-remaining helper (still used by 201 / rollback path).
  assert.strictEqual(resolvePoolSplitDropsRemaining(101, 0), 5, '101 drops: score 0 → 5');
  assert.strictEqual(resolvePoolSplitDropsRemaining(101, 20), 4, '101 drops: score 20 → 4');
  assert.strictEqual(resolvePoolSplitDropsRemaining(201, 0), 8, '201: score 0 → 8 drops');
  assert.strictEqual(resolvePoolSplitDropsRemaining(201, 200), 0, '201: score 200 → 0 drops');

  // Client 101 bracket weights (default POOL_SPLIT_WEIGHT_MODEL=brackets).
  const bracketCases = [
    [0, 5], [20, 5], [21, 4], [40, 4], [41, 3], [60, 3],
    [61, 2], [80, 2], [81, 1], [100, 1], [101, 0],
  ];
  for (const [score, expected] of bracketCases) {
    assert.strictEqual(
      resolvePoolSplitWeight(101, score),
      expected,
      `101 brackets: score ${score} → ${expected}`
    );
  }

  // 201 unchanged (drops-remaining; score 0 → 8, near limit → 1 floor).
  assert.strictEqual(resolvePoolSplitWeight(201, 0), 8, '201 weight: score 0 → 8');
  assert.strictEqual(resolvePoolSplitWeight(201, 200), 1, '201 weight: score 200 active floor → 1');

  const sessionWithBot = {
    contest: { entry: 50 },
    players: [
      { user_id: 101, metadata: { is_bot: false } },
      { user_id: 102, metadata: { is_bot: false } },
      { user_id: 9001, metadata: { is_bot: true } },
    ],
  };

  const blocked = evaluateAdminProfitProtection(
    sessionWithBot,
    [
      { user_id: 101, split_amount: 60 },
      { user_id: 102, split_amount: 70 },
      { user_id: 9001, split_amount: 20 },
    ],
    { participantUserIds: [101, 102, 9001] }
  );
  assert.strictEqual(blocked.decision, 'REJECT', 'must reject when real payout exceeds contribution with bot present');

  const allowed = evaluateAdminProfitProtection(
    sessionWithBot,
    [
      { user_id: 101, split_amount: 45 },
      { user_id: 102, split_amount: 50 },
      { user_id: 9001, split_amount: 55 },
    ],
    { participantUserIds: [101, 102, 9001] }
  );
  assert.strictEqual(allowed.decision, 'ACCEPT', 'must accept when real payout is within contribution');

  const sessionWithoutBot = {
    contest: { entry: 50 },
    players: [
      { user_id: 201, metadata: { is_bot: false } },
      { user_id: 202, metadata: { is_bot: false } },
    ],
  };

  const noBot = evaluateAdminProfitProtection(
    sessionWithoutBot,
    [
      { user_id: 201, split_amount: 100 },
      { user_id: 202, split_amount: 100 },
    ],
    { participantUserIds: [201, 202] }
  );
  assert.strictEqual(noBot.decision, 'ACCEPT', 'must skip protection when no bot participates');
  assert.strictEqual(noBot.reason, 'ADMIN_PROFIT_PROTECTION_SKIPPED_NO_BOT');

  // 6-max human vs bot: option stays visible even when admin would lose.
  const sixMaxSession = {
    max_players: 6,
    contest: { entry: 1 },
    game: { name: '201 Pool' },
    metadata: { pool_split_enabled: true },
    players: [
      { user_id: 1, seat_no: 1, status: 'joined', name: 'human', metadata: { is_bot: false } },
      { user_id: 2, seat_no: 2, status: 'eliminated', name: 'botA', metadata: { is_bot: true } },
      { user_id: 3, seat_no: 3, status: 'eliminated', name: 'botB', metadata: { is_bot: true } },
      { user_id: 4, seat_no: 4, status: 'eliminated', name: 'botC', metadata: { is_bot: true } },
      { user_id: 5, seat_no: 5, status: 'eliminated', name: 'botD', metadata: { is_bot: true } },
      { user_id: 6, seat_no: 6, status: 'joined', name: 'botFinal', metadata: { is_bot: true } },
    ],
  };
  const sixMaxPlan = buildPoolSplitPlan(
    sixMaxSession,
    {
      poolLimit: 201,
      scoresByUser: { '1': 200, '6': 200 },
      eliminatedUserIds: [2, 3, 4, 5],
      activeUserIds: [1, 6],
      currentRoundNo: 12,
      nextRoundNo: 13,
    },
    { status: 'round_completed' }
  );
  assert.strictEqual(sixMaxPlan.can_split, true, '6-max must show split even if admin loss');
  assert.strictEqual(
    sixMaxPlan.admin_profit_protection?.decision,
    'REJECT',
    'protection still flags admin loss for bots'
  );
  assert.strictEqual(
    shouldBotAcceptSplitOffer(sixMaxSession, {
      rows: sixMaxPlan.rows,
      eligible_user_ids: sixMaxPlan.active_user_ids,
    }, 6),
    false,
    'bot must reject when admin would lose'
  );

  // 2-max with bot: split option allowed; bot decides by admin profit.
  const twoMaxSession = {
    max_players: 2,
    contest: { entry: 10 },
    game: { name: '101 Pool' },
    metadata: { pool_split_enabled: true },
    players: [
      { user_id: 11, seat_no: 1, status: 'joined', name: 'human', metadata: { is_bot: false } },
      { user_id: 12, seat_no: 2, status: 'joined', name: 'bot', metadata: { is_bot: true } },
    ],
  };
  const twoMaxPlan = buildPoolSplitPlan(
    twoMaxSession,
    {
      poolLimit: 101,
      scoresByUser: { '11': 80, '12': 80 },
      eliminatedUserIds: [],
      activeUserIds: [11, 12],
      currentRoundNo: 4,
      nextRoundNo: 5,
    },
    { status: 'round_completed' }
  );
  assert.strictEqual(twoMaxPlan.can_split, true, '2-max with bot must show split');
  assert.strictEqual(
    shouldBotAcceptSplitOffer(twoMaxSession, {
      rows: twoMaxPlan.rows,
      eligible_user_ids: twoMaxPlan.active_user_ids,
    }, 12),
    twoMaxPlan.admin_profit_protection?.decision === 'ACCEPT',
    '2-max bot follows admin profit decision'
  );

  // Client 2-player example: A=15 (w5), B=72 (w2) → 5:2 ≈ 71.43% : 28.57%
  const ratioSession = {
    max_players: 6,
    contest: { entry: 100 },
    game: { name: '101 Pool' },
    metadata: { pool_split_enabled: true },
    players: [
      { user_id: 31, seat_no: 1, status: 'joined', name: 'A', metadata: { is_bot: false } },
      { user_id: 32, seat_no: 2, status: 'joined', name: 'B', metadata: { is_bot: false } },
      { user_id: 33, seat_no: 3, status: 'eliminated', name: 'C', metadata: { is_bot: false } },
      { user_id: 34, seat_no: 4, status: 'eliminated', name: 'D', metadata: { is_bot: false } },
    ],
  };
  const ratioPlan = buildPoolSplitPlan(
    ratioSession,
    {
      poolLimit: 101,
      scoresByUser: { '31': 15, '32': 72, '33': 110, '34': 120 },
      eliminatedUserIds: [33, 34],
      activeUserIds: [31, 32],
      currentRoundNo: 5,
      nextRoundNo: 6,
    },
    { status: 'round_completed' }
  );
  assert.strictEqual(ratioPlan.can_split, true, '2-player 101 split offered');
  const rowA = ratioPlan.rows.find((r) => r.user_id === 31);
  const rowB = ratioPlan.rows.find((r) => r.user_id === 32);
  assert.strictEqual(rowA.split_weight, 5, 'score 15 → weight 5');
  assert.strictEqual(rowB.split_weight, 2, 'score 72 → weight 2');
  assert.strictEqual(rowA.drops_remaining, 5, 'UI drops_remaining mirrors weight');
  const total = ratioPlan.total_split_amount;
  assert.ok(total > 0, 'prize pool positive');
  assert.strictEqual(rowA.split_amount, Math.round((total * 5) / 7 * 100) / 100, 'A gets 5/7 of pool');
  assert.strictEqual(
    Math.round((rowA.split_amount + rowB.split_amount) * 100) / 100,
    total,
    'split amounts sum to prize pool'
  );

  // Client 3-player example: weights 5:4:3
  const threeSession = {
    max_players: 6,
    contest: { entry: 50 },
    game: { name: '101 Pool' },
    metadata: { pool_split_enabled: true },
    players: [
      { user_id: 41, seat_no: 1, status: 'joined', metadata: { is_bot: false } },
      { user_id: 42, seat_no: 2, status: 'joined', metadata: { is_bot: false } },
      { user_id: 43, seat_no: 3, status: 'joined', metadata: { is_bot: false } },
    ],
  };
  const threePlan = buildPoolSplitPlan(
    threeSession,
    {
      poolLimit: 101,
      scoresByUser: { '41': 10, '42': 30, '43': 50 },
      eliminatedUserIds: [],
      activeUserIds: [41, 42, 43],
    },
    { status: 'round_completed' }
  );
  assert.strictEqual(threePlan.can_split, true, '3-player split offered');
  const w = threePlan.rows.map((r) => r.split_weight).sort((a, b) => b - a);
  assert.deepStrictEqual(w, [5, 4, 3], '3-player weights 5:4:3');

  // No split with 4 actives.
  const fourPlan = buildPoolSplitPlan(
    {
      ...threeSession,
      players: [
        ...threeSession.players,
        { user_id: 44, seat_no: 4, status: 'joined', metadata: { is_bot: false } },
      ],
    },
    {
      poolLimit: 101,
      scoresByUser: { '41': 10, '42': 20, '43': 30, '44': 40 },
      eliminatedUserIds: [],
      activeUserIds: [41, 42, 43, 44],
    },
    { status: 'round_completed' }
  );
  assert.strictEqual(fourPlan.can_split, false, '4 actives → no split');
  assert.strictEqual(fourPlan.reason, 'active_players_out_of_range');

  // Profitable for admin → bot accepts.
  const profitableSession = {
    max_players: 2,
    contest: { entry: 50 },
    game: { name: '101 Pool' },
    metadata: { pool_split_enabled: true },
    players: [
      { user_id: 21, seat_no: 1, status: 'joined', metadata: { is_bot: false } },
      { user_id: 22, seat_no: 2, status: 'joined', metadata: { is_bot: true } },
    ],
  };
  assert.strictEqual(
    shouldBotAcceptSplitOffer(profitableSession, {
      eligible_user_ids: [21, 22],
      rows: [
        { user_id: 21, split_amount: 20 },
        { user_id: 22, split_amount: 68 },
      ],
    }, 22),
    true,
    'bot accepts when real payout is within contribution'
  );

  console.log('Split profit protection checks passed');
}

run();
