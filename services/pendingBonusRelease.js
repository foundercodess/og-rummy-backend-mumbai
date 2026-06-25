/**
 * Release locked pending_bonus into released_bonus when a player finishes a monetized
 * game (same rules as points loss: up to 10% of a basis amount, FIFO pending_bonus_credit).
 */

const { roundCurrency } = require('./walletDebitSplit');

const BONUS_RELEASE_TX_TYPES = ['bonus_release_credit', 'released_bonus_credit', 'release_bonus_credit'];

async function resolveEntryFeesPaidForSession(client, userId, sessionId) {
  const sid = Number(sessionId);
  const uid = Number(userId);
  if (!Number.isFinite(sid) || !Number.isFinite(uid)) return 0;

  const res = await client.query(
    `SELECT COALESCE(SUM(ABS(amount)), 0) AS total
     FROM wallet_transactions
     WHERE user_id = $1
       AND reference_type = 'game_session'
       AND reference_id = $2
       AND transaction_type = 'game_entry_debit'`,
    [uid, sid]
  );
  return roundCurrency(Number(res.rows[0]?.total || 0));
}

/**
 * @param {import('pg').PoolClient} client
 * @param {object} options
 * @param {number} options.userId
 * @param {number} options.sessionId
 * @param {number} options.basisAmount — positive INR; cap = 10% of this (e.g. loss debit or entry fees paid)
 * @param {object} [options.metadata] — merged into bonus_release_credit metadata
 * @param {{ id: number, pending_bonus?: number }} [options.prelockedWallet] — row already locked FOR UPDATE in this tx
 * @returns {Promise<{ released: number }>}
 */
async function releasePendingBonusAfterPlay(client, options = {}) {
  const {
    userId,
    sessionId,
    basisAmount,
    metadata = {},
    prelockedWallet = null,
  } = options;

  const uid = Number(userId);
  const sid = Number(sessionId);
  if (!Number.isFinite(uid) || !Number.isFinite(sid)) return { released: 0 };

  const basis = roundCurrency(Math.max(0, Number(basisAmount) || 0));
  const tenPercentRelease = roundCurrency(basis * 0.1);
  if (tenPercentRelease <= 0) return { released: 0 };

  let wallet = prelockedWallet;
  if (!wallet?.id) {
    const walletRes = await client.query(
      'SELECT id, pending_bonus FROM wallets WHERE user_id = $1 FOR UPDATE',
      [uid]
    );
    wallet = walletRes.rows[0];
  }
  if (!wallet || Number(wallet.pending_bonus) <= 0) return { released: 0 };

  const walletId = wallet.id;

  const pendingBonusRes = await client.query(
    `SELECT
       pb.id,
       pb.amount,
       pb.expires_at,
       COALESCE(releases.total_released, 0) AS released_amount
     FROM wallet_transactions pb
     LEFT JOIN (
       SELECT
         (rel.metadata->>'pending_bonus_tx_id')::int AS pending_bonus_tx_id,
         COALESCE(SUM(rel.amount), 0) AS total_released
       FROM wallet_transactions rel
       WHERE rel.user_id = $1
         AND rel.wallet_id = $2
         AND rel.transaction_type = ANY($3::text[])
         AND (rel.metadata->>'pending_bonus_tx_id') IS NOT NULL
       GROUP BY (rel.metadata->>'pending_bonus_tx_id')::int
     ) releases ON releases.pending_bonus_tx_id = pb.id
     WHERE pb.user_id = $1
       AND pb.wallet_id = $2
       AND pb.transaction_type = 'pending_bonus_credit'
       AND (pb.expires_at IS NULL OR pb.expires_at > NOW())
       AND (pb.amount - COALESCE(releases.total_released, 0)) > 0
     ORDER BY pb.expires_at ASC NULLS LAST, pb.created_at ASC, pb.id ASC
     LIMIT 1`,
    [uid, walletId, BONUS_RELEASE_TX_TYPES]
  );

  const activePending = pendingBonusRes.rows[0];
  if (!activePending) return { released: 0 };

  const pendingRemaining = roundCurrency(
    Number(activePending.amount) - Number(activePending.released_amount || 0)
  );
  const conversionAmount = roundCurrency(Math.min(
    tenPercentRelease,
    pendingRemaining,
    Number(wallet.pending_bonus) || 0
  ));

  if (conversionAmount <= 0) return { released: 0 };

  await client.query(
    `UPDATE wallets
     SET pending_bonus = GREATEST(0, pending_bonus - $2),
         released_bonus = released_bonus + $2,
         total_balance = total_balance + $2,
         updated_at    = NOW()
     WHERE id = $1`,
    [walletId, conversionAmount]
  );

  await client.query(
    `INSERT INTO wallet_transactions
       (user_id, wallet_id, transaction_type, amount, source, reference_type, reference_id, metadata)
     VALUES ($1, $2, 'bonus_release_credit', $3, 'game', 'game_session', $4, $5::jsonb)`,
    [
      uid,
      walletId,
      conversionAmount,
      sid,
      JSON.stringify({
        ...metadata,
        pending_bonus_tx_id: activePending.id,
        released_amount: conversionAmount,
        conversion_rate_percent: 10,
        based_on_basis_amount: basis,
      }),
    ]
  );

  return { released: conversionAmount };
}

module.exports = {
  resolveEntryFeesPaidForSession,
  releasePendingBonusAfterPlay,
};
