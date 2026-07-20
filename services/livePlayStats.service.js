'use strict';

/**
 * Live play stats for admin dashboard (REST).
 *
 * Aligned with home-screen live semantics in realtime/gameLiveCount.js:
 * - sessions: waiting | ready | active
 * - exclude practice / practice_bot_only
 * - seats: joined | disconnected (not eliminated)
 *
 * Does NOT touch socket broadcasts or gameplay paths.
 */

const { query } = require('../db');

async function getLivePlayStats() {
  const result = await query(
    `SELECT
       COUNT(DISTINCT CASE
         WHEN COALESCE((gsp.metadata->>'is_bot')::boolean, false) = false
         THEN gsp.user_id
       END)::int AS humans,
       COUNT(DISTINCT CASE
         WHEN COALESCE((gsp.metadata->>'is_bot')::boolean, false) = true
         THEN gsp.user_id
       END)::int AS bots,
       COUNT(DISTINCT gs.id)::int AS tables
     FROM game_sessions gs
     INNER JOIN game_session_players gsp
       ON gsp.game_session_id = gs.id
      AND gsp.status IN ('joined', 'disconnected')
     WHERE gs.status IN ('waiting', 'ready', 'active')
       AND COALESCE((gs.metadata->>'practice_mode')::boolean, false) = false
       AND COALESCE((gs.metadata->>'practice_bot_only')::boolean, false) = false`,
  );

  const row = result.rows[0] || {};
  const humans = Number(row.humans) || 0;
  const bots = Number(row.bots) || 0;
  const tables = Number(row.tables) || 0;

  return {
    humans,
    bots,
    tables,
    total: humans + bots,
    updated_at: new Date().toISOString(),
  };
}

module.exports = {
  getLivePlayStats,
};
