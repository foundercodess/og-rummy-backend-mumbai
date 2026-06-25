const { query } = require('../db');

function toNumber(v) {
  return v == null ? 0 : Number(v);
}

function formatForResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    wallet_id: row.wallet_id,
    transaction_type: row.transaction_type,
    amount: toNumber(row.amount),
    source: row.source,
    type: row.type,
    reference_type: row.reference_type,
    reference_id: row.reference_id,
    expires_at: row.expires_at,
    metadata: row.metadata,
    created_at: row.created_at,
    released_amount: row.released_amount == null ? undefined : toNumber(row.released_amount),
    remaining_amount: row.remaining_amount == null ? undefined : toNumber(row.remaining_amount),
    status: row.status == null ? undefined : row.status,
    using: row.using == null ? undefined : Boolean(row.using),
  };
}

async function listDepositCreditsForRechargeTxIds({ userId, rechargeTransactionIds }) {
  if (!Array.isArray(rechargeTransactionIds) || rechargeTransactionIds.length === 0) return [];
  const result = await query(
    `SELECT *
     FROM wallet_transactions
     WHERE user_id = $1
       AND transaction_type = 'deposit_credit'
       AND source = 'recharge'
       AND reference_type = 'recharge_transaction'
       AND reference_id = ANY($2::int[])
     ORDER BY created_at ASC, id ASC`,
    [userId, rechargeTransactionIds]
  );
  return result.rows.map(formatForResponse);
}

async function listPendingBonusHistory({ userId, limit = 50, offset = 0 }) {
  const safeLimit = Number.isNaN(Number(limit)) ? 50 : Math.min(Number(limit), 100);
  const safeOffset = Number.isNaN(Number(offset)) ? 0 : Math.max(Number(offset), 0);

  const result = await query(
    `WITH pending_rows AS (
       SELECT
         wt.id,
         wt.user_id,
         wt.wallet_id,
         wt.type,
         wt.source,
         wt.amount,
         wt.reference_type,
         wt.reference_id,
         wt.expires_at,
         wt.metadata,
         wt.created_at
       FROM wallet_transactions wt
       WHERE wt.user_id = $1
         AND wt.transaction_type = 'pending_bonus_credit'
     ),
     released_by_pending AS (
       SELECT
         (rel.metadata->>'pending_bonus_tx_id')::int AS pending_bonus_tx_id,
         COALESCE(SUM(rel.amount), 0) AS released_amount
       FROM wallet_transactions rel
       WHERE rel.user_id = $1
         AND rel.transaction_type = ANY($4::text[])
         AND (rel.metadata->>'pending_bonus_tx_id') IS NOT NULL
       GROUP BY (rel.metadata->>'pending_bonus_tx_id')::int
     ),
     annotated AS (
       SELECT
         p.*,
         COALESCE(r.released_amount, 0)::numeric(12,2) AS released_amount,
         GREATEST(0, p.amount - COALESCE(r.released_amount, 0))::numeric(12,2) AS remaining_amount,
         CASE
           WHEN GREATEST(0, p.amount - COALESCE(r.released_amount, 0)) <= 0 THEN 'completed'
           WHEN p.expires_at IS NOT NULL AND p.expires_at <= NOW() THEN 'expired'
           ELSE 'valid'
         END AS status
       FROM pending_rows p
       LEFT JOIN released_by_pending r ON r.pending_bonus_tx_id = p.id
     ),
     active_row AS (
       SELECT id
       FROM annotated
       WHERE status = 'valid'
         AND remaining_amount > 0
       ORDER BY expires_at ASC NULLS LAST, created_at ASC, id ASC
       LIMIT 1
     )
     SELECT
       a.*,
       CASE WHEN ar.id IS NOT NULL AND a.id = ar.id THEN true ELSE false END AS using
     FROM annotated a
     LEFT JOIN active_row ar ON true
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $2 OFFSET $3`,
    [userId, safeLimit, safeOffset, ['bonus_release_credit', 'released_bonus_credit', 'release_bonus_credit']]
  );

  // Normalize output to match wallet_transactions rows plus derived bonus status fields.
  return result.rows.map((row) =>
    formatForResponse({
      ...row,
      transaction_type: 'pending_bonus_credit',
    })
  );
}

/**
 * Aggregate summary for the user's pending bonus across ALL rows (not paginated).
 *
 * The listing endpoint paginates, and marks only the single currently-active
 * pending bonus with `using: true`. UIs that only read from the active row see
 * totals "reset" as soon as one pending bonus completes and the next becomes
 * active. This summary exposes the full picture so clients can show stable,
 * cumulative numbers alongside the active row.
 */
async function getPendingBonusSummary({ userId }) {
  const result = await query(
    `WITH pending_rows AS (
       SELECT wt.id, wt.amount, wt.expires_at, wt.created_at
       FROM wallet_transactions wt
       WHERE wt.user_id = $1
         AND wt.transaction_type = 'pending_bonus_credit'
     ),
     released_by_pending AS (
       SELECT
         (rel.metadata->>'pending_bonus_tx_id')::int AS pending_bonus_tx_id,
         COALESCE(SUM(rel.amount), 0) AS released_amount
       FROM wallet_transactions rel
       WHERE rel.user_id = $1
         AND rel.transaction_type = ANY($2::text[])
         AND (rel.metadata->>'pending_bonus_tx_id') IS NOT NULL
       GROUP BY (rel.metadata->>'pending_bonus_tx_id')::int
     ),
     annotated AS (
       SELECT
         p.id,
         p.amount,
         p.expires_at,
         p.created_at,
         COALESCE(r.released_amount, 0)::numeric(12,2) AS released_amount,
         GREATEST(0, p.amount - COALESCE(r.released_amount, 0))::numeric(12,2) AS remaining_amount,
         CASE
           WHEN GREATEST(0, p.amount - COALESCE(r.released_amount, 0)) <= 0 THEN 'completed'
           WHEN p.expires_at IS NOT NULL AND p.expires_at <= NOW() THEN 'expired'
           ELSE 'valid'
         END AS status
       FROM pending_rows p
       LEFT JOIN released_by_pending r ON r.pending_bonus_tx_id = p.id
     ),
     totals AS (
       SELECT
         COALESCE(SUM(amount), 0)::numeric(12,2)            AS total_credited,
         COALESCE(SUM(released_amount), 0)::numeric(12,2)   AS total_released,
         COALESCE(SUM(CASE WHEN status = 'valid'   THEN remaining_amount ELSE 0 END), 0)::numeric(12,2) AS total_remaining,
         COALESCE(SUM(CASE WHEN status = 'expired' THEN remaining_amount ELSE 0 END), 0)::numeric(12,2) AS total_expired_remaining,
         COUNT(*)::int                                          AS total_count,
         COUNT(*) FILTER (WHERE status = 'valid')::int          AS valid_count,
         COUNT(*) FILTER (WHERE status = 'completed')::int      AS completed_count,
         COUNT(*) FILTER (WHERE status = 'expired')::int        AS expired_count
       FROM annotated
     ),
     active_row AS (
       SELECT id, amount, released_amount, remaining_amount, expires_at, created_at
       FROM annotated
       WHERE status = 'valid' AND remaining_amount > 0
       ORDER BY expires_at ASC NULLS LAST, created_at ASC, id ASC
       LIMIT 1
     )
     SELECT
       t.*,
       a.id              AS active_id,
       a.amount          AS active_amount,
       a.released_amount AS active_released_amount,
       a.remaining_amount AS active_remaining_amount,
       a.expires_at      AS active_expires_at,
       a.created_at      AS active_created_at
     FROM totals t
     LEFT JOIN active_row a ON true`,
    [userId, ['bonus_release_credit', 'released_bonus_credit', 'release_bonus_credit']]
  );

  const row = result.rows[0] || {};

  return {
    totals: {
      credited: toNumber(row.total_credited),
      released: toNumber(row.total_released),
      remaining: toNumber(row.total_remaining),
      expired_remaining: toNumber(row.total_expired_remaining),
    },
    counts: {
      total: Number(row.total_count) || 0,
      valid: Number(row.valid_count) || 0,
      completed: Number(row.completed_count) || 0,
      expired: Number(row.expired_count) || 0,
    },
    active: row.active_id
      ? {
          id: row.active_id,
          amount: toNumber(row.active_amount),
          released_amount: toNumber(row.active_released_amount),
          remaining_amount: toNumber(row.active_remaining_amount),
          expires_at: row.active_expires_at,
          created_at: row.active_created_at,
        }
      : null,
  };
}

async function listUserWalletTransactions({
  userId,
  limit = 50,
  offset = 0,
  fromDate = null,
  toDate = null,
  filter = 'all',
}) {
  const safeLimit = Number.isNaN(Number(limit)) ? 50 : Math.min(Number(limit), 100);
  const safeOffset = Number.isNaN(Number(offset)) ? 0 : Math.max(Number(offset), 0);

  const params = [userId];
  let idx = params.length + 1;
  const where = ['wt.user_id = $1'];

  if (fromDate) {
    where.push(`wt.created_at >= $${idx++}`);
    params.push(fromDate);
  }
  if (toDate) {
    where.push(`wt.created_at <= $${idx++}`);
    params.push(toDate);
  }

  const filterKey = String(filter || 'all').trim().toLowerCase();
  if (filterKey === 'won') {
    where.push(`wt.transaction_type = $${idx++}`);
    params.push('game_win_credit');
  } else if (filterKey === 'lost') {
    where.push(`wt.transaction_type = ANY($${idx++}::text[])`);
    params.push(['game_loss_debit', 'game_entry_debit']);
  } else if (filterKey === 'money_add') {
    // Keep add-cash history behavior intact: this filter is for recharge credits only.
    where.push(`wt.transaction_type = $${idx++}`);
    params.push('deposit_credit');
    where.push(`wt.source = $${idx++}`);
    params.push('recharge');
  } else if (filterKey === 'withdraw') {
    where.push(`wt.transaction_type = ANY($${idx++}::text[])`);
    params.push(['withdraw_debit', 'withdrawal_debit']);
  } else if (filterKey === 'release_bonus') {
    where.push(`wt.transaction_type = ANY($${idx++}::text[])`);
    params.push(['bonus_release_credit', 'released_bonus_credit', 'release_bonus_credit']);
  }

  params.push(safeLimit, safeOffset);

  const result = await query(
    `SELECT
       wt.*,
       gs.game_id AS session_game_id,
       gs.contest_id AS session_contest_id,
       gs.metadata AS session_metadata,
       g.name AS game_name,
       c.entry AS contest_entry,
       c.point_value AS contest_point_value
     FROM wallet_transactions wt
     LEFT JOIN game_sessions gs
       ON wt.reference_type = 'game_session'
      AND gs.id = wt.reference_id
     LEFT JOIN games g ON g.id = gs.game_id
     LEFT JOIN contests c ON c.id = gs.contest_id
     WHERE ${where.join(' AND ')}
     ORDER BY wt.created_at DESC, wt.id DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );

  return result.rows;
}

module.exports = {
  formatForResponse,
  listDepositCreditsForRechargeTxIds,
  listPendingBonusHistory,
  getPendingBonusSummary,
  listUserWalletTransactions,
};

