#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { __testHooks } = require('../realtime/socketServer');

const { evaluateAdminProfitProtection } = __testHooks;

function run() {
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

  console.log('Split profit protection checks passed');
}

run();
