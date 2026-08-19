const { query } = require('../db');
const sessionCache = require('../services/sessionCache.service');
const liveSessionState = require('../services/liveSessionState.service');

function isTerminalSessionStatus(status) {
  return status === 'completed' || status === 'cancelled';
}

async function fetchSessionRowFromDb(sessionId) {
  const result = await query('SELECT * FROM game_sessions WHERE id = $1', [sessionId]);
  return result.rows[0] || null;
}

async function replaceLiveFromDbRow(sessionId, row) {
  if (liveSessionState.isEnabled()) await liveSessionState.drop(sessionId);
  if (sessionCache.isEnabled()) await sessionCache.invalidate(sessionId);
  if (row && liveSessionState.isEnabled()) {
    await liveSessionState.hydrateFromRow(sessionId, row);
  }
  if (row && sessionCache.isEnabled()) {
    await sessionCache.setSessionRow(sessionId, row);
  }
}

function liveRowIsStale(live, pgRow) {
  if (!live) return false;
  if (!pgRow) return true;
  if (String(live.session_code || '') !== String(pgRow.session_code || '')) return true;
  if (isTerminalSessionStatus(live.status) && !isTerminalSessionStatus(pgRow.status)) return true;
  return false;
}

async function createSession({ sessionCode, gameId, contestId, hostUserId, maxPlayers, metadata = {} }) {
  const result = await query(
    `INSERT INTO game_sessions (
      session_code,
      game_id,
      contest_id,
      host_user_id,
      max_players,
      metadata,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
    RETURNING *`,
    [sessionCode, gameId, contestId, hostUserId, maxPlayers, JSON.stringify(metadata)]
  );

  const row = result.rows[0] || null;
  // Postgres IDs can be reused after a truncate/reset while Redis still holds
  // live:sess:{id} from a previous completed load-test table. Drop before hydrate.
  if (row) await replaceLiveFromDbRow(row.id, row);
  return row;
}

async function findSessionByIdFromDb(sessionId) {
  const row = await fetchSessionRowFromDb(sessionId);
  if (!row) {
    if (liveSessionState.isEnabled()) await liveSessionState.drop(sessionId);
    if (sessionCache.isEnabled()) await sessionCache.invalidate(sessionId);
    return null;
  }
  if (liveSessionState.isEnabled()) {
    const live = await liveSessionState.get(sessionId);
    if (liveRowIsStale(live, row)) {
      await replaceLiveFromDbRow(sessionId, row);
    }
  }
  return row;
}

async function findSessionById(sessionId) {
  // Hot path (pick/discard/turn): trust Redis live snapshot — no per-move PG
  // fingerprint. Join/create use findSessionByIdFromDb which validates session_code.
  if (liveSessionState.isEnabled()) {
    const live = await liveSessionState.get(sessionId);
    if (live) return live;
  }

  if (sessionCache.isEnabled()) {
    const cached = await sessionCache.getSessionRow(sessionId);
    if (cached) {
      // Promote into live store so subsequent pick/discard skip PG JSONB.
      if (liveSessionState.isEnabled()) {
        await liveSessionState.hydrateFromRow(sessionId, cached);
      }
      return cached;
    }
  }

  const row = await fetchSessionRowFromDb(sessionId);
  if (row) {
    if (liveSessionState.isEnabled()) {
      await liveSessionState.hydrateFromRow(sessionId, row);
    }
    if (sessionCache.isEnabled()) {
      await sessionCache.setSessionRow(sessionId, row);
    }
  }
  return row;
}

async function findSessionByCode(sessionCode) {
  const result = await query('SELECT * FROM game_sessions WHERE session_code = $1', [sessionCode]);
  const row = result.rows[0] || null;
  if (!row) return null;
  if (liveSessionState.isEnabled()) {
    const live = await liveSessionState.get(row.id);
    if (live && !liveRowIsStale(live, row)) return live;
    if (liveRowIsStale(live, row)) {
      await replaceLiveFromDbRow(row.id, row);
    } else {
      await liveSessionState.hydrateFromRow(row.id, row);
    }
  }
  return row;
}

async function findOpenWaitingSession({ gameId, contestId, maxPlayers, excludeUserId = null }) {
  const excludeUid = excludeUserId != null ? Number(excludeUserId) : null;
  const result = await query(
    `SELECT gs.*
     FROM game_sessions gs
     JOIN LATERAL (
       SELECT COUNT(*)::int AS joined_count
       FROM game_session_players gsp
       WHERE gsp.game_session_id = gs.id
         AND gsp.status IN ('joined', 'disconnected')
     ) p ON true
     WHERE gs.game_id = $1
       AND gs.contest_id = $2
       AND gs.max_players = $3
       AND gs.status = 'waiting'
       AND COALESCE((gs.metadata->>'rematch_reserved')::boolean, false) = false
       AND p.joined_count < gs.max_players
       AND (
         $4::int IS NULL
         OR NOT EXISTS (
           SELECT 1
           FROM game_session_players self
           WHERE self.game_session_id = gs.id
             AND self.user_id = $4::int
         )
       )
     ORDER BY gs.created_at ASC
     LIMIT 1`,
    [gameId, contestId, maxPlayers, Number.isFinite(excludeUid) ? excludeUid : null]
  );

  return result.rows[0] || null;
}

async function findReservedContinuationSession(sourceSessionId) {
  const result = await query(
    `SELECT gs.*
     FROM game_sessions gs
     WHERE gs.metadata->>'continuation_source_session_id' = $1
       AND COALESCE((gs.metadata->>'rematch_reserved')::boolean, false) = true
       AND COALESCE((gs.metadata->>'rematch_reserved_consumed')::boolean, false) = false
       AND gs.status IN ('waiting', 'ready')
     ORDER BY gs.created_at DESC
     LIMIT 1`,
    [String(sourceSessionId)]
  );

  return result.rows[0] || null;
}

/**
 * Concurrent multi-table seats for a user (waiting / ready / active).
 * Excludes hard-left / opted-out seats. Used for the max-3 cap and active list.
 */
async function countConcurrentTablesForUser(userId, options = {}) {
  const excludeSessionId = options.excludeSessionId != null
    ? Number(options.excludeSessionId)
    : null;
  const result = await query(
    `SELECT COUNT(*)::int AS count
     FROM game_sessions gs
     JOIN game_session_players gsp ON gsp.game_session_id = gs.id
     WHERE gsp.user_id = $1
       AND gs.status IN ('waiting', 'ready', 'active')
       AND gsp.status IN ('joined', 'disconnected', 'eliminated')
       AND COALESCE((gsp.metadata->>'pending_rejoin_opt_out')::boolean, false) = false
       AND COALESCE((gsp.metadata->>'auto_rematch_opt_out')::boolean, false) = false
       AND COALESCE((gsp.metadata->>'table_left')::boolean, false) = false
       AND NOT COALESCE(gs.metadata->'post_result_left_user_ids', '[]'::jsonb)
         @> jsonb_build_array($1::int)
       AND ($2::int IS NULL OR gs.id <> $2::int)`,
    [userId, Number.isFinite(excludeSessionId) ? excludeSessionId : null]
  );
  return Number(result.rows[0]?.count || 0);
}

async function listConcurrentSessionsForUser(userId, options = {}) {
  const limit = Math.max(1, Math.min(10, Number(options.limit) || 3));
  const result = await query(
    `SELECT gs.*
     FROM game_sessions gs
     JOIN game_session_players gsp ON gsp.game_session_id = gs.id
     WHERE gsp.user_id = $1
       AND gs.status IN ('waiting', 'ready', 'active')
       AND gsp.status IN ('joined', 'disconnected', 'eliminated')
       AND COALESCE((gsp.metadata->>'pending_rejoin_opt_out')::boolean, false) = false
       AND COALESCE((gsp.metadata->>'auto_rematch_opt_out')::boolean, false) = false
       AND COALESCE((gsp.metadata->>'table_left')::boolean, false) = false
       AND NOT COALESCE(gs.metadata->'post_result_left_user_ids', '[]'::jsonb)
         @> jsonb_build_array($1::int)
     ORDER BY
       gs.updated_at DESC,
       gs.id DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

const REJOINABLE_SESSION_WHERE = `
       AND gs.updated_at >= (NOW() - make_interval(mins => $2::int))
       AND COALESCE((gs.metadata->>'practice_mode')::boolean, false) = false
       AND COALESCE((gs.metadata->>'practice_bot_only')::boolean, false) = false
       AND COALESCE((gsp.metadata->>'pending_rejoin_opt_out')::boolean, false) = false
       AND COALESCE((gsp.metadata->>'auto_rematch_opt_out')::boolean, false) = false
       AND (
         (
           -- Classic disconnect pending rejoin (all table sizes)
           gs.status = 'active'
           AND gsp.status IN ('joined', 'disconnected')
           AND (
             gsp.status = 'disconnected'
             OR COALESCE(gsp.metadata->>'connection_status', '') = 'disconnected'
             OR COALESCE((gsp.metadata->>'is_connected')::boolean, false) = false
           )
           AND COALESCE((gsp.metadata->>'is_dropped')::boolean, false) = false
           AND COALESCE((gsp.metadata->>'table_left')::boolean, false) = false
           AND COALESCE(gsp.metadata->>'drop_status', '') <> 'dropped'
           AND COALESCE(gsp.metadata->>'elimination_reason', '') NOT IN ('dropped', 'timeout')
           AND NOT COALESCE(gs.metadata->'post_result_left_user_ids', '[]'::jsonb)
             @> jsonb_build_array($1::int)
         )
         OR (
           -- 6-player soft pending rejoin: drop / soft leave / disconnect while game ongoing
           gs.max_players = 6
           AND gs.status IN ('active', 'ready')
           AND gsp.status IN ('joined', 'disconnected', 'eliminated')
           AND COALESCE((gsp.metadata->>'table_left')::boolean, false) = false
           AND NOT COALESCE(gs.metadata->'pool_eliminated_user_ids', '[]'::jsonb)
             @> jsonb_build_array($1::int)
           AND (
             COALESCE((gsp.metadata->>'soft_table_away')::boolean, false) = true
             OR COALESCE((gsp.metadata->>'is_dropped')::boolean, false) = true
             OR COALESCE(gsp.metadata->>'drop_status', '') = 'dropped'
             OR COALESCE(gsp.metadata->>'elimination_reason', '') IN ('dropped', 'timeout')
             OR COALESCE((gsp.metadata->>'packed_in_current_deal')::boolean, false) = true
             OR COALESCE((gsp.metadata->>'invalid_declaration')::boolean, false) = true
             OR gsp.status = 'disconnected'
             OR COALESCE(gsp.metadata->>'connection_status', '') = 'disconnected'
             OR COALESCE((gsp.metadata->>'is_connected')::boolean, false) = false
           )
         )
       )
`;

async function findLatestRejoinableSessionForUser(userId, options = {}) {
  const rows = await listRejoinableSessionsForUser(userId, { ...options, limit: 1 });
  return rows[0] || null;
}

/**
 * Multi-table pending rejoin: up to N sessions.
 * Does NOT suppress a pending table because the user is live on another table.
 */
async function listRejoinableSessionsForUser(userId, options = {}) {
  const maxAgeMinutes = Math.max(1, Number(options.maxAgeMinutes) || 15);
  const limit = Math.max(1, Math.min(10, Number(options.limit) || 3));
  const result = await query(
    `SELECT gs.*
     FROM game_sessions gs
     JOIN game_session_players gsp ON gsp.game_session_id = gs.id
     WHERE gsp.user_id = $1
       ${REJOINABLE_SESSION_WHERE}
     ORDER BY
       gs.updated_at DESC,
       gs.id DESC
     LIMIT $3`,
    [userId, maxAgeMinutes, limit]
  );

  return result.rows;
}

async function findLatestActiveSessionForUser(userId, options = {}) {
  const maxAgeMinutes = Math.max(1, Number(options.maxAgeMinutes) || 15);
  const result = await query(
    `SELECT gs.*
     FROM game_sessions gs
     JOIN game_session_players gsp ON gsp.game_session_id = gs.id
     WHERE gsp.user_id = $1
       AND gs.updated_at >= (NOW() - make_interval(mins => $2::int))
       AND COALESCE((gs.metadata->>'practice_mode')::boolean, false) = false
       AND COALESCE((gs.metadata->>'practice_bot_only')::boolean, false) = false
       AND COALESCE((gsp.metadata->>'pending_rejoin_opt_out')::boolean, false) = false
       AND COALESCE((gsp.metadata->>'auto_rematch_opt_out')::boolean, false) = false
       AND (
         (
           gs.status = 'active'
           AND gsp.status IN ('joined', 'disconnected')
           AND COALESCE((gsp.metadata->>'is_dropped')::boolean, false) = false
           AND COALESCE((gsp.metadata->>'table_left')::boolean, false) = false
           AND COALESCE(gsp.metadata->>'drop_status', '') <> 'dropped'
           AND COALESCE(gsp.metadata->>'elimination_reason', '') NOT IN ('dropped', 'timeout')
           AND NOT COALESCE(gs.metadata->'post_result_left_user_ids', '[]'::jsonb)
             @> jsonb_build_array($1::int)
         )
         OR (
           gs.max_players = 6
           AND gs.status IN ('active', 'ready')
           AND gsp.status IN ('joined', 'disconnected', 'eliminated')
           AND COALESCE((gsp.metadata->>'table_left')::boolean, false) = false
           AND NOT COALESCE(gs.metadata->'pool_eliminated_user_ids', '[]'::jsonb)
             @> jsonb_build_array($1::int)
           AND (
             COALESCE((gsp.metadata->>'soft_table_away')::boolean, false) = true
             OR COALESCE((gsp.metadata->>'is_dropped')::boolean, false) = true
             OR COALESCE(gsp.metadata->>'drop_status', '') = 'dropped'
             OR COALESCE(gsp.metadata->>'elimination_reason', '') IN ('dropped', 'timeout')
             OR COALESCE((gsp.metadata->>'packed_in_current_deal')::boolean, false) = true
             OR COALESCE((gsp.metadata->>'invalid_declaration')::boolean, false) = true
             OR gsp.status = 'disconnected'
             OR COALESCE(gsp.metadata->>'connection_status', '') = 'disconnected'
             OR COALESCE((gsp.metadata->>'is_connected')::boolean, false) = false
           )
         )
       )
       AND NOT COALESCE(gs.metadata->'post_result_left_user_ids', '[]'::jsonb)
         @> jsonb_build_array($1::int)
     ORDER BY
       gs.updated_at DESC,
       gs.id DESC
     LIMIT 1`,
    [userId, maxAgeMinutes]
  );

  return result.rows[0] || null;
}

async function sessionExistsInDb(sessionId) {
  const result = await query(
    'SELECT 1 FROM game_sessions WHERE id = $1 LIMIT 1',
    [sessionId]
  );
  return Boolean(result.rows[0]);
}

async function listStaleWaitingSessions({ olderThanSeconds = 30, limit = 25 } = {}) {
  const safeOlderThanSeconds = Math.max(1, Number(olderThanSeconds) || 30);
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 25));

  const result = await query(
    `SELECT gs.*
     FROM game_sessions gs
     JOIN LATERAL (
       SELECT COUNT(*)::int AS joined_count
       FROM game_session_players gsp
       WHERE gsp.game_session_id = gs.id
         AND gsp.status IN ('joined', 'disconnected')
     ) p ON true
     WHERE gs.status = 'waiting'
       AND p.joined_count >= 1
       AND p.joined_count < gs.max_players
       AND COALESCE((gs.metadata->>'load_test_gameplay')::boolean, false) = false
       AND COALESCE((gs.metadata->>'load_test')::boolean, false) = false
       AND (
         gs.created_at <= NOW() - make_interval(secs => $1)
         OR COALESCE((gs.metadata->>'practice_bot_only')::boolean, false) = true
       )
     ORDER BY gs.created_at ASC
     LIMIT $2`,
    [safeOlderThanSeconds, safeLimit]
  );

  return result.rows;
}

async function listSessionPlayers(sessionId) {
  if (sessionCache.isEnabled()) {
    const cached = await sessionCache.getPlayers(sessionId);
    if (cached) return cached;
  }
  const result = await query(
    `SELECT gsp.*, u.name, u.phone, u.avatar, u.view_id
     FROM game_session_players gsp
     JOIN users u ON u.id = gsp.user_id
     WHERE gsp.game_session_id = $1
     ORDER BY gsp.seat_no ASC`,
    [sessionId]
  );
  if (sessionCache.isEnabled()) {
    await sessionCache.setPlayers(sessionId, result.rows);
  }
  return result.rows;
}

async function addPlayer({ sessionId, userId, seatNo, metadata = {} }) {
  const result = await query(
    `INSERT INTO game_session_players (
      game_session_id,
      user_id,
      seat_no,
      metadata
    )
    VALUES ($1, $2, $3, $4::jsonb)
    RETURNING *`,
    [sessionId, userId, seatNo, JSON.stringify(metadata)]
  );
  if (sessionCache.isEnabled()) await sessionCache.invalidate(sessionId);
  return result.rows[0] || null;
}

async function findPlayer(sessionId, userId) {
  const result = await query(
    'SELECT * FROM game_session_players WHERE game_session_id = $1 AND user_id = $2',
    [sessionId, userId]
  );
  return result.rows[0] || null;
}

async function updatePlayerMetadata(sessionId, userId, metadata = {}) {
  const result = await query(
    `UPDATE game_session_players
     SET metadata = $3::jsonb
     WHERE game_session_id = $1 AND user_id = $2
     RETURNING *`,
    [sessionId, userId, JSON.stringify(metadata)]
  );
  if (sessionCache.isEnabled()) await sessionCache.invalidate(sessionId);
  return result.rows[0] || null;
}

async function updatePlayerState(sessionId, userId, fields = {}) {
  const updates = [];
  const values = [sessionId, userId];
  let index = values.length + 1;

  if (Object.prototype.hasOwnProperty.call(fields, 'status')) {
    updates.push(`status = $${index++}`);
    values.push(fields.status);
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'leftAt')) {
    updates.push(`left_at = $${index++}`);
    values.push(fields.leftAt);
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'metadata')) {
    updates.push(`metadata = $${index++}::jsonb`);
    values.push(JSON.stringify(fields.metadata || {}));
  }

  if (updates.length === 0) {
    return findPlayer(sessionId, userId);
  }

  const result = await query(
    `UPDATE game_session_players
     SET ${updates.join(', ')}
     WHERE game_session_id = $1 AND user_id = $2
     RETURNING *`,
    values
  );
  if (sessionCache.isEnabled()) await sessionCache.invalidate(sessionId);
  return result.rows[0] || null;
}

async function countJoinedPlayers(sessionId) {
  const result = await query(
    `SELECT COUNT(*)::int AS total
     FROM game_session_players
     WHERE game_session_id = $1 AND status IN ('joined', 'disconnected')`,
    [sessionId]
  );
  return result.rows[0] ? result.rows[0].total : 0;
}

async function persistSessionStatusToPostgres(sessionId, status, fields = {}) {
  const updates = ['status = $2', 'updated_at = NOW()'];
  const values = [sessionId, status];
  let index = values.length + 1;

  if (Object.prototype.hasOwnProperty.call(fields, 'currentTurnUserId')) {
    updates.push(`current_turn_user_id = $${index++}`);
    values.push(fields.currentTurnUserId);
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'startedAt')) {
    updates.push(`started_at = $${index++}`);
    values.push(fields.startedAt);
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'endedAt')) {
    updates.push(`ended_at = $${index++}`);
    values.push(fields.endedAt);
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'metadata')) {
    updates.push(`metadata = $${index++}::jsonb`);
    values.push(JSON.stringify(fields.metadata || {}));
  }

  const result = await query(
    `UPDATE game_sessions
     SET ${updates.join(', ')}
     WHERE id = $1
     RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

async function updateSessionStatus(sessionId, status, fields = {}) {
  // ── Phase 3 live path (flag OFF → fall through to classic PG-only) ─────────
  if (liveSessionState.isEnabled()) {
    let base = await liveSessionState.get(sessionId);
    if (!base) {
      const result = await query('SELECT * FROM game_sessions WHERE id = $1', [sessionId]);
      base = result.rows[0] || null;
    }
    if (!base) return null;

    const nextLive = liveSessionState.applyStatusUpdate(base, status, fields);
    await liveSessionState.set(sessionId, nextLive);
    // Status/turn/metadata updates do not change the players roster — keep
    // sess:players:* warm so pick/discard avoid a PG JOIN every move.
    if (sessionCache.isEnabled()) await sessionCache.invalidateSessionRow(sessionId);

    const terminal = status === 'completed' || status === 'cancelled';
    const awaitPg = liveSessionState.mustAwaitPostgres(status, fields);

    if (awaitPg) {
      liveSessionState.noteSyncPersist();
      const row = await persistSessionStatusToPostgres(sessionId, status, fields);
      if (terminal) {
        await liveSessionState.drop(sessionId);
      } else if (row) {
        // Keep live in sync with any DB defaults (updated_at etc.)
        await liveSessionState.hydrateFromRow(sessionId, {
          ...row,
          live_version: nextLive.live_version,
        });
      }
      return row || nextLive;
    }

    // Async Postgres snapshot — Redis already has the move; ACK path stays fast.
    liveSessionState.noteAsyncPersist();
    const capturedFields = { ...fields };
    const capturedStatus = status;
    const capturedVersion = nextLive.live_version;
    setImmediate(() => {
      persistSessionStatusToPostgres(sessionId, capturedStatus, capturedFields)
        .then((row) => {
          if (!row) return;
          // Only refresh live from PG if no newer live write raced ahead.
          return liveSessionState.get(sessionId).then((current) => {
            if (!current) return;
            if (Number(current.live_version) > capturedVersion) return;
            return liveSessionState.hydrateFromRow(sessionId, {
              ...row,
              live_version: capturedVersion,
            });
          });
        })
        .catch((err) => {
          console.warn(
            `[live-session] async PG persist failed session=${sessionId} ` +
            `v=${capturedVersion}: ${err.message}`
          );
        });
    });
    return nextLive;
  }

  // ── Classic path (LIVE disabled) ───────────────────────────────────────────
  const row = await persistSessionStatusToPostgres(sessionId, status, fields);
  if (sessionCache.isEnabled()) await sessionCache.invalidateSessionRow(sessionId);
  return row;
}

function shouldAwaitSessionEventInsert() {
  // Default: fire-and-forget so pick/discard/bot turns are not blocked on audit I/O.
  // Set GAME_SESSION_EVENTS_AWAIT=true only for tests that assert on event rows immediately.
  return String(process.env.GAME_SESSION_EVENTS_AWAIT || '').trim().toLowerCase() === 'true';
}

async function persistSessionEvent({ sessionId, userId = null, eventType, payload = {} }, options = {}) {
  const returning = options.returning === true;
  const sql = returning
    ? `INSERT INTO game_session_events (game_session_id, user_id, event_type, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING *`
    : `INSERT INTO game_session_events (game_session_id, user_id, event_type, payload)
       VALUES ($1, $2, $3, $4::jsonb)`;
  const result = await query(sql, [sessionId, userId, eventType, JSON.stringify(payload)]);
  return returning ? (result.rows[0] || null) : null;
}

// ─── Micro-batch event queue ──────────────────────────────────────────────────
// At high CCU, individual setImmediate inserts flood the pool (one connection
// per event). We queue them and flush with a single multi-row INSERT every
// BATCH_FLUSH_MS, using at most one pool connection per flush cycle.
// Max batch size caps the VALUES list so a single statement doesn't get too large.
const EVENT_BATCH_FLUSH_MS = Number(process.env.GAME_SESSION_EVENTS_BATCH_MS) || 40;
const EVENT_BATCH_MAX_SIZE = Number(process.env.GAME_SESSION_EVENTS_BATCH_MAX) || 200;
let _eventQueue = [];
let _eventFlushTimer = null;

function _scheduleEventFlush() {
  if (_eventFlushTimer !== null) return;
  _eventFlushTimer = setTimeout(_flushEventQueue, EVENT_BATCH_FLUSH_MS);
  if (_eventFlushTimer.unref) _eventFlushTimer.unref();
}

async function _flushEventQueue() {
  _eventFlushTimer = null;
  if (_eventQueue.length === 0) return;

  const batch = _eventQueue.splice(0, EVENT_BATCH_MAX_SIZE);
  if (_eventQueue.length > 0) _scheduleEventFlush();

  // Build a single multi-row INSERT for the whole batch.
  const values = [];
  const params = [];
  batch.forEach(({ sessionId, userId, eventType, payload }, i) => {
    const base = i * 4;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb)`);
    params.push(sessionId, userId ?? null, eventType, JSON.stringify(payload));
  });

  const sql = `INSERT INTO game_session_events (game_session_id, user_id, event_type, payload) VALUES ${values.join(', ')}`;
  try {
    await query(sql, params);
  } catch (err) {
    console.warn(`[game_session_events] batch insert failed (${batch.length} rows): ${err.message}`);
  }
}

/**
 * Audit-trail write for gameplay. By default does not block the caller: the insert is
 * queued and flushed in a micro-batch every ~40ms so the pool is not flooded with
 * individual INSERT connections at high CCU.
 * Game rules never depend on this row existing before the next action.
 */
async function insertEvent({ sessionId, userId = null, eventType, payload = {} }) {
  if (shouldAwaitSessionEventInsert()) {
    return persistSessionEvent({ sessionId, userId, eventType, payload }, { returning: true });
  }

  _eventQueue.push({ sessionId, userId: userId ?? null, eventType, payload });
  _scheduleEventFlush();
  return null;
}

async function listRecentEvents(sessionId, limit = 25) {
  const result = await query(
    `SELECT *
     FROM game_session_events
     WHERE game_session_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [sessionId, limit]
  );
  return result.rows.reverse();
}

module.exports = {
  createSession,
  findSessionById,
  findSessionByIdFromDb,
  sessionExistsInDb,
  findSessionByCode,
  findOpenWaitingSession,
  findReservedContinuationSession,
  findLatestRejoinableSessionForUser,
  listRejoinableSessionsForUser,
  findLatestActiveSessionForUser,
  countConcurrentTablesForUser,
  listConcurrentSessionsForUser,
  listStaleWaitingSessions,
  listSessionPlayers,
  addPlayer,
  findPlayer,
  updatePlayerMetadata,
  updatePlayerState,
  countJoinedPlayers,
  updateSessionStatus,
  insertEvent,
  listRecentEvents,
};
