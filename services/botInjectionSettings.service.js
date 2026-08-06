'use strict';

const botInjectionSettingsModel = require('../models/botInjectionSettings.model');

const CACHE_TTL_MS = Math.max(
  1000,
  Number(process.env.BOT_INJECTION_SETTINGS_CACHE_MS) || 2000,
);

let cache = {
  enabled: null,
  loadedAt: 0,
};

function envFallbackEnabled() {
  const raw = process.env.BOT_ENGINE_ENABLED;
  if (raw == null || raw === '') return false;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function isForceDisabledByEnv() {
  const raw = process.env.BOT_ENGINE_FORCE_DISABLED;
  if (raw == null || raw === '') return false;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

/**
 * Sync check used by socket handlers and bot-engine ticks.
 * Uses a short-lived cache refreshed on an interval and after admin updates.
 */
function isBotInjectionEnabled() {
  if (isForceDisabledByEnv()) return false;

  const now = Date.now();
  if (cache.enabled !== null && now - cache.loadedAt <= CACHE_TTL_MS) {
    return cache.enabled === true;
  }

  return envFallbackEnabled();
}

async function refreshBotInjectionCache() {
  if (isForceDisabledByEnv()) {
    cache.enabled = false;
    cache.loadedAt = Date.now();
    return false;
  }

  try {
    const row = await botInjectionSettingsModel.getCurrent();
    cache.enabled = row ? row.enabled === true : envFallbackEnabled();
  } catch (err) {
    console.error('[BOT] Failed to load bot_injection_settings, using env fallback:', err.message);
    cache.enabled = envFallbackEnabled();
  }

  cache.loadedAt = Date.now();
  return cache.enabled === true;
}

let pollerStarted = false;

function startBotInjectionSettingsPoller() {
  if (pollerStarted) return;
  pollerStarted = true;

  refreshBotInjectionCache().catch((err) => {
    console.error('[BOT] Initial bot injection settings load failed:', err.message);
  });

  setInterval(() => {
    refreshBotInjectionCache().catch((err) => {
      console.error('[BOT] Bot injection settings refresh failed:', err.message);
    });
  }, CACHE_TTL_MS).unref();
}

function toBotInjectionResponse(row) {
  const formatted = botInjectionSettingsModel.formatForResponse(row);
  return {
    ...(formatted || { enabled: envFallbackEnabled() }),
    effective_enabled: isBotInjectionEnabled(),
    force_disabled_by_env: isForceDisabledByEnv(),
  };
}

async function getBotInjectionSettingsForAdmin() {
  await refreshBotInjectionCache();
  const row = await botInjectionSettingsModel.getCurrent();
  return {
    bot_injection: toBotInjectionResponse(row),
  };
}

async function updateBotInjectionSettingsForAdmin({ enabled, updatedBy = null }) {
  if (typeof enabled !== 'boolean') {
    const err = new Error('INVALID_BOT_INJECTION_ENABLED');
    err.code = 'INVALID_BOT_INJECTION_ENABLED';
    throw err;
  }

  const next = await botInjectionSettingsModel.upsertCurrent({
    enabled,
    updatedBy,
  });

  await refreshBotInjectionCache();

  return {
    bot_injection: toBotInjectionResponse(next),
  };
}

module.exports = {
  isBotInjectionEnabled,
  refreshBotInjectionCache,
  startBotInjectionSettingsPoller,
  getBotInjectionSettingsForAdmin,
  updateBotInjectionSettingsForAdmin,
};
