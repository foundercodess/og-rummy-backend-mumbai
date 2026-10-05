'use strict';

const { query } = require('../../db');
const { roundCurrency } = require('./dtRules.service');

const CACHE_TTL_MS = Math.max(1000, Number(process.env.DT_SETTINGS_CACHE_MS) || 3000);
const MAX_COMMISSION_PERCENT = 12;

const DEFAULTS = Object.freeze({
  enabled: true,
  betting_seconds: 15,
  reveal_seconds: 5,
  result_seconds: 3,
  chip_values: [10, 50, 100, 500, 1000],
  min_bet: 10,
  max_bet_per_area: 10000,
  max_round_payout: 500000,
  commission_percent: 5,
  updated_at: null,
});

let cache = { value: null, loadedAt: 0 };

function toBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

/** Process-level kill switch. Off unless DRAGONTIGER_ENGINE_ENABLED=true. */
function isEngineEnabled() {
  return toBool(process.env.DRAGONTIGER_ENGINE_ENABLED, false);
}

function normalizeRow(row) {
  if (!row) return { ...DEFAULTS };
  const chips = Array.isArray(row.chip_values)
    ? row.chip_values.map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b)
    : DEFAULTS.chip_values;
  return {
    enabled: row.enabled !== false,
    betting_seconds: Number(row.betting_seconds) || DEFAULTS.betting_seconds,
    reveal_seconds: Number(row.reveal_seconds) || DEFAULTS.reveal_seconds,
    result_seconds: Number(row.result_seconds) || DEFAULTS.result_seconds,
    chip_values: chips.length > 0 ? chips : DEFAULTS.chip_values,
    min_bet: roundCurrency(row.min_bet) || DEFAULTS.min_bet,
    max_bet_per_area: roundCurrency(row.max_bet_per_area) || DEFAULTS.max_bet_per_area,
    max_round_payout: roundCurrency(row.max_round_payout) || DEFAULTS.max_round_payout,
    commission_percent: Math.min(
      MAX_COMMISSION_PERCENT,
      Math.max(0, Number(row.commission_percent ?? DEFAULTS.commission_percent))
    ),
    updated_at: row.updated_at || null,
  };
}

async function loadSettings() {
  const result = await query('SELECT * FROM dt_settings WHERE id = 1');
  const value = normalizeRow(result.rows[0]);
  cache = { value, loadedAt: Date.now() };
  return value;
}

async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.loadedAt <= CACHE_TTL_MS) {
    return cache.value;
  }
  try {
    return await loadSettings();
  } catch (err) {
    console.error('[DT] Failed to load dt_settings:', err.message);
    return cache.value || { ...DEFAULTS };
  }
}

/** Playable = env switch on AND admin toggle on. */
async function isPlayable() {
  if (!isEngineEnabled()) return false;
  const settings = await getSettings();
  return settings.enabled === true;
}

function publicSettings(settings) {
  return {
    chip_values: settings.chip_values,
    min_bet: settings.min_bet,
    max_bet_per_area: settings.max_bet_per_area,
    betting_seconds: settings.betting_seconds,
    reveal_seconds: settings.reveal_seconds,
    result_seconds: settings.result_seconds,
    commission_percent: settings.commission_percent,
    payouts: { dragon: 1, tiger: 1, tie: 8, tie_half_back: true },
  };
}

/** Dragon Tiger entry for the public games list (it has no `games` row). */
async function lobbyInfo() {
  const settings = await getSettings();
  return {
    name: 'Dragon Tiger',
    game_family: 'dragontiger',
    enabled: isEngineEnabled() && settings.enabled === true,
    ...publicSettings(settings),
  };
}

function invalid(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function intInRange(value, min, max, code) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw invalid(code, `${code}: expected integer between ${min} and ${max}`);
  }
  return n;
}

function positiveAmount(value, code) {
  const n = roundCurrency(value);
  if (!(n > 0)) throw invalid(code, `${code}: expected a positive amount`);
  return n;
}

async function updateSettings(fields = {}, adminId = null) {
  const current = await getSettings({ fresh: true });
  const next = { ...current };

  if (fields.enabled != null) next.enabled = fields.enabled === true || fields.enabled === 'true';
  if (fields.betting_seconds != null) next.betting_seconds = intInRange(fields.betting_seconds, 5, 60, 'INVALID_BETTING_SECONDS');
  if (fields.reveal_seconds != null) next.reveal_seconds = intInRange(fields.reveal_seconds, 3, 20, 'INVALID_REVEAL_SECONDS');
  if (fields.result_seconds != null) next.result_seconds = intInRange(fields.result_seconds, 2, 20, 'INVALID_RESULT_SECONDS');
  if (fields.min_bet != null) next.min_bet = positiveAmount(fields.min_bet, 'INVALID_MIN_BET');
  if (fields.max_bet_per_area != null) next.max_bet_per_area = positiveAmount(fields.max_bet_per_area, 'INVALID_MAX_BET_PER_AREA');
  if (fields.max_round_payout != null) next.max_round_payout = positiveAmount(fields.max_round_payout, 'INVALID_MAX_ROUND_PAYOUT');
  if (fields.commission_percent != null) {
    const pct = Number(fields.commission_percent);
    if (!Number.isFinite(pct) || pct < 0 || pct > MAX_COMMISSION_PERCENT) {
      throw invalid('INVALID_COMMISSION_PERCENT', `commission_percent must be between 0 and ${MAX_COMMISSION_PERCENT}`);
    }
    next.commission_percent = roundCurrency(pct);
  }
  if (fields.chip_values != null) {
    const chips = Array.isArray(fields.chip_values) ? fields.chip_values.map(Number) : [];
    if (chips.length === 0 || chips.length > 8 || chips.some((n) => !Number.isInteger(n) || n <= 0)) {
      throw invalid('INVALID_CHIP_VALUES', 'chip_values must be 1-8 positive integers');
    }
    next.chip_values = [...new Set(chips)].sort((a, b) => a - b);
  }
  if (next.min_bet > next.max_bet_per_area) {
    throw invalid('INVALID_BET_LIMITS', 'min_bet cannot exceed max_bet_per_area');
  }

  await query(
    `UPDATE dt_settings
     SET enabled = $1,
         betting_seconds = $2,
         reveal_seconds = $3,
         result_seconds = $4,
         chip_values = $5,
         min_bet = $6,
         max_bet_per_area = $7,
         max_round_payout = $8,
         commission_percent = $9,
         updated_by = $10,
         updated_at = NOW()
     WHERE id = 1`,
    [
      next.enabled,
      next.betting_seconds,
      next.reveal_seconds,
      next.result_seconds,
      next.chip_values,
      next.min_bet,
      next.max_bet_per_area,
      next.max_round_payout,
      next.commission_percent,
      adminId,
    ]
  );
  return loadSettings();
}

module.exports = {
  DEFAULTS,
  MAX_COMMISSION_PERCENT,
  isEngineEnabled,
  getSettings,
  isPlayable,
  publicSettings,
  lobbyInfo,
  updateSettings,
};
