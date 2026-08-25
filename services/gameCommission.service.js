'use strict';

/**
 * Game rake (admin commission) helpers.
 *
 * Rules:
 * - Deposit + released_bonus portions always use LEGACY_DEPOSIT_COMMISSION_PERCENT (12).
 * - Withdrawable (winning wallet) portion uses admin-configured percent (default 12, max 12).
 * - When admin percent is 12, total rake equals legacy flat totalAmount * 0.12 (no behavior change).
 */

const { roundCurrency } = require('./walletDebitSplit');

const LEGACY_DEPOSIT_COMMISSION_PERCENT = 12;
const DEFAULT_WINNING_COMMISSION_PERCENT = 12;
const MAX_WINNING_COMMISSION_PERCENT = 12;
const MIN_WINNING_COMMISSION_PERCENT = 0;

function normalizeWinningCommissionPercent(raw) {
  if (raw == null || raw === '') return DEFAULT_WINNING_COMMISSION_PERCENT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_WINNING_COMMISSION_PERCENT;
  const clamped = Math.max(
    MIN_WINNING_COMMISSION_PERCENT,
    Math.min(MAX_WINNING_COMMISSION_PERCENT, n),
  );
  return Math.round(clamped * 100) / 100;
}

function extractDebitParts(split = {}) {
  const debitFromDeposit = roundCurrency(Math.max(
    0,
    Number(split.debitFromDeposit ?? split.debit_from_deposit) || 0,
  ));
  const debitFromReleased = roundCurrency(Math.max(
    0,
    Number(split.debitFromReleased ?? split.debit_from_released_bonus ?? split.debit_from_released) || 0,
  ));
  const debitFromWithdrawable = roundCurrency(Math.max(
    0,
    Number(split.debitFromWithdrawable ?? split.debit_from_withdrawable) || 0,
  ));
  const depositLike = roundCurrency(debitFromDeposit + debitFromReleased);
  const actualDebit = roundCurrency(
    Number.isFinite(Number(split.actualDebit ?? split.actual_debit))
      ? Number(split.actualDebit ?? split.actual_debit)
      : depositLike + debitFromWithdrawable,
  );
  return {
    debitFromDeposit,
    debitFromReleased,
    debitFromWithdrawable,
    depositLike,
    actualDebit,
  };
}

/**
 * Commission for one debit split (entry fee or loss settlement).
 */
function computeCommissionForDebitSplit(split = {}, winningCommissionPercent = DEFAULT_WINNING_COMMISSION_PERCENT) {
  const parts = extractDebitParts(split);
  const winningPercent = normalizeWinningCommissionPercent(winningCommissionPercent);
  const depositCommission = roundCurrency(parts.depositLike * (LEGACY_DEPOSIT_COMMISSION_PERCENT / 100));
  const winningCommission = roundCurrency(parts.debitFromWithdrawable * (winningPercent / 100));
  return roundCurrency(depositCommission + winningCommission);
}

/**
 * Flat commission on an amount (used when wallet split is unknown).
 * Uses the winning/admin percent so default 12 matches legacy flat rake.
 */
function computeFlatCommission(amount = 0, winningCommissionPercent = DEFAULT_WINNING_COMMISSION_PERCENT) {
  const safeAmount = roundCurrency(Math.max(0, Number(amount) || 0));
  const percent = normalizeWinningCommissionPercent(winningCommissionPercent);
  return roundCurrency(safeAmount * (percent / 100));
}

/**
 * Sum commission across many debit splits.
 */
function computeCommissionForDebitSplits(splits = [], winningCommissionPercent = DEFAULT_WINNING_COMMISSION_PERCENT) {
  const list = Array.isArray(splits) ? splits : [];
  if (list.length === 0) return 0;
  return roundCurrency(
    list.reduce(
      (sum, split) => sum + computeCommissionForDebitSplit(split, winningCommissionPercent),
      0,
    ),
  );
}

/**
 * Resolve commission percent locked on a session, else provided fallback, else default 12.
 */
function resolveSessionWinningCommissionPercent(sessionOrMetadata = null, fallbackPercent = null) {
  const metadata = sessionOrMetadata?.metadata && typeof sessionOrMetadata.metadata === 'object'
    ? sessionOrMetadata.metadata
    : (sessionOrMetadata && typeof sessionOrMetadata === 'object' ? sessionOrMetadata : {});
  const locked = metadata?.locked_winning_commission_percent
    ?? metadata?.admin_commission_percent
    ?? metadata?.game_commission_percent;
  if (locked != null && Number.isFinite(Number(locked))) {
    return normalizeWinningCommissionPercent(locked);
  }
  if (fallbackPercent != null && Number.isFinite(Number(fallbackPercent))) {
    return normalizeWinningCommissionPercent(fallbackPercent);
  }
  return DEFAULT_WINNING_COMMISSION_PERCENT;
}

/**
 * Effective display percent for prize-pool payloads.
 * When splits are unknown, report the flat percent in use (default 12).
 */
function resolveDisplayCommissionPercent({
  session = null,
  winningCommissionPercent = null,
  hasWalletSplits = false,
} = {}) {
  const percent = resolveSessionWinningCommissionPercent(session, winningCommissionPercent);
  if (!hasWalletSplits && percent === LEGACY_DEPOSIT_COMMISSION_PERCENT) {
    return LEGACY_DEPOSIT_COMMISSION_PERCENT;
  }
  return percent;
}

function buildCommissionMetaFromSplit(split = {}, winningCommissionPercent = DEFAULT_WINNING_COMMISSION_PERCENT) {
  const parts = extractDebitParts(split);
  const winningPercent = normalizeWinningCommissionPercent(winningCommissionPercent);
  const commissionAmount = computeCommissionForDebitSplit(parts, winningPercent);
  return {
    debit_from_deposit: parts.debitFromDeposit,
    debit_from_released_bonus: parts.debitFromReleased,
    debit_from_withdrawable: parts.debitFromWithdrawable,
    deposit_like_amount: parts.depositLike,
    deposit_commission_percent: LEGACY_DEPOSIT_COMMISSION_PERCENT,
    winning_commission_percent: winningPercent,
    admin_commission_percent: winningPercent,
    commission_amount: commissionAmount,
  };
}

module.exports = {
  LEGACY_DEPOSIT_COMMISSION_PERCENT,
  DEFAULT_WINNING_COMMISSION_PERCENT,
  MAX_WINNING_COMMISSION_PERCENT,
  MIN_WINNING_COMMISSION_PERCENT,
  roundCurrency,
  normalizeWinningCommissionPercent,
  extractDebitParts,
  computeCommissionForDebitSplit,
  computeFlatCommission,
  computeCommissionForDebitSplits,
  resolveSessionWinningCommissionPercent,
  resolveDisplayCommissionPercent,
  buildCommissionMetaFromSplit,
};
