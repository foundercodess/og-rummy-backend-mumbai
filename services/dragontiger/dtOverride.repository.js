'use strict';

const { query } = require('../../db');

/**
 * Insert a pending override for a specific future round.
 * Refuses if that round already has a pending override.
 */
async function schedule({ targetRound, result, adminId }) {
    try {
        const res = await query(
            `INSERT INTO dt_override_queue (target_round, result, created_by)
       VALUES ($1, $2, $3)
       RETURNING *`,
            [Number(targetRound), String(result).toLowerCase(), adminId || null]
        );
        return res.rows[0];
    } catch (err) {
        if (err.code === '23505') {
            const e = new Error(`Round ${targetRound} already has a pending override`);
            e.code = 'DT_OVERRIDE_EXISTS';
            throw e;
        }
        throw err;
    }
}

/** Cancel a pending override. No-op if already applied/cancelled. */
async function cancel({ overrideId, adminId }) {
    const res = await query(
        `UPDATE dt_override_queue
     SET cancelled_at = NOW(), cancelled_by = $2
     WHERE id = $1 AND applied_at IS NULL AND cancelled_at IS NULL
     RETURNING *`,
        [Number(overrideId), adminId || null]
    );
    return res.rows[0] || null;
}

/** The pending override for a specific round, if any. */
async function findForRound(roundId) {
    const res = await query(
        `SELECT * FROM dt_override_queue
     WHERE target_round = $1 AND applied_at IS NULL AND cancelled_at IS NULL
     LIMIT 1`,
        [Number(roundId)]
    );
    return res.rows[0] || null;
}

/**
 * Mark an override as applied to the round that just locked.
 * Idempotent: re-running updates nothing.
 */
async function markApplied({ overrideId, appliedRound }) {
    await query(
        `UPDATE dt_override_queue
     SET applied_at = NOW(), applied_round = $2
     WHERE id = $1 AND applied_at IS NULL`,
        [Number(overrideId), Number(appliedRound)]
    );
}

/**
 * Pending overrides for rounds >= `fromRound`, newest target last.
 * Also used to preview the "next N rounds" list.
 */
async function listPending({ fromRound = 0, limit = 50 } = {}) {
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    const res = await query(
        `SELECT id, target_round, result, created_by, created_at
     FROM dt_override_queue
     WHERE applied_at IS NULL AND cancelled_at IS NULL
       AND target_round >= $1
     ORDER BY target_round ASC
     LIMIT $2`,
        [Number(fromRound) || 0, safeLimit]
    );
    return res.rows.map((r) => ({
        id: Number(r.id),
        target_round: Number(r.target_round),
        result: r.result,
        created_by: r.created_by ? Number(r.created_by) : null,
        created_at: r.created_at,
    }));
}

/** Full history — pending, applied, cancelled. Paginated. */
async function listAll({ page = 1, limit = 50, status = null } = {}) {
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    const where = [];
    const params = [];
    if (status === 'pending') {
        where.push(`applied_at IS NULL AND cancelled_at IS NULL`);
    } else if (status === 'applied') {
        where.push(`applied_at IS NOT NULL`);
    } else if (status === 'cancelled') {
        where.push(`cancelled_at IS NOT NULL`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    //   const [rows, count] = await Promise.all([
    //     query(
    //       `SELECT o.*,
    //               a1.name AS created_by_name, a1.view_id AS created_by_view_id,
    //               a2.name AS cancelled_by_name
    //        FROM dt_override_queue o
    //        LEFT JOIN admins a1 ON a1.id = o.created_by
    //        LEFT JOIN admins a2 ON a2.id = o.cancelled_by
    //        ${whereSql}
    //        ORDER BY o.created_at DESC
    //        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    //       [...params, safeLimit, offset]
    //     ),
    //     query(`SELECT COUNT(*)::int AS total FROM dt_override_queue o ${whereSql}`, params),
    //   ]);

    const [rows, count] = await Promise.all([
        query(
            `SELECT o.*,
              a1.email AS created_by_email,
              a2.email AS cancelled_by_email
       FROM dt_override_queue o
       LEFT JOIN admins a1 ON a1.id = o.created_by
       LEFT JOIN admins a2 ON a2.id = o.cancelled_by
       ${whereSql}
       ORDER BY o.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, safeLimit, offset]
        ),
        query(`SELECT COUNT(*)::int AS total FROM dt_override_queue o ${whereSql}`, params),
    ]);

    return {
        page: safePage,
        limit: safeLimit,
        total: count.rows[0]?.total || 0,
        // overrides: rows.rows.map((r) => ({
        //     id: Number(r.id),
        //     target_round: Number(r.target_round),
        //     result: r.result,
        //     status: r.applied_at ? 'applied' : r.cancelled_at ? 'cancelled' : 'pending',
        //     created_at: r.created_at,
        //     created_by: r.created_by ? Number(r.created_by) : null,
        //     created_by_name: r.created_by_name || null,
        //     created_by_view_id: r.created_by_view_id || null,
        //     applied_at: r.applied_at,
        //     applied_round: r.applied_round ? Number(r.applied_round) : null,
        //     cancelled_at: r.cancelled_at,
        //     cancelled_by: r.cancelled_by ? Number(r.cancelled_by) : null,
        //     cancelled_by_name: r.cancelled_by_name || null,
        // })),

        overrides: rows.rows.map((r) => ({
            id: Number(r.id),
            target_round: Number(r.target_round),
            result: r.result,
            status: r.applied_at ? 'applied' : r.cancelled_at ? 'cancelled' : 'pending',
            created_at: r.created_at,
            created_by: r.created_by ? Number(r.created_by) : null,
            created_by_email: r.created_by_email || null,       // <- renamed
            applied_at: r.applied_at,
            applied_round: r.applied_round ? Number(r.applied_round) : null,
            cancelled_at: r.cancelled_at,
            cancelled_by: r.cancelled_by ? Number(r.cancelled_by) : null,
            cancelled_by_email: r.cancelled_by_email || null,   // <- renamed
          })),
    };
}

module.exports = {
    schedule,
    cancel,
    findForRound,
    markApplied,
    listPending,
    listAll,
};