#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  anticlockwiseNextTurnUserId,
  resolveNextDealFirstTurnUserId,
  resolveLastTurnUserId,
  filterTurnEligibleAtDealStart,
} = require('../realtime/turnRotation');

const active = [
  { user_id: 1, seat_no: 1 },
  { user_id: 3, seat_no: 3 },
  { user_id: 5, seat_no: 5 },
];

assert.strictEqual(
  anticlockwiseNextTurnUserId(active, 3, { currentSeatNo: 3 }),
  5,
  'After seat-3 drop, turn should go anticlockwise (higher seat) to seat 5'
);

assert.strictEqual(
  anticlockwiseNextTurnUserId(
    active.filter((p) => p.user_id !== 1),
    1,
    { currentSeatNo: 1 }
  ),
  3,
  'After seat-1 drop, turn should go to the next higher active seat 3'
);

assert.strictEqual(
  anticlockwiseNextTurnUserId(active, 1),
  3,
  'Normal anticlockwise rotation from seat 1 goes to seat 3'
);

assert.strictEqual(
  resolveNextDealFirstTurnUserId(
    { metadata: { first_turn_user_id: 3 } },
    active
  ),
  5,
  'Next deal opener rotates anticlockwise from previous deal opener'
);

const twoPlayer = [
  { user_id: 10, seat_no: 1 },
  { user_id: 20, seat_no: 2 },
];

assert.strictEqual(
  resolveNextDealFirstTurnUserId(
    { metadata: { first_turn_user_id: 10 } },
    twoPlayer
  ),
  20,
  '2-player next deal opener alternates from previous opener'
);

assert.strictEqual(
  resolveNextDealFirstTurnUserId(
    { metadata: { first_turn_user_id: 20 } },
    twoPlayer
  ),
  10,
  '2-player next deal opener alternates back'
);

assert.strictEqual(
  resolveLastTurnUserId(twoPlayer, 10),
  20,
  '2-player last-turn badge is the non-opener'
);

assert.strictEqual(
  resolveLastTurnUserId(active, 3),
  1,
  'Last-turn badge is anticlockwise previous seat from opener'
);

const withDrop = filterTurnEligibleAtDealStart(active, { poolEliminatedUserIds: [5] });
assert.strictEqual(withDrop.length, 2, 'Pool eliminated players excluded from deal-start turn roster');
assert.strictEqual(
  resolveLastTurnUserId(withDrop, 1),
  3,
  'Last-turn badge uses deal-start roster only'
);

console.log('verify_next_turn_after_drop: PASS');
