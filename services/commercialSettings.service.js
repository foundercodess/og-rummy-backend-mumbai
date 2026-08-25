'use strict';

const platformCommercialSettingsModel = require('../models/platformCommercialSettings.model');
const {
  DEFAULT_WINNING_COMMISSION_PERCENT,
  normalizeWinningCommissionPercent,
  MAX_WINNING_COMMISSION_PERCENT,
  MIN_WINNING_COMMISSION_PERCENT,
} = require('./gameCommission.service');

const CACHE_TTL_MS = Math.max(
  1000,
  Number(process.env.COMMERCIAL_SETTINGS_CACHE_MS) || 2000,
);

let cache = {
  gameCommissionPercent: DEFAULT_WINNING_COMMISSION_PERCENT,
  loadedAt: 0,
  row: null,
};

function getCachedGameCommissionPercent() {
  const now = Date.now();
  if (cache.loadedAt > 0 && now - cache.loadedAt <= CACHE_TTL_MS) {
    return normalizeWinningCommissionPercent(cache.gameCommissionPercent);
  }
  return normalizeWinningCommissionPercent(cache.gameCommissionPercent || DEFAULT_WINNING_COMMISSION_PERCENT);
}

async function refreshCommercialSettingsCache() {
  try {
    const row = await platformCommercialSettingsModel.getCurrent();
    const percent = row
      ? normalizeWinningCommissionPercent(row.game_commission_percent)
      : DEFAULT_WINNING_COMMISSION_PERCENT;
    cache = {
      gameCommissionPercent: percent,
      loadedAt: Date.now(),
      row: row || null,
    };
    return percent;
  } catch (err) {
    console.error('[COMMERCIAL] Failed to load platform_commercial_settings, using default 12%:', err.message);
    cache = {
      gameCommissionPercent: DEFAULT_WINNING_COMMISSION_PERCENT,
      loadedAt: Date.now(),
      row: cache.row || null,
    };
    return DEFAULT_WINNING_COMMISSION_PERCENT;
  }
}

let pollerStarted = false;

function startCommercialSettingsPoller() {
  if (pollerStarted) return;
  pollerStarted = true;

  refreshCommercialSettingsCache().catch((err) => {
    console.error('[COMMERCIAL] Initial settings load failed:', err.message);
  });

  setInterval(() => {
    refreshCommercialSettingsCache().catch((err) => {
      console.error('[COMMERCIAL] Settings refresh failed:', err.message);
    });
  }, CACHE_TTL_MS).unref();
}

/**
 * Sync read for hot paths (prize pool display, settlement).
 * Falls back to 12 when cache is cold.
 */
function getGameCommissionPercentSync() {
  return getCachedGameCommissionPercent();
}

async function getGameCommissionPercent() {
  const now = Date.now();
  if (!(cache.loadedAt > 0 && now - cache.loadedAt <= CACHE_TTL_MS)) {
    await refreshCommercialSettingsCache();
  }
  return getCachedGameCommissionPercent();
}

function defaultCommercialFields() {
  return {
    game_commission_percent: DEFAULT_WINNING_COMMISSION_PERCENT,
    withdrawal_fee_percent: 0,
    withdrawal_min_amount: 100,
    withdrawal_daily_max_count: 3,
    withdrawal_daily_max_amount: 50000,
    withdrawal_min_account_age_hours: 0,
    withdrawal_new_account_max_amount: 0,
    withdrawal_max_processing_count: 5,
    withdrawal_require_approved_kyc: true,
  };
}

function toCommercialResponse(row) {
  const formatted = platformCommercialSettingsModel.formatForResponse(row);
  if (formatted) {
    return {
      ...formatted,
      game_commission_percent: normalizeWinningCommissionPercent(formatted.game_commission_percent),
      effective_game_commission_percent: getGameCommissionPercentSync(),
      game_commission_percent_min: MIN_WINNING_COMMISSION_PERCENT,
      game_commission_percent_max: MAX_WINNING_COMMISSION_PERCENT,
      game_commission_percent_default: DEFAULT_WINNING_COMMISSION_PERCENT,
    };
  }
  const defaults = defaultCommercialFields();
  return {
    ...defaults,
    id: null,
    updated_by: null,
    created_at: null,
    updated_at: null,
    effective_game_commission_percent: getGameCommissionPercentSync(),
    game_commission_percent_min: MIN_WINNING_COMMISSION_PERCENT,
    game_commission_percent_max: MAX_WINNING_COMMISSION_PERCENT,
    game_commission_percent_default: DEFAULT_WINNING_COMMISSION_PERCENT,
  };
}

async function getCommercialSettingsForAdmin() {
  await refreshCommercialSettingsCache();
  const row = await platformCommercialSettingsModel.getCurrent();
  return {
    commercial_settings: toCommercialResponse(row),
  };
}

function toFiniteNumber(value, code) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    const err = new Error(code);
    err.code = code;
    throw err;
  }
  return n;
}

async function updateCommercialSettingsForAdmin(fields = {}) {
  const existing = await platformCommercialSettingsModel.getCurrent();
  const current = existing
    ? platformCommercialSettingsModel.formatForResponse(existing)
    : defaultCommercialFields();

  const nextGameCommission = fields.game_commission_percent != null
    ? normalizeWinningCommissionPercent(fields.game_commission_percent)
    : normalizeWinningCommissionPercent(current.game_commission_percent);

  if (fields.game_commission_percent != null) {
    const raw = Number(fields.game_commission_percent);
    if (!Number.isFinite(raw)) {
      const err = new Error('INVALID_GAME_COMMISSION_PERCENT');
      err.code = 'INVALID_GAME_COMMISSION_PERCENT';
      throw err;
    }
    if (raw < MIN_WINNING_COMMISSION_PERCENT || raw > MAX_WINNING_COMMISSION_PERCENT) {
      const err = new Error('GAME_COMMISSION_PERCENT_OUT_OF_RANGE');
      err.code = 'GAME_COMMISSION_PERCENT_OUT_OF_RANGE';
      err.details = {
        min: MIN_WINNING_COMMISSION_PERCENT,
        max: MAX_WINNING_COMMISSION_PERCENT,
      };
      throw err;
    }
  }

  const next = await platformCommercialSettingsModel.upsertCurrent({
    game_commission_percent: nextGameCommission,
    withdrawal_fee_percent: fields.withdrawal_fee_percent != null
      ? toFiniteNumber(fields.withdrawal_fee_percent, 'INVALID_WITHDRAWAL_FEE_PERCENT')
      : Number(current.withdrawal_fee_percent),
    withdrawal_min_amount: fields.withdrawal_min_amount != null
      ? toFiniteNumber(fields.withdrawal_min_amount, 'INVALID_WITHDRAWAL_MIN_AMOUNT')
      : Number(current.withdrawal_min_amount),
    withdrawal_daily_max_count: fields.withdrawal_daily_max_count != null
      ? toFiniteNumber(fields.withdrawal_daily_max_count, 'INVALID_WITHDRAWAL_DAILY_MAX_COUNT')
      : Number(current.withdrawal_daily_max_count),
    withdrawal_daily_max_amount: fields.withdrawal_daily_max_amount != null
      ? toFiniteNumber(fields.withdrawal_daily_max_amount, 'INVALID_WITHDRAWAL_DAILY_MAX_AMOUNT')
      : Number(current.withdrawal_daily_max_amount),
    withdrawal_min_account_age_hours: fields.withdrawal_min_account_age_hours != null
      ? toFiniteNumber(fields.withdrawal_min_account_age_hours, 'INVALID_WITHDRAWAL_MIN_ACCOUNT_AGE_HOURS')
      : Number(current.withdrawal_min_account_age_hours),
    withdrawal_new_account_max_amount: fields.withdrawal_new_account_max_amount != null
      ? toFiniteNumber(fields.withdrawal_new_account_max_amount, 'INVALID_WITHDRAWAL_NEW_ACCOUNT_MAX_AMOUNT')
      : Number(current.withdrawal_new_account_max_amount),
    withdrawal_max_processing_count: fields.withdrawal_max_processing_count != null
      ? toFiniteNumber(fields.withdrawal_max_processing_count, 'INVALID_WITHDRAWAL_MAX_PROCESSING_COUNT')
      : Number(current.withdrawal_max_processing_count),
    withdrawal_require_approved_kyc: fields.withdrawal_require_approved_kyc != null
      ? fields.withdrawal_require_approved_kyc === true
      : current.withdrawal_require_approved_kyc === true,
    updatedBy: fields.updatedBy ?? null,
  });

  await refreshCommercialSettingsCache();

  return {
    commercial_settings: toCommercialResponse(next),
  };
}

/**
 * Lock winning-wallet commission percent onto session metadata (immutable once set).
 */
function lockWinningCommissionOnMetadata(metadata = {}, winningCommissionPercent = null) {
  const existing = metadata?.locked_winning_commission_percent;
  if (existing != null && Number.isFinite(Number(existing))) {
    return {
      metadata: { ...metadata },
      locked_winning_commission_percent: normalizeWinningCommissionPercent(existing),
      did_lock: false,
    };
  }
  const locked = normalizeWinningCommissionPercent(
    winningCommissionPercent != null ? winningCommissionPercent : getGameCommissionPercentSync(),
  );
  return {
    metadata: {
      ...metadata,
      locked_winning_commission_percent: locked,
    },
    locked_winning_commission_percent: locked,
    did_lock: true,
  };
}

function mergeEntryDebitSplitOnMetadata(metadata = {}, userId, splitMeta = {}) {
  const uid = String(Number(userId));
  if (!uid || uid === 'NaN') return { ...metadata };
  const prev = metadata?.entry_debit_splits && typeof metadata.entry_debit_splits === 'object'
    ? { ...metadata.entry_debit_splits }
    : {};
  prev[uid] = {
    ...(prev[uid] || {}),
    ...splitMeta,
    user_id: Number(userId),
    recorded_at: new Date().toISOString(),
  };
  return {
    ...metadata,
    entry_debit_splits: prev,
  };
}

function listEntryDebitSplitsFromMetadata(metadata = {}) {
  const raw = metadata?.entry_debit_splits;
  if (!raw || typeof raw !== 'object') return [];
  return Object.values(raw).filter((row) => row && typeof row === 'object');
}

module.exports = {
  startCommercialSettingsPoller,
  refreshCommercialSettingsCache,
  getGameCommissionPercentSync,
  getGameCommissionPercent,
  getCommercialSettingsForAdmin,
  updateCommercialSettingsForAdmin,
  lockWinningCommissionOnMetadata,
  mergeEntryDebitSplitOnMetadata,
  listEntryDebitSplitsFromMetadata,
  toCommercialResponse,
};
