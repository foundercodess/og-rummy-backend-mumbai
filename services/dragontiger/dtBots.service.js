'use strict';

const crypto = require('crypto');
const { query } = require('../../db');

/**
 * Side-seat bots are presentation only: they have no wallet, never place real
 * bets, are not counted in area totals, and never influence a round.
 */

const SEAT_COUNT = 6;
const MIN_BOTS = 4;
const MAX_BOTS = 6;
const FALLBACK_NAMES = [
  'Aarav', 'Vihaan', 'Ishaan', 'Kabir', 'Riya', 'Ananya',
  'Arjun', 'Meera', 'Rohan', 'Sneha', 'Kunal', 'Priya',
];

let profilePool = [];
let poolLoadedAt = 0;
const POOL_TTL_MS = 10 * 60 * 1000;

async function loadProfilePool() {
  if (profilePool.length > 0 && Date.now() - poolLoadedAt < POOL_TTL_MS) return profilePool;
  try {
    const [bots, avatars] = await Promise.all([
      query(
        `SELECT name, avatar FROM users
         WHERE is_bot = true AND name IS NOT NULL AND btrim(name) <> ''
         ORDER BY RANDOM() LIMIT 24`
      ),
      query('SELECT url FROM avatars WHERE active = true ORDER BY sort_order, id'),
    ]);
    const avatarUrls = avatars.rows.map((row) => row.url).filter(Boolean);
    const pickAvatar = () => (avatarUrls.length > 0
      ? avatarUrls[crypto.randomInt(avatarUrls.length)]
      : null);
    const fromBots = bots.rows.map((row) => ({
      name: String(row.name).trim(),
      avatar: row.avatar || pickAvatar(),
    }));
    const fromFallback = FALLBACK_NAMES.map((name) => ({ name, avatar: pickAvatar() }));
    profilePool = fromBots.length >= SEAT_COUNT ? fromBots : [...fromBots, ...fromFallback];
  } catch (err) {
    console.error('[DT] Failed to load bot profiles:', err.message);
    profilePool = FALLBACK_NAMES.map((name) => ({ name, avatar: null }));
  }
  poolLoadedAt = Date.now();
  return profilePool;
}

function pickDistinct(pool, count, exclude = new Set()) {
  const candidates = pool.filter((p) => !exclude.has(p.name));
  const out = [];
  while (out.length < count && candidates.length > 0) {
    const idx = crypto.randomInt(candidates.length);
    out.push(candidates.splice(idx, 1)[0]);
  }
  return out;
}

/** 6 seat slots; 4-6 of them hold a bot. */
async function buildSeats() {
  const pool = await loadProfilePool();
  const count = MIN_BOTS + crypto.randomInt(MAX_BOTS - MIN_BOTS + 1);
  const profiles = pickDistinct(pool, count);
  const seats = new Array(SEAT_COUNT).fill(null);
  const slots = [...Array(SEAT_COUNT).keys()];
  for (const profile of profiles) {
    const slot = slots.splice(crypto.randomInt(slots.length), 1)[0];
    seats[slot] = { seat: slot, name: profile.name, avatar: profile.avatar };
  }
  return seats;
}

/** Swap one occupied seat for a new face so the table feels alive. */
async function rotateSeats(seats) {
  if (!Array.isArray(seats) || seats.length !== SEAT_COUNT) return buildSeats();
  const pool = await loadProfilePool();
  const occupied = seats.filter(Boolean);
  if (occupied.length === 0) return buildSeats();
  const out = seats.slice();
  const leaving = occupied[crypto.randomInt(occupied.length)];
  const [replacement] = pickDistinct(pool, 1, new Set(occupied.map((s) => s.name)));
  out[leaving.seat] = replacement
    ? { seat: leaving.seat, name: replacement.name, avatar: replacement.avatar }
    : leaving;
  return out;
}

module.exports = {
  SEAT_COUNT,
  buildSeats,
  rotateSeats,
};
