'use strict';

const { pool } = require('../../db');
const { computeWalletDebitSplit, roundCurrency } = require('../walletDebitSplit');

function shouldSettle(session) {
  if (!session) return false;
  if (session.metadata?.practice_mode === true) return false;
  if (session.metadata?.practice_bot_only === true) return false;
  return true;
}

function insufficientError(required, available) {
  const err = new Error(
    `Insufficient wallet balance. Required ₹${required}, available ₹${available}`
  );
  err.code = 'TP_INSUFFICIENT_BALANCE';
  err.details = { required, available };
  return err;
}

async function debitStake({ sessionId, userId, amount, reason, roundNo = null }) {
  const stake = roundCurrency(amount);
  if (!(stake > 0)) {
    return { actualDebit: 0, total_balance: null };
  }
  if (!pool) {
    const err = new Error('Wallet debit unavailable');
    err.code = 'WALLET_UNAVAILABLE';
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let walletRes = await client.query(
      'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (!walletRes.rows[0]) {
      await client.query(
        `INSERT INTO wallets (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
        [userId]
      );
      walletRes = await client.query(
        'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
        [userId]
      );
    }

    const wallet = walletRes.rows[0];
    const debitSplit = computeWalletDebitSplit(wallet, stake);
    if (debitSplit.available < stake) {
      throw insufficientError(stake, debitSplit.available);
    }

    const nextTotal = roundCurrency(Number(wallet.total_balance || 0) - stake);
    await client.query(
      `UPDATE wallets
       SET deposit = $2,
           released_bonus = $3,
           withdrawable = $4,
           total_balance = $5,
           updated_at = NOW()
       WHERE id = $1`,
      [
        wallet.id,
        debitSplit.nextDeposit,
        debitSplit.nextReleasedBonus,
        debitSplit.nextWithdrawable,
        nextTotal,
      ]
    );
    await client.query(
      `INSERT INTO wallet_transactions (
         user_id, wallet_id, transaction_type, amount, source, reference_type, reference_id, metadata
       )
       VALUES ($1, $2, 'game_entry_debit', $3, 'game', 'game_session', $4, $5::jsonb)`,
      [
        userId,
        wallet.id,
        -stake,
        sessionId,
        JSON.stringify({
          reason: reason || 'teenpatti_stake',
          game_family: 'teenpatti',
          session_id: sessionId,
          round_no: roundNo,
          stake,
        }),
      ]
    );
    await client.query('COMMIT');
    return { actualDebit: stake, total_balance: nextTotal };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function creditWin({ sessionId, userId, amount, reason, roundNo = null }) {
  const credit = roundCurrency(amount);
  if (!(credit > 0)) {
    return { total_balance: null, credited: 0 };
  }
  if (!pool) {
    const err = new Error('Wallet credit unavailable');
    err.code = 'WALLET_UNAVAILABLE';
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let walletRes = await client.query(
      'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (!walletRes.rows[0]) {
      await client.query(
        `INSERT INTO wallets (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
        [userId]
      );
      walletRes = await client.query(
        'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
        [userId]
      );
    }
    const wallet = walletRes.rows[0];
    const nextWithdrawable = roundCurrency(Number(wallet.withdrawable || 0) + credit);
    const nextTotal = roundCurrency(Number(wallet.total_balance || 0) + credit);
    await client.query(
      `UPDATE wallets
       SET withdrawable = $2,
           total_balance = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [wallet.id, nextWithdrawable, nextTotal]
    );
    await client.query(
      `INSERT INTO wallet_transactions (
         user_id, wallet_id, transaction_type, amount, source, reference_type, reference_id, metadata
       )
       VALUES ($1, $2, 'game_win_credit', $3, 'game', 'game_session', $4, $5::jsonb)`,
      [
        userId,
        wallet.id,
        credit,
        sessionId,
        JSON.stringify({
          reason: reason || 'teenpatti_win',
          game_family: 'teenpatti',
          session_id: sessionId,
          round_no: roundNo,
          amount: credit,
        }),
      ]
    );
    await client.query('COMMIT');
    return { total_balance: nextTotal, credited: credit };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  shouldSettle,
  debitStake,
  creditWin,
  roundCurrency,
};
