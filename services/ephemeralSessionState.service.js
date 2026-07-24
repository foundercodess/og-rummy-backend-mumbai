'use strict';

/**
 * Short-lived Redis JSON blobs for process-local Maps that must survive
 * multi-instance recovery (declare responses, etc.).
 */
const { ensureRedisConnection } = require('./redis.service');

const KEY_PREFIX = process.env.EPHEMERAL_STATE_PREFIX || 'ephemeral:session:';
const DEFAULT_TTL_SECONDS = Math.max(
  60,
  Number(process.env.EPHEMERAL_STATE_TTL_SECONDS) || 900,
);

function key(kind, sessionId) {
  return `${KEY_PREFIX}${kind}:${Number(sessionId)}`;
}

async function setJson(kind, sessionId, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const client = await ensureRedisConnection();
  if (!client) return false;
  try {
    await client.set(
      key(kind, sessionId),
      JSON.stringify(value),
      'EX',
      Math.max(30, Number(ttlSeconds) || DEFAULT_TTL_SECONDS),
    );
    return true;
  } catch (err) {
    console.error(`[EPHEMERAL] set ${kind}/${sessionId} failed:`, err.message);
    return false;
  }
}

async function getJson(kind, sessionId) {
  const client = await ensureRedisConnection();
  if (!client) return null;
  try {
    const raw = await client.get(key(kind, sessionId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[EPHEMERAL] get ${kind}/${sessionId} failed:`, err.message);
    return null;
  }
}

async function del(kind, sessionId) {
  const client = await ensureRedisConnection();
  if (!client) return false;
  try {
    await client.del(key(kind, sessionId));
    return true;
  } catch (err) {
    console.error(`[EPHEMERAL] del ${kind}/${sessionId} failed:`, err.message);
    return false;
  }
}

function serializeDeclareResponses(responses) {
  const out = {};
  if (!responses || typeof responses.forEach !== 'function') return out;
  responses.forEach((value, userId) => {
    out[String(userId)] = value;
  });
  return out;
}

function deserializeDeclareResponses(raw) {
  const map = new Map();
  if (!raw || typeof raw !== 'object') return map;
  Object.entries(raw).forEach(([userId, value]) => {
    const id = Number(userId);
    if (!Number.isNaN(id)) map.set(id, value);
  });
  return map;
}

async function saveDeclareSnapshot(sessionId, state) {
  if (!state) return false;
  return setJson('declare', sessionId, {
    session_id: Number(sessionId),
    sequence: state.sequence,
    declare_by_user_id: state.declareByUserId,
    participant_user_ids: state.participantUserIds || [],
    visibility_stage: state.visibilityStage,
    started_at: state.startedAt,
    ends_at: state.endsAt,
    finish_card: state.finishCard || null,
    responses: serializeDeclareResponses(state.responses),
    saved_at: new Date().toISOString(),
  });
}

async function loadDeclareSnapshot(sessionId) {
  return getJson('declare', sessionId);
}

async function clearDeclareSnapshot(sessionId) {
  return del('declare', sessionId);
}

module.exports = {
  setJson,
  getJson,
  del,
  saveDeclareSnapshot,
  loadDeclareSnapshot,
  clearDeclareSnapshot,
  serializeDeclareResponses,
  deserializeDeclareResponses,
};
