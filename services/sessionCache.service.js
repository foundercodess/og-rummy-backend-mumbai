const { cacheGetJson, cacheSetJson, cacheDel } = require('./redis.service');

// Phase 1 of the reliable-architecture rollout: a read-through cache for the two
// hot session reads (session row + players-with-user join). This is a pure
// latency optimization layered on top of Postgres, which REMAINS the source of
// truth. It is disabled by default; nothing changes until SESSION_STATE_CACHE_ENABLED=true.
//
// Safety model:
//  - When disabled, every function is a no-op / cache-miss → identical behavior.
//  - Writes invalidate the keys, and a short TTL bounds staleness as a backstop
//    in case any write path is missed.
//  - Redis is shared, so invalidation is cross-process safe.
//  - Cached rows are re-hydrated so their shape matches a fresh pg row (timestamp
//    columns come back as Date objects, not ISO strings).

const SESSION_ROW_PREFIX = 'sess:row:';
const SESSION_PLAYERS_PREFIX = 'sess:players:';
const DEFAULT_TTL_MS = 30_000;

const stats = {
  rowHit: 0,
  rowMiss: 0,
  playersHit: 0,
  playersMiss: 0,
  invalidations: 0,
};
let statsLoggerStarted = false;

function isEnabled() {
  return String(process.env.SESSION_STATE_CACHE_ENABLED || '').trim().toLowerCase() === 'true';
}

function resolveTtlMs() {
  const raw = Number(process.env.SESSION_STATE_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

function rowKey(sessionId) {
  return `${SESSION_ROW_PREFIX}${sessionId}`;
}

function playersKey(sessionId) {
  return `${SESSION_PLAYERS_PREFIX}${sessionId}`;
}

// pg returns TIMESTAMPTZ columns as Date objects; JSON serialization turns them
// into ISO strings. Convert top-level `*_at` string fields back to Date so any
// caller that treats them as Dates behaves exactly as with a fresh DB row. Only
// top-level keys are touched — the JSONB `metadata` object is left as-is.
function reviveTimestamps(row) {
  if (!row || typeof row !== 'object') return row;
  for (const key of Object.keys(row)) {
    if (key.endsWith('_at') && typeof row[key] === 'string') {
      const d = new Date(row[key]);
      if (!Number.isNaN(d.getTime())) row[key] = d;
    }
  }
  return row;
}

async function getSessionRow(sessionId) {
  if (!isEnabled() || sessionId == null) return null;
  const cached = await cacheGetJson(rowKey(sessionId));
  if (cached) {
    stats.rowHit += 1;
    return reviveTimestamps(cached);
  }
  stats.rowMiss += 1;
  return null;
}

async function setSessionRow(sessionId, row) {
  if (!isEnabled() || sessionId == null || !row) return;
  await cacheSetJson(rowKey(sessionId), row, resolveTtlMs());
}

async function getPlayers(sessionId) {
  if (!isEnabled() || sessionId == null) return null;
  const cached = await cacheGetJson(playersKey(sessionId));
  if (Array.isArray(cached)) {
    stats.playersHit += 1;
    cached.forEach(reviveTimestamps);
    return cached;
  }
  stats.playersMiss += 1;
  return null;
}

async function setPlayers(sessionId, players) {
  if (!isEnabled() || sessionId == null || !Array.isArray(players)) return;
  await cacheSetJson(playersKey(sessionId), players, resolveTtlMs());
}

/** Drop both cached views for a session. Call AFTER a write commits. */
async function invalidate(sessionId) {
  if (!isEnabled() || sessionId == null) return;
  stats.invalidations += 1;
  await cacheDel(rowKey(sessionId), playersKey(sessionId));
}

/**
 * Drop only the session-row cache. Use after metadata/turn/status updates that
 * do not change game_session_players — keeps players cache warm on pick/discard.
 */
async function invalidateSessionRow(sessionId) {
  if (!isEnabled() || sessionId == null) return;
  stats.invalidations += 1;
  await cacheDel(rowKey(sessionId));
}

/** Invalidate many sessions (e.g. bulk cron cancels). */
async function invalidateMany(sessionIds = []) {
  if (!isEnabled() || !Array.isArray(sessionIds) || sessionIds.length === 0) return;
  const keys = [];
  sessionIds.forEach((id) => {
    if (id == null) return;
    stats.invalidations += 1;
    keys.push(rowKey(id), playersKey(id));
  });
  if (keys.length > 0) await cacheDel(...keys);
}

function getStats() {
  const rowTotal = stats.rowHit + stats.rowMiss;
  const playersTotal = stats.playersHit + stats.playersMiss;
  const pct = (hit, total) => (total > 0 ? Number(((hit / total) * 100).toFixed(1)) : 0);
  return {
    enabled: isEnabled(),
    ttl_ms: resolveTtlMs(),
    row: { hit: stats.rowHit, miss: stats.rowMiss, hit_rate_pct: pct(stats.rowHit, rowTotal) },
    players: {
      hit: stats.playersHit,
      miss: stats.playersMiss,
      hit_rate_pct: pct(stats.playersHit, playersTotal),
    },
    invalidations: stats.invalidations,
  };
}

// Lightweight live visibility while validating the rollout. Only runs when the
// cache is enabled, only logs when there was activity, and never keeps the
// process alive (unref).
function startStatsLogger() {
  if (statsLoggerStarted || !isEnabled()) return;
  statsLoggerStarted = true;
  const timer = setInterval(() => {
    const s = getStats();
    const rowTotal = s.row.hit + s.row.miss;
    const playersTotal = s.players.hit + s.players.miss;
    if (rowTotal + playersTotal === 0) return;
    console.log(
      `[session-cache] row ${s.row.hit}/${rowTotal} (${s.row.hit_rate_pct}% hit) | ` +
      `players ${s.players.hit}/${playersTotal} (${s.players.hit_rate_pct}% hit) | ` +
      `invalidations=${s.invalidations} | ttl=${s.ttl_ms}ms`
    );
  }, 30000);
  if (timer.unref) timer.unref();
}

startStatsLogger();

module.exports = {
  isEnabled,
  getSessionRow,
  setSessionRow,
  getPlayers,
  setPlayers,
  invalidate,
  invalidateSessionRow,
  invalidateMany,
  getStats,
};
