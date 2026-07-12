const { query } = require('../db');

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

  return result.rows[0] || null;
}

async function findSessionById(sessionId) {
  const result = await query('SELECT * FROM game_sessions WHERE id = $1', [sessionId]);
  return result.rows[0] || null;
}

async function findSessionByCode(sessionCode) {
  const result = await query('SELECT * FROM game_sessions WHERE session_code = $1', [sessionCode]);
  return result.rows[0] || null;
}

async function findOpenWaitingSession({ gameId, contestId, maxPlayers }) {
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
     ORDER BY gs.created_at ASC
     LIMIT 1`,
    [gameId, contestId, maxPlayers]
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

async function findLatestRejoinableSessionForUser(userId, options = {}) {
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
             OR gsp.status = 'disconnected'
             OR COALESCE(gsp.metadata->>'connection_status', '') = 'disconnected'
             OR COALESCE((gsp.metadata->>'is_connected')::boolean, false) = false
           )
         )
       )
       AND NOT EXISTS (
         SELECT 1
         FROM game_sessions gs2
         JOIN game_session_players gsp2 ON gsp2.game_session_id = gs2.id
         WHERE gsp2.user_id = $1
           AND gs2.id <> gs.id
           AND gs2.status IN ('waiting', 'ready', 'active')
           AND COALESCE((gs2.metadata->>'practice_mode')::boolean, false) = false
           AND COALESCE((gs2.metadata->>'practice_bot_only')::boolean, false) = false
           AND gsp2.status IN ('joined', 'disconnected')
           AND COALESCE((gsp2.metadata->>'is_dropped')::boolean, false) = false
           AND COALESCE((gsp2.metadata->>'table_left')::boolean, false) = false
           AND COALESCE(gsp2.metadata->>'drop_status', '') <> 'dropped'
           AND COALESCE(gsp2.metadata->>'elimination_reason', '') NOT IN ('dropped', 'timeout')
           AND (
             gsp2.status = 'joined'
             AND COALESCE(gsp2.metadata->>'connection_status', 'connected') <> 'disconnected'
             AND COALESCE((gsp2.metadata->>'is_connected')::boolean, true) = true
           )
       )
     ORDER BY
       gs.updated_at DESC,
       gs.id DESC
     LIMIT 1`,
    [userId, maxAgeMinutes]
  );

  return result.rows[0] || null;
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
  const result = await query(
    `SELECT gsp.*, u.name, u.phone, u.avatar, u.view_id
     FROM game_session_players gsp
     JOIN users u ON u.id = gsp.user_id
     WHERE gsp.game_session_id = $1
     ORDER BY gsp.seat_no ASC`,
    [sessionId]
  );
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

async function updateSessionStatus(sessionId, status, fields = {}) {
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

async function insertEvent({ sessionId, userId = null, eventType, payload = {} }) {
  const result = await query(
    `INSERT INTO game_session_events (game_session_id, user_id, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING *`,
    [sessionId, userId, eventType, JSON.stringify(payload)]
  );
  return result.rows[0] || null;
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
  findSessionByCode,
  findOpenWaitingSession,
  findReservedContinuationSession,
  findLatestRejoinableSessionForUser,
  findLatestActiveSessionForUser,
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
