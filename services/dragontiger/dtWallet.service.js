'use strict';

const { pool } = require('../../db');
const { computeWalletDebitSplit } = require('../walletDebitSplit');
const {
  AREAS,
  isArea,
  roundCurrency,
  settleUser,
  splitCredit,
  worstCasePayout,
} = require('./dtRules.service');

const GAME_FAMILY = 'dragontiger';
const REFERENCE_TYPE = 'dt_round';

function dtError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  if (details) err.details = details;
  return err;
}

function requirePool() {
  if (!pool) throw dtError('WALLET_UNAVAILABLE', 'Wallet unavailable');
  return pool;
}

async function rollback(client) {
  try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
}

async function lockWallet(client, userId) {
  let res = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
  if (!res.rows[0]) {
    await client.query(
      `INSERT INTO wallets (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
      [userId]
    );
    res = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
  }
  return res.rows[0];
}

function spendableOf(wallet) {
  return roundCurrency(
    Number(wallet.deposit || 0) + Number(wallet.released_bonus || 0) + Number(wallet.withdrawable || 0)
  );
}

async function creditBuckets(client, wallet, { toDeposit = 0, toReleasedBonus = 0, toWithdrawable = 0 }) {
  const amount = roundCurrency(toDeposit + toReleasedBonus + toWithdrawable);
  const next = {
    deposit: roundCurrency(Number(wallet.deposit || 0) + toDeposit),
    released_bonus: roundCurrency(Number(wallet.released_bonus || 0) + toReleasedBonus),
    withdrawable: roundCurrency(Number(wallet.withdrawable || 0) + toWithdrawable),
    total_balance: roundCurrency(Number(wallet.total_balance || 0) + amount),
  };
  await client.query(
    `UPDATE wallets
     SET deposit = $2, released_bonus = $3, withdrawable = $4, total_balance = $5, updated_at = NOW()
     WHERE id = $1`,
    [wallet.id, next.deposit, next.released_bonus, next.withdrawable, next.total_balance]
  );
  return { ...wallet, ...next };
}

async function insertLedger(client, { userId, walletId, type, amount, roundId, metadata }) {
  await client.query(
    `INSERT INTO wallet_transactions (
       user_id, wallet_id, transaction_type, amount, source, reference_type, reference_id, metadata
     )
     VALUES ($1, $2, $3, $4, 'game', $5, $6, $7::jsonb)`,
    [
      userId,
      walletId,
      type,
      amount,
      REFERENCE_TYPE,
      Number(roundId),
      JSON.stringify({ game_family: GAME_FAMILY, round_id: Number(roundId), ...metadata }),
    ]
  );
}

async function lockBettingRound(client, roundId) {
  const res = await client.query(
    `SELECT id, status, dragon_total, tiger_total, tie_total, (betting_ends_at > NOW()) AS open
     FROM dt_rounds WHERE id = $1 FOR UPDATE`,
    [roundId]
  );
  const round = res.rows[0];
  if (!round) throw dtError('DT_ROUND_NOT_FOUND', 'Round not found');
  if (round.status !== 'betting' || round.open !== true) {
    throw dtError('DT_BETTING_CLOSED', 'Betting is closed for this round');
  }
  return round;
}

async function userAreaTotals(client, roundId, userId) {
  const res = await client.query(
    `SELECT area, COALESCE(SUM(amount), 0) AS total
     FROM dt_bets
     WHERE round_id = $1 AND user_id = $2 AND status = 'placed'
     GROUP BY area`,
    [roundId, userId]
  );
  const totals = { dragon: 0, tiger: 0, tie: 0 };
  for (const row of res.rows) totals[row.area] = roundCurrency(row.total);
  return totals;
}

function roundTotals(row) {
  return {
    dragon: roundCurrency(row.dragon_total),
    tiger: roundCurrency(row.tiger_total),
    tie: roundCurrency(row.tie_total),
  };
}

async function findClientBet(userId, clientBetId) {
  const res = await requirePool().query(
    'SELECT * FROM dt_bets WHERE user_id = $1 AND client_bet_id = $2',
    [userId, clientBetId]
  );
  return res.rows[0] || null;
}

/**
 * Debit the wallet and record one bet, atomically with the betting-window check
 * and the risk limits. Lock order: round row, then wallet row.
 */
async function placeBet({ roundId, userId, area, amount, clientBetId, settings }) {
  if (!isArea(area)) throw dtError('DT_INVALID_AREA', 'Invalid betting area');
  const stake = roundCurrency(amount);

  if (clientBetId) {
    const existing = await findClientBet(userId, clientBetId);
    if (existing) return { duplicate: true, bet: existing };
  }

  const client = await requirePool().connect();
  try {
    await client.query('BEGIN');
    const round = await lockBettingRound(client, roundId);

    const mine = await userAreaTotals(client, roundId, userId);
    if (roundCurrency(mine[area] + stake) > settings.max_bet_per_area) {
      throw dtError('DT_AREA_LIMIT', `Max ₹${settings.max_bet_per_area} per area`, {
        remaining: roundCurrency(Math.max(0, settings.max_bet_per_area - mine[area])),
      });
    }

    const nextTotals = roundTotals(round);
    nextTotals[area] = roundCurrency(nextTotals[area] + stake);
    if (worstCasePayout(nextTotals) > settings.max_round_payout) {
      throw dtError('DT_ROUND_LIMIT', 'Table limit reached for this round');
    }

    const wallet = await lockWallet(client, userId);
    const split = computeWalletDebitSplit(wallet, stake);
    if (split.available < stake) {
      throw dtError(
        'DT_INSUFFICIENT_BALANCE',
        `Insufficient wallet balance. Required ₹${stake}, available ₹${split.available}`,
        { required: stake, available: split.available }
      );
    }
    const nextTotal = roundCurrency(Number(wallet.total_balance || 0) - stake);
    await client.query(
      `UPDATE wallets
       SET deposit = $2, released_bonus = $3, withdrawable = $4, total_balance = $5, updated_at = NOW()
       WHERE id = $1`,
      [wallet.id, split.nextDeposit, split.nextReleasedBonus, split.nextWithdrawable, nextTotal]
    );
    await insertLedger(client, {
      userId,
      walletId: wallet.id,
      type: 'game_entry_debit',
      amount: -stake,
      roundId,
      metadata: {
        reason: 'dragontiger_bet',
        area,
        stake,
        split: {
          deposit: split.debitFromDeposit,
          released_bonus: split.debitFromReleased,
          withdrawable: split.debitFromWithdrawable,
        },
      },
    });

    const betRes = await client.query(
      `INSERT INTO dt_bets (
         round_id, user_id, area, amount, from_deposit, from_released_bonus, from_withdrawable, client_bet_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        roundId,
        userId,
        area,
        stake,
        split.debitFromDeposit,
        split.debitFromReleased,
        split.debitFromWithdrawable,
        clientBetId || null,
      ]
    );

    const column = `${area}_total`;
    const totalsRes = await client.query(
      `UPDATE dt_rounds
       SET ${column} = ${column} + $2,
           total_staked = total_staked + $2,
           totals_version = totals_version + 1
       WHERE id = $1
       RETURNING dragon_total, tiger_total, tie_total, totals_version`,
      [roundId, stake]
    );
    await client.query('COMMIT');

    mine[area] = roundCurrency(mine[area] + stake);
    return {
      duplicate: false,
      bet: betRes.rows[0],
      totals: roundTotals(totalsRes.rows[0]),
      totals_version: Number(totalsRes.rows[0].totals_version),
      my_bets: mine,
      wallet: {
        total_balance: nextTotal,
        spendable: roundCurrency(split.available - stake),
      },
    };
  } catch (err) {
    await rollback(client);
    if (err.code === '23505' && clientBetId) {
      const existing = await findClientBet(userId, clientBetId);
      if (existing) return { duplicate: true, bet: existing };
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Refund every open bet of the user in the current betting window (Clear). */
async function clearBets({ roundId, userId }) {
  const client = await requirePool().connect();
  try {
    await client.query('BEGIN');
    await lockBettingRound(client, roundId);

    const betsRes = await client.query(
      `SELECT id, area, amount, from_deposit, from_released_bonus, from_withdrawable
       FROM dt_bets
       WHERE round_id = $1 AND user_id = $2 AND status = 'placed'
       FOR UPDATE`,
      [roundId, userId]
    );
    const bets = betsRes.rows;
    if (bets.length === 0) {
      await client.query('COMMIT');
      return { refunded: 0, cleared: { dragon: 0, tiger: 0, tie: 0 }, totals: null };
    }

    const cleared = { dragon: 0, tiger: 0, tie: 0 };
    let toDeposit = 0;
    let toReleasedBonus = 0;
    let toWithdrawable = 0;
    for (const bet of bets) {
      cleared[bet.area] = roundCurrency(cleared[bet.area] + Number(bet.amount));
      toDeposit += Number(bet.from_deposit);
      toReleasedBonus += Number(bet.from_released_bonus);
      toWithdrawable += Number(bet.from_withdrawable);
    }
    const refund = roundCurrency(cleared.dragon + cleared.tiger + cleared.tie);

    const wallet = await lockWallet(client, userId);
    const nextWallet = await creditBuckets(client, wallet, {
      toDeposit: roundCurrency(toDeposit),
      toReleasedBonus: roundCurrency(toReleasedBonus),
      toWithdrawable: roundCurrency(toWithdrawable),
    });
    await insertLedger(client, {
      userId,
      walletId: wallet.id,
      type: 'game_refund_credit',
      amount: refund,
      roundId,
      metadata: { reason: 'dragontiger_clear_bets', cleared },
    });

    await client.query(
      `UPDATE dt_bets SET status = 'refunded', settled_at = NOW() WHERE id = ANY($1::bigint[])`,
      [bets.map((bet) => bet.id)]
    );
    const totalsRes = await client.query(
      `UPDATE dt_rounds
       SET dragon_total = dragon_total - $2,
           tiger_total = tiger_total - $3,
           tie_total = tie_total - $4,
           total_staked = total_staked - $5,
           totals_version = totals_version + 1
       WHERE id = $1
       RETURNING dragon_total, tiger_total, tie_total, totals_version`,
      [roundId, cleared.dragon, cleared.tiger, cleared.tie, refund]
    );
    await client.query('COMMIT');

    return {
      refunded: refund,
      cleared,
      totals: roundTotals(totalsRes.rows[0]),
      totals_version: Number(totalsRes.rows[0].totals_version),
      wallet: {
        total_balance: nextWallet.total_balance,
        spendable: spendableOf(nextWallet),
      },
    };
  } catch (err) {
    await rollback(client);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Settle one user for a decided round. The dt_round_settlements insert is the
 * idempotency gate, so re-running after a crash never double-credits.
 */
async function settleUserForRound({ round, entry }) {
  const outcome = round.result;
  const commissionPercent = Number(round.commission_percent) || 0;
  const summary = settleUser(entry.stakes, outcome, commissionPercent);

  const client = await requirePool().connect();
  try {
    await client.query('BEGIN');
    const gate = await client.query(
      `INSERT INTO dt_round_settlements (round_id, user_id, staked, returned, commission, credited, net)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (round_id, user_id) DO NOTHING
       RETURNING round_id`,
      [
        round.id,
        entry.user_id,
        summary.staked,
        summary.returned,
        summary.commission,
        summary.credited,
        summary.net,
      ]
    );
    if (gate.rows.length === 0) {
      await client.query('ROLLBACK');
      return { already_settled: true, user_id: entry.user_id, ...summary };
    }

    let wallet;
    if (summary.credited > 0) {
      wallet = await lockWallet(client, entry.user_id);
      const split = splitCredit({
        staked: summary.staked,
        credited: summary.credited,
        fromDeposit: entry.from_deposit,
        fromReleasedBonus: entry.from_released_bonus,
        fromWithdrawable: entry.from_withdrawable,
      });
      wallet = await creditBuckets(client, wallet, split);
      await insertLedger(client, {
        userId: entry.user_id,
        walletId: wallet.id,
        type: summary.net > 0 ? 'game_win_credit' : 'game_refund_credit',
        amount: summary.credited,
        roundId: round.id,
        metadata: {
          reason: summary.net > 0 ? 'dragontiger_win' : 'dragontiger_tie_half_back',
          outcome,
          staked: summary.staked,
          returned: summary.returned,
          commission: summary.commission,
          commission_percent: commissionPercent,
          split: {
            deposit: split.toDeposit,
            released_bonus: split.toReleasedBonus,
            withdrawable: split.toWithdrawable,
          },
        },
      });
    } else {
      const res = await client.query('SELECT * FROM wallets WHERE user_id = $1', [entry.user_id]);
      wallet = res.rows[0] || { total_balance: 0 };
    }

    await client.query(
      `UPDATE dt_bets
       SET status = CASE
             WHEN area = $3 THEN 'won'
             WHEN $3 = 'tie' THEN 'half_back'
             ELSE 'lost'
           END,
           payout = CASE
             WHEN area = $3 AND area = 'tie' THEN ROUND(amount * 9, 2)
             WHEN area = $3 THEN ROUND(amount * 2, 2)
             WHEN $3 = 'tie' THEN ROUND(amount * 0.5, 2)
             ELSE 0
           END,
           settled_at = NOW()
       WHERE round_id = $1 AND user_id = $2 AND status = 'placed'`,
      [round.id, entry.user_id, outcome]
    );
    await client.query('COMMIT');

    return {
      already_settled: false,
      user_id: entry.user_id,
      ...summary,
      wallet: {
        total_balance: roundCurrency(wallet.total_balance),
        spendable: spendableOf(wallet),
      },
    };
  } catch (err) {
    await rollback(client);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  AREAS,
  placeBet,
  clearBets,
  settleUserForRound,
};
