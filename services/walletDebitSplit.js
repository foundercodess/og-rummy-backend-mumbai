/**
 * Wallet debits for entry fees and in-game loss settlement use the same buckets and order:
 * spendable = deposit + released_bonus + withdrawable (pending_bonus is not spendable here).
 * Debit order: deposit → released_bonus → withdrawable.
 */

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function computeWalletDebitSplit(wallet = {}, amount = 0) {
  const debitAmount = roundCurrency(Math.max(0, Number(amount) || 0));
  const deposit = roundCurrency(Number(wallet?.deposit || 0));
  const releasedBonus = roundCurrency(Number(wallet?.released_bonus || 0));
  const withdrawable = roundCurrency(Number(wallet?.withdrawable || 0));
  const available = roundCurrency(deposit + releasedBonus + withdrawable);
  const actualDebit = roundCurrency(Math.min(debitAmount, available));

  let remaining = actualDebit;
  const debitFromDeposit = roundCurrency(Math.min(remaining, deposit));
  remaining = roundCurrency(remaining - debitFromDeposit);
  const debitFromReleased = roundCurrency(Math.min(remaining, releasedBonus));
  remaining = roundCurrency(remaining - debitFromReleased);
  const debitFromWithdrawable = roundCurrency(Math.min(remaining, withdrawable));

  return {
    available,
    actualDebit,
    debitFromDeposit,
    debitFromReleased,
    debitFromWithdrawable,
    nextDeposit: roundCurrency(deposit - debitFromDeposit),
    nextReleasedBonus: roundCurrency(releasedBonus - debitFromReleased),
    nextWithdrawable: roundCurrency(withdrawable - debitFromWithdrawable),
  };
}

module.exports = {
  roundCurrency,
  computeWalletDebitSplit,
};
