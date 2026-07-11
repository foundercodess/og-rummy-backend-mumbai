#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  anticlockwiseNextTurnUserId,
  resolveNextDealFirstTurnUserId,
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

console.log('verify_next_turn_after_drop: PASS');
