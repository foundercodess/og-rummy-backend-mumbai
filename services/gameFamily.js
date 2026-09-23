'use strict';

function toBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function normalizeGameFamily(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  if (raw === 'teenpatti') return 'teenpatti';
  if (raw === 'rummy') return 'rummy';
  return null;
}

function resolveGameFamily(game = {}) {
  const fromColumn = normalizeGameFamily(game.game_family || game.family);
  if (fromColumn) return fromColumn;

  const name = String(game.name || game.game_name || '').toLowerCase();
  if (name.includes('teen patti') || name.includes('teenpatti')) {
    return 'teenpatti';
  }
  return 'rummy';
}

function isTeenPattiGame(game) {
  return resolveGameFamily(game) === 'teenpatti';
}

function isTeenPattiSession(session) {
  if (!session) return false;
  const fromMeta = normalizeGameFamily(session.metadata?.game_family);
  if (fromMeta) return fromMeta === 'teenpatti';
  return isTeenPattiGame(session.game || { name: session.game_name || session.metadata?.game_name });
}

/** Teen Patti never offers kill-app / disconnect pending-rejoin (rummy keeps that flow). */
function allowsPendingRejoin(session) {
  return !isTeenPattiSession(session);
}

function isTeenPattiEngineEnabled() {
  return toBool(process.env.TEENPATTI_ENGINE_ENABLED, false);
}

function assertTeenPattiEngineReady(game) {
  if (!isTeenPattiGame(game)) return;
  if (isTeenPattiEngineEnabled()) return;

  const error = new Error('Teen Patti tables are coming soon');
  error.code = 'GAME_ENGINE_NOT_READY';
  throw error;
}

module.exports = {
  resolveGameFamily,
  isTeenPattiGame,
  isTeenPattiSession,
  allowsPendingRejoin,
  isTeenPattiEngineEnabled,
  assertTeenPattiEngineReady,
};
