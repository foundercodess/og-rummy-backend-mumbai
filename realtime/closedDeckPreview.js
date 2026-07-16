'use strict';

const socketRegistry = require('./socketRegistry');
const gameSessionModel = require('../models/gameSession.model');

function sessionRoom(sessionId) {
  return `game-session:${sessionId}`;
}

/** Public card face id used by Flutter (`S7`, `HA`, `JKR_B`, …). */
function toClientCardFaceId(card) {
  if (!card || typeof card !== 'object') return null;
  if (card.is_joker === true) {
    const suit = String(card.suit || '').toUpperCase();
    if (suit === 'RED') return 'JKR_R';
    return String(card.card_id || 'JKR_B');
  }
  const explicit = String(card.card_id || '').trim();
  if (explicit) return explicit;
  const suit = String(card.suit || '');
  const rank = String(card.rank || '');
  if (!suit || !rank) return null;
  return `${suit[0].toUpperCase()}${rank}`;
}

/**
 * Closed-deck top for the current turn player only — enables optimistic face flip
 * without waiting for pick ACK. Never room-broadcast (fairness / anti-cheat).
 */
function resolveClosedDeckTopPreview(distribution) {
  const closed = Array.isArray(distribution?.closed_deck) ? distribution.closed_deck : [];
  if (closed.length === 0) return null;
  const top = closed[0];
  if (!top || typeof top !== 'object') return null;
  const cardUid = String(top.card_uid || '').trim();
  const cardId = toClientCardFaceId(top);
  if (!cardUid || !cardId) return null;
  return {
    card_uid: cardUid,
    card_id: cardId,
    rank: top.rank ?? null,
    suit: top.suit ?? null,
    value: top.value ?? null,
    is_joker: top.is_joker === true,
  };
}

function emitClosedDeckPreviewToTurnPlayer(io, sessionId, turn, distribution) {
  if (!io || sessionId == null || !turn) return false;
  if (turn.has_picked === true) return false;
  const userId = turn.user_id;
  if (userId == null) return false;
  const preview = resolveClosedDeckTopPreview(distribution);
  if (!preview) return false;
  const payload = {
    session_id: sessionId,
    server_time: new Date().toISOString(),
    event: 'player:closed_deck_preview',
    turn_id: turn.turn_id,
    closed_deck_top: preview,
  };
  // Prefer in-session sockets, but also fan out to the user's sockets so a
  // brief room-membership lag cannot drop the private preview.
  const uidNum = Number(userId);
  const socketIds = new Set([
    ...socketRegistry.getSocketIds(Number.isNaN(uidNum) ? userId : uidNum),
    ...socketRegistry.getSocketIds(userId),
  ]);
  const roomSocketIds = io.sockets.adapter.rooms.get(sessionRoom(sessionId)) || new Set();
  let emitted = 0;
  for (const sid of socketIds) {
    const sock = io.sockets.sockets.get(sid);
    if (!sock) continue;
    // Prefer room members; still emit to user sockets outside the room.
    if (roomSocketIds.size > 0 && !roomSocketIds.has(sid) && socketIds.size > 1) {
      // keep emitting — membership lag is common right after deal
    }
    sock.emit('player:closed_deck_preview', payload);
    emitted += 1;
  }
  return emitted > 0;
}

function scheduleClosedDeckPreviewFromSession(io, sessionId, turn) {
  if (!turn || turn.has_picked === true) return;
  Promise.resolve()
    .then(() => gameSessionModel.findSessionById(sessionId))
    .then((row) => {
      const dist = row?.metadata?.distribution;
      emitClosedDeckPreviewToTurnPlayer(io, sessionId, turn, dist);
    })
    .catch(() => {});
}

module.exports = {
  toClientCardFaceId,
  resolveClosedDeckTopPreview,
  emitClosedDeckPreviewToTurnPlayer,
  scheduleClosedDeckPreviewFromSession,
};
