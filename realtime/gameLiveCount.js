'use strict';

const { query } = require('../db');

const BROADCAST_INTERVAL_MS = Math.max(
  2000,
  Number(process.env.GAME_LIVE_COUNT_INTERVAL_MS) || 5000,
);

let ioInstance = null;
let broadcastTimer = null;
let inFlight = false;
let lastPayloadJson = '';

/**
 * Players currently at tables (waiting / ready / active), excluding practice
 * and bots. Used only for home-screen "X playing" — not gameplay state.
 */
async function buildLiveGameCounts() {
  const result = await query(
    `SELECT
       g.id,
       g.name,
       COALESCE(COUNT(gsp.id), 0)::int AS live_players_count
     FROM games g
     LEFT JOIN game_sessions gs
       ON gs.game_id = g.id
      AND gs.status IN ('waiting', 'ready', 'active')
      AND COALESCE((gs.metadata->>'practice_mode')::boolean, false) = false
      AND COALESCE((gs.metadata->>'practice_bot_only')::boolean, false) = false
     LEFT JOIN game_session_players gsp
       ON gsp.game_session_id = gs.id
      AND gsp.status IN ('joined', 'disconnected')
      AND COALESCE((gsp.metadata->>'is_bot')::boolean, false) = false
     WHERE g.active = true
     GROUP BY g.id, g.name, g.sort_order
     ORDER BY g.sort_order, g.id`,
  );

  return {
    games: (result.rows || []).map((row) => ({
      id: Number(row.id),
      name: row.name,
      live_players_count: Number(row.live_players_count) || 0,
    })),
    updated_at: new Date().toISOString(),
  };
}

async function emitLiveGameCounts(targetSocket = null) {
  try {
    const payload = await buildLiveGameCounts();
    const serialized = JSON.stringify(payload.games);

    if (targetSocket) {
      targetSocket.emit('game:live_count', payload);
      return payload;
    }

    if (!ioInstance) return payload;

    // Skip global broadcast when nothing changed.
    if (serialized === lastPayloadJson) return payload;
    lastPayloadJson = serialized;
    ioInstance.emit('game:live_count', payload);
    return payload;
  } catch (err) {
    console.error('[GAME_LIVE_COUNT] emit failed:', err.message);
    return null;
  }
}

async function tickBroadcast() {
  if (!ioInstance || inFlight) return;
  inFlight = true;
  try {
    await emitLiveGameCounts(null);
  } finally {
    inFlight = false;
  }
}

function startLiveCountBroadcaster(io) {
  ioInstance = io;
  if (broadcastTimer) {
    clearInterval(broadcastTimer);
    broadcastTimer = null;
  }
  broadcastTimer = setInterval(() => {
    tickBroadcast().catch(() => {});
  }, BROADCAST_INTERVAL_MS);
  // Warm cache once so first connect is fast.
  tickBroadcast().catch(() => {});
  console.log(
    `[GAME_LIVE_COUNT] Broadcaster started (interval=${BROADCAST_INTERVAL_MS}ms)`,
  );
}

function stopLiveCountBroadcaster() {
  if (broadcastTimer) {
    clearInterval(broadcastTimer);
    broadcastTimer = null;
  }
  ioInstance = null;
  lastPayloadJson = '';
}

module.exports = {
  buildLiveGameCounts,
  emitLiveGameCounts,
  startLiveCountBroadcaster,
  stopLiveCountBroadcaster,
};
