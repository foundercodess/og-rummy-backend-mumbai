const { pool } = require('../db');
const walletModel = require('../models/wallet.model');
const rechargeTxModel = require('../models/rechargeTransaction.model');
const promoCodeModel = require('../models/promoCode.model');
const walletTransactionModel = require('../models/walletTransaction.model');
const giftauraPgService = require('./giftauraPg.service');
const notificationService = require('./notification.service');

const ACCOUNT_STATEMENT_FILTERS = Object.freeze([
  { key: 'all', label: 'All', enabled: true, default: true },
  { key: 'won', label: 'Won', enabled: true, default: false },
  { key: 'lost', label: 'Lost', enabled: true, default: false },
  { key: 'money_add', label: 'Money Add', enabled: true, default: false },
  { key: 'withdraw', label: 'Withdraw', enabled: false, default: false },
  { key: 'release_bonus', label: 'Release bonus', enabled: false, default: false },
]);

function generateOrderId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeModeValue(value) {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes('spin')) return 'spin_go';
  if (normalized.includes('deal')) return 'deals_2';
  if (normalized.includes('pool')) return 'pool';
  if (normalized.includes('point')) return 'points';
  return null;
}

function resolveGameModeFromLedgerRow(row = {}) {
  return normalizeModeValue(row?.session_metadata?.game_mode)
    || normalizeModeValue(row?.session_metadata?.game_type)
    || normalizeModeValue(row?.session_metadata?.mode)
    || normalizeModeValue(row?.game_name)
    || 'points';
}

function resolveLedgerReason(row = {}) {
  const txType = String(row?.transaction_type || '');
  const mode = resolveGameModeFromLedgerRow(row);

  const modeLabel = mode === 'deals_2'
    ? 'Deal Rummy'
    : mode === 'spin_go'
      ? 'Spin & Go'
      : mode === 'pool'
        ? 'Pool Rummy'
        : 'Points Rummy';

  if (txType === 'game_win_credit') return `${modeLabel} Won`;
  if (txType === 'game_loss_debit') return `${modeLabel} Loss`;
  if (txType === 'game_entry_debit') return 'Entry Fee';
  if (txType === 'pending_bonus_credit') return 'Bonus Credit';
  if (txType === 'withdraw_debit' || txType === 'withdrawal_debit') return 'Withdraw';
  if (txType === 'bonus_release_credit' || txType === 'released_bonus_credit') return 'Release bonus';
  if (txType === 'deposit_credit') return 'Deposit Credit';
  return 'Wallet Transaction';
}

function buildPublicTransactionId(row = {}) {
  const createdMs = Date.parse(row?.created_at || '') || Date.now();
  const base36Time = createdMs.toString(36).toUpperCase();
  const base36Id = Number(row?.id || 0).toString(36).toUpperCase();
  const base36User = Number(row?.user_id || 0).toString(36).toUpperCase();
  const seed = `TX${base36Time}${base36User}${base36Id}`;
  return seed.length >= 20 ? seed : seed.padEnd(20, 'X');
}

function mapWalletTransactionForDetails(row = {}) {
  const txType = String(row?.transaction_type || '');
  const amount = roundCurrency(row?.amount);
  const isBonusReleaseType = (
    txType === 'bonus_release_credit'
    || txType === 'released_bonus_credit'
    || txType === 'release_bonus_credit'
  );
  const debitTypes = new Set(['game_loss_debit', 'game_entry_debit', 'withdraw_debit', 'withdrawal_debit']);
  const creditTypes = new Set([
    'deposit_credit',
    'game_win_credit',
    'pending_bonus_credit',
    'bonus_release_credit',
    'released_bonus_credit',
    'release_bonus_credit',
  ]);
  const normalizedAmount = Math.abs(amount);
  const signedAmount = debitTypes.has(txType)
    ? -normalizedAmount
    : creditTypes.has(txType)
      ? normalizedAmount
      : amount;
  const action = signedAmount < 0 ? 'sub' : 'add';

  const depositAmount = (
    txType === 'deposit_credit'
    || txType === 'game_loss_debit'
    || txType === 'game_entry_debit'
  ) ? Math.abs(amount) : 0;

  const bonusAmount = (
    txType === 'pending_bonus_credit'
    || isBonusReleaseType
  ) ? Math.abs(amount) : 0;
  const withdrawableAmount = (
    txType === 'deposit_credit'
    || txType === 'game_win_credit'
  ) ? Math.abs(amount) : 0;

  return {
    transaction_id: buildPublicTransactionId(row),
    date_time: row?.created_at || null,
    reason: resolveLedgerReason(row),
    from: 'Game generation',
    withdrawable_amount: withdrawableAmount,
    deposit_amount: depositAmount,
    bonus: bonusAmount,
    action,
  };
}

function getAccountStatementFilters() {
  return ACCOUNT_STATEMENT_FILTERS
    .filter((item) => item.enabled === true)
    .map((item) => ({ ...item }));
}

function normalizeAccountStatementFilter(filter) {
  const fallback = 'all';
  if (filter == null) return fallback;
  const normalized = String(filter).trim().toLowerCase();
  if (!normalized) return fallback;
  const exists = ACCOUNT_STATEMENT_FILTERS.some((item) => item.key === normalized);
  if (!exists) {
    const error = new Error('Invalid filter. Supported values: all, won, lost, money_add, withdraw, release_bonus');
    error.code = 'INVALID_ACCOUNT_STATEMENT_FILTER';
    throw error;
  }
  return normalized;
}

/** Validate promo and return { promo, bonusAmount, instantCash } or throw. */
async function validateAndGetPromoBonus(promoCode, amount, userId) {
  if (!promoCode || !promoCode.trim()) return null;

  const promo = await promoCodeModel.findByCode(promoCode);
  if (!promo) {
    const err = new Error('Invalid or expired promo code');
    err.code = 'INVALID_PROMO_CODE';
    throw err;
  }

  const minAmount = Number(promo.min_amount) || 0;
  if (amount < minAmount) {
    const err = new Error(`Add minimum ₹${minAmount} to use this promo`);
    err.code = 'PROMO_MIN_AMOUNT';
    throw err;
  }

  const userUsage = await promoCodeModel.countUserUsage(promo.id, userId);
  const maxPerUser = promo.max_uses_per_user;
  if (maxPerUser != null && userUsage >= maxPerUser) {
    const err = new Error('You have already used this promo');
    err.code = 'PROMO_ALREADY_USED';
    throw err;
  }

  const totalUsage = await promoCodeModel.countTotalUsage(promo.id);
  const maxTotal = promo.max_uses_total;
  if (maxTotal != null && totalUsage >= maxTotal) {
    const err = new Error('This promo is no longer available');
    err.code = 'PROMO_EXHAUSTED';
    throw err;
  }

  const { bonusAmount, instantCash } = promoCodeModel.calculateBonus(promo, amount);
  return { promo, bonusAmount, instantCash };
}

/** Create an init recharge transaction, initiate PG pay-in, and return transaction + payment link. */
async function createAddCashInit({
  userId,
  amount,
  type = 'conventional',
  addCashOptionId = null,
  currency = 'INR',
  name = null,
  email = null,
  phone = null,
  promoCode = null,
}) {
  if (type === 'conventional' && !giftauraPgService.isConfigured()) {
    const error = new Error('Payment gateway is not configured');
    error.code = 'PG_NOT_CONFIGURED';
    throw error;
  }


  
  let promoCodeId = null;
  let promoBonusAmount = 0;
  let promoInstantCash = 0;

  if (promoCode && promoCode.trim()) {
    const result = await validateAndGetPromoBonus(promoCode, amount, userId);
    if (result) {
      promoCodeId = result.promo.id;
      promoBonusAmount = result.bonusAmount;
      promoInstantCash = result.instantCash;
    }
  }

  const wallet = await walletModel.getOrCreateByUserId(userId);
  const orderId = type === 'conventional'
    ? giftauraPgService.generatePgOrderId()
    : generateOrderId();

  const row = await rechargeTxModel.createInit({
    userId,
    walletId: wallet.id,
    type,
    amount,
    orderId,
    addCashOptionId,
    currency,
    name,
    email,
    phone,
    promoCodeId,
    promoBonusAmount,
    promoInstantCash,
  });

  if (type !== 'conventional') {
    return {
      transaction: rechargeTxModel.formatForResponse(row),
      payment: null,
    };
  }

  let payment;
  try {
    payment = await giftauraPgService.initiatePayment({
      orderId,
      amount,
      name,
      email,
      mobile: phone,
    });
  } catch (err) {
    await rechargeTxModel.updateStatusByOrderId({
      orderId,
      status: 'failed',
      paymentResponse: JSON.stringify({
        stage: 'pg_init',
        error: err.message,
        code: err.code || null,
        gatewayResponse: err.gatewayResponse || null,
      }),
      completedAt: new Date(),
    });
    throw err;
  }

  const updatedRow = await rechargeTxModel.updateStatusByOrderId({
    orderId,
    status: 'init',
    paymentRef: payment.gateway_txn || null,
    paymentResponse: JSON.stringify({
      stage: 'pg_init',
      gateway: 'giftaura',
      ...payment.raw,
    }),
  });

  return {
    transaction: rechargeTxModel.formatForResponse(updatedRow || row),
    payment: {
      payment_link: payment.payment_link,
      gateway_txn: payment.gateway_txn,
      order_id: payment.gateway_order_id || orderId,
      redirect_url: giftauraPgService.buildRedirectUrl(orderId),
    },
  };
}

async function getRechargeByOrderIdForUser({ userId, orderId }) {
  const row = await rechargeTxModel.findByOrderId(orderId);
  if (!row || Number(row.user_id) !== Number(userId)) {
    return null;
  }
  return rechargeTxModel.formatForResponse(row);
}

async function handlePaymentCallback(query = {}) {
  const { orderId, paymentRef, status } = giftauraPgService.extractCallbackFields(query);
  if (!orderId) {
    const error = new Error('order_id is required');
    error.code = 'INVALID_CALLBACK';
    throw error;
  }

  const resolvedStatus = status || 'payment_success';
  const paymentResponse = JSON.stringify({
    stage: 'pg_callback',
    gateway: 'giftaura',
    query,
  });

  const tx = await updatePaymentStatus({
    orderId,
    status: resolvedStatus,
    paymentRef: paymentRef || orderId,
    paymentResponse,
  });

  return { tx, resolvedStatus };
}

/**
 * Update payment status by order_id and, on payment_success,
 * atomically update the user's wallet balances.
 */
async function updatePaymentStatus({ orderId, status, paymentRef, paymentResponse }) {
  if (!pool) {
    throw new Error('DATABASE_URL not configured');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 10000'); // 10s per statement

    // Lock the recharge row
    const txRes = await client.query(
      'SELECT * FROM recharge_transactions WHERE order_id = $1 FOR UPDATE',
      [orderId]
    );
    const txRow = txRes.rows[0];
    if (!txRow) {
      await client.query('ROLLBACK');
      return null;
    }

    // If already in a terminal status, just return
    const wasAlreadyTerminal = ['payment_success', 'failed', 'not_paid'].includes(txRow.status);
    if (wasAlreadyTerminal) {
      await client.query('COMMIT');
      return rechargeTxModel.formatForResponse(txRow);
    }

    const completedAt = status === 'payment_success' ? new Date() : null;
    const updatedTxRes = await client.query(
      `UPDATE recharge_transactions
       SET status = $2,
           payment_ref = COALESCE($3, payment_ref),
           payment_response = COALESCE($4, payment_response),
           completed_at = COALESCE($5, completed_at),
           updated_at = NOW()
       WHERE order_id = $1
       RETURNING *`,
      [orderId, status, paymentRef || null, paymentResponse || null, completedAt]
    );
    const updatedTx = updatedTxRes.rows[0];

    // On successful payment, credit wallet
    if (status === 'payment_success') {
      const walletRes = await client.query(
        'SELECT * FROM wallets WHERE id = $1 FOR UPDATE',
        [updatedTx.wallet_id]
      );
      const walletRow = walletRes.rows[0];
      if (!walletRow) {
        throw new Error('WALLET_NOT_FOUND');
      }

      const baseAmount = Number(updatedTx.amount);
      let optionInstantCash = 0;
      let optionBonus = 0;
      if (updatedTx.add_cash_option_id) {
        const optRes = await client.query(
          'SELECT base_amount, instant_cash, bonus FROM add_cash_options WHERE id = $1',
          [updatedTx.add_cash_option_id]
        );
        const option = optRes.rows[0];
        if (option && Number(option.base_amount) === baseAmount) {
          optionInstantCash = Number(option.instant_cash) || 0;
          optionBonus = Number(option.bonus) || 0;
        }
      }
      const promoBonus = Number(updatedTx.promo_bonus_amount) || 0;
      const promoInstant = Number(updatedTx.promo_instant_cash) || 0;
      const totalPendingBonusCredit = optionBonus + promoBonus;

      // Wallet credit rules:
      // - base amount + instant_cash -> deposit
      // - bonus -> pending_bonus (with expiry)
      const depositCredit = baseAmount + optionInstantCash + promoInstant;

      const newDeposit = Number(walletRow.deposit) + depositCredit;
      const newPendingBonus = Number(walletRow.pending_bonus) + totalPendingBonusCredit;
      const newTotal = Number(walletRow.total_balance) + depositCredit;

      await client.query(
        `UPDATE wallets
         SET deposit = $2,
             pending_bonus = $3,
             total_balance = $4,
             updated_at = NOW()
         WHERE id = $1`,
        [walletRow.id, newDeposit, newPendingBonus, newTotal]
      );

      // Transaction history
      if (depositCredit > 0) {
        await client.query(
          `INSERT INTO wallet_transactions (
             user_id, wallet_id, transaction_type, amount, source, reference_type, reference_id, metadata
           ) VALUES (
             $1, $2, 'deposit_credit', $3, 'recharge', 'recharge_transaction', $4,
             $5::jsonb
           )`,
          [
            updatedTx.user_id,
            walletRow.id,
            depositCredit,
            updatedTx.id,
            {
              base_amount: baseAmount,
              option_instant_cash: optionInstantCash,
              promo_instant_cash: promoInstant,
            },
          ]
        );
      }
      if (optionBonus > 0) {
        // Random expiry between 7-15 days for add-cash option bonus
        const optionExpiryDays = 7 + Math.floor(Math.random() * 9); // 7-15 inclusive
        const optionExpiresAt = new Date(Date.now() + optionExpiryDays * 24 * 60 * 60 * 1000);

        await client.query(
          `INSERT INTO wallet_transactions (
             user_id, wallet_id, transaction_type, amount, source, reference_type, reference_id, expires_at, metadata
           ) VALUES (
             $1, $2, 'pending_bonus_credit', $3, 'recharge', 'recharge_transaction', $4, $5,
             $6::jsonb
           )`,
          [
            updatedTx.user_id,
            walletRow.id,
            optionBonus,
            updatedTx.id,
            optionExpiresAt,
            {
              add_cash_option_id: updatedTx.add_cash_option_id,
              option_bonus_amount: optionBonus,
            },
          ]
        );
      }

      if (promoBonus > 0) {
        let promoExpiryDays = 30;
        if (updatedTx.promo_code_id) {
          const promoCfgRes = await client.query(
            'SELECT bonus_expiry_days FROM promo_codes WHERE id = $1',
            [updatedTx.promo_code_id]
          );
          const v = promoCfgRes.rows[0]?.bonus_expiry_days;
          if (v != null && !Number.isNaN(Number(v))) promoExpiryDays = Number(v);
        }
        const expiresAt = new Date(Date.now() + promoExpiryDays * 24 * 60 * 60 * 1000);

        await client.query(
          `INSERT INTO wallet_transactions (
             user_id, wallet_id, transaction_type, amount, source, reference_type, reference_id, expires_at, metadata
           ) VALUES (
             $1, $2, 'pending_bonus_credit', $3, 'promo', 'recharge_transaction', $4, $5,
             $6::jsonb
           )`,
          [
            updatedTx.user_id,
            walletRow.id,
            promoBonus,
            updatedTx.id,
            expiresAt,
            {
              promo_code_id: updatedTx.promo_code_id,
              promo_bonus_amount: promoBonus,
            },
          ]
        );
      }

      if (updatedTx.promo_code_id) {
        await client.query(
          `INSERT INTO promo_code_usage (promo_code_id, user_id, recharge_transaction_id)
           VALUES ($1, $2, $3)`,
          [updatedTx.promo_code_id, updatedTx.user_id, updatedTx.id]
        );
      }
    }

    await client.query('COMMIT');
    const formatted = rechargeTxModel.formatForResponse(updatedTx);

    if (status === 'payment_success') {
      try {
        await notificationService.notifyUser(updatedTx.user_id, {
          title: 'Cash added successfully',
          content: `₹${roundCurrency(updatedTx.amount)} has been added to your wallet.`,
          type: 'recharge',
          event: notificationService.NOTIFICATION_EVENTS.CASH_ADDED,
          metadata: {
            order_id: updatedTx.order_id,
            amount: roundCurrency(updatedTx.amount),
            screen: 'wallet',
          },
        });
      } catch (notifyError) {
        console.error('cash added notification error:', notifyError.message);
      }
    }

    return formatted;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listUserTransactions({ userId, limit = 50, offset = 0, fromDate, toDate }) {
  const safeLimit = Number.isNaN(Number(limit)) ? 50 : Math.min(Number(limit), 100);
  const safeOffset = Number.isNaN(Number(offset)) ? 0 : Math.max(Number(offset), 0);

  const from = fromDate ? new Date(fromDate) : null;
  let to = toDate ? new Date(toDate) : null;

  // Make date_to inclusive for the whole day (local time)
  if (to) {
    to.setHours(23, 59, 59, 999);
  }

  return rechargeTxModel.listByUserId({
    userId,
    limit: safeLimit,
    offset: safeOffset,
    fromDate: from,
    toDate: to,
  });
}

async function listPendingBonusTransactions({ userId, limit = 50, offset = 0 }) {
  const [items, summary] = await Promise.all([
    walletTransactionModel.listPendingBonusHistory({ userId, limit, offset }),
    walletTransactionModel.getPendingBonusSummary({ userId }),
  ]);
  return { items, summary };
}

async function listTransactionDetails({ userId, limit = 50, offset = 0, fromDate, toDate, filter = 'all' }) {
  const safeLimit = Number.isNaN(Number(limit)) ? 50 : Math.min(Number(limit), 100);
  const safeOffset = Number.isNaN(Number(offset)) ? 0 : Math.max(Number(offset), 0);
  const normalizedFilter = normalizeAccountStatementFilter(filter);

  const from = fromDate ? new Date(fromDate) : null;
  let to = toDate ? new Date(toDate) : null;
  if (to) {
    to.setHours(23, 59, 59, 999);
  }

  const rows = await walletTransactionModel.listUserWalletTransactions({
    userId,
    limit: safeLimit,
    offset: safeOffset,
    fromDate: from,
    toDate: to,
    filter: normalizedFilter,
  });

  return rows.map(mapWalletTransactionForDetails);
}

module.exports = {
  getAccountStatementFilters,
  createAddCashInit,
  getRechargeByOrderIdForUser,
  handlePaymentCallback,
  updatePaymentStatus,
  listUserTransactions,
  listPendingBonusTransactions,
  listTransactionDetails,
};

