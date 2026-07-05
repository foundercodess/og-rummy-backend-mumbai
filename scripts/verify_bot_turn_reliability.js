#!/usr/bin/env node
/* eslint-disable no-console */

const assert = require('assert');
const path = require('path');

function loadSocketServerModule() {
  const modulePath = path.join(__dirname, '..', 'realtime', 'socketServer.js');
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function testExecuteBotTurnActionClearsPendingState() {
  const mod = loadSocketServerModule();
  const internals = mod.__testHooks;
  assert(internals, 'socketServer test exports missing');

  const sessionId = 991001;
  internals.activeBotActionBySession.set(sessionId, {
    timeoutHandle: setTimeout(() => {}, 60_000),
    turnId: 42,
    phase: 'pick',
  });

  internals.executeBotTurnAction({ to: () => ({ emit: () => {} }) }, sessionId, 42, 'pick')
    .catch(() => {});

  assert.strictEqual(
    internals.getActiveBotActionState(sessionId),
    null,
    'executeBotTurnAction should clear pending bot timer state before running'
  );
}

function testEmitBotDiscardBroadcastShape() {
  const mod = loadSocketServerModule();
  const internals = mod.__testHooks;
  const emitted = [];

  const io = {
    to: () => ({
      emit: (event, payload) => emitted.push({ event, payload }),
    }),
  };

  internals.emitBotDiscardBroadcast(
    io,
    77,
    501,
    { card_uid: 'c-1', card_id: 'H7', suit: 'hearts', rank: '7' },
    { card_uid: 'c-1', card_id: 'H7', suit: 'hearts', rank: '7' },
    { reason: 'bot_discard' }
  );

  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0].event, 'game:discard');
  assert.strictEqual(emitted[0].payload.data.user_id, 501);
  assert.strictEqual(emitted[0].payload.data.discarded_card.card_uid, 'c-1');
}

function main() {
  testExecuteBotTurnActionClearsPendingState();
  testEmitBotDiscardBroadcastShape();
  console.log('verify_bot_turn_reliability: ok');
}

main();
