'use strict';

const assert = require('assert');
const {
  LEGACY_DEPOSIT_COMMISSION_PERCENT,
  DEFAULT_WINNING_COMMISSION_PERCENT,
  normalizeWinningCommissionPercent,
  computeCommissionForDebitSplit,
  computeFlatCommission,
  computeCommissionForDebitSplits,
  buildCommissionMetaFromSplit,
} = require('../services/gameCommission.service');
const { computeWalletDebitSplit } = require('../services/walletDebitSplit');

function almostEqual(a, b, label) {
  assert.strictEqual(Number(a), Number(b), label);
}

// Defaults / clamps
assert.strictEqual(normalizeWinningCommissionPercent(null), 12);
assert.strictEqual(normalizeWinningCommissionPercent(undefined), 12);
assert.strictEqual(normalizeWinningCommissionPercent(-1), 0);
assert.strictEqual(normalizeWinningCommissionPercent(15), 12);
assert.strictEqual(normalizeWinningCommissionPercent(8.5), 8.5);
assert.strictEqual(DEFAULT_WINNING_COMMISSION_PERCENT, 12);
assert.strictEqual(LEGACY_DEPOSIT_COMMISSION_PERCENT, 12);

// Flat at 12% matches legacy total * 0.12
almostEqual(computeFlatCommission(100, 12), 12, 'flat 12% of 100');
almostEqual(computeFlatCommission(250, 12), 30, 'flat 12% of 250');
almostEqual(computeFlatCommission(100, 8), 8, 'flat 8% of 100');

// Deposit-only debit: always 12% even if winning percent is lower
{
  const split = computeWalletDebitSplit({ deposit: 100, released_bonus: 0, withdrawable: 0 }, 50);
  almostEqual(split.debitFromDeposit, 50, 'deposit debit amount');
  almostEqual(computeCommissionForDebitSplit(split, 8), 6, 'deposit portion stays at 12%');
  almostEqual(computeCommissionForDebitSplit(split, 12), 6, 'deposit portion at default 12%');
}

// Winning-only debit: uses admin winning percent
{
  const split = computeWalletDebitSplit({ deposit: 0, released_bonus: 0, withdrawable: 100 }, 50);
  almostEqual(split.debitFromWithdrawable, 50, 'winning debit amount');
  almostEqual(computeCommissionForDebitSplit(split, 12), 6, 'winning at 12%');
  almostEqual(computeCommissionForDebitSplit(split, 8), 4, 'winning at 8%');
}

// Mixed debit: deposit 30 + winning 20 at winning%=8 → 30*0.12 + 20*0.08 = 3.6 + 1.6 = 5.2
{
  const split = computeWalletDebitSplit({ deposit: 30, released_bonus: 0, withdrawable: 100 }, 50);
  almostEqual(split.debitFromDeposit, 30, 'mixed deposit');
  almostEqual(split.debitFromWithdrawable, 20, 'mixed winning');
  almostEqual(computeCommissionForDebitSplit(split, 8), 5.2, 'mixed commission');
  // At winning%=12: identical to flat 12% on 50
  almostEqual(computeCommissionForDebitSplit(split, 12), 6, 'mixed at 12 equals flat');
  almostEqual(computeFlatCommission(50, 12), 6, 'flat check');
}

// Identity: when winning%=12, any mix equals flat 12% of total
{
  const cases = [
    { deposit: 100, released_bonus: 0, withdrawable: 0, amount: 80 },
    { deposit: 0, released_bonus: 0, withdrawable: 100, amount: 80 },
    { deposit: 10, released_bonus: 20, withdrawable: 70, amount: 80 },
    { deposit: 5, released_bonus: 5, withdrawable: 5, amount: 12 },
  ];
  for (const c of cases) {
    const split = computeWalletDebitSplit(c, c.amount);
    const fromSplit = computeCommissionForDebitSplit(split, 12);
    const flat = computeFlatCommission(split.actualDebit, 12);
    almostEqual(fromSplit, flat, `identity deposit=${c.deposit} released=${c.released_bonus} win=${c.withdrawable}`);
  }
}

// Aggregate splits
{
  const a = computeWalletDebitSplit({ deposit: 100, released_bonus: 0, withdrawable: 0 }, 100);
  const b = computeWalletDebitSplit({ deposit: 0, released_bonus: 0, withdrawable: 100 }, 100);
  almostEqual(computeCommissionForDebitSplits([a, b], 12), 24, 'two entries at 12');
  almostEqual(computeCommissionForDebitSplits([a, b], 8), 20, 'deposit 12 + winning 8');
}

// Meta builder
{
  const split = computeWalletDebitSplit({ deposit: 10, released_bonus: 5, withdrawable: 40 }, 40);
  const meta = buildCommissionMetaFromSplit(split, 10);
  assert.strictEqual(meta.deposit_commission_percent, 12);
  assert.strictEqual(meta.winning_commission_percent, 10);
  assert.ok(meta.commission_amount >= 0);
}

// walletDebitSplit exposes debit parts
{
  const split = computeWalletDebitSplit({ deposit: 1, released_bonus: 2, withdrawable: 3 }, 5);
  assert.strictEqual(split.debitFromDeposit, 1);
  assert.strictEqual(split.debitFromReleased, 2);
  assert.strictEqual(split.debitFromWithdrawable, 2);
}

console.log('verify_game_commission: PASS');
