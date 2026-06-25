const gameModel = require('../models/game.model');

const ALLOWED_PLAY_TYPES = new Set([2, 3, 4, 6]);
const POINTS_DIVISOR = 80;
const DEFAULT_SPIN_GO_MULTIPLIER = 10;

function normalizeOptionalText(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function normalizeBoolean(value, defaultValue = null) {
  if (value == null) return defaultValue;
  if (typeof value === 'boolean') return value;
  return null;
}

function normalizeInteger(value, defaultValue = null) {
  if (value == null || value === '') return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeNumber(value, defaultValue = null) {
  if (value == null || value === '') return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value * 100) / 100;
  return rounded.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function normalizeGameKey(gameName) {
  const normalized = String(gameName || '').trim().toLowerCase();
  if (normalized === 'points') return 'points';
  if (normalized === '101 pool' || normalized === '201 pool') return 'pool';
  if (normalized === 'deals') return 'deals';
  if (normalized === 'spin & go') return 'spin_go';
  return 'unsupported';
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizePlayTypes(value, fallback) {
  const source = Array.isArray(value) && value.length > 0 ? value : fallback;
  const normalized = [...new Set(source.map((item) => normalizeInteger(item)).filter((item) => item != null))]
    .sort((a, b) => a - b);
  return normalized;
}

function normalizePlayerCounts(value, fallback, allowedValues) {
  const source = Array.isArray(value) && value.length > 0 ? value : fallback;
  const normalized = [...new Set(source.map((item) => normalizeInteger(item)).filter((item) => item != null))]
    .sort((a, b) => a - b);

  if (normalized.length === 0 || normalized.some((item) => !allowedValues.includes(item))) {
    const err = new Error('INVALID_PLAYER_COUNTS_FOR_GAME');
    err.code = 'INVALID_PLAYER_COUNTS_FOR_GAME';
    err.details = { expected_player_counts: allowedValues };
    throw err;
  }

  return normalized;
}

function buildContestConfig(game, payload, sortOrder) {
  const gameKey = normalizeGameKey(game.name);
  if (gameKey === 'unsupported') {
    const err = new Error('UNSUPPORTED_GAME_FOR_CONTEST_CREATION');
    err.code = 'UNSUPPORTED_GAME_FOR_CONTEST_CREATION';
    throw err;
  }

  const entryFeeInput = payload.entry_fee ?? payload.min_entry ?? payload.entry;
  const entryFee = normalizeNumber(entryFeeInput);
  if (entryFee == null || entryFee <= 0) {
    const err = new Error('INVALID_ENTRY_FEE');
    err.code = 'INVALID_ENTRY_FEE';
    throw err;
  }

  const active = normalizeBoolean(payload.active, true);
  if (active == null) {
    const err = new Error('INVALID_ACTIVE_FLAG');
    err.code = 'INVALID_ACTIVE_FLAG';
    throw err;
  }

  let expectedPlayTypes = [];
  let defaultPlayerCounts = [];
  let allowedPlayerCounts = [];
  let playerCounts = [];
  let pointValue = null;
  let winUpto = null;
  let multiplierX = null;

  if (gameKey === 'points') {
    expectedPlayTypes = [2, 6];
    defaultPlayerCounts = [2, 6];
    allowedPlayerCounts = [2, 6];
    pointValue = formatNumber(entryFee / POINTS_DIVISOR);
  } else if (gameKey === 'pool') {
    expectedPlayTypes = [2, 6];
    defaultPlayerCounts = [2, 6];
    allowedPlayerCounts = [2, 6];
  } else if (gameKey === 'deals') {
    expectedPlayTypes = [2];
    defaultPlayerCounts = [2];
    allowedPlayerCounts = [2];
  } else if (gameKey === 'spin_go') {
    expectedPlayTypes = [3];
    defaultPlayerCounts = [3];
    allowedPlayerCounts = [3];
    multiplierX = normalizeInteger(payload.multiplier_x ?? payload.multiplier, DEFAULT_SPIN_GO_MULTIPLIER);
    if (multiplierX == null || multiplierX <= 0) {
      const err = new Error('INVALID_MULTIPLIER_X');
      err.code = 'INVALID_MULTIPLIER_X';
      throw err;
    }
    winUpto = formatNumber(entryFee * multiplierX);
  }

  const playTypes = normalizePlayTypes(payload.play_types, expectedPlayTypes);
  if (playTypes.length === 0 || playTypes.some((value) => !ALLOWED_PLAY_TYPES.has(value)) || !arraysEqual(playTypes, expectedPlayTypes)) {
    const err = new Error('INVALID_PLAY_TYPES_FOR_GAME');
    err.code = 'INVALID_PLAY_TYPES_FOR_GAME';
    err.details = { expected_play_types: expectedPlayTypes };
    throw err;
  }

  playerCounts = normalizePlayerCounts(payload.player_counts, defaultPlayerCounts, allowedPlayerCounts);

  const contests = playerCounts.map((playerCount) => ({
    player_count: playerCount,
    point_value: pointValue,
    entry: formatNumber(entryFee),
    win_upto: winUpto,
    sort_order: sortOrder,
    active,
  }));

  return {
    game_key: gameKey,
    play_types: playTypes,
    player_counts: playerCounts,
    multiplier_x: multiplierX,
    point_value: pointValue,
    entry: formatNumber(entryFee),
    win_upto: winUpto,
    sort_order: sortOrder,
    active,
    contests,
  };
}

function shapeGamesResponse(rows) {
  const gamesMap = new Map();
  const contestsMap = new Map();

  for (const row of rows) {
    const gid = row.game_id;
    if (!gamesMap.has(gid)) {
      gamesMap.set(gid, {
        id: gid,
        name: row.name,
        dashboard_banner: row.dashboard_banner,
        side_banner: row.side_banner,
        badge: row.badge,
        turn_timer_seconds: row.turn_timer_seconds,
        bonus_timer_seconds: row.bonus_timer_seconds,
        active: row.game_active !== false,
        player_types: [],
        contests: {},
      });
    }

    if (row.contest_id) {
      const cid = row.contest_id;
      if (!contestsMap.has(cid)) {
        contestsMap.set(cid, {
          id: cid,
          game_id: gid,
          player_count: row.player_count,
          contest_sort: row.contest_sort,
          point_value: row.point_value,
          entry: row.entry,
          win_upto: row.win_upto,
          active: row.contest_active !== false,
          play_types: [],
        });
      }
      const contest = contestsMap.get(cid);
      if (row.play_type && !contest.play_types.includes(row.play_type)) {
        contest.play_types.push(row.play_type);
      }
    }
  }

  const sortedContests = Array.from(contestsMap.values()).sort(
    (a, b) =>
      a.game_id - b.game_id ||
      a.player_count - b.player_count ||
      (a.contest_sort || 0) - (b.contest_sort || 0)
  );

  for (const contest of sortedContests) {
    contest.play_types.sort((a, b) => a - b);
    const game = gamesMap.get(contest.game_id);
    const pc = String(contest.player_count);
    if (!game.contests[pc]) game.contests[pc] = [];
    game.contests[pc].push({
      id: contest.id,
      point_value: contest.point_value,
      entry: contest.entry,
      win_upto: contest.win_upto,
      active: contest.active,
      play_types: contest.play_types,
    });
  }

  const games = Array.from(gamesMap.values());
  for (const game of games) {
    const playerCounts = new Set();
    for (const pc of Object.keys(game.contests)) {
      playerCounts.add(parseInt(pc, 10));
    }
    game.player_types = Array.from(playerCounts).sort((a, b) => a - b);
  }

  return games;
}

async function getGames() {
  const rows = await gameModel.getAllWithContests();
  return shapeGamesResponse(rows);
}

/** For admin: returns all games and contests including inactive. */
async function getGamesForAdmin() {
  const rows = await gameModel.getAllWithContests({ includeInactive: true });
  return shapeGamesResponse(rows);
}

async function setGameActive(gameId, active) {
  return gameModel.updateGameActive(gameId, active);
}

async function setContestActive(contestId, active) {
  return gameModel.updateContestActive(contestId, active);
}

async function createContest(gameId, payload = {}) {
  const normalizedGameId = normalizeInteger(gameId);
  if (!normalizedGameId || normalizedGameId <= 0) {
    const err = new Error('INVALID_GAME_ID');
    err.code = 'INVALID_GAME_ID';
    throw err;
  }

  const game = await gameModel.findGameById(normalizedGameId);
  if (!game) {
    const err = new Error('GAME_NOT_FOUND');
    err.code = 'GAME_NOT_FOUND';
    throw err;
  }

  const sortOrder = normalizeInteger(payload.sort_order);
  if (sortOrder == null) {
    if (payload.sort_order != null && payload.sort_order !== '') {
      const err = new Error('INVALID_SORT_ORDER');
      err.code = 'INVALID_SORT_ORDER';
      throw err;
    }
  }

  const nextSortOrder = sortOrder == null
    ? await gameModel.getNextContestSortOrder(normalizedGameId)
    : sortOrder;

  const config = buildContestConfig(game, payload, nextSortOrder);
  const duplicates = await gameModel.findDuplicateContests({
    gameId: normalizedGameId,
    contests: config.contests,
  });
  if (duplicates.length > 0) {
    const err = new Error('DUPLICATE_CONTEST_CONFIG');
    err.code = 'DUPLICATE_CONTEST_CONFIG';
    err.details = {
      duplicates: duplicates.map((row) => ({
        id: row.id,
        player_count: row.player_count,
        point_value: row.point_value,
        entry: row.entry,
        win_upto: row.win_upto,
        sort_order: row.sort_order,
        active: row.active,
      })),
    };
    throw err;
  }

  const contests = await gameModel.createContests({
    gameId: normalizedGameId,
    contests: config.contests,
    playTypes: config.play_types,
  });

  return {
    game: {
      id: game.id,
      name: game.name,
    },
    config: {
      entry: config.entry,
      point_value: config.point_value,
      win_upto: config.win_upto,
      play_types: config.play_types,
      player_counts: config.player_counts,
      multiplier_x: config.multiplier_x,
      sort_order: config.sort_order,
      active: config.active,
    },
    contests,
  };
}

module.exports = {
  getGames,
  getGamesForAdmin,
  setGameActive,
  setContestActive,
  createContest,
};
