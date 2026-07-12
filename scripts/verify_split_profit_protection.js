#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { __testHooks } = require('../realtime/socketServer');

const {
  evaluateAdminProfitProtection,
  resolvePoolSplitDropsRemaining,
  buildPoolSplitPlan,
  shouldBotAcceptSplitOffer,
} = __testHooks;

function run() {
  assert.strictEqual(resolvePoolSplitDropsRemaining(101, 0), 5, '101: score 0 → 5 drops');
  assert.strictEqual(resolvePoolSplitDropsRemaining(101, 20), 4, '101: score 20 → 4 drops');
  assert.strictEqual(resolvePoolSplitDropsRemaining(201, 0), 8, '201: score 0 → 8 drops');
  assert.strictEqual(resolvePoolSplitDropsRemaining(201, 200), 0, '201: score 200 → 0 drops');

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
