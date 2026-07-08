const { pool, query } = require('../db');
const walletModel = require('../models/wallet.model');
const userBankAccountModel = require('../models/userBankAccount.model');
const withdrawalTxModel = require('../models/withdrawalTransaction.model');
const giftauraPayoutService = require('./giftauraPayout.service');
const notificationService = require('./notification.service');

const WITHDRAWAL_FEE_RATE = Number(process.env.WITHDRAWAL_FEE_RATE || 0.04);
const WITHDRAWAL_MIN_AMOUNT = Number(process.env.WITHDRAWAL_MIN_AMOUNT || 100);
const WITHDRAWAL_DAILY_MAX_COUNT = Number(process.env.WITHDRAWAL_DAILY_MAX_COUNT || 10);
const WITHDRAWAL_DAILY_MAX_AMOUNT = Number(process.env.WITHDRAWAL_DAILY_MAX_AMOUNT || 100000);
const MAX_BANK_ACCOUNTS = Number(process.env.MAX_BANK_ACCOUNTS_PER_USER || 5);
const WITHDRAWAL_MIN_ACCOUNT_AGE_HOURS = Number(process.env.WITHDRAWAL_MIN_ACCOUNT_AGE_HOURS || 24);
const WITHDRAWAL_NEW_ACCOUNT_MAX_AMOUNT = Number(process.env.WITHDRAWAL_NEW_ACCOUNT_MAX_AMOUNT || 5000);
const WITHDRAWAL_MAX_PROCESSING_COUNT = Number(process.env.WITHDRAWAL_MAX_PROCESSING_COUNT || 3);
const WITHDRAWAL_REQUIRE_APPROVED_KYC = process.env.WITHDRAWAL_REQUIRE_APPROVED_KYC === 'true';
const BYPASS_WITHDRAWAL_BALANCE_CHECK = process.env.BYPASS_WITHDRAWAL_BALANCE_CHECK === 'true';
const WITHDRAWAL_PAYOUT_SYNC_MIN_AGE_MINUTES = Number(process.env.WITHDRAWAL_PAYOUT_SYNC_MIN_AGE_MINUTES || 2);
const WITHDRAWAL_PAYOUT_SYNC_BATCH_LIMIT = Number(process.env.WITHDRAWAL_PAYOUT_SYNC_BATCH_LIMIT || 50);
const TERMINAL_WITHDRAWAL_STATUSES = new Set(['successful', 'failed', 'rejected']);

function isWithdrawalBalanceCheckBypassed() {
  if (!BYPASS_WITHDRAWAL_BALANCE_CHECK) return false;
  if (process.env.NODE_ENV === 'production') {
    console.warn('[withdrawal] BYPASS_WITHDRAWAL_BALANCE_CHECK is ignored in production');
    return false;
  }
  return true;
}

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

async function sendWithdrawalUserNotification(row, event) {
  if (!row?.user_id) return;
  const amount = roundCurrency(row.amount);
  const baseMetadata = {
    withdrawal_id: row.id,
    order_id: row.order_id,
    amount,
    screen: 'withdrawals',
  };

  if (event === notificationService.NOTIFICATION_EVENTS.WITHDRAWAL_SUBMITTED) {
    await notificationService.notifyUser(row.user_id, {
      title: 'Withdrawal submitted',
      content: `Your withdrawal of ₹${amount} has been submitted to the bank.`,
      type: 'withdrawal',
      event,
      metadata: baseMetadata,
    });
    return;
  }

  if (event === notificationService.NOTIFICATION_EVENTS.WITHDRAWAL_SUCCESS) {
    await notificationService.notifyUser(row.user_id, {
      title: 'Withdrawal successful',
      content: `₹${amount} has been sent to your bank account.`,
      type: 'withdrawal',
      event,
      metadata: baseMetadata,
    });
    return;
  }

  if (event === notificationService.NOTIFICATION_EVENTS.WITHDRAWAL_FAILED) {
    await notificationService.notifyUser(row.user_id, {
      title: 'Withdrawal failed',
      content: `Your withdrawal of ₹${amount} could not be completed. The amount has been refunded to your wallet.`,
      type: 'withdrawal',
      event,
      metadata: baseMetadata,
    });
    return;
  }

  if (event === notificationService.NOTIFICATION_EVENTS.WITHDRAWAL_REJECTED) {
    await notificationService.notifyUser(row.user_id, {
      title: 'Withdrawal rejected',
      content: `Your withdrawal request of ₹${amount} was rejected and refunded to your wallet.`,
      type: 'withdrawal',
      event,
      metadata: baseMetadata,
    });
  }
}

function calculateHandlingFee(amount) {
  return roundCurrency(amount * WITHDRAWAL_FEE_RATE);
}

function validateIfsc(ifsc) {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/i.test(String(ifsc || '').trim());
}

function validateAccountNumber(accountNumber) {
  return /^\d{9,18}$/.test(String(accountNumber || '').trim());
}

function normalizeAccountHolderName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function validateBankPayload({
  accountHolderName,
  bankName,
  accountNumber,
  ifscCode,
}) {
  const holder = normalizeAccountHolderName(accountHolderName);
  const bank = String(bankName || '').trim().toUpperCase();
  const account = String(accountNumber || '').trim();
  const ifsc = String(ifscCode || '').trim().toUpperCase();

  if (holder.length < 2) {
    const error = new Error('Account holder name must be at least 2 characters');
    error.code = 'INVALID_BANK_HOLDER';
    throw error;
  }
  if (!bank) {
    const error = new Error('Bank name is required');
    error.code = 'INVALID_BANK_NAME';
    throw error;
  }
  if (!validateAccountNumber(account)) {
    const error = new Error('Bank account number must be 9 to 18 digits');
    error.code = 'INVALID_ACCOUNT_NUMBER';
    throw error;
  }
  if (!validateIfsc(ifsc)) {
    const error = new Error('Please enter a valid IFSC code');
    error.code = 'INVALID_IFSC';
    throw error;
  }

  return { holder, bank, account, ifsc };
}

function mergePayoutResponse(existing, entry) {
  let attempts = [];
  if (existing) {
    try {
      const parsed = typeof existing === 'string' ? JSON.parse(existing) : existing;
      if (Array.isArray(parsed?.attempts)) {
        attempts = parsed.attempts;
      } else if (parsed) {
        attempts = [parsed];
      }
    } catch {
      attempts = [];
    }
  }
  attempts.push({ ...entry, at: new Date().toISOString() });
  return JSON.stringify({ attempts });
}

function parseBankSnapshot(row) {
  const bankRaw = row?.bank_snapshot;
  if (!bankRaw) return {};
  if (typeof bankRaw === 'string') {
    try {
      return JSON.parse(bankRaw);
    } catch {
      return {};
    }
  }
  return bankRaw;
}

async function validateUserWithdrawalEligibility(userId, { amount = null } = {}) {
  const userRes = await query(
    `SELECT id, active, withdrawals_frozen, created_at
     FROM users
     WHERE id = $1`,
    [userId]
  );
  const user = userRes.rows[0];
  if (!user) {
    const error = new Error('User not found');
    error.code = 'USER_NOT_FOUND';
    throw error;
  }
  if (user.active === false) {
    const error = new Error('Your account is blocked. Contact support.');
    error.code = 'USER_BLOCKED';
    throw error;
  }
  if (user.withdrawals_frozen === true) {
    const error = new Error('Withdrawals are temporarily disabled on your account. Contact support.');
    error.code = 'WITHDRAWALS_FROZEN';
    throw error;
  }

  if (WITHDRAWAL_REQUIRE_APPROVED_KYC) {
    const kycRes = await query(
      `SELECT status
       FROM kyc
       WHERE user_id = $1 AND active = true
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
      [userId]
    );
    const kyc = kycRes.rows[0];
    if (!kyc || kyc.status !== 'approved') {
      const error = new Error('KYC approval is required before withdrawal');
      error.code = 'KYC_NOT_APPROVED';
      throw error;
    }
  }

  const suspiciousReasons = [];
  const accountAgeHours = (Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60);
  const numericAmount = amount == null ? null : roundCurrency(amount);

  if (
    numericAmount != null
    && accountAgeHours < WITHDRAWAL_MIN_ACCOUNT_AGE_HOURS
    && numericAmount > WITHDRAWAL_NEW_ACCOUNT_MAX_AMOUNT
  ) {
    suspiciousReasons.push('new_account_high_amount');
  }

  const processingRes = await query(
    `SELECT COUNT(*)::int AS count
     FROM withdrawal_transactions
     WHERE user_id = $1
       AND status IN ('processing', 'init', 'pending')`,
    [userId]
  );
  const processingCount = processingRes.rows[0]?.count || 0;
  if (processingCount >= WITHDRAWAL_MAX_PROCESSING_COUNT) {
    suspiciousReasons.push('too_many_open_withdrawals');
  }

  const rejectedKycRes = await query(
    `SELECT id
     FROM kyc
     WHERE user_id = $1 AND active = true AND status = 'rejected'
     LIMIT 1`,
    [userId]
  );
  if (rejectedKycRes.rows[0]) {
    suspiciousReasons.push('kyc_rejected');
  }

  if (suspiciousReasons.length > 0) {
    const error = new Error('Withdrawal request cannot be processed. Please contact support.');
    error.code = 'SUSPICIOUS_ACCOUNT';
    error.reasons = suspiciousReasons;
    throw error;
  }

  return user;
}

async function listBankAccounts(userId) {
  return userBankAccountModel.listByUserId(userId);
}

async function addBankAccount(userId, payload) {
  const { holder, bank, account, ifsc } = validateBankPayload(payload);
  const count = await userBankAccountModel.countActiveByUserId(userId);
  if (count >= MAX_BANK_ACCOUNTS) {
    const error = new Error(`You can save up to ${MAX_BANK_ACCOUNTS} bank accounts`);
    error.code = 'BANK_LIMIT_REACHED';
    throw error;
  }

  return userBankAccountModel.createAccount({
    userId,
    accountHolderName: holder,
    bankName: bank,
    accountNumber: account,
    ifscCode: ifsc,
    branch: payload.branch || null,
    isPrimary: count === 0,
  });
}

async function deleteBankAccount(userId, bankAccountId) {
  const deleted = await userBankAccountModel.softDeleteForUser({ id: bankAccountId, userId });
  if (!deleted) return null;
  return { message: 'Bank account removed successfully' };
}

async function validateWithdrawalRequest({ userId, amount, bankAccountId, type = 'conventional' }) {
  const numericAmount = roundCurrency(amount);
  await validateUserWithdrawalEligibility(userId, { amount: numericAmount });

  if (!numericAmount || numericAmount <= 0) {
    const error = new Error('Valid positive withdrawal amount required');
    error.code = 'INVALID_AMOUNT';
    throw error;
  }
  if (numericAmount < WITHDRAWAL_MIN_AMOUNT) {
    const error = new Error(`Minimum withdrawal amount is ₹${WITHDRAWAL_MIN_AMOUNT}`);
    error.code = 'MIN_AMOUNT';
    throw error;
  }

  const bankAccount = await userBankAccountModel.findByIdForUser({ id: bankAccountId, userId });
  if (!bankAccount) {
    const error = new Error('Selected bank account not found');
    error.code = 'BANK_NOT_FOUND';
    throw error;
  }

  const wallet = await walletModel.getOrCreateByUserId(userId);
  const handlingFee = calculateHandlingFee(numericAmount);
  const totalDebit = roundCurrency(numericAmount + handlingFee);
  const withdrawable = roundCurrency(wallet.withdrawable);

  if (!isWithdrawalBalanceCheckBypassed() && totalDebit > withdrawable) {
    const error = new Error('Insufficient withdrawable balance (amount + handling fee)');
    error.code = 'INSUFFICIENT_BALANCE';
    throw error;
  }

  const daily = await withdrawalTxModel.getDailyStats(userId);
  if (daily.count >= WITHDRAWAL_DAILY_MAX_COUNT) {
    const error = new Error(`Daily withdrawal limit of ${WITHDRAWAL_DAILY_MAX_COUNT} requests reached`);
    error.code = 'DAILY_COUNT_LIMIT';
    throw error;
  }
  if (roundCurrency(daily.total_amount + numericAmount) > WITHDRAWAL_DAILY_MAX_AMOUNT) {
    const error = new Error(`Daily withdrawal amount limit of ₹${WITHDRAWAL_DAILY_MAX_AMOUNT} reached`);
    error.code = 'DAILY_AMOUNT_LIMIT';
    throw error;
  }

  return {
    wallet,
    bankAccount,
    amount: numericAmount,
    handlingFee,
    totalDebit,
    netAmount: numericAmount,
    type: type === 'p2p' ? 'p2p' : 'conventional',
  };
}

async function attemptPayoutForWithdrawal({
  withdrawalRow,
  userPhone = null,
  adminId = null,
  stageOnSuccess = 'pg_init',
  stageOnFailure = 'pg_init_failed',
  throwOnFailure = false,
}) {
  if (!giftauraPayoutService.isConfigured()) {
    if (throwOnFailure) {
      const error = new Error('Payout gateway is not configured');
      error.code = 'PG_NOT_CONFIGURED';
      throw error;
    }
    return { row: withdrawalRow, payoutAttempted: false, success: false };
  }

  const bank = parseBankSnapshot(withdrawalRow);
  let payout;
  try {
    payout = await giftauraPayoutService.initiatePayout({
      orderId: withdrawalRow.order_id,
      amount: withdrawalRow.net_amount,
      accountHolderName: bank.account_holder_name,
      bankName: bank.bank_name,
      accountNumber: bank.account_number,
      ifscCode: bank.ifsc_code,
      mobile: userPhone,
    });
  } catch (error) {
    const remark = error.message || 'Payout gateway rejected the request';
    const payoutResponse = mergePayoutResponse(withdrawalRow.payout_response, {
      stage: stageOnFailure,
      gateway: 'giftaura',
      reason: remark,
      gatewayResponse: error.gatewayResponse || null,
      admin_id: adminId || null,
    });

    const updatedRes = await query(
      `UPDATE withdrawal_transactions
       SET pg_remark = $2,
           payout_response = $3,
           status = 'processing',
           settled_by = COALESCE($4, settled_by),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [withdrawalRow.id, remark, payoutResponse, adminId || null]
    );

    if (throwOnFailure) {
      const resultError = new Error(remark);
      resultError.code = error.code || 'PG_INIT_FAILED';
      resultError.withdrawal = withdrawalTxModel.formatDetail(updatedRes.rows[0]);
      resultError.gatewayResponse = error.gatewayResponse || null;
      throw resultError;
    }

    return {
      row: updatedRes.rows[0],
      payoutAttempted: true,
      success: false,
      remark,
    };
  }

  const payoutResponse = mergePayoutResponse(withdrawalRow.payout_response, {
    stage: stageOnSuccess,
    gateway: 'giftaura',
    admin_id: adminId || null,
    ...payout.raw,
  });

  const updatedRes = await query(
    `UPDATE withdrawal_transactions
     SET status = 'pending',
         pg_reference = $2,
         payout_response = $3,
         pg_remark = NULL,
         settled_by = COALESCE($4, settled_by),
         reviewed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      withdrawalRow.id,
      payout.gateway_txn || withdrawalRow.order_id,
      payoutResponse,
      adminId || null,
    ]
  );

  return {
    row: updatedRes.rows[0],
    payoutAttempted: true,
    success: true,
  };
}

async function createWithdrawal({ userId, amount, bankAccountId, type = 'conventional', phone = null }) {
  const validated = await validateWithdrawalRequest({ userId, amount, bankAccountId, type });
  const orderId = giftauraPayoutService.generatePayoutOrderId();
  const withdrawNo = giftauraPayoutService.generateWithdrawNo(orderId);
  const bankSnapshot = {
    account_holder_name: validated.bankAccount.account_holder_name,
    bank_name: validated.bankAccount.bank_name,
    account_number: validated.bankAccount.account_number,
    ifsc_code: validated.bankAccount.ifsc_code,
    branch: validated.bankAccount.branch,
  };

  if (!pool) throw new Error('DATABASE_URL not configured');

  const client = await pool.connect();
  let withdrawalRow;
  try {
    await client.query('BEGIN');

    const walletRes = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
    const walletRow = walletRes.rows[0];
    if (!walletRow) throw new Error('WALLET_NOT_FOUND');

    const withdrawable = roundCurrency(walletRow.withdrawable);
    const balanceBypassed = isWithdrawalBalanceCheckBypassed();
    if (!balanceBypassed && validated.totalDebit > withdrawable) {
      const error = new Error('Insufficient withdrawable balance (amount + handling fee)');
      error.code = 'INSUFFICIENT_BALANCE';
      throw error;
    }

    const walletDebitApplied = balanceBypassed
      ? roundCurrency(Math.min(withdrawable, validated.totalDebit))
      : validated.totalDebit;
    if (balanceBypassed) {
      console.warn(
        `[withdrawal] Balance check bypassed for user ${userId}; wallet debit ₹${walletDebitApplied}`
      );
    }

    const insertRes = await client.query(
      `INSERT INTO withdrawal_transactions (
         user_id, wallet_id, bank_account_id, type, amount, handling_fee, net_amount,
         withdraw_no, order_id, status, bank_snapshot, requested_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'processing', $10::jsonb, NOW())
       RETURNING *`,
      [
        userId,
        walletRow.id,
        validated.bankAccount.id,
        validated.type,
        validated.amount,
        validated.handlingFee,
        validated.netAmount,
        withdrawNo,
        orderId,
        JSON.stringify(bankSnapshot),
      ]
    );
    withdrawalRow = insertRes.rows[0];

    if (walletDebitApplied > 0) {
      const newWithdrawable = roundCurrency(withdrawable - walletDebitApplied);
      const newTotal = roundCurrency(Number(walletRow.total_balance) - walletDebitApplied);
      await client.query(
        `UPDATE wallets
         SET withdrawable = $2, total_balance = $3, updated_at = NOW()
         WHERE id = $1`,
        [walletRow.id, newWithdrawable, newTotal]
      );

      await client.query(
        `INSERT INTO wallet_transactions (
           user_id, wallet_id, transaction_type, amount, source, reference_type, reference_id, metadata
         ) VALUES ($1,$2,'withdraw_debit',$3,'withdrawal','withdrawal_transaction',$4,$5::jsonb)`,
        [
          userId,
          walletRow.id,
          walletDebitApplied,
          withdrawalRow.id,
          JSON.stringify({
            withdrawal_amount: validated.amount,
            handling_fee: validated.handlingFee,
            withdraw_no: withdrawNo,
            wallet_debit_applied: walletDebitApplied,
            balance_check_bypassed: balanceBypassed,
          }),
        ]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const userPhoneRes = await query('SELECT phone FROM users WHERE id = $1', [userId]);
  const resolvedPhone = phone || userPhoneRes.rows[0]?.phone || null;

  const attemptResult = await attemptPayoutForWithdrawal({
    withdrawalRow,
    userPhone: resolvedPhone,
    stageOnSuccess: 'pg_auto_init',
    stageOnFailure: 'pg_auto_init_failed',
    throwOnFailure: false,
  });

  if (attemptResult.success) {
    try {
      await sendWithdrawalUserNotification(
        attemptResult.row,
        notificationService.NOTIFICATION_EVENTS.WITHDRAWAL_SUBMITTED
      );
    } catch (notifyError) {
      console.error('withdrawal submitted notification error:', notifyError.message);
    }
  }

  return withdrawalTxModel.formatDetail(attemptResult.row);
}

async function getWithdrawalWalletDebitApplied(withdrawalId) {
  const debitRes = await query(
    `SELECT amount, metadata
     FROM wallet_transactions
     WHERE reference_type = 'withdrawal_transaction'
       AND reference_id = $1
       AND transaction_type = 'withdraw_debit'
     ORDER BY id DESC
     LIMIT 1`,
    [withdrawalId]
  );
  const debitRow = debitRes.rows[0];
  if (!debitRow) return 0;

  let metadata = debitRow.metadata;
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      metadata = null;
    }
  }
  return roundCurrency(metadata?.wallet_debit_applied ?? debitRow.amount);
}

async function refundFailedWithdrawal({
  userId,
  withdrawalId,
  totalDebit,
  reason,
  gatewayResponse,
  newStatus = 'failed',
  adminNotes = null,
  adminId = null,
  payoutStage = null,
}) {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txRes = await client.query(
      'SELECT * FROM withdrawal_transactions WHERE id = $1 FOR UPDATE',
      [withdrawalId]
    );
    const tx = txRes.rows[0];
    if (!tx || tx.status === 'failed' || tx.status === 'rejected') {
      await client.query('COMMIT');
      return;
    }

    const refundAmount = await getWithdrawalWalletDebitApplied(withdrawalId);
    const walletRes = await client.query('SELECT * FROM wallets WHERE id = $1 FOR UPDATE', [tx.wallet_id]);
    const wallet = walletRes.rows[0];
    if (wallet && refundAmount > 0) {
      await client.query(
        `UPDATE wallets
         SET withdrawable = withdrawable + $2,
             total_balance = total_balance + $2,
             updated_at = NOW()
         WHERE id = $1`,
        [wallet.id, refundAmount]
      );
      await client.query(
        `INSERT INTO wallet_transactions (
           user_id, wallet_id, transaction_type, amount, source, reference_type, reference_id, metadata
         ) VALUES ($1,$2,'deposit_credit',$3,'withdrawal_refund','withdrawal_transaction',$4,$5::jsonb)`,
        [
          userId,
          wallet.id,
          refundAmount,
          withdrawalId,
          JSON.stringify({
            reason: reason || 'Payout failed',
            refunded: true,
            requested_refund: roundCurrency(totalDebit),
          }),
        ]
      );
    }

    const payoutPayload = mergePayoutResponse(tx.payout_response, {
      stage: payoutStage || (newStatus === 'rejected' ? 'admin_rejected' : 'pg_init_failed'),
      reason,
      gatewayResponse,
      admin_id: adminId || null,
    });

    await client.query(
      `UPDATE withdrawal_transactions
       SET status = $2,
           payout_response = $3,
           admin_notes = COALESCE($4, admin_notes),
           settled_by = COALESCE($5, settled_by),
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [
        withdrawalId,
        newStatus,
        payoutPayload,
        adminNotes,
        adminId,
      ]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function listWithdrawals({ userId, type, limit, offset }) {
  return withdrawalTxModel.listByUserId({ userId, type, limit, offset });
}

async function getWithdrawalDetail({ userId, withdrawalId }) {
  const row = await withdrawalTxModel.findByIdForUser({ id: withdrawalId, userId });
  return withdrawalTxModel.formatDetail(row);
}

async function applyPayoutStatusFromPgHistory(row, pgHistory, { source = 'poll' } = {}) {
  const previousStatus = row?.status;
  const pgStatusRaw = pgHistory?.status ?? null;
  const pgStatusLabel = giftauraPayoutService.pgHistoryStatusLabel(pgHistory?.normalizedStatus);
  const baseResult = {
    previousStatus,
    newStatus: previousStatus,
    changed: false,
    pgStatus: pgStatusRaw,
    pgStatusLabel,
    source,
  };

  if (!row || !pgHistory) {
    return { row, ...baseResult };
  }

  if (TERMINAL_WITHDRAWAL_STATUSES.has(previousStatus)) {
    return { row, ...baseResult };
  }

  const resolvedStatus = pgHistory.normalizedStatus;

  if (resolvedStatus === 'pending') {
    const payoutResponse = mergePayoutResponse(row.payout_response, {
      stage: 'pg_poll',
      gateway: 'giftaura',
      source,
      pg_status: pgStatusRaw,
      pg_history: pgHistory.raw,
    });
    const updatedRes = await query(
      `UPDATE withdrawal_transactions
       SET payout_response = $2,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [row.id, payoutResponse]
    );
    return {
      row: updatedRes.rows[0],
      previousStatus,
      newStatus: 'pending',
      changed: false,
      pgStatus: pgStatusRaw,
      pgStatusLabel,
      source,
    };
  }

  if (resolvedStatus === 'successful') {
    const paymentRef = pgHistory.payoutId || row.pg_reference || row.order_id;
    const payoutResponse = mergePayoutResponse(row.payout_response, {
      stage: 'pg_poll_success',
      gateway: 'giftaura',
      source,
      pg_status: pgStatusRaw,
      pg_history: pgHistory.raw,
    });
    const updatedRes = await query(
      `UPDATE withdrawal_transactions
       SET status = 'successful',
           pg_reference = COALESCE($2, pg_reference),
           payout_response = $3,
           pg_remark = NULL,
           reviewed_at = COALESCE(reviewed_at, NOW()),
           completed_at = COALESCE(completed_at, NOW()),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [row.id, paymentRef, payoutResponse]
    );
    const updatedRow = updatedRes.rows[0];
    if (previousStatus !== 'successful') {
      try {
        await sendWithdrawalUserNotification(
          updatedRow,
          notificationService.NOTIFICATION_EVENTS.WITHDRAWAL_SUCCESS
        );
      } catch (notifyError) {
        console.error('withdrawal success notification error:', notifyError.message);
      }
    }
    return {
      row: updatedRow,
      previousStatus,
      newStatus: 'successful',
      changed: previousStatus !== 'successful',
      pgStatus: pgStatusRaw,
      pgStatusLabel,
      source,
    };
  }

  if (resolvedStatus === 'failed') {
    const totalDebit = roundCurrency(Number(row.amount) + Number(row.handling_fee));
    await refundFailedWithdrawal({
      userId: row.user_id,
      withdrawalId: row.id,
      totalDebit,
      reason: 'Payout failed at gateway',
      gatewayResponse: pgHistory.raw,
      newStatus: 'failed',
      payoutStage: 'pg_poll_failed',
    });
    const updatedRes = await query('SELECT * FROM withdrawal_transactions WHERE id = $1', [row.id]);
    const updatedRow = updatedRes.rows[0];
    if (previousStatus !== 'failed' && previousStatus !== 'rejected') {
      try {
        await sendWithdrawalUserNotification(
          updatedRow,
          notificationService.NOTIFICATION_EVENTS.WITHDRAWAL_FAILED
        );
      } catch (notifyError) {
        console.error('withdrawal failed notification error:', notifyError.message);
      }
    }
    return {
      row: updatedRow,
      previousStatus,
      newStatus: updatedRow?.status || 'failed',
      changed: previousStatus !== 'failed' && previousStatus !== 'rejected',
      pgStatus: pgStatusRaw,
      pgStatusLabel,
      source,
    };
  }

  return { row, ...baseResult };
}

async function recordPgHistoryNotFound(row, { source = 'poll' } = {}) {
  const payoutResponse = mergePayoutResponse(row.payout_response, {
    stage: 'pg_poll_not_found',
    gateway: 'giftaura',
    source,
    order_id: row.order_id,
  });
  const updatedRes = await query(
    `UPDATE withdrawal_transactions
     SET payout_response = $2,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [row.id, payoutResponse]
  );
  return updatedRes.rows[0];
}

async function syncWithdrawalStatusFromPg({ withdrawalId, source = 'manual' } = {}) {
  const rowRes = await query('SELECT * FROM withdrawal_transactions WHERE id = $1', [withdrawalId]);
  const row = rowRes.rows[0];
  if (!row) {
    const error = new Error('Withdrawal not found');
    error.code = 'WITHDRAWAL_NOT_FOUND';
    throw error;
  }
  if (!row.order_id) {
    const error = new Error('Withdrawal has no order_id');
    error.code = 'WITHDRAWAL_NO_ORDER_ID';
    throw error;
  }
  if (!giftauraPayoutService.isConfigured()) {
    const error = new Error('Payout gateway is not configured');
    error.code = 'PG_NOT_CONFIGURED';
    throw error;
  }
  if (row.status !== 'pending') {
    const error = new Error(`Cannot sync PG status while withdrawal status is ${row.status}`);
    error.code = 'WITHDRAWAL_NOT_SYNCABLE';
    throw error;
  }

  const pgHistory = await giftauraPayoutService.fetchPayoutHistoryByOrderId(row.order_id);
  if (!pgHistory) {
    const updatedRow = await recordPgHistoryNotFound(row, { source });
    return {
      withdrawal: withdrawalTxModel.formatDetail(updatedRow),
      previousStatus: row.status,
      newStatus: row.status,
      changed: false,
      pgStatus: null,
      pgStatusLabel: 'Not found at PG',
      message: 'Order not found at payout gateway yet',
    };
  }

  const result = await applyPayoutStatusFromPgHistory(row, pgHistory, { source });
  let message = 'Status checked — still processing at PG';
  if (result.changed && result.newStatus === 'successful') {
    message = 'Withdrawal marked successful';
  } else if (result.changed && result.newStatus === 'failed') {
    message = 'Withdrawal marked failed and refunded to wallet';
  }

  return {
    withdrawal: withdrawalTxModel.formatDetail(result.row),
    previousStatus: result.previousStatus,
    newStatus: result.newStatus,
    changed: result.changed,
    pgStatus: result.pgStatus,
    pgStatusLabel: result.pgStatusLabel,
    message,
  };
}

async function syncPendingWithdrawalsFromPg({ trigger = 'cron' } = {}) {
  if (!giftauraPayoutService.isConfigured()) {
    return { skipped: true, reason: 'pg_not_configured' };
  }

  const res = await query(
    `SELECT *
     FROM withdrawal_transactions
     WHERE status = 'pending'
       AND order_id IS NOT NULL
       AND requested_at < NOW() - ($1::text || ' minutes')::interval
     ORDER BY requested_at ASC
     LIMIT $2`,
    [String(WITHDRAWAL_PAYOUT_SYNC_MIN_AGE_MINUTES), WITHDRAWAL_PAYOUT_SYNC_BATCH_LIMIT]
  );

  const stats = {
    checked: 0,
    changed: 0,
    successful: 0,
    failed: 0,
    still_pending: 0,
    not_found: 0,
    errors: 0,
    trigger,
  };

  for (const row of res.rows) {
    stats.checked += 1;
    try {
      const pgHistory = await giftauraPayoutService.fetchPayoutHistoryByOrderId(row.order_id);
      if (!pgHistory) {
        stats.not_found += 1;
        await recordPgHistoryNotFound(row, { source: trigger });
        continue;
      }

      const result = await applyPayoutStatusFromPgHistory(row, pgHistory, { source: trigger });
      if (result.changed) {
        stats.changed += 1;
        if (result.newStatus === 'successful') stats.successful += 1;
        if (result.newStatus === 'failed') stats.failed += 1;
      } else if (result.newStatus === 'pending') {
        stats.still_pending += 1;
      }
    } catch (error) {
      stats.errors += 1;
      console.error(
        `[withdrawal-payout-sync] order ${row.order_id} failed:`,
        error.message
      );
    }
  }

  return stats;
}

async function handlePayoutCallback(query = {}) {
  const { orderId, paymentRef, status } = giftauraPayoutService.extractCallbackFields(query);
  if (!orderId) {
    const error = new Error('order_id is required');
    error.code = 'INVALID_CALLBACK';
    throw error;
  }

  const row = await withdrawalTxModel.findByOrderId(orderId);
  if (!row) return null;

  const resolvedStatus = status || 'successful';
  const completedAt = ['successful', 'failed'].includes(resolvedStatus) ? new Date() : null;

  const result = await pool.query(
    `UPDATE withdrawal_transactions
     SET status = $2,
         pg_reference = COALESCE($3, pg_reference),
         payout_response = COALESCE($4, payout_response),
         reviewed_at = COALESCE(reviewed_at, NOW()),
         completed_at = COALESCE($5, completed_at),
         updated_at = NOW()
     WHERE order_id = $1
     RETURNING *`,
    [
      orderId,
      resolvedStatus,
      paymentRef || null,
      JSON.stringify({ stage: 'pg_callback', gateway: 'giftaura', query }),
      completedAt,
    ]
  );

  if (resolvedStatus === 'failed' && row.status !== 'failed') {
    const totalDebit = roundCurrency(Number(row.amount) + Number(row.handling_fee));
    await refundFailedWithdrawal({
      userId: row.user_id,
      withdrawalId: row.id,
      totalDebit,
      reason: 'Payout callback failed',
      gatewayResponse: query,
    });
    try {
      await sendWithdrawalUserNotification(
        result.rows[0],
        notificationService.NOTIFICATION_EVENTS.WITHDRAWAL_FAILED
      );
    } catch (notifyError) {
      console.error('withdrawal failed notification error:', notifyError.message);
    }
  } else if (resolvedStatus === 'successful' && row.status !== 'successful') {
    try {
      await sendWithdrawalUserNotification(
        result.rows[0],
        notificationService.NOTIFICATION_EVENTS.WITHDRAWAL_SUCCESS
      );
    } catch (notifyError) {
      console.error('withdrawal success notification error:', notifyError.message);
    }
  }

  return {
    tx: withdrawalTxModel.formatDetail(result.rows[0]),
    resolvedStatus,
  };
}

async function settleWithdrawalByAdmin({ withdrawalId, adminId, phone = null }) {
  const rowRes = await query(
    `SELECT wt.*, u.phone AS user_phone
     FROM withdrawal_transactions wt
     JOIN users u ON u.id = wt.user_id
     WHERE wt.id = $1`,
    [withdrawalId]
  );
  const row = rowRes.rows[0];
  if (!row) {
    const error = new Error('Withdrawal not found');
    error.code = 'WITHDRAWAL_NOT_FOUND';
    throw error;
  }

  const settleableStatuses = new Set(['processing', 'init']);
  if (!settleableStatuses.has(row.status)) {
    const error = new Error(`Withdrawal cannot be settled while status is ${row.status}`);
    error.code = 'WITHDRAWAL_NOT_SETTLEABLE';
    throw error;
  }

  const attemptResult = await attemptPayoutForWithdrawal({
    withdrawalRow: row,
    userPhone: phone || row.user_phone || null,
    adminId,
    stageOnSuccess: 'pg_settle',
    stageOnFailure: 'pg_settle_failed',
    throwOnFailure: true,
  });

  return withdrawalTxModel.formatDetail(attemptResult.row);
}

async function rejectWithdrawalByAdmin({ withdrawalId, adminId, reason }) {
  const rowRes = await query('SELECT * FROM withdrawal_transactions WHERE id = $1', [withdrawalId]);
  const row = rowRes.rows[0];
  if (!row) {
    const error = new Error('Withdrawal not found');
    error.code = 'WITHDRAWAL_NOT_FOUND';
    throw error;
  }

  const rejectableStatuses = new Set(['processing', 'init']);
  if (!rejectableStatuses.has(row.status)) {
    const error = new Error(`Withdrawal cannot be rejected while status is ${row.status}`);
    error.code = 'WITHDRAWAL_NOT_REJECTABLE';
    throw error;
  }

  const totalDebit = roundCurrency(Number(row.amount) + Number(row.handling_fee));
  await refundFailedWithdrawal({
    userId: row.user_id,
    withdrawalId: row.id,
    totalDebit,
    reason: reason || 'Rejected by admin',
    gatewayResponse: null,
    newStatus: 'rejected',
    adminNotes: reason || 'Rejected by admin',
    adminId,
  });

  const updated = await query('SELECT * FROM withdrawal_transactions WHERE id = $1', [withdrawalId]);
  try {
    await sendWithdrawalUserNotification(
      updated.rows[0],
      notificationService.NOTIFICATION_EVENTS.WITHDRAWAL_REJECTED
    );
  } catch (notifyError) {
    console.error('withdrawal rejected notification error:', notifyError.message);
  }
  return withdrawalTxModel.formatDetail(updated.rows[0]);
}

module.exports = {
  listBankAccounts,
  addBankAccount,
  deleteBankAccount,
  validateWithdrawalRequest,
  validateUserWithdrawalEligibility,
  createWithdrawal,
  settleWithdrawalByAdmin,
  rejectWithdrawalByAdmin,
  listWithdrawals,
  getWithdrawalDetail,
  handlePayoutCallback,
  syncWithdrawalStatusFromPg,
  syncPendingWithdrawalsFromPg,
  calculateHandlingFee,
  WITHDRAWAL_MIN_AMOUNT,
  WITHDRAWAL_FEE_RATE,
};
