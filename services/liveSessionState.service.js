const { cacheGetJson, cacheSetJson, cacheDel } = require('./redis.service');

/**
 * Phase 3 — Redis live session state (pick / discard / turn hot path).
 *
 * When LIVE_SESSION_STATE_ENABLED=true:
 *  - findSessionById prefers the Redis snapshot (avoids pulling huge JSONB from PG every move)
 *  - updateSessionStatus writes Redis first (authoritative for the live table)
 *  - Postgres is still written: awaited by default; set LIVE_SESSION_STATE_ASYNC_PG=true
 *    to snapshot PG in the background for metadata-heavy active-play updates only
 *
 * DEFAULT ON (permanent architecture). Set LIVE_SESSION_STATE_ENABLED=false only to roll back.
 * Postgres is always written: async for hot moves, sync for terminal statuses.
 */

const LIVE_PREFIX = 'live:sess:';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h — covers long pool tables; cleaned on complete
const LIVE_SNAPSHOT_WARN_BYTES = Math.max(
  50_000,
  Number(process.env.LIVE_SNAPSHOT_WARN_BYTES) || 200_000,
);

const stats = {
  hit: 0,
  miss: 0,
  write: 0,
  drop: 0,
  asyncPersist: 0,
  syncPersist: 0,
};
let statsLoggerStarted = false;
const largeSnapshotWarnAtMs = new Map();

function warnIfLargeSnapshot(sessionId, snapshot) {
  if (!snapshot) return;
  const now = Date.now();
  const last = largeSnapshotWarnAtMs.get(sessionId) || 0;
  // Avoid double-stringify cost on every pick/discard write.
  if (now - last < 60_000) return;
  try {
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    if (bytes > LIVE_SNAPSHOT_WARN_BYTES) {
      largeSnapshotWarnAtMs.set(sessionId, now);
      console.warn(`[LIVE_STATE] large snapshot session=${sessionId} bytes=${bytes}`);
    }
  } catch (_) {
    // ignore serialization errors
  }
}

function isEnabled() {
  // Permanent default ON — set LIVE_SESSION_STATE_ENABLED=false only for emergency rollback.
  const raw = String(process.env.LIVE_SESSION_STATE_ENABLED ?? 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

function isAsyncPgEnabled() {
  if (!isEnabled()) return false;
  // Permanent default ON with live state — opt out explicitly if needed.
  const raw = String(process.env.LIVE_SESSION_STATE_ASYNC_PG ?? 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

function resolveTtlMs() {
  const raw = Number(process.env.LIVE_SESSION_STATE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

function liveKey(sessionId) {
  return `${LIVE_PREFIX}${sessionId}`;
}

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

/** Strip volatile / circular fields; store a PG-row-shaped snapshot. */
function toSnapshot(row = {}) {
  if (!row || typeof row !== 'object') return null;
  const snap = { ...row };
  // Ensure metadata is a plain object (pg may already parse jsonb)
  if (snap.metadata == null) snap.metadata = {};
  if (typeof snap.metadata === 'string') {
    try {
      snap.metadata = JSON.parse(snap.metadata);
    } catch (_) {
      snap.metadata = {};
    }
  }
  snap.live_version = Number(snap.live_version) || 0;
  snap.live_updated_at = new Date().toISOString();
  return snap;
}

async function get(sessionId) {
  if (!isEnabled() || sessionId == null) return null;
  const cached = await cacheGetJson(liveKey(sessionId));
  if (cached) {
    stats.hit += 1;
    return reviveTimestamps(cached);
  }
  stats.miss += 1;
  return null;
}

async function set(sessionId, row) {
  if (!isEnabled() || sessionId == null || !row) return;
  const snap = toSnapshot(row);
  if (!snap) return;
  stats.write += 1;
  warnIfLargeSnapshot(sessionId, snap);
  await cacheSetJson(liveKey(sessionId), snap, resolveTtlMs());
}

async function drop(sessionId) {
  if (!isEnabled() || sessionId == null) return;
  stats.drop += 1;
  largeSnapshotWarnAtMs.delete(sessionId);
  await cacheDel(liveKey(sessionId));
}

async function dropMany(sessionIds = []) {
  if (!isEnabled() || !Array.isArray(sessionIds) || sessionIds.length === 0) return;
  const keys = sessionIds.filter((id) => id != null).map((id) => liveKey(id));
  if (keys.length > 0) {
    stats.drop += keys.length;
    await cacheDel(...keys);
  }
}

/**
 * Hydrate live Redis from a fresh PG row (call on cache miss after SELECT).
 */
async function hydrateFromRow(sessionId, row) {
  if (!isEnabled() || sessionId == null || !row) return;
  const snap = toSnapshot(row);
  if (!snap.live_version) snap.live_version = 1;
  stats.write += 1;
  warnIfLargeSnapshot(sessionId, snap);
  await cacheSetJson(liveKey(sessionId), snap, resolveTtlMs());
}

/**
 * Apply updateSessionStatus-style fields onto a base row (in memory).
 */
function applyStatusUpdate(baseRow, status, fields = {}) {
  const next = toSnapshot(baseRow) || {};
  next.status = status;
  next.updated_at = new Date().toISOString();
  next.live_version = (Number(next.live_version) || 0) + 1;
  next.live_updated_at = next.updated_at;

  if (Object.prototype.hasOwnProperty.call(fields, 'currentTurnUserId')) {
    next.current_turn_user_id = fields.currentTurnUserId;
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'startedAt')) {
    next.started_at = fields.startedAt;
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'endedAt')) {
    next.ended_at = fields.endedAt;
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'metadata')) {
    next.metadata = fields.metadata || {};
  }
  return next;
}

/**
 * When async PG is on, still force sync PG for terminal / money-sensitive transitions.
 */
function mustAwaitPostgres(status, fields = {}) {
  if (!isAsyncPgEnabled()) return true;
  const terminal = status === 'completed' || status === 'cancelled';
  if (terminal) return true;
  if (Object.prototype.hasOwnProperty.call(fields, 'endedAt') && fields.endedAt) return true;
  return false;
}

function noteAsyncPersist() {
  stats.asyncPersist += 1;
}

function noteSyncPersist() {
  stats.syncPersist += 1;
}

function getStats() {
  const total = stats.hit + stats.miss;
  const pct = (hit, t) => (t > 0 ? Number(((hit / t) * 100).toFixed(1)) : 0);
  return {
    enabled: isEnabled(),
    async_pg: isAsyncPgEnabled(),
    ttl_ms: resolveTtlMs(),
    hit: stats.hit,
    miss: stats.miss,
    hit_rate_pct: pct(stats.hit, total),
    write: stats.write,
    drop: stats.drop,
    async_persist: stats.asyncPersist,
    sync_persist: stats.syncPersist,
  };
}

function startStatsLogger() {
  if (statsLoggerStarted || !isEnabled()) return;
  statsLoggerStarted = true;
  const timer = setInterval(() => {
    const s = getStats();
    if (s.hit + s.miss + s.write === 0) return;
    console.log(
      `[live-session] hit ${s.hit}/${s.hit + s.miss} (${s.hit_rate_pct}%) | ` +
      `writes=${s.write} drops=${s.drop} | syncPg=${s.sync_persist} asyncPg=${s.async_persist} | ` +
      `async_pg=${s.async_pg}`
    );
  }, 30000);
  if (timer.unref) timer.unref();
}

startStatsLogger();

module.exports = {
  isEnabled,
  isAsyncPgEnabled,
  get,
  set,
  drop,
  dropMany,
  hydrateFromRow,
  applyStatusUpdate,
  mustAwaitPostgres,
  noteAsyncPersist,
  noteSyncPersist,
  getStats,
};
