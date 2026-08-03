const crypto = require('crypto');
const gameModel = require('../models/game.model');
const gameSessionModel = require('../models/gameSession.model');
const walletModel = require('../models/wallet.model');
const { computeWalletDebitSplit } = require('./walletDebitSplit');
const { buildPoolSessionPrizePoolFields } = require('./poolPrizePool.service');
const sessionCache = require('./sessionCache.service');
const liveSessionState = require('./liveSessionState.service');
const redisLockService = require('./redisLock.service');
const { pool, query } = require('../db');

function createSessionCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

const DEFAULT_REJOIN_PENDING_MAX_AGE_MINUTES = 15;

function resolveRejoinPendingMaxAgeMinutes(override) {
  if (override != null && override !== '') {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(Math.floor(parsed), 24 * 60);
    }
  }
  const envValue = Number(process.env.REJOIN_PENDING_MAX_AGE_MINUTES);
  if (Number.isFinite(envValue) && envValue > 0) {
    return Math.min(Math.floor(envValue), 24 * 60);
  }
  return DEFAULT_REJOIN_PENDING_MAX_AGE_MINUTES;
}

function buildSessionResponse(session, players = [], events = [], game = null, contest = null, extra = {}) {
  if (!session) return null;

  return {
    id: session.id,
    session_code: session.session_code,
    game_id: session.game_id,
    contest_id: session.contest_id,
    host_user_id: session.host_user_id,
    status: session.status,
    max_players: session.max_players,
    current_turn_user_id: session.current_turn_user_id,
    metadata: session.metadata || {},
    started_at: session.started_at,
    ended_at: session.ended_at,
    created_at: session.created_at,
    updated_at: session.updated_at,
    game,
    contest,
    players,
    events,
    ...(extra || {}),
  };
}

function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeModeValue(value) {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;

  if (normalized.includes('spin')) return 'spin_go';
  if (normalized.includes('deal')) return 'deals_2';
  if (normalized.includes('pool')) return 'pool';
  if (normalized.includes('point')) return 'points';
  return null;
}

function isPracticeGameName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'practice';
}

function resolveSessionGameMode({ metadata = {}, game = null }) {
  const explicitMode =
    normalizeModeValue(metadata.game_mode)
    || normalizeModeValue(metadata.game_type)
    || normalizeModeValue(metadata.mode);
  if (explicitMode) return explicitMode;

  const fromGameName = normalizeModeValue(game?.name);
  if (fromGameName) return fromGameName;

  return 'points';
}

function buildSessionModeMetadata({ metadata = {}, game = null }) {
  const mode = resolveSessionGameMode({ metadata, game });
  const nextMetadata = {
    ...(metadata || {}),
    game_mode: mode,
  };

  if (mode === 'deals_2' || mode === 'spin_go') {
    const totalDeals = mode === 'spin_go'
      ? 1
      : Math.max(2, Number(metadata.total_deals) || 2);
    nextMetadata.total_deals = totalDeals;
    nextMetadata.current_deal = Math.max(1, Number(metadata.current_deal) || 1);
    nextMetadata.deal_scores = Array.isArray(metadata.deal_scores) ? metadata.deal_scores : [];
    return nextMetadata;
  }

  if (!Number.isFinite(Number(nextMetadata.total_deals))) {
    nextMetadata.total_deals = 1;
  }

  if (!Number.isFinite(Number(nextMetadata.current_deal))) {
    nextMetadata.current_deal = 1;
  }

  return nextMetadata;
}

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function resolveEntryPotPlayerCount({ mode = null, players = [], maxPlayers = null } = {}) {
  if (mode === 'deals_2') {
    const seats = Number(maxPlayers);
    if (Number.isFinite(seats) && seats > 0) return Math.floor(seats);
  }
  if (!Array.isArray(players)) return 0;
  return players.filter((player) => ['joined', 'disconnected'].includes(player?.status)).length;
}

function buildSessionPrizePoolFields({ mode = null, contest = null, players = [], metadata = null, maxPlayers = null } = {}) {
  if (mode === 'pool') {
    return buildPoolSessionPrizePoolFields({
      contest,
      players,
      metadata: metadata || {},
    });
  }
  const isEntryPotMode = mode === 'deals_2' || mode === 'spin_go' || mode === 'pool';
  const entryFee = Number(contest?.entry);
  const playerCount = resolveEntryPotPlayerCount({ mode, players, maxPlayers });

  let totalEntry = null;
  let adminCommissionAmount = null;
  let winningBalance = null;

  if (isEntryPotMode && Number.isFinite(entryFee) && entryFee > 0 && playerCount > 0) {
    if (mode === 'spin_go') {
      const configuredWin = Number(contest?.win_upto);
      winningBalance = Number.isFinite(configuredWin) && configuredWin > 0
        ? roundCurrency(configuredWin)
        : null;
      totalEntry = roundCurrency(entryFee * playerCount);
      adminCommissionAmount = null;
    } else {
      totalEntry = roundCurrency(entryFee * playerCount);
      adminCommissionAmount = roundCurrency(totalEntry * 0.12);
      winningBalance = roundCurrency(totalEntry - adminCommissionAmount);
    }
  }

  return {
    winning_balance: winningBalance,
    prize_pool: {
      player_count: playerCount,
      entry_fee: Number.isFinite(entryFee) ? roundCurrency(entryFee) : null,
      total_entry: totalEntry,
      admin_commission_percent: mode === 'spin_go' ? null : (isEntryPotMode ? 12 : null),
      admin_commission_amount: adminCommissionAmount,
      winning_balance: winningBalance,
    },
  };
}

function shouldDebitJoinEntry({ session = {}, contest = null, game = null, skipBalanceCheck = false }) {
  if (skipBalanceCheck) return false;
  const mode = resolveSessionGameMode({ metadata: session.metadata || {}, game });
  if (!['deals_2', 'pool', 'spin_go'].includes(mode)) return false;
  const entryFee = Number(contest?.entry);
  return Number.isFinite(entryFee) && entryFee > 0;
}

async function debitJoinEntryForDeals({ session, userId, contest }) {
  if (!pool) {
    const err = new Error('Wallet debit unavailable — DATABASE_URL not configured');
    err.code = 'WALLET_UNAVAILABLE';
    throw err;
  }

  const entryFee = roundCurrency(contest?.entry);
  if (!(entryFee > 0)) return null;
  const mode = resolveSessionGameMode({ metadata: session?.metadata || {}, game: session?.game || null });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let walletRes = await client.query(
      'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (!walletRes.rows[0]) {
      await client.query(
        `INSERT INTO wallets (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
        [userId]
      );
      walletRes = await client.query(
        'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
        [userId]
      );
    }

    const wallet = walletRes.rows[0];
    const debitSplit = computeWalletDebitSplit(wallet, entryFee);
    if (debitSplit.available < entryFee) {
      const err = new Error(
        `Insufficient balance. Required ₹${entryFee}, available ₹${debitSplit.available.toFixed(2)}`
      );
      err.code = 'INSUFFICIENT_BALANCE';
      err.details = { required: entryFee, available: debitSplit.available };
      throw err;
    }

    const nextDeposit = debitSplit.nextDeposit;
    const nextReleasedBonus = debitSplit.nextReleasedBonus;
    const nextWithdrawable = debitSplit.nextWithdrawable;
    const nextTotal = roundCurrency(Number(wallet?.total_balance || 0) - entryFee);

    await client.query(
      `UPDATE wallets
       SET deposit = $2,
           released_bonus = $3,
           withdrawable = $4,
           total_balance = $5,
           updated_at = NOW()
       WHERE id = $1`,
      [wallet.id, nextDeposit, nextReleasedBonus, nextWithdrawable, nextTotal]
    );

    await client.query(
      `INSERT INTO wallet_transactions (
         user_id, wallet_id, transaction_type, amount, source, reference_type, reference_id, metadata
       )
       VALUES ($1, $2, 'game_entry_debit', $3, 'game', 'game_session', $4, $5::jsonb)`,
      [userId, wallet.id, -entryFee, session.id, JSON.stringify({
        reason: `${mode || 'game'}_entry_debit`,
        mode: mode || null,
        session_id: session.id,
        contest_id: session.contest_id,
        entry_fee: entryFee,
      })]
    );

    await client.query('COMMIT');
    return {
      amount: entryFee,
      remaining_deposit: nextDeposit,
      remaining_total_balance: nextTotal,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function resolveConnectionStatus(player = {}) {
  if (player.status === 'disconnected') return 'disconnected';
  if (player.metadata && player.metadata.connection_status === 'disconnected') return 'disconnected';
  return 'connected';
}

function resolvePlayerStatus(player = {}) {
  const metadata = player.metadata || {};
  if (metadata.is_dropped || metadata.drop_status === 'dropped' || metadata.elimination_reason === 'dropped') {
    return 'dropped';
  }
  if (metadata.elimination_reason === 'timeout') {
    return 'timeout';
  }
  if (player.status === 'eliminated' || metadata.elimination_reason === 'pool_limit') {
    return 'eliminated';
  }
  if (player.status === 'left') {
    return 'left';
  }
  if (resolveConnectionStatus(player) === 'disconnected') {
    return 'disconnected';
  }
  return 'active';
}

function normalizeNumericMap(value = {}) {
  const entries = Object.entries(value || {});
  const normalized = {};
  entries.forEach(([key, raw]) => {
    const numericKey = Number(key);
    if (Number.isNaN(numericKey)) return;
    const numericValue = Number(raw);
    if (!Number.isFinite(numericValue)) return;
    normalized[String(numericKey)] = numericValue;
  });
  return normalized;
}

function resolveSessionScoreContext({ session = {}, game = null, players = [] } = {}) {
  const mode = resolveSessionGameMode({ metadata: session.metadata || {}, game });
  const metadata = session.metadata || {};
  const numericTotalDeals = Number(metadata.total_deals);
  const numericCurrentDeal = Number(metadata.current_deal);
  const numericPoolRoundNo = Number(metadata.pool_round_no);
  const numericPoolLimit = Number(metadata.pool_limit);

  if (mode === 'pool') {
    const poolRoundNo = Number.isFinite(numericPoolRoundNo)
      ? Math.max(1, Math.floor(numericPoolRoundNo))
      : (Number.isFinite(numericCurrentDeal) ? Math.max(1, Math.floor(numericCurrentDeal)) : 1);
    return {
      game_mode: mode,
      deal_no: poolRoundNo,
      total_deals: null,
      pool_round_no: poolRoundNo,
      pool_limit: Number.isFinite(numericPoolLimit) ? Math.max(1, Math.floor(numericPoolLimit)) : null,
      total_score_by_user: normalizeNumericMap(metadata.pool_scores_by_user || {}),
    };
  }

  if (mode === 'deals_2' || mode === 'spin_go') {
    const totalDeals = Number.isFinite(numericTotalDeals) ? Math.max(1, Math.floor(numericTotalDeals)) : (mode === 'spin_go' ? 1 : 2);
    const dealNo = Number.isFinite(numericCurrentDeal) ? Math.max(1, Math.floor(numericCurrentDeal)) : 1;
    const defaultBaseScore = totalDeals * 80;
    const fromMetadata = normalizeNumericMap(metadata.deal_score_totals_by_user || {});
    const totalScoreByUser = {};
    (Array.isArray(players) ? players : []).forEach((player) => {
      const uid = Number(player?.user_id);
      if (Number.isNaN(uid)) return;
      const fromMap = Number(fromMetadata[String(uid)]);
      totalScoreByUser[String(uid)] = Number.isFinite(fromMap) ? fromMap : defaultBaseScore;
    });
    return {
      game_mode: mode,
      deal_no: dealNo,
      total_deals: totalDeals,
      pool_round_no: null,
      pool_limit: null,
      total_score_by_user: totalScoreByUser,
    };
  }

  return {
    game_mode: mode,
    deal_no: null,
    total_deals: Number.isFinite(numericTotalDeals) ? Math.max(1, Math.floor(numericTotalDeals)) : null,
    pool_round_no: Number.isFinite(numericPoolRoundNo) ? Math.max(1, Math.floor(numericPoolRoundNo)) : null,
    pool_limit: Number.isFinite(numericPoolLimit) ? Math.max(1, Math.floor(numericPoolLimit)) : null,
    total_score_by_user: {},
  };
}

function resolvePoolDropPenalties(poolLimit) {
  const safeLimit = Number(poolLimit);
  if (Number.isFinite(safeLimit) && safeLimit >= 201) {
    return { first: 25, middle: 50, full: 80 };
  }
  return { first: 20, middle: 40, full: 80 };
}

function buildGameRulesByMode({ mode, poolLimit = null } = {}) {
  const poolDrop = resolvePoolDropPenalties(poolLimit);
  const dealsRules = [
    'A valid declaration is needed to win every deal in this game.',
    'At least 2 sequences with 1 pure sequence are mandatory.',
    'Remaining groups can be sets or sequences.',
    'Winning player will get points from losing players at the end of every deal.',
    'The player with the maximum points at the end of the final deal is the winner.',
    'If you drop at any time, you lose by 80 points for that deal.',
  ];
  const pointsRules = [
    'A valid declaration is needed to win Points Rummy game.',
    'At least 2 sequences with 1 pure sequence are mandatory.',
    'Remaining groups can be sets or sequences.',
    'If you drop on your first turn, you lose by 20 points.',
    'You lose by 40 points if you drop any time after your first turn.',
  ];
  const poolRules = [
    'A valid declaration is needed to win a deal in Pool Rummy game.',
    'At least 2 sequences with 1 pure sequence are mandatory.',
    'Remaining groups can be sets or sequences.',
    'Winner of every deal gets 0 points. The other players get points based on their cards.',
    'Players reaching the max allowed points (101/201) get eliminated.',
    `If you drop on your first turn, you lose by ${poolDrop.first} points.`,
    `You lose by ${poolDrop.middle} points if you drop any time after your first turn.`,
    'When 3 or less than 3 players are left, they can use the Split Prize option.',
  ];
  const spinGoRules = [
    'A valid declaration is needed to win Spin & Go.',
    'At least 2 sequences with 1 pure sequence are mandatory.',
    'Remaining groups can be sets or sequences.',
    'Spin & Go is a single-deal format and winner is decided in that deal.',
    'Winner receives the configured Spin & Go prize amount for that table.',
    'If you drop on your first turn, you lose by 20 points. You lose by 40 points if you drop later.',
  ];
  const practiceRules = [
    'Practice uses Points Rummy gameplay with bots.',
    'At least 2 sequences with 1 pure sequence are mandatory.',
    'Remaining groups can be sets or sequences.',
    'No wallet deduction or cash settlement is applied in Practice.',
    'If you drop on your first turn, you lose by 20 points. You lose by 40 points if you drop later.',
  ];

  if (mode === 'deals_2') return dealsRules;
  if (mode === 'pool') return poolRules;
  if (mode === 'spin_go') return spinGoRules;
  if (mode === 'practice') return practiceRules;
  return pointsRules;
}

function buildGameInfoAndRulesPayload({
  session = {},
  game = null,
  contest = null,
  mode = 'points',
  poolLimit = null,
} = {}) {
  const gameName = String(game?.name || '').trim();
  const practice = isPracticeGameName(gameName) || mode === 'practice';
  const dropRules = mode === 'pool'
    ? resolvePoolDropPenalties(poolLimit)
    : mode === 'deals_2'
      ? { first: 80, middle: 80, full: 80 }
      : { first: 20, middle: 40, full: 80 };
  const numberOfDecks = Math.max(1, Number(session?.metadata?.number_of_decks) || 2);

  return {
    game_info: {
      table_id: session?.id || null,
      game_id: game?.id || session?.game_id || null,
      game_name: gameName || null,
      entry_fee: Number.isFinite(Number(contest?.entry)) ? roundCurrency(Number(contest.entry)) : null,
      game_type: practice ? 'practice game' : 'cash game',
      variant: '13 cards point rummy',
      printed_jokers: '1 per deck',
      jokers: 'Printed and wild jokers',
      number_of_decks: numberOfDecks,
      drop: {
        first: dropRules.first,
        middle: dropRules.middle,
        full: dropRules.full,
      },
    },
    game_rules: buildGameRulesByMode({ mode, poolLimit }),
  };
}

function normalizeAllowedUserIds(metadata = {}) {
  const raw = Array.isArray(metadata?.allowed_user_ids) ? metadata.allowed_user_ids : [];
  return Array.from(new Set(
    raw.map((userId) => Number(userId)).filter((userId) => !Number.isNaN(userId))
  ));
}

/**
 * Same reservation / practice-table rules as joinSession, without mutating the session.
 * Used by socket `session:refresh` to re-attach only when the user is allowed on this table.
 */
function userAllowedToAccessSessionMetadata(metadata = {}, userId) {
  const uid = Number(userId);
  if (Number.isNaN(uid)) return false;
  const isPracticeBotOnly = metadata?.practice_bot_only === true;
  const allowedUserIds = normalizeAllowedUserIds(metadata);
  if (isPracticeBotOnly && !allowedUserIds.includes(uid)) {
    return false;
  }
  if (allowedUserIds.length > 0 && !allowedUserIds.includes(uid)) {
    return false;
  }
  return true;
}

function resolveFirstAvailableSeat({ players = [], maxPlayers = 0 } = {}) {
  const safeMaxPlayers = Math.max(0, Number(maxPlayers) || 0);
  if (safeMaxPlayers <= 0) return null;
  const occupiedSeats = new Set(
    (Array.isArray(players) ? players : [])
      .map((player) => Number(player?.seat_no))
      .filter((seatNo) => Number.isFinite(seatNo) && seatNo >= 1)
  );
  for (let seatNo = 1; seatNo <= safeMaxPlayers; seatNo += 1) {
    if (!occupiedSeats.has(seatNo)) return seatNo;
  }
  return null;
}

/**
 * Throws INSUFFICIENT_BALANCE if deposit + released_bonus + withdrawable does not
 * cover the contest entry fee (skipped automatically for free/no-entry contests).
 */
async function checkSufficientBalance(userId, contest) {
  if (!userId || !contest) return;
  const entryFee = parseFloat(contest.entry);
  if (!Number.isFinite(entryFee) || entryFee <= 0) return; // free game — nothing to check

  const wallet = await walletModel.getOrCreateByUserId(userId);
  const availableSpendable = roundCurrency(
    Number(wallet?.deposit ?? 0)
    + Number(wallet?.released_bonus ?? 0)
    + Number(wallet?.withdrawable ?? 0)
  );

  if (availableSpendable < entryFee) {
    const error = new Error(
      `Insufficient balance. Required ₹${entryFee}, available ₹${availableSpendable.toFixed(2)}`
    );
    error.code = 'INSUFFICIENT_BALANCE';
    error.details = { required: entryFee, available: availableSpendable };
    throw error;
  }
}

function resolveContinuationEligibleUserIds(session = {}) {
  const players = Array.isArray(session.players) ? session.players : [];
  const leftUserIds = new Set(
    (Array.isArray(session.metadata?.post_result_left_user_ids) ? session.metadata.post_result_left_user_ids : [])
      .map((userId) => Number(userId))
      .filter((userId) => !Number.isNaN(userId))
  );

  return players
    .filter((player) => !leftUserIds.has(Number(player.user_id)))
    .map((player) => Number(player.user_id))
    .filter((userId) => !Number.isNaN(userId));
}

async function resolveContest(gameId, contestId) {
  const rows = await gameModel.getAllWithContests({ includeInactive: true });
  const normalizedGameId = toNumberOrNull(gameId);
  const normalizedContestId = toNumberOrNull(contestId);

  const gameRows = rows.filter(
    (row) => toNumberOrNull(row.game_id) === normalizedGameId && row.contest_id != null
  );

  const contest = gameRows.find((row) => toNumberOrNull(row.contest_id) === normalizedContestId) || null;
  const availableContestIds = [...new Set(
    gameRows.map((row) => toNumberOrNull(row.contest_id)).filter((id) => id != null)
  )].sort((a, b) => a - b);

  return { contest, availableContestIds };
}

async function getGameAndContestData(gameId, contestId) {
  const rows = await gameModel.getAllWithContests({ includeInactive: true });
  const normalizedGameId = toNumberOrNull(gameId);
  const normalizedContestId = toNumberOrNull(contestId);

  const gameRows = rows.filter((row) => toNumberOrNull(row.game_id) === normalizedGameId);
  if (gameRows.length === 0) {
    return { game: null, contest: null };
  }

  const gameBase = gameRows[0];
  const game = {
    id: gameBase.game_id,
    name: gameBase.name,
    dashboard_banner: gameBase.dashboard_banner,
    side_banner: gameBase.side_banner,
    badge: gameBase.badge,
    turn_timer_seconds: gameBase.turn_timer_seconds,
    bonus_timer_seconds: gameBase.bonus_timer_seconds,
    sort_order: gameBase.game_sort,
    active: gameBase.game_active !== false,
  };

  const contestRows = gameRows.filter((row) => toNumberOrNull(row.contest_id) === normalizedContestId);
  if (contestRows.length === 0) {
    return { game, contest: null };
  }

  const contestBase = contestRows[0];
  const playTypes = [...new Set(
    contestRows
      .map((row) => toNumberOrNull(row.play_type))
      .filter((value) => value != null)
  )].sort((a, b) => a - b);

  const contest = {
    id: contestBase.contest_id,
    game_id: contestBase.game_id,
    player_count: contestBase.player_count,
    point_value: contestBase.point_value,
    entry: contestBase.entry,
    win_upto: contestBase.win_upto,
    sort_order: contestBase.contest_sort,
    active: contestBase.contest_active !== false,
    play_types: playTypes,
  };

  return { game, contest };
}

async function createSession({ gameId, contestId, hostUserId, maxPlayers, metadata = {} }) {
  console.log('Creating session with gameId:', gameId, 'contestId:', contestId, 'hostUserId:', hostUserId);
  const { contest, availableContestIds } = await resolveContest(gameId, contestId);
  const { game } = await getGameAndContestData(gameId, contestId);
  if (!contest) {
    const error = new Error(`Contest not found for game_id ${gameId}`);
    error.code = 'CONTEST_NOT_FOUND';
    error.details = {
      game_id: gameId,
      contest_id: contestId,
      available_contest_ids: availableContestIds,
    };
    throw error;
  }
  if (contest.game_active === false || contest.contest_active === false) {
    const error = new Error('Contest is inactive');
    error.code = 'CONTEST_INACTIVE';
    throw error;
  }

  // Validate host has enough balance before any seat allocation.
  await checkSufficientBalance(hostUserId, contest);

  let session = null;
  const isPracticeGame = isPracticeGameName(game?.name);
  const normalizedContestPlayerCount = toNumberOrNull(contest.player_count) || 2;
  const normalizedRequestedMaxPlayers = toNumberOrNull(maxPlayers);
  const sessionMaxPlayers = isPracticeGame
    ? normalizedContestPlayerCount
    : (Number.isInteger(normalizedRequestedMaxPlayers) && normalizedRequestedMaxPlayers >= 2
    ? normalizedRequestedMaxPlayers
    : normalizedContestPlayerCount);
  const sessionMetadata = buildSessionModeMetadata({ metadata, game });
  if (isPracticeGame) {
    sessionMetadata.practice_bot_only = true;
    sessionMetadata.allowed_user_ids = [hostUserId];
    sessionMetadata.practice_mode = true;
    sessionMetadata.game_mode = 'points';
  }

  // Matchmaking behavior for session API: join an existing waiting session before creating a new one.
  // Load-test / private tables must get a fresh session so both scripted seats can join.
  const skipMatchmaking = metadata?.skip_matchmaking === true
    || metadata?.load_test_gameplay === true
    || metadata?.load_test === true;
  const openSession = (isPracticeGame || skipMatchmaking)
    ? null
    : await gameSessionModel.findOpenWaitingSession({
      gameId,
      contestId,
      maxPlayers: sessionMaxPlayers,
    });

  if (openSession) {
    try {
      return await joinSession({ sessionIdOrCode: openSession.id, userId: hostUserId });
    } catch (err) {
      // If another request filled it in parallel, fallback to fresh create.
      if (err.code !== 'SESSION_FULL') throw err;
    }
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      session = await gameSessionModel.createSession({
        sessionCode: createSessionCode(),
        gameId,
        contestId,
        hostUserId,
        maxPlayers: sessionMaxPlayers,
        metadata: sessionMetadata,
      });
      break;
    } catch (err) {
      if (err.code !== '23505') throw err;
    }
  }

  if (!session) {
    throw new Error('Failed to create unique game session code');
  }

  await gameSessionModel.addPlayer({
    sessionId: session.id,
    userId: hostUserId,
    seatNo: 1,
    metadata: { ready: false, host: true },
  });

  await gameSessionModel.insertEvent({
    sessionId: session.id,
    userId: hostUserId,
    eventType: 'session_created',
    payload: { session_code: session.session_code },
  });

  return getSessionState(session.id);
}

async function joinSession({ sessionIdOrCode, userId, skipBalanceCheck = false }) {
  const session = Number.isInteger(sessionIdOrCode)
    ? await gameSessionModel.findSessionById(sessionIdOrCode)
    : await gameSessionModel.findSessionByCode(String(sessionIdOrCode));

  if (!session) {
    const error = new Error('Session not found');
    error.code = 'SESSION_NOT_FOUND';
    throw error;
  }

  if (!['waiting', 'ready', 'active'].includes(session.status)) {
    const error = new Error('Session is not joinable');
    error.code = 'SESSION_NOT_JOINABLE';
    throw error;
  }

  const isPracticeBotOnly = session.metadata?.practice_bot_only === true;
  const isBotJoinForPractice = isPracticeBotOnly && skipBalanceCheck === true;
  if (isPracticeBotOnly && !isBotJoinForPractice) {
    const realPlayerAllowed = normalizeAllowedUserIds(session.metadata || {});
    if (!realPlayerAllowed.includes(Number(userId))) {
      const error = new Error('Practice table allows bots only');
      error.code = 'SESSION_ACCESS_DENIED';
      throw error;
    }
  }

  const allowedUserIds = normalizeAllowedUserIds(session.metadata || {});
  if (allowedUserIds.length > 0 && !allowedUserIds.includes(Number(userId)) && !isBotJoinForPractice) {
    const error = new Error('Session is reserved for another table');
    error.code = 'SESSION_ACCESS_DENIED';
    throw error;
  }

  const existingPlayer = await gameSessionModel.findPlayer(session.id, userId);
  if (existingPlayer) {
    // Player is reconnecting — no balance re-check needed.
    return getSessionState(session.id);
  }

  // Balance check: deposit + released_bonus + withdrawable must cover entry (see checkSufficientBalance).
  // Skipped for bots (skipBalanceCheck=true) and when session has no monetary contest.
  let contest = null;
  let game = null;
  if (session.contest_id) {
    const gameContest = await getGameAndContestData(session.game_id, session.contest_id);
    contest = gameContest.contest;
    game = gameContest.game;
    if (!skipBalanceCheck) {
      await checkSufficientBalance(userId, contest);
    }
  }

  // Serialize seat assignment across ALB/workers. Without this, two joiners can
  // pick the same seat_no and hit game_session_players_unique_seat (23505).
  const joinLockKey = redisLockService.joinSessionLockKey(session.id);
  const joinLockOwner = `join:${userId}:${process.pid}:${Date.now()}`;
  let joinLockGot = await redisLockService.acquireLock(joinLockKey, joinLockOwner, 15);
  if (!joinLockGot) {
    for (let i = 0; i < 20 && !joinLockGot; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      joinLockGot = await redisLockService.acquireLock(joinLockKey, joinLockOwner, 15);
    }
  }
  if (!joinLockGot) {
    const error = new Error('Session join busy — retry shortly');
    error.code = 'SESSION_JOIN_BUSY';
    throw error;
  }

  try {
    // Re-check inside the lock (reconnect / double-submit races).
    const lockedExistingPlayer = await gameSessionModel.findPlayer(session.id, userId);
    if (lockedExistingPlayer) {
      return getSessionState(session.id);
    }

    const joinedCount = await gameSessionModel.countJoinedPlayers(session.id);
    if (joinedCount >= session.max_players) {
      const error = new Error('Session is full');
      error.code = 'SESSION_FULL';
      throw error;
    }

    let seatNo = null;
    let inserted = false;
    for (let attempt = 0; attempt < 3 && !inserted; attempt += 1) {
      const existingSeats = await gameSessionModel.listSessionPlayers(session.id);
      seatNo = resolveFirstAvailableSeat({
        players: existingSeats,
        maxPlayers: session.max_players,
      });
      if (session.metadata?.continuation_source_session_id) {
        const sourcePlayer = await gameSessionModel.findPlayer(
          session.metadata.continuation_source_session_id,
          userId
        );
        const sourceSeatNo = Number(sourcePlayer?.seat_no);
        const isSourceSeatAvailable = Number.isFinite(sourceSeatNo)
          && sourceSeatNo >= 1
          && sourceSeatNo <= Number(session.max_players)
          && !(existingSeats || []).some((item) => Number(item?.seat_no) === sourceSeatNo);
        if (isSourceSeatAvailable) {
          seatNo = sourcePlayer.seat_no;
        }
      }
      if (!Number.isFinite(Number(seatNo)) || Number(seatNo) < 1) {
        const error = new Error('Session is full');
        error.code = 'SESSION_FULL';
        throw error;
      }

      try {
        await gameSessionModel.addPlayer({
          sessionId: session.id,
          userId,
          seatNo,
          metadata: { ready: false, host: false },
        });
        inserted = true;
      } catch (err) {
        if (err?.code !== '23505') throw err;
        const uniqHint = `${err.constraint || ''} ${err.detail || ''}`.toLowerCase();
        if (uniqHint.includes('unique_user') || uniqHint.includes('(game_session_id, user_id)')) {
          // Another request already seated this user.
          return getSessionState(session.id);
        }
        // Seat taken between list + insert (or unknown unique) — retry with a fresh seat map.
        continue;
      }
    }
    if (!inserted) {
      const error = new Error('Session is full');
      error.code = 'SESSION_FULL';
      throw error;
    }

    const nextJoinedCount = joinedCount + 1;
    const nextStatus = nextJoinedCount === session.max_players ? 'ready' : session.status;
    if (nextStatus !== session.status) {
      await gameSessionModel.updateSessionStatus(session.id, nextStatus);
    }

    await gameSessionModel.insertEvent({
      sessionId: session.id,
      userId,
      eventType: 'player_joined',
      payload: { seat_no: seatNo },
    });

    return getSessionState(session.id);
  } finally {
    await redisLockService.releaseLock(joinLockKey, joinLockOwner).catch(() => {});
  }
}

async function markPlayerReady({ sessionId, userId, ready }) {
  const session = await gameSessionModel.findSessionById(sessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.code = 'SESSION_NOT_FOUND';
    throw error;
  }

  const currentPhase = session.metadata && session.metadata.phase;
  if (['countdown', 'toss', 'dealing'].includes(currentPhase)) {
    const error = new Error('Ready state is managed automatically during pre-game sequence');
    error.code = 'SESSION_PHASE_LOCKED';
    throw error;
  }

  const player = await gameSessionModel.findPlayer(session.id, userId);
  if (!player) {
    const error = new Error('Player not part of session');
    error.code = 'PLAYER_NOT_FOUND';
    throw error;
  }

  await gameSessionModel.updatePlayerMetadata(session.id, userId, {
    ...(player.metadata || {}),
    ready,
  });

  const updatedPlayers = await gameSessionModel.listSessionPlayers(session.id);

  const targetPlayer = updatedPlayers.find((item) => item.user_id === userId);
  await gameSessionModel.insertEvent({
    sessionId: session.id,
    userId,
    eventType: ready ? 'player_ready' : 'player_not_ready',
    payload: { seat_no: targetPlayer.seat_no },
  });

  const everyoneReady = updatedPlayers.length === session.max_players
    && updatedPlayers.every((item) => item.metadata && item.metadata.ready === true);

  if (everyoneReady && session.status !== 'active') {
    await gameSessionModel.updateSessionStatus(session.id, 'active', {
      startedAt: new Date(),
      currentTurnUserId: updatedPlayers[0].user_id,
    });
    await gameSessionModel.insertEvent({
      sessionId: session.id,
      eventType: 'session_started',
      payload: { current_turn_user_id: updatedPlayers[0].user_id },
    });
  }

  return getSessionState(session.id, updatedPlayers);
}

async function getSessionState(sessionIdOrCode, existingPlayers = null, options = {}) {
  const session = Number.isInteger(sessionIdOrCode)
    ? await gameSessionModel.findSessionById(sessionIdOrCode)
    : await gameSessionModel.findSessionByCode(String(sessionIdOrCode));

  if (!session) return null;

  const includeEvents = options?.includeEvents !== false;
  const includeGameContest = options?.includeGameContest !== false;
  const players = existingPlayers || await gameSessionModel.listSessionPlayers(session.id);
  // Internal bot/timer + pick/discard paths skip events to avoid an extra ordered PG scan.
  // Client-facing paths (join, refresh, session:state) keep the default includeEvents=true.
  const events = includeEvents
    ? await gameSessionModel.listRecentEvents(session.id)
    : [];
  const { game, contest } = includeGameContest
    ? await getGameAndContestData(session.game_id, session.contest_id)
    : { game: null, contest: null };
  const scoreContext = resolveSessionScoreContext({ session, game, players });
  const prizePoolFields = buildSessionPrizePoolFields({
    mode: scoreContext.game_mode,
    contest,
    players,
    metadata: session.metadata,
    maxPlayers: session.max_players,
  });
  const gameInfoAndRules = buildGameInfoAndRulesPayload({
    session,
    game,
    contest,
    mode: scoreContext.game_mode,
    poolLimit: scoreContext.pool_limit,
  });

  return buildSessionResponse(session, players.map((player) => ({
    id: player.id,
    user_id: player.user_id,
    seat_no: player.seat_no,
    status: player.status,
    player_status: resolvePlayerStatus(player),
    connection_status: resolveConnectionStatus(player),
    joined_at: player.joined_at,
    left_at: player.left_at,
    metadata: player.metadata || {},
    name: player.name,
    phone: player.phone,
    avatar: player.avatar,
    view_id: player.view_id,
    total_score: Number(scoreContext.total_score_by_user?.[String(player.user_id)]),
  })), events, game, contest, {
    game_mode: scoreContext.game_mode,
    deal_no: scoreContext.deal_no,
    total_deals: scoreContext.total_deals,
    pool_round_no: scoreContext.pool_round_no,
    pool_limit: scoreContext.pool_limit,
    ...prizePoolFields,
    ...gameInfoAndRules,
  });
}

/**
 * Hot-path loader for pick/discard/auto-drop.
 * Same session row + players needed for turn validation — skips events, contest,
 * score, and prize-pool assembly that never appear in pick/discard ACKs.
 */
async function loadTurnActionSession(sessionId) {
  const session = await gameSessionModel.findSessionById(sessionId);
  if (!session) return null;
  const rows = await gameSessionModel.listSessionPlayers(session.id);
  const players = (rows || []).map((player) => ({
    id: player.id,
    user_id: player.user_id,
    seat_no: player.seat_no,
    status: player.status,
    metadata: player.metadata || {},
    name: player.name,
    view_id: player.view_id,
  }));
  return {
    ...session,
    players,
  };
}

async function getPendingRejoinSession(userId, options = {}) {
  const maxAgeMinutes = resolveRejoinPendingMaxAgeMinutes(options.maxAgeMinutes);
  let session = await gameSessionModel.findLatestRejoinableSessionForUser(userId, { maxAgeMinutes });
  if (!session) {
    session = await gameSessionModel.findLatestActiveSessionForUser(userId, { maxAgeMinutes });
  }
  if (!session) return null;
  return getSessionState(session.id);
}

async function createOrJoinContinuationSession({ sourceSessionId, userId }) {
  const sourceSession = await getSessionState(sourceSessionId);
  if (!sourceSession) {
    const error = new Error('Source session not found');
    error.code = 'SESSION_NOT_FOUND';
    throw error;
  }

  const sourcePlayer = (sourceSession.players || []).find((player) => Number(player.user_id) === Number(userId));
  if (!sourcePlayer) {
    const error = new Error('Player not found in source session');
    error.code = 'PLAYER_NOT_FOUND';
    throw error;
  }

  const eligibleUserIds = resolveContinuationEligibleUserIds(sourceSession);
  if (!eligibleUserIds.includes(Number(userId))) {
    const error = new Error('Player already left the table');
    error.code = 'PLAYER_LEFT_TABLE';
    throw error;
  }

  if (eligibleUserIds.length < 2) {
    return {
      session: null,
      sourceSession,
      eligibleUserIds,
      fallbackToMatchmaking: true,
    };
  }

  const existingContinuation = await gameSessionModel.findReservedContinuationSession(sourceSession.id);
  if (existingContinuation) {
    return {
      session: await joinSession({ sessionIdOrCode: existingContinuation.id, userId }),
      sourceSession,
      eligibleUserIds,
      fallbackToMatchmaking: false,
      reused: true,
    };
  }

  // Validate the host has enough balance before creating a fresh continuation session.
  if (sourceSession.contest_id) {
    const { contest } = await getGameAndContestData(sourceSession.game_id, sourceSession.contest_id);
    await checkSufficientBalance(userId, contest);
  }

  const metadata = {
    continuation_source_session_id: sourceSession.id,
    continuation_mode: 'same_table',
    rematch_reserved: true,
    allowed_user_ids: eligibleUserIds,
    phase: 'waiting',
    phase_updated_at: new Date().toISOString(),
  };

  let continuation = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      continuation = await gameSessionModel.createSession({
        sessionCode: createSessionCode(),
        gameId: sourceSession.game_id,
        contestId: sourceSession.contest_id,
        hostUserId: userId,
        maxPlayers: eligibleUserIds.length,
        metadata,
      });
      break;
    } catch (err) {
      if (err.code !== '23505') throw err;
    }
  }

  if (!continuation) {
    throw new Error('Failed to create continuation session');
  }

  const sourceSeat = sourcePlayer.seat_no || 1;
  await gameSessionModel.addPlayer({
    sessionId: continuation.id,
    userId,
    seatNo: sourceSeat,
    metadata: {
      ready: false,
      host: true,
      continuation_source_session_id: sourceSession.id,
    },
  });

  await gameSessionModel.insertEvent({
    sessionId: continuation.id,
    userId,
    eventType: 'continuation_session_created',
    payload: {
      source_session_id: sourceSession.id,
      allowed_user_ids: eligibleUserIds,
    },
  });

  const nextSourceMetadata = {
    ...(sourceSession.metadata || {}),
    latest_continuation_session_id: continuation.id,
    phase_updated_at: new Date().toISOString(),
  };
  await gameSessionModel.updateSessionStatus(sourceSession.id, sourceSession.status, {
    metadata: nextSourceMetadata,
  });

  return {
    session: await getSessionState(continuation.id),
    sourceSession: await getSessionState(sourceSession.id),
    eligibleUserIds,
    fallbackToMatchmaking: false,
    reused: false,
  };
}

async function leaveTableContinuation({ sourceSessionId, userId }) {
  const sourceSession = await getSessionState(sourceSessionId);
  if (!sourceSession) {
    const error = new Error('Source session not found');
    error.code = 'SESSION_NOT_FOUND';
    throw error;
  }

  const sourcePlayer = (sourceSession.players || []).find((player) => Number(player.user_id) === Number(userId));
  if (!sourcePlayer) {
    const error = new Error('Player not found in source session');
    error.code = 'PLAYER_NOT_FOUND';
    throw error;
  }

  const phase = String(sourceSession.metadata?.phase || '').toLowerCase();
  // Free leave only for lobby / match-start countdown before entry lock.
  // Do NOT treat pool inter_deal / toss / dealing as free leave (would wipe seats).
  const isPrelockLeave = isPregameFreeLeaveEligible(sourceSession);
  if (isPrelockLeave) {
    await query('BEGIN');
    try {
      await query(
        `DELETE FROM game_session_players
         WHERE game_session_id = $1
           AND user_id = $2`,
        [sourceSession.id, userId]
      );

      const remainingPlayersRes = await query(
        `SELECT user_id, seat_no, status
         FROM game_session_players
         WHERE game_session_id = $1
           AND status IN ('joined', 'disconnected')
         ORDER BY seat_no ASC`,
        [sourceSession.id]
      );
      const remainingPlayers = remainingPlayersRes.rows || [];
      const nextMetadata = {
        ...(sourceSession.metadata || {}),
        phase: 'waiting',
        phase_updated_at: new Date().toISOString(),
      };
      delete nextMetadata.countdown;
      delete nextMetadata.toss;
      delete nextMetadata.declaration;
      delete nextMetadata.entry_locked;
      delete nextMetadata.entry_locked_at;
      delete nextMetadata.entry_locked_at_seconds_left;

      if (remainingPlayers.length === 0) {
        await query(
          `DELETE FROM game_sessions
           WHERE id = $1`,
          [sourceSession.id]
        );
        await query('COMMIT');
        if (sessionCache.isEnabled()) await sessionCache.invalidate(sourceSession.id);
        if (liveSessionState.isEnabled()) await liveSessionState.drop(sourceSession.id);
        return null;
      }

      const nextHostUserId = Number(sourceSession.host_user_id) === Number(userId)
        ? Number(remainingPlayers[0].user_id)
        : Number(sourceSession.host_user_id);
      await query(
        `UPDATE game_sessions
         SET host_user_id = $2,
             status = 'waiting',
             metadata = $3::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [sourceSession.id, nextHostUserId, JSON.stringify(nextMetadata)]
      );
      await query(
        `INSERT INTO game_session_events (game_session_id, user_id, event_type, payload)
         VALUES ($1, $2, 'table_left', $3::jsonb)`,
        [sourceSession.id, userId, JSON.stringify({
          source_session_id: sourceSession.id,
          phase: phase || sourceSession.status || 'waiting',
          prelock_exit: true,
        })]
      );
      await query('COMMIT');
      if (sessionCache.isEnabled()) await sessionCache.invalidate(sourceSession.id);
      if (liveSessionState.isEnabled()) await liveSessionState.drop(sourceSession.id);
      return getSessionState(sourceSession.id);
    } catch (err) {
      await query('ROLLBACK');
      throw err;
    }
  }

  // 6P ongoing (e.g. pool inter_deal `ready`): soft away so disconnect-style
  // pending rejoin remains available. Never apply to 2P or finished games.
  if (isSixPlayerSoftRejoinSession(sourceSession)) {
    return recordSoftTableAway({
      sourceSessionId: sourceSession.id,
      userId,
      reason: 'soft_table_away_continuation',
    });
  }

  const leftUserIds = new Set(
    (Array.isArray(sourceSession.metadata?.post_result_left_user_ids) ? sourceSession.metadata.post_result_left_user_ids : [])
      .map((playerId) => Number(playerId))
      .filter((playerId) => !Number.isNaN(playerId))
  );
  leftUserIds.add(Number(userId));

  await gameSessionModel.updateSessionStatus(sourceSession.id, sourceSession.status, {
    metadata: {
      ...(sourceSession.metadata || {}),
      post_result_left_user_ids: Array.from(leftUserIds),
      phase_updated_at: new Date().toISOString(),
    },
  });

  await gameSessionModel.insertEvent({
    sessionId: sourceSession.id,
    userId,
    eventType: 'table_left',
    payload: {
      source_session_id: sourceSession.id,
    },
  });

  // If a continuation/rematch session already exists and the player has opted to leave
  // before rematch execution completes, mark them as left there as well so pending-rejoin
  // does not keep surfacing that active table.
  const candidateContinuationSessionId = Number(sourceSession?.metadata?.latest_continuation_session_id);
  let continuationSession = null;
  if (!Number.isNaN(candidateContinuationSessionId)) {
    continuationSession = await gameSessionModel.findSessionById(candidateContinuationSessionId);
  }
  if (!continuationSession || !['waiting', 'ready', 'active'].includes(String(continuationSession.status || '').toLowerCase())) {
    continuationSession = await gameSessionModel.findReservedContinuationSession(sourceSession.id);
  }
  if (continuationSession && Number(continuationSession.id) !== Number(sourceSession.id)) {
    const continuationPlayer = await gameSessionModel.findPlayer(continuationSession.id, userId);
    if (continuationPlayer && ['joined', 'disconnected'].includes(String(continuationPlayer.status || '').toLowerCase())) {
      await gameSessionModel.updatePlayerState(continuationSession.id, userId, {
        status: 'left',
        leftAt: new Date(),
        metadata: {
          ...(continuationPlayer.metadata || {}),
          table_left: true,
          auto_rematch_opt_out: true,
          left_at: new Date().toISOString(),
          connection_status: 'disconnected',
          is_connected: false,
        },
      });
      await gameSessionModel.insertEvent({
        sessionId: continuationSession.id,
        userId,
        eventType: 'table_left',
        payload: {
          source_session_id: sourceSession.id,
          continuation_session_id: continuationSession.id,
          rematch_opt_out: true,
        },
      });
    }
  }

  return getSessionState(sourceSession.id);
}

async function recordExplicitTableLeave({
  sourceSessionId,
  userId,
  reason = 'table_left',
  activeSessionExit = false,
}) {
  const sourceSession = await getSessionState(sourceSessionId);
  if (!sourceSession) {
    const error = new Error('Source session not found');
    error.code = 'SESSION_NOT_FOUND';
    throw error;
  }

  const sourcePlayer = (sourceSession.players || []).find(
    (player) => Number(player.user_id) === Number(userId)
  );
  if (!sourcePlayer) {
    const error = new Error('Player not found in source session');
    error.code = 'PLAYER_NOT_FOUND';
    throw error;
  }

  const leftUserIds = new Set(
    (Array.isArray(sourceSession.metadata?.post_result_left_user_ids)
      ? sourceSession.metadata.post_result_left_user_ids
      : [])
      .map((playerId) => Number(playerId))
      .filter((playerId) => !Number.isNaN(playerId))
  );
  leftUserIds.add(Number(userId));

  await gameSessionModel.updateSessionStatus(sourceSession.id, sourceSession.status, {
    metadata: {
      ...(sourceSession.metadata || {}),
      post_result_left_user_ids: Array.from(leftUserIds),
      phase_updated_at: new Date().toISOString(),
    },
  });

  const nextPlayerMetadata = {
    ...(sourcePlayer.metadata || {}),
    table_left: true,
    pool_rejoin_opt_out: true,
    auto_rematch_opt_out: true,
    pending_rejoin_opt_out: true,
    soft_table_away: false,
    left_at: new Date().toISOString(),
    connection_status: 'disconnected',
    is_connected: false,
  };
  const nextPlayerStatus = ['joined', 'disconnected', 'eliminated'].includes(
    String(sourcePlayer.status || '').toLowerCase()
  )
    ? 'left'
    : sourcePlayer.status;

  await gameSessionModel.updatePlayerState(sourceSession.id, userId, {
    status: nextPlayerStatus,
    leftAt: new Date(),
    metadata: nextPlayerMetadata,
  });

  await gameSessionModel.insertEvent({
    sessionId: sourceSession.id,
    userId,
    eventType: 'table_left',
    payload: {
      source_session_id: sourceSession.id,
      active_session_exit: activeSessionExit === true,
      reason,
    },
  });

  return getSessionState(sourceSession.id);
}

/**
 * 6-player only: leave the UI like a disconnect without hard opting out of
 * pending rejoin. Seat stays reserved; deal-drop / invalid-pack state is preserved.
 * Does NOT charge or touch pool buyback eligibility flags.
 */
async function recordSoftTableAway({
  sourceSessionId,
  userId,
  reason = 'soft_table_away',
}) {
  const sourceSession = await getSessionState(sourceSessionId);
  if (!sourceSession) {
    const error = new Error('Source session not found');
    error.code = 'SESSION_NOT_FOUND';
    throw error;
  }
  if (Number(sourceSession.max_players) !== 6) {
    const error = new Error('Soft table away is only allowed on 6-player tables');
    error.code = 'SOFT_AWAY_NOT_ALLOWED';
    throw error;
  }

  const sourcePlayer = (sourceSession.players || []).find(
    (player) => Number(player.user_id) === Number(userId)
  );
  if (!sourcePlayer) {
    const error = new Error('Player not found in source session');
    error.code = 'PLAYER_NOT_FOUND';
    throw error;
  }

  const playerStatus = String(sourcePlayer.status || '').toLowerCase();
  const meta = sourcePlayer.metadata || {};
  const isDealPacked = meta.packed_in_current_deal === true
    || meta.invalid_declaration === true;
  const isDealDropped = meta.is_dropped === true
    || String(meta.drop_status || '').toLowerCase() === 'dropped'
    || String(meta.elimination_reason || '').toLowerCase() === 'dropped'
    || String(meta.elimination_reason || '').toLowerCase() === 'timeout'
    // Pool wipe / true seat elimination — not invalid-declare pack (DB often stays joined).
    || (playerStatus === 'eliminated' && !isDealPacked);

  const timestamp = new Date().toISOString();
  const nextPlayerMetadata = {
    ...(sourcePlayer.metadata || {}),
    soft_table_away: true,
    soft_table_away_at: timestamp,
    soft_table_away_reason: reason,
    // Keep seat reclaimable via pending rejoin — do NOT hard-leave.
    table_left: false,
    pool_rejoin_opt_out: false,
    auto_rematch_opt_out: false,
    pending_rejoin_opt_out: false,
    connection_status: 'disconnected',
    is_connected: false,
    disconnected_at: timestamp,
  };

  await gameSessionModel.updatePlayerState(sourceSession.id, userId, {
    // Pack stays disconnect-style so classic + soft listing both see a rejoinable seat.
    status: isDealDropped ? 'eliminated' : 'disconnected',
    leftAt: null,
    metadata: nextPlayerMetadata,
  });

  await gameSessionModel.insertEvent({
    sessionId: sourceSession.id,
    userId,
    eventType: 'soft_table_away',
    payload: {
      source_session_id: sourceSession.id,
      reason,
      deal_dropped: isDealDropped,
      deal_packed: isDealPacked,
    },
  });

  return getSessionState(sourceSession.id);
}

/**
 * Non-6 tables: leave after deal-out (e.g. invalid declare pack) without hard
 * opt-out, so classic disconnect pending rejoin can still surface.
 */
async function recordDisconnectAwayForPendingRejoin({
  sourceSessionId,
  userId,
  reason = 'disconnect_away',
}) {
  const sourceSession = await getSessionState(sourceSessionId);
  if (!sourceSession) {
    const error = new Error('Source session not found');
    error.code = 'SESSION_NOT_FOUND';
    throw error;
  }

  const sourcePlayer = (sourceSession.players || []).find(
    (player) => Number(player.user_id) === Number(userId)
  );
  if (!sourcePlayer) {
    const error = new Error('Player not found in source session');
    error.code = 'PLAYER_NOT_FOUND';
    throw error;
  }

  const playerStatus = String(sourcePlayer.status || '').toLowerCase();
  const meta = sourcePlayer.metadata || {};
  const isDealPacked = meta.packed_in_current_deal === true
    || meta.invalid_declaration === true;
  const keepEliminated = playerStatus === 'eliminated'
    && !isDealPacked
    && (
      meta.is_dropped === true
      || String(meta.drop_status || '').toLowerCase() === 'dropped'
      || String(meta.elimination_reason || '').toLowerCase() === 'pool_limit'
      || String(meta.elimination_reason || '').toLowerCase() === 'timeout'
    );

  const timestamp = new Date().toISOString();
  const nextPlayerMetadata = {
    ...(sourcePlayer.metadata || {}),
    soft_table_away: Number(sourceSession.max_players) === 6,
    soft_table_away_at: timestamp,
    soft_table_away_reason: reason,
    table_left: false,
    pool_rejoin_opt_out: false,
    auto_rematch_opt_out: false,
    pending_rejoin_opt_out: false,
    connection_status: 'disconnected',
    is_connected: false,
    disconnected_at: timestamp,
  };

  await gameSessionModel.updatePlayerState(sourceSession.id, userId, {
    status: keepEliminated ? 'eliminated' : 'disconnected',
    leftAt: null,
    metadata: nextPlayerMetadata,
  });

  await gameSessionModel.insertEvent({
    sessionId: sourceSession.id,
    userId,
    eventType: 'disconnect_away_pending_rejoin',
    payload: {
      source_session_id: sourceSession.id,
      reason,
      deal_packed: isDealPacked,
    },
  });

  return getSessionState(sourceSession.id);
}

/** Hard opt-out of disconnect-style pending rejoin (e.g. switched to another table). */
async function markPendingRejoinOptOut({
  sessionId,
  userId,
  reason = 'pending_rejoin_opt_out',
}) {
  const player = await gameSessionModel.findPlayer(sessionId, userId);
  if (!player) return null;

  const timestamp = new Date().toISOString();
  await gameSessionModel.updatePlayerState(sessionId, userId, {
    metadata: {
      ...(player.metadata || {}),
      pending_rejoin_opt_out: true,
      pending_rejoin_opt_out_at: timestamp,
      pending_rejoin_opt_out_reason: reason,
      soft_table_away: false,
    },
  });

  await gameSessionModel.insertEvent({
    sessionId,
    userId,
    eventType: 'pending_rejoin_opt_out',
    payload: { reason },
  });

  return getSessionState(sessionId);
}

function isSixPlayerSoftRejoinSession(session = {}) {
  return Number(session?.max_players) === 6
    && ['active', 'ready'].includes(String(session?.status || '').toLowerCase());
}

/**
 * True when the player may leave without soft-away / pending-rejoin:
 * - waiting lobby, or
 * - first match-start countdown before entry fee lock (default last 3s).
 * Never true for inter_deal / mid-match countdown / toss / dealing / active play.
 */
function isPregameFreeLeaveEligible(session = {}) {
  const status = String(session?.status || '').toLowerCase();
  if (!['waiting', 'ready'].includes(status)) return false;

  const phase = String(session?.metadata?.phase || '').toLowerCase();
  if (!phase || phase === 'waiting') return true;
  if (phase !== 'countdown') return false;

  // Session already started a deal once → this countdown is inter-deal / next round.
  if (session?.started_at) return false;
  const poolRoundNo = Number(session?.metadata?.pool_round_no);
  if (Number.isFinite(poolRoundNo) && poolRoundNo > 1) return false;
  const dealNo = Number(
    session?.metadata?.current_deal
    ?? session?.metadata?.deal_no
    ?? session?.metadata?.deal
  );
  if (Number.isFinite(dealNo) && dealNo > 1) return false;

  const countdownLockAt = Math.max(
    1,
    Number(process.env.MATCH_COUNTDOWN_LOCK_AT_SECONDS) || 3
  );
  const countdown = session?.metadata?.countdown || {};
  const endsAtMs = countdown?.ends_at ? Date.parse(countdown.ends_at) : NaN;
  const secondsLeft = Number.isFinite(endsAtMs)
    ? Math.max(0, Math.ceil((endsAtMs - Date.now()) / 1000))
    : null;
  const entryLocked = session?.metadata?.entry_locked === true
    || (secondsLeft != null && secondsLeft <= countdownLockAt);
  return !entryLocked;
}

module.exports = {
  createSession,
  joinSession,
  markPlayerReady,
  getSessionState,
  loadTurnActionSession,
  getPendingRejoinSession,
  resolveRejoinPendingMaxAgeMinutes,
  createOrJoinContinuationSession,
  leaveTableContinuation,
  recordExplicitTableLeave,
  recordSoftTableAway,
  recordDisconnectAwayForPendingRejoin,
  markPendingRejoinOptOut,
  isSixPlayerSoftRejoinSession,
  isPregameFreeLeaveEligible,
  userAllowedToAccessSessionMetadata,
};
