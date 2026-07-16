const { pool } = require('../db');
const sessionCache = require('./sessionCache.service');
const liveSessionState = require('./liveSessionState.service');

// Lobbies with no row activity past this window are cancelled (waiting/ready only). Tune via STALE_SESSION_CANCEL_AFTER_HOURS (e.g. 3).
const DEFAULT_STALE_AFTER_HOURS = 2;
const DEFAULT_MAX_BATCH = 500;
const MIN_STALE_HOURS = 1;
const MAX_STALE_HOURS = 720;
const MIN_BATCH = 1;
const MAX_BATCH = 5000;

function resolveStaleAfterHours(override) {
  if (override != null && override !== '') {
    const n = Number(override);
    if (!Number.isInteger(n) || n < MIN_STALE_HOURS || n > MAX_STALE_HOURS) {
      const err = new Error(`stale_after_hours must be an integer between ${MIN_STALE_HOURS} and ${MAX_STALE_HOURS}`);
      err.code = 'INVALID_STALE_AFTER_HOURS';
      throw err;
    }
    return n;
  }
  const env = Number(process.env.STALE_SESSION_CANCEL_AFTER_HOURS);
  if (Number.isInteger(env) && env >= MIN_STALE_HOURS && env <= MAX_STALE_HOURS) {
    return env;
  }
  return DEFAULT_STALE_AFTER_HOURS;
}

function resolveMaxBatch(override) {
  if (override != null && override !== '') {
    const n = Number(override);
    if (!Number.isInteger(n) || n < MIN_BATCH || n > MAX_BATCH) {
      const err = new Error(`max_batch must be an integer between ${MIN_BATCH} and ${MAX_BATCH}`);
      err.code = 'INVALID_MAX_BATCH';
      throw err;
    }
    return n;
  }
  const env = Number(process.env.STALE_SESSION_CLEANUP_MAX_BATCH);
  if (Number.isInteger(env) && env >= MIN_BATCH && env <= MAX_BATCH) {
    return env;
  }
  return DEFAULT_MAX_BATCH;
}

/**
 * Cancels only waiting/ready lobbies whose updated_at is older than staleAfterHours (default 2h).
 * Does not touch active, completed, or cancelled sessions (avoids pool / in-progress games).
 *
 * @returns {Promise<{ cancelled_count: number, cancelled_session_ids: number[], stale_after_hours: number, max_batch: number }>}
 */
async function runStaleSessionCleanup(options = {}) {
  if (!pool) {
    const err = new Error('DATABASE_URL not configured');
    err.code = 'DATABASE_NOT_CONFIGURED';
    throw err;
  }

  const staleAfterHours = resolveStaleAfterHours(options.staleAfterHours);
  const maxBatch = resolveMaxBatch(options.maxBatch);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const updateSql = `
      WITH candidates AS (
        SELECT id
        FROM game_sessions
        WHERE status IN ('waiting', 'ready')
          AND ended_at IS NULL
          AND updated_at < (NOW() - make_interval(hours => $1::int))
        ORDER BY id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      UPDATE game_sessions gs
      SET
        status = 'cancelled',
        ended_at = COALESCE(gs.ended_at, NOW()),
        updated_at = NOW(),
        metadata = COALESCE(gs.metadata, '{}'::jsonb)
          || jsonb_build_object(
            'auto_cancelled_at', to_jsonb(NOW()),
            'auto_cancel_reason', to_jsonb('stale_waiting_ready'::text),
            'auto_cancel_trigger', to_jsonb(COALESCE(NULLIF(trim($3::text), ''), 'cron'))
          )
      FROM candidates c
      WHERE gs.id = c.id
      RETURNING gs.id`;

    const triggerTag = options.trigger == null ? null : String(options.trigger).slice(0, 80);
    const updated = await client.query(updateSql, [staleAfterHours, maxBatch, triggerTag]);
    const cancelledSessionIds = updated.rows.map((r) => Number(r.id)).filter((id) => Number.isInteger(id));

    if (cancelledSessionIds.length > 0) {
      await client.query(
        `INSERT INTO game_session_events (game_session_id, user_id, event_type, payload)
         SELECT
           x.id,
           NULL,
           'session_auto_cancelled',
           jsonb_build_object(
             'reason', 'stale_waiting_ready',
             'stale_after_hours', $2::int,
             'trigger', COALESCE(NULLIF(trim($3::text), ''), 'cron'),
             'session_id', x.id
           )
         FROM unnest($1::int[]) AS x(id)`,
        [cancelledSessionIds, staleAfterHours, triggerTag]
      );
    }

    await client.query('COMMIT');
    if (sessionCache.isEnabled() && cancelledSessionIds.length > 0) {
      await sessionCache.invalidateMany(cancelledSessionIds);
    }
    if (liveSessionState.isEnabled() && cancelledSessionIds.length > 0) {
      await liveSessionState.dropMany(cancelledSessionIds);
    }

    return {
      cancelled_count: cancelledSessionIds.length,
      cancelled_session_ids: cancelledSessionIds,
      stale_after_hours: staleAfterHours,
      max_batch: maxBatch,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  runStaleSessionCleanup,
  resolveStaleAfterHours,
  resolveMaxBatch,
  DEFAULT_STALE_AFTER_HOURS,
  DEFAULT_MAX_BATCH,
};
