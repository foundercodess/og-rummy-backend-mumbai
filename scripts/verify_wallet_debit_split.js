const assert = require('assert');
const { computeWalletDebitSplit, roundCurrency } = require('../services/walletDebitSplit');

function run(label, wallet, amount, expect) {
  const got = computeWalletDebitSplit(wallet, amount);
  try {
    assert.strictEqual(got.available, expect.available, `${label} available`);
    assert.strictEqual(got.actualDebit, expect.actualDebit, `${label} actualDebit`);
    assert.strictEqual(got.nextDeposit, expect.nextDeposit, `${label} nextDeposit`);
    assert.strictEqual(got.nextReleasedBonus, expect.nextReleasedBonus, `${label} nextReleasedBonus`);
    assert.strictEqual(got.nextWithdrawable, expect.nextWithdrawable, `${label} nextWithdrawable`);
  } catch (e) {
    console.error(label, 'got', got, 'expect', expect);
    throw e;
  }
}

// All from deposit
run('deposit-only', { deposit: 50, released_bonus: 30, withdrawable: 20 }, 40, {
  available: 100,
  actualDebit: 40,
  nextDeposit: 10,
  nextReleasedBonus: 30,
  nextWithdrawable: 20,
});

// Deposit then released
run('deposit-then-released', { deposit: 10, released_bonus: 25, withdrawable: 5 }, 30, {
  available: 40,
  actualDebit: 30,
  nextDeposit: 0,
  nextReleasedBonus: 5,
  nextWithdrawable: 5,
});

// Full chain deposit → released → withdrawable (8 of 11 from withdrawable)
run('three-bucket', { deposit: 5, released_bonus: 7, withdrawable: 11 }, 20, {
  available: 23,
  actualDebit: 20,
  nextDeposit: 0,
  nextReleasedBonus: 0,
  nextWithdrawable: 3,
});

// Capped when amount exceeds spendable
run('capped-debit', { deposit: 1, released_bonus: 1, withdrawable: 1 }, 100, {
  available: 3,
  actualDebit: 3,
  nextDeposit: 0,
  nextReleasedBonus: 0,
  nextWithdrawable: 0,
});

// Zero amount
run('zero-amount', { deposit: 10, released_bonus: 0, withdrawable: 0 }, 0, {
  available: 10,
  actualDebit: 0,
  nextDeposit: 10,
  nextReleasedBonus: 0,
  nextWithdrawable: 0,
});

// Released + withdrawable only (no deposit): 15 from released, 5 from withdrawable
run('no-deposit', { deposit: 0, released_bonus: 15, withdrawable: 10 }, 20, {
  available: 25,
  actualDebit: 20,
  nextDeposit: 0,
  nextReleasedBonus: 0,
  nextWithdrawable: 5,
});

// Conservation: post-balance + actualDebit equals pre-balance (pending_bonus unchanged here)
const w = { deposit: 0.01, released_bonus: 0.02, withdrawable: 0.03 };
const pre = roundCurrency(Number(w.deposit) + Number(w.released_bonus) + Number(w.withdrawable));
const split = computeWalletDebitSplit(w, 0.06);
assert.strictEqual(split.actualDebit, 0.06);
assert.strictEqual(
  roundCurrency(split.nextDeposit + split.nextReleasedBonus + split.nextWithdrawable + split.actualDebit),
  pre
);

console.log('verify_wallet_debit_split: PASS');
