#!/usr/bin/env node
'use strict';

const assert = require('assert');

function nextTurnUserId(players, currentUserId, options = {}) {
  const seats = [...(players || [])].sort((a, b) => a.seat_no - b.seat_no);
  if (seats.length === 0) return null;

  const currentId = Number(currentUserId);
  const idx = seats.findIndex((p) => Number(p.user_id) === currentId);
  if (idx >= 0) {
    return seats[(idx + 1) % seats.length].user_id;
  }

  const pivotSeat = Number(options.currentSeatNo);
  if (Number.isFinite(pivotSeat)) {
    const next = seats.find((p) => Number(p.seat_no) > pivotSeat);
    return (next ?? seats[0]).user_id;
  }

  return seats[0].user_id;
}

const active = [
  { user_id: 1, seat_no: 1 },
  { user_id: 3, seat_no: 3 },
  { user_id: 5, seat_no: 5 },
];

assert.strictEqual(
  nextTurnUserId(active, 3, { currentSeatNo: 3 }),
  5,
  'After seat-3 drop, turn should go to seat 5'
);

assert.strictEqual(
  nextTurnUserId(
    active.filter((p) => p.user_id !== 1),
    1,
    { currentSeatNo: 1 }
  ),
  3,
  'After seat-1 drop, turn should go to seat 3'
);

assert.strictEqual(nextTurnUserId(active, 1), 3, 'Normal rotation from seat 1');

console.log('verify_next_turn_after_drop: PASS');
