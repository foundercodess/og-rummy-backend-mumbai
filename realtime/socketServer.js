const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const crypto = require('crypto');
const gameplayService = require('../services/gameplay.service');
const { computeWalletDebitSplit } = require('../services/walletDebitSplit');
const {
  releasePendingBonusAfterPlay,
  resolveEntryFeesPaidForSession,
} = require('../services/pendingBonusRelease');
const adminLedgerService = require('../services/adminLedger.service');
const gameSessionModel = require('../models/gameSession.model');
const loginAttemptModel = require('../models/loginAttempt.model');
const userModel = require('../models/user.model');
const avatarModel = require('../models/avatar.model');
const groupingService = require('../services/grouping.service');
const { isJokerCard: isJokerCardWithWild } = require('../services/wildJokerRules');
const redisLockService = require('../services/redisLock.service');
const durableTimer = require('../services/durableTimer.service');
const ephemeralSessionState = require('../services/ephemeralSessionState.service');
const botLeaseService = require('../services/botLease.service');
const { isBotInjectionEnabled } = require('../services/botInjectionSettings.service');
const {
  chooseBotDiscardCard,
  buildDiscardCandidateRanking,
  getCardValue,
  isCardIsolated,
  canFinishAfterOneDiscard,
  evaluateHandStrength,
  explainPickSourceDecision,
  compactGroupingSummary,
} = require('../services/botEngine/rummyBotStrategy');
const { pool } = require('../db');
const { getSocketAdapterRedisClients } = require('../services/redis.service');
const sessionCache = require('../services/sessionCache.service');
const liveSessionState = require('../services/liveSessionState.service');
const turnActionIdempotency = require('../services/turnActionIdempotency.service');
const { socketAuth } = require('./socketAuth');
const socketRegistry = require('./socketRegistry');
const { emitActiveNotices, setSocketIO } = require('./socketBus');
const {
  emitLiveGameCounts,
  startLiveCountBroadcaster,
} = require('./gameLiveCount');
const { startPregame, cancelPregame } = require('./pregameOrchestrator');
const {
  anticlockwiseNextTurnUserId,
  resolveNextDealFirstTurnUserId,
} = require('./turnRotation');
const { setTurnTimerStarter } = require('./turnSchedulerBridge');
const {
  toClientCardFaceId,
  resolveClosedDeckTopPreview,
  emitClosedDeckPreviewToTurnPlayer,
  scheduleClosedDeckPreviewFromSession,
} = require('./closedDeckPreview');
const {
  instrumentSocket,
  traceSessionBroadcast,
  handleClientTelemetryAck,
} = require('./socketTelemetry');
const {
  resolvePoolBaseEntryCount,
  resolvePoolRejoinEntryCount,
  buildPoolPrizePoolSummary,
  buildPoolRejoinInfoPayload,
  buildPoolSessionPrizePoolFields,
} = require('../services/poolPrizePool.service');

// ── Namespace helper ──────────────────────────────────────────────────────────
function sessionRoom(sessionId) {
  return `game-session:${sessionId}`;
}

function getSessionIdsFromSocket(socket) {
  return Array.from(socket.rooms || [])
    .filter((room) => room.startsWith('game-session:'))
    .map((room) => Number(room.replace('game-session:', '')))
    .filter((sessionId) => !Number.isNaN(sessionId));
}

function emitToUserInSession(io, sessionId, userId, eventName, payload) {
  const uidNum = Number(userId);
  const socketIds = new Set([
    ...socketRegistry.getSocketIds(Number.isNaN(uidNum) ? userId : uidNum),
    ...socketRegistry.getSocketIds(userId),
  ]);
  const roomSocketIds = io.sockets.adapter.rooms.get(sessionRoom(sessionId)) || new Set();
  for (const sid of socketIds) {
    if (!roomSocketIds.has(sid)) continue;
    const sock = io.sockets.sockets.get(sid);
    if (sock) sock.emit(eventName, payload);
  }
}

async function validateSocketSessionState(socket) {
  const nowMs = Date.now();
  const lastCheckedAtMs = Number(socket?.data?.sessionCheckedAtMs || 0);
  const lastCheckValid = socket?.data?.sessionCheckValid === true;
  if (lastCheckValid && (nowMs - lastCheckedAtMs) < SOCKET_SESSION_CHECK_TTL_MS) {
    return { valid: true, reason: null, activeSession: null };
  }

  const sessionId = String(socket?.user?.sessionId || '').trim();
  const userId = Number(socket?.user?.id);
  if (!sessionId || Number.isNaN(userId)) {
    return { valid: false, reason: 'missing_socket_session_identity', activeSession: null };
  }

  const activeSession = await loginAttemptModel.findActiveBySessionId(sessionId);
  const valid = Boolean(activeSession && Number(activeSession.user_id) === userId);
  socket.data.sessionCheckedAtMs = nowMs;
  socket.data.sessionCheckValid = valid;
  return {
    valid,
    reason: valid ? null : 'session_replaced_or_expired',
    activeSession,
  };
}

// ── Logging helpers ───────────────────────────────────────────────────────────
function logGame(sessionId, msg, ...rest) {
  console.log(`[GAME][${sessionId}] ${msg}`, ...rest);
}
function warnGame(sessionId, msg, ...rest) {
  console.warn(`[GAME][${sessionId}] ⚠ ${msg}`, ...rest);
}
function errorGame(sessionId, msg, ...rest) {
  console.error(`[GAME][${sessionId}] ✖ ${msg}`, ...rest);
}

const BOT_DECISION_EXPLAIN_LOG_ENABLED = (() => {
  const raw = process.env.BOT_DECISION_LOG_ENABLED;
  if (raw === undefined || raw === '') return true;
  return String(raw).trim().toLowerCase() === 'true';
})();

function logBotDecisionExplainability(sessionId, payload = {}) {
  if (!BOT_DECISION_EXPLAIN_LOG_ENABLED) return;
  console.log(`[BOT_DECISION] ${JSON.stringify({
    event: 'bot_decision_explain',
    ts: new Date().toISOString(),
    session_id: sessionId,
    ...payload,
  })}`);
}

const activeDeclareBySession = new Map();
const activeTurnBySession = new Map();
const activeBotActionBySession = new Map();
const activePoolSplitBySession = new Map();
const pendingPoolSplitStartBySession = new Map();
const pendingAutoRematchBySourceSession = new Map();
const pendingPoolEliminationDetachByKey = new Map();
const AUTO_DROP_IDEMPOTENCY_TTL_SECONDS = 120;
const AUTO_REMATCH_COUNTDOWN_SECONDS = 7;
const REMATCH_FAST_COUNTDOWN_SECONDS = 1;
const REMATCH_FAST_FILL_WAIT_MS = 2000;
const REMATCH_BOT_POOL_SIZE = Math.max(10, Math.min(10000, Number(process.env.BOT_POOL_SIZE) || 200));
const REMATCH_BOT_PHONE_PREFIX = String(process.env.BOT_PHONE_PREFIX || '98999').replace(/\D/g, '');
const REMATCH_BOT_NAME_PREFIX = String(process.env.BOT_NAME_PREFIX || 'RummyBot-');
const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const declarationRuntime = {
  startWindow: null,
  scheduleBotResponses: null,
};
const DECLARATION_VISIBILITY_AWAITING_DECLARER = 'awaiting_declarer_submit';
const DECLARATION_VISIBILITY_OPEN_FOR_ALL = 'open_for_all';
const DECLARE_WINDOW_SECONDS = 30;
const DECLARE_RESULT_IDEMPOTENCY_TTL_SECONDS = 300;
const TURN_TIMEOUT_IDEMPOTENCY_TTL_SECONDS = 120;
const POOL_SPLIT_WINDOW_SECONDS = Math.max(10, Number(process.env.POOL_SPLIT_WINDOW_SECONDS) || 20);
const POOL_NEXT_DEAL_COUNTDOWN_SECONDS = Math.max(5, Number(process.env.POOL_NEXT_DEAL_COUNTDOWN_SECONDS) || 10);
const POOL_SPLIT_ENABLED = String(process.env.POOL_SPLIT_ENABLED || '').toLowerCase() === 'true';
const MAX_BONUS_ATTEMPTS_PER_PLAYER = 1;
const MAX_ROUND_LOSS_POINTS = 80;
const TURN_START_GRACE_MS = 1000;
const BOT_ACTION_DELAY_MIN_MS = Math.max(250, Number(process.env.BOT_ACTION_DELAY_MIN_MS) || 400);
const BOT_ACTION_DELAY_MAX_MS = Math.max(BOT_ACTION_DELAY_MIN_MS, Number(process.env.BOT_ACTION_DELAY_MAX_MS) || 1400);
const BOT_ACTION_DELAY_MS = Math.max(0, Number(process.env.BOT_ACTION_DELAY_MS) || 0);
const BOT_POST_PICK_DELAY_MIN_MS = Math.max(2000, Number(process.env.BOT_POST_PICK_DELAY_MIN_MS) || 2000);
const BOT_POST_PICK_DELAY_MAX_MS = Math.max(BOT_POST_PICK_DELAY_MIN_MS, Number(process.env.BOT_POST_PICK_DELAY_MAX_MS) || 8000);
const BOT_POST_PICK_DELAY_MS = Math.max(0, Number(process.env.BOT_POST_PICK_DELAY_MS) || 0);
const BOT_DECLARE_RESPONSE_DELAY_MS = Math.max(300, Number(process.env.BOT_DECLARE_RESPONSE_DELAY_MS) || 650);
const BOT_AGGRESSION_ENABLED = String(process.env.BOT_AGGRESSION_ENABLED || 'true').trim().toLowerCase() === 'true';
const BOT_AGGRESSIVE_PICK_DELAY_MIN_MULTIPLIER = 0.28;
const BOT_AGGRESSIVE_PICK_DELAY_MAX_MULTIPLIER = 0.52;
const BOT_AGGRESSIVE_DISCARD_DELAY_MIN_MULTIPLIER = 0.22;
const BOT_AGGRESSIVE_DISCARD_DELAY_MAX_MULTIPLIER = 0.48;
const BOT_STRATEGIC_DROP_ENABLED = String(process.env.BOT_STRATEGIC_DROP_ENABLED || 'true').trim().toLowerCase() === 'true';
const BOT_DROP_BENEFIT_THRESHOLD = Math.max(12, Number(process.env.BOT_DROP_BENEFIT_THRESHOLD) || 28);
const BOT_STRATEGIC_DROP_EARLY_TURN_GATE = Math.max(1, Number(process.env.BOT_STRATEGIC_DROP_EARLY_TURN_GATE) || 6);
const BOT_HOPELESS_DISPLAY_POINT = Math.max(30, Number(process.env.BOT_HOPELESS_DISPLAY_POINT) || 58);
const BOT_HOPELESS_TURN_MIN = Math.max(1, Number(process.env.BOT_HOPELESS_TURN_MIN) || 5);
const BOT_HOPELESS_DROP_BENEFIT_MIN = Math.max(10, Number(process.env.BOT_HOPELESS_DROP_BENEFIT_MIN) || 28);
const BOT_EARLY_DROP_MEANINGFUL_UNGROUPED_REDUCTION = Math.max(
  6,
  Number(process.env.BOT_EARLY_DROP_MEANINGFUL_UNGROUPED_REDUCTION) || 10
);
const BOT_STRUCTURE_BLOCK_UNGROUPED_MAX = Math.max(
  15,
  Number(process.env.BOT_STRUCTURE_BLOCK_UNGROUPED_MAX) || 38
);
const BOT_POOL_COMFORTABLE_HEADROOM = Math.max(20, Number(process.env.BOT_POOL_COMFORTABLE_HEADROOM) || 45);
const BOT_POOL_NEAR_ELIMINATION_HEADROOM = Math.max(8, Number(process.env.BOT_POOL_NEAR_ELIMINATION_HEADROOM) || 28);
const BOT_POOL_HIGH_SCORE_DROP_AT = Math.max(30, Number(process.env.BOT_POOL_HIGH_SCORE_DROP_AT) || 50);
const BOT_EARLY_DROP_MIN_MARGIN = Math.max(10, Number(process.env.BOT_EARLY_DROP_MIN_MARGIN) || 35);
const BOT_STRATEGIC_DROP_MAX_PROBABILITY = Math.max(
  0.05,
  Math.min(0.6, Number(process.env.BOT_STRATEGIC_DROP_MAX_PROBABILITY) || 0.28)
);
const BOT_POOL_STRATEGIC_DROP_MAX_PROBABILITY = Math.max(
  0.05,
  Math.min(0.5, Number(process.env.BOT_POOL_STRATEGIC_DROP_MAX_PROBABILITY) || 0.22)
);
const BOT_SPLIT_AUTO_RESPONSE_MIN_MS = Math.max(250, Number(process.env.BOT_SPLIT_AUTO_RESPONSE_MIN_MS) || 600);
const BOT_SPLIT_AUTO_RESPONSE_MAX_MS = Math.max(BOT_SPLIT_AUTO_RESPONSE_MIN_MS, Number(process.env.BOT_SPLIT_AUTO_RESPONSE_MAX_MS) || 1500);
const BOT_SPLIT_MIN_GAIN_MULTIPLIER = Math.max(0.2, Number(process.env.BOT_SPLIT_MIN_GAIN_MULTIPLIER) || 0.6);
const BOT_EARLY_DROP_DEAD_HAND_ENABLED = String(process.env.BOT_EARLY_DROP_DEAD_HAND_ENABLED || 'true').trim().toLowerCase() === 'true';
const BOT_SOFT_RIGGING_DECK_LOOKAHEAD = Math.max(3, Number(process.env.BOT_SOFT_RIGGING_DECK_LOOKAHEAD) || 5);
const BOT_SOFT_RIGGING_MAX_HELPFUL_CANDIDATES = Math.max(2, Number(process.env.BOT_SOFT_RIGGING_MAX_HELPFUL_CANDIDATES) || 4);
const BOT_SOFT_RIGGING_MIN_PICK_MULTIPLIER = 0.65;
const BOT_SOFT_RIGGING_MAX_PICK_MULTIPLIER = 0.88;
const BOT_SOFT_RIGGING_MIN_DISCARD_MULTIPLIER = 0.7;
const BOT_SOFT_RIGGING_MAX_DISCARD_MULTIPLIER = 0.92;
const BOT_CONSERVATIVE_PLAY_ON_LOW_CONFIDENCE = String(process.env.BOT_CONSERVATIVE_PLAY_ON_LOW_CONFIDENCE || 'true').trim().toLowerCase() === 'true';
const BOT_LOW_CONFIDENCE_THRESHOLD = Math.max(0, Math.min(1, Number(process.env.BOT_LOW_CONFIDENCE_THRESHOLD) || 0.72));
const BOT_LOW_MARGIN_THRESHOLD = Math.max(0, Number(process.env.BOT_LOW_MARGIN_THRESHOLD) || 12);
const GROUPING_TIE_NEAR_EQUAL_MARGIN = Math.max(1, Number(process.env.GROUPING_TIE_NEAR_EQUAL_MARGIN) || 10);
const BOT_FINISH_DEBUG_LOG_ENABLED = String(process.env.BOT_FINISH_DEBUG_LOG_ENABLED || 'false').trim().toLowerCase() === 'true';
const BOT_FINISH_EVAL_WARN_MS = Math.max(5, Number(process.env.BOT_FINISH_EVAL_WARN_MS) || 60);
/**
 * Hard CPU budget for bot finish-card search (ms). Always enforced — even when no
 * candidate has been found yet — so a miss cannot block the gameplay event loop.
 */
const BOT_FINISH_EVAL_BUDGET_MS = Math.max(
  10,
  Number(process.env.BOT_FINISH_EVAL_BUDGET_MS) || 40
);
/** Cap how many finish-card candidates we fully re-group under the hard budget. */
const BOT_FINISH_EVAL_MAX_CARDS = Math.max(
  1,
  Math.min(14, Number(process.env.BOT_FINISH_EVAL_MAX_CARDS) || 5)
);
/** High enough that an invalid-single leftover is near-optimal; stop early when found. */
const BOT_FINISH_EARLY_EXIT_UTILITY = Math.max(
  500,
  Number(process.env.BOT_FINISH_EARLY_EXIT_UTILITY) || 1650
);
/**
 * Cap stored discard_history.timeline (and emit payload size). Game rules use
 * distribution.discard_pile — history is UI/audit only. Keep enough entries for
 * pick-marking the open pile top and the discard-history panel.
 */
const DISCARD_HISTORY_MAX_ENTRIES = Math.max(
  8,
  Math.min(500, Number(process.env.DISCARD_HISTORY_MAX_ENTRIES) || 48),
);
/** Human pick ACK finish-hint scan budget (ungrouped leftovers). Rules unchanged. */
const PICK_ACK_FINISH_PLAN_MAX_CANDIDATES = Math.max(
  1,
  // Default lowered to reduce CPU spikes at high CCU.
  Math.min(8, Number(process.env.PICK_ACK_FINISH_PLAN_MAX_CANDIDATES) || 1),
);
/** Yield so inbound socket:ping / player ACKs can run between bot CPU chunks. */
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}
/** Lean session row+players for bot/timer hot paths (no events/contest/prize assembly). */
function loadBotActionSession(sessionId) {
  return gameplayService.loadTurnActionSession(sessionId);
}
const SOCKET_SESSION_CHECK_TTL_MS = Math.max(1000, Number(process.env.SOCKET_SESSION_CHECK_TTL_MS) || 3000);
const POOL_REJOIN_THRESHOLD_BY_LIMIT = {
  101: 79,
  201: 174,
};
// Bots must not drop once cumulative pool score exceeds these limits.
const POOL_BOT_DROP_BLOCK_SCORE_BY_LIMIT = {
  101: 80,
  201: 150,
};
/** First-drop penalty used as the unit for "drops remaining" in split (101→20, 201→25). */
function resolvePoolSplitDropUnit(poolLimit) {
  return Number(poolLimit) >= 201 ? 25 : 20;
}

function resolvePickSource(source) {
  if (source === 'discard') return 'discard';
  if (source === 'available' || source === 'avl') return 'closed';
  return 'closed';
}

function buildDecisionSeed(sessionId, turnId, userId) {
  return `${Number(sessionId) || 0}:${Number(turnId) || 0}:${Number(userId) || 0}`;
}

function deterministicRoll(seed, salt = '') {
  const input = `${seed}:${salt}`;
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function buildGroupingTieBreakOptions(seed) {
  return {
    tieBreakSeed: String(seed || ''),
    nearTieMargin: GROUPING_TIE_NEAR_EQUAL_MARGIN,
  };
}

function isLowConfidenceGrouping(summary = {}) {
  const confidenceRaw = summary?.grouping_confidence;
  const marginRaw = summary?.decision_margin;
  if (confidenceRaw == null || marginRaw == null) return false;
  const confidence = Number(confidenceRaw);
  const margin = Number(marginRaw);
  if (!Number.isFinite(confidence) || !Number.isFinite(margin)) return false;
  return confidence < BOT_LOW_CONFIDENCE_THRESHOLD || margin < BOT_LOW_MARGIN_THRESHOLD;
}

function nextTurnUserId(players, currentUserId, options = {}) {
  return anticlockwiseNextTurnUserId(players, currentUserId, options);
}

function getEliminatedUserIdSet(metadata = {}) {
  const eliminated = [
    ...(Array.isArray(metadata?.turn_eliminated_user_ids) ? metadata.turn_eliminated_user_ids : []),
    ...(Array.isArray(metadata?.pool_eliminated_user_ids) ? metadata.pool_eliminated_user_ids : []),
  ];

  return new Set(eliminated.map((id) => Number(id)).filter((id) => !Number.isNaN(id)));
}

/** Pool threshold only — do not mix with deal drop / turn timeout eliminations. */
function getPoolEliminatedUserIdSet(metadata = {}) {
  return new Set(
    (Array.isArray(metadata?.pool_eliminated_user_ids) ? metadata.pool_eliminated_user_ids : [])
      .map((id) => Number(id))
      .filter((id) => !Number.isNaN(id))
  );
}

function isPoolThresholdEliminatedPlayer(session, player, userId = null) {
  const uid = Number(userId != null ? userId : player?.user_id);
  if (Number.isNaN(uid)) return false;
  if (getPoolEliminatedUserIdSet(session?.metadata || {}).has(uid)) return true;
  return String(player?.metadata?.elimination_reason || '').toLowerCase() === 'pool_limit';
}

/**
 * Mid-pool wipe on an unfinished table: "Back to Table" must open a fresh
 * same-contest matchmaking room — never a reserved rematch against the live pool.
 * Completed games keep the existing same-table continuation path.
 */
function shouldOpenFreshMatchmakingOnTableBack(session = {}, userId = null) {
  const status = String(session?.status || '').toLowerCase();
  if (status === 'completed') return false;
  if (!['waiting', 'ready', 'active'].includes(status)) return false;
  if (resolveSessionGameMode(session) !== 'pool') return false;

  const uid = Number(userId);
  if (Number.isNaN(uid)) return false;
  const player = (Array.isArray(session.players) ? session.players : [])
    .find((item) => Number(item?.user_id) === uid);
  return isPoolThresholdEliminatedPlayer(session, player || {}, uid);
}

/**
 * Seat is out of the current deal / match (drop, timeout, pool wipe, exit).
 * Used for presence reconnect — not for choosing pool-threshold copy.
 */
function isSeatOutOfActivePlayForPresence(session, player, userId = null) {
  const uid = Number(userId != null ? userId : player?.user_id);
  if (Number.isNaN(uid)) return false;
  if (String(player?.status || '').toLowerCase() === 'eliminated') return true;
  if (getEliminatedUserIdSet(session?.metadata || {}).has(uid)) return true;
  if (getTimeoutEliminatedUserIdSet(session?.metadata || {}).has(uid)) return true;
  if (player?.metadata?.is_dropped === true) return true;
  if (String(player?.metadata?.drop_status || '').toLowerCase() === 'dropped') return true;
  const reason = String(player?.metadata?.elimination_reason || '').toLowerCase();
  return ['pool_limit', 'dropped', 'timeout', 'player_exit'].includes(reason);
}

/**
 * Banner copy for out-of-play statuses. Empty for active/disconnected so
 * presence reconnects do not spam misleading elimination UI.
 */
function buildOutOfPlayBannerMessages(playerStatus, { isPoolThreshold = false } = {}) {
  const status = String(playerStatus || '').toLowerCase();
  if (status === 'timeout') {
    return {
      content_message: 'You timed out. Please wait for others to finish the game.',
      action_message: 'Please wait for next round to start.',
    };
  }
  if (status === 'dropped') {
    return {
      content_message: 'You have dropped this game. Please wait for others to finish the game. or click "Switch" to start a new game.',
      action_message: 'Please wait for next round to start.',
    };
  }
  if (status === 'eliminated' && isPoolThreshold) {
    return {
      content_message: 'You reached the pool threshold and are eliminated.',
      action_message: 'Please wait for game completion or use rejoin option if available.',
    };
  }
  if (status === 'eliminated') {
    return {
      content_message: 'You are out of this deal. Please wait for others to finish.',
      action_message: 'Please wait for next round to start.',
    };
  }
  return {};
}

function resolvePreviousPoolEliminatedUserIds(session = {}) {
  return (Array.isArray(session?.metadata?.pool_eliminated_user_ids)
    ? session.metadata.pool_eliminated_user_ids
    : [])
    .map((id) => Number(id))
    .filter((id) => !Number.isNaN(id));
}

function resolveNewlyPoolEliminatedUserIds(session = {}, poolProgress = {}) {
  const previous = new Set(resolvePreviousPoolEliminatedUserIds(session));
  return (Array.isArray(poolProgress?.eliminatedUserIds) ? poolProgress.eliminatedUserIds : [])
    .map((id) => Number(id))
    .filter((id) => !Number.isNaN(id) && !previous.has(id));
}

function buildPoolEliminationContextFields(session = {}, poolProgress = {}) {
  const previousPoolEliminatedUserIds = resolvePreviousPoolEliminatedUserIds(session);
  const poolNewlyEliminatedUserIds = resolveNewlyPoolEliminatedUserIds(session, poolProgress);
  return {
    pool_previous_eliminated_user_ids: previousPoolEliminatedUserIds,
    pool_newly_eliminated_user_ids: poolNewlyEliminatedUserIds,
    previousPoolEliminatedUserIds,
    poolNewlyEliminatedUserIds,
  };
}

function getTimeoutEliminatedUserIdSet(metadata = {}) {
  const eliminated = Array.isArray(metadata?.turn_timeout_eliminated_user_ids)
    ? metadata.turn_timeout_eliminated_user_ids
    : [];

  return new Set(eliminated.map((id) => Number(id)).filter((id) => !Number.isNaN(id)));
}

function getTurnEliminatedUserIdSet(metadata = {}) {
  const eliminated = Array.isArray(metadata?.turn_eliminated_user_ids)
    ? metadata.turn_eliminated_user_ids
    : [];
  return new Set(eliminated.map((id) => Number(id)).filter((id) => !Number.isNaN(id)));
}

function isInvalidDeclarationPackedPlayer(player = {}, metadata = {}) {
  const playerMeta = player?.metadata && typeof player.metadata === 'object'
    ? player.metadata
    : {};
  if (playerMeta.packed_in_current_deal === true) return true;
  if (playerMeta.invalid_declaration === true) return true;
  return false;
}

/** Fixed wrong-show penalty — never hand / ungrouped points. */
function resolveInvalidDeclarationPenaltyPoints(player = {}) {
  const prior = Number(player?.metadata?.invalid_declaration_penalty_points);
  if (Number.isFinite(prior) && prior > 0) {
    return Math.min(MAX_ROUND_LOSS_POINTS, Math.max(0, Math.floor(prior)));
  }
  return MAX_ROUND_LOSS_POINTS;
}

/**
 * Merge pack flags onto in-memory players so finalize / result builders do not
 * fall back to scoreFromBestGrouping when DB persist has not been reloaded yet.
 */
function applyInvalidDeclarationPackToSessionPlayers(
  session,
  userId,
  {
    penaltyPoints = MAX_ROUND_LOSS_POINTS,
    cumulativePoints = null,
    eliminated = false,
  } = {}
) {
  const uid = Number(userId);
  if (!session || Number.isNaN(uid)) return session;
  const players = (Array.isArray(session.players) ? session.players : []).map((player) => {
    if (Number(player?.user_id) !== uid) return player;
    return {
      ...player,
      metadata: {
        ...(player.metadata || {}),
        invalid_declaration: true,
        packed_in_current_deal: true,
        invalid_declaration_penalty_points: penaltyPoints,
        ...(cumulativePoints != null ? { cumulative_points: cumulativePoints } : {}),
        ...(eliminated ? { elimination_reason: 'pool_limit' } : {}),
      },
    };
  });
  return { ...session, players };
}

/**
 * Classify seat for table:leave / soft-away.
 * Invalid-declare pack is per-deal only — it must NOT force hard leave / pending opt-out.
 */
function buildTableLeaveSeatFlags(session = {}, player = {}, userId = null) {
  const uid = Number(userId != null ? userId : player?.user_id);
  const meta = player?.metadata && typeof player.metadata === 'object'
    ? player.metadata
    : {};
  const status = String(player?.status || '').toLowerCase();
  const eliminationReason = String(meta.elimination_reason || '').toLowerCase();

  const isTurnEliminated = !Number.isNaN(uid)
    && getTurnEliminatedUserIdSet(session?.metadata || {}).has(uid);
  const isTimeoutEliminated = !Number.isNaN(uid)
    && getTimeoutEliminatedUserIdSet(session?.metadata || {}).has(uid);
  const isPoolEliminated = !Number.isNaN(uid)
    && (
      getPoolEliminatedUserIdSet(session?.metadata || {}).has(uid)
      || eliminationReason === 'pool_limit'
    );
  const isDealDropped = meta.is_dropped === true
    || String(meta.drop_status || '').toLowerCase() === 'dropped'
    || eliminationReason === 'dropped'
    || eliminationReason === 'timeout';
  const isDealPacked = isInvalidDeclarationPackedPlayer(player);
  const alreadyHardLeft = meta.table_left === true || status === 'left';

  // Skip dropPlayerFromSession — seat already out of this deal's rotation.
  const skipRedundantDrop = isDealDropped
    || isDealPacked
    || isTurnEliminated
    || isTimeoutEliminated
    || isPoolEliminated
    || status === 'eliminated'
    || alreadyHardLeft;

  // Hide pending rejoin permanently. Pack / turn_eliminated alone is NOT this.
  const forceHardLeave = alreadyHardLeft
    || isPoolEliminated
    || isDealDropped
    || isTimeoutEliminated;

  return {
    uid,
    isTurnEliminated,
    isTimeoutEliminated,
    isPoolEliminated,
    isDealDropped,
    isDealPacked,
    alreadyHardLeft,
    skipRedundantDrop,
    forceHardLeave,
  };
}

/** Persist pack flags so later session:state / finalize do not re-score the seat. */
async function persistInvalidDeclarationPackMetadata(
  sessionId,
  userId,
  {
    penaltyPoints = 80,
    cumulativePoints = null,
    eliminated = false,
  } = {}
) {
  const player = await gameSessionModel.findPlayer(sessionId, userId);
  if (!player) return null;
  const nextMetadata = {
    ...(player.metadata || {}),
    invalid_declaration: true,
    packed_in_current_deal: true,
    invalid_declaration_penalty_points: penaltyPoints,
    ...(cumulativePoints != null ? { cumulative_points: cumulativePoints } : {}),
    ...(eliminated ? { elimination_reason: 'pool_limit' } : {}),
  };
  return gameSessionModel.updatePlayerMetadata(sessionId, userId, nextMetadata);
}

/**
 * Lock the player's manual declare layout into the in-memory declare window.
 * Must run before invalid-pack result builders so result UI does not fall back
 * to buildBestGrouping when responses were never written.
 */
function recordManualDeclareResponse(state, userId, groups = []) {
  if (!state?.responses || userId == null) return;
  const uidNum = Number(userId);
  const key = Number.isNaN(uidNum) ? userId : uidNum;
  state.responses.set(key, {
    submitted_at: new Date().toISOString(),
    auto: false,
    groups: Array.isArray(groups) ? groups : [],
  });
  persistDeclareState(state);
}

/**
 * Persist last manual arrangement on distribution so later finalize / inactive
 * prefills can show the same groups (instead of inventing a best layout).
 */
async function persistPlayerSubmittedGroups(sessionId, userId, groups = []) {
  const session = await gameplayService.getSessionState(sessionId);
  if (!session) return null;
  const distribution = session.metadata?.distribution;
  if (!distribution || !Array.isArray(distribution.players)) return session;

  const nextPlayers = distribution.players.map((pd) => {
    if (Number(pd?.user_id) !== Number(userId)) return pd;
    // Never persist UIDs that are no longer in the hand (finish / sync drift).
    const safeGroups = coerceSubmittedGroupsForHand(groups, pd?.cards || []);
    return {
      ...pd,
      submitted_groups: safeGroups,
    };
  });
  const nextMetadata = {
    ...(session.metadata || {}),
    distribution: {
      ...distribution,
      players: nextPlayers,
    },
    phase_updated_at: new Date().toISOString(),
  };
  await gameSessionModel.updateSessionStatus(sessionId, session.status, {
    metadata: nextMetadata,
  });
  return gameplayService.getSessionState(sessionId);
}

function getActivePlayers(session) {
  const players = Array.isArray(session?.players) ? session.players : [];
  const eliminated = getEliminatedUserIdSet(session?.metadata || {});
  const turnEliminated = getTurnEliminatedUserIdSet(session?.metadata || {});
  return players.filter((player) => {
    const userId = Number(player?.user_id);
    if (Number.isNaN(userId)) return false;
    if (eliminated.has(userId)) return false;
    if (turnEliminated.has(userId)) return false;
    if (player?.status === 'left' || player?.status === 'eliminated') return false;
    if (player?.metadata?.is_dropped === true) return false;
    if (String(player?.metadata?.drop_status || '').toLowerCase() === 'dropped') return false;
    return true;
  });
}

function isSessionEligibleForAutoDrop(session) {
  if (!session) return false;
  const status = String(session.status || '').toLowerCase();
  if (status === 'active') return true;
  // Pool tables sit in `ready` between deals while players remain seated.
  if (status === 'ready' && resolveSessionGameMode(session) === 'pool') return true;
  return false;
}

function isPlayerEligibleForAutoDrop(session, player) {
  if (!player) return false;
  if (player?.metadata?.is_bot === true) return false;
  const userId = Number(player.user_id);
  if (Number.isNaN(userId)) return false;
  return getActivePlayers(session).some((item) => Number(item.user_id) === userId);
}

function normalizeSessionModeValue(value) {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;

  if (normalized.includes('practice')) return 'practice';
  if (normalized.includes('spin')) return 'spin_go';
  if (normalized.includes('deal')) return 'deals_2';
  if (normalized.includes('pool')) return 'pool';
  if (normalized.includes('point')) return 'points';
  return null;
}

function isDealLikeMode(mode) {
  return mode === 'deals_2' || mode === 'spin_go';
}

function resolveSessionGameMode(session = {}) {
  const metadata = session.metadata || {};
  return normalizeSessionModeValue(metadata.game_mode)
    || normalizeSessionModeValue(metadata.game_type)
    || normalizeSessionModeValue(metadata.mode)
    || normalizeSessionModeValue(session?.game?.name)
    || 'points';
}

function isAutoRematchAllowedMode(session = {}) {
  const mode = resolveSessionGameMode(session);
  return ['points', 'spin_go', 'practice'].includes(mode);
}

function resolveTotalDeals(session = {}) {
  const mode = resolveSessionGameMode(session);
  if (mode === 'spin_go') return 1;
  if (mode !== 'deals_2') return 1;
  const totalDeals = Number(session?.metadata?.total_deals);
  return Number.isFinite(totalDeals) && totalDeals >= 2 ? Math.floor(totalDeals) : 2;
}

function resolveCurrentDeal(session = {}) {
  const raw = Number(session?.metadata?.current_deal);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return 1;
}

function normalizeDealScoreHistory(metadata = {}) {
  const raw = Array.isArray(metadata?.deal_scores) ? metadata.deal_scores : [];
  return raw
    .map((entry) => {
      const dealNo = Number(entry?.deal_no || entry?.deal);
      const results = Array.isArray(entry?.results) ? entry.results : [];
      if (!Number.isFinite(dealNo) || dealNo < 1) return null;
      return {
        ...entry,
        deal_no: Math.floor(dealNo),
        results,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.deal_no - b.deal_no);
}

function resolveDealBaseScore(session = {}, totalDeals = null) {
  const resolvedTotalDeals = Number.isFinite(Number(totalDeals))
    ? Math.max(1, Math.floor(Number(totalDeals)))
    : resolveTotalDeals(session);
  return resolvedTotalDeals * 80;
}

function normalizeDealScoreTotalsByUser(session = {}, options = {}) {
  const metadata = session?.metadata || {};
  const raw = options?.totalsByUser || metadata.deal_score_totals_by_user || {};
  const players = Array.isArray(session?.players) ? session.players : [];
  const totalDeals = Number.isFinite(Number(options?.totalDeals))
    ? Math.max(1, Math.floor(Number(options.totalDeals)))
    : resolveTotalDeals(session);
  const dealBaseScore = resolveDealBaseScore(session, totalDeals);
  const normalized = {};

  players.forEach((player) => {
    const userId = Number(player?.user_id);
    if (Number.isNaN(userId)) return;
    const value = Number(raw[String(userId)]);
    normalized[String(userId)] = Number.isFinite(value) ? value : dealBaseScore;
  });

  Object.entries(raw || {}).forEach(([userId, score]) => {
    const numericUserId = Number(userId);
    if (Number.isNaN(numericUserId)) return;
    if (!Object.prototype.hasOwnProperty.call(normalized, String(numericUserId))) {
      const numericScore = Number(score);
      normalized[String(numericUserId)] = Number.isFinite(numericScore) ? numericScore : dealBaseScore;
    }
  });

  return normalized;
}

function resolvePlayerTotalScore(session = {}, userId) {
  const numericUserId = Number(userId);
  if (Number.isNaN(numericUserId)) return null;
  const mode = resolveSessionGameMode(session);
  if (isDealLikeMode(mode)) {
    const totalsByUser = normalizeDealScoreTotalsByUser(session);
    const totalScore = Number(totalsByUser[String(numericUserId)]);
    return Number.isFinite(totalScore) ? totalScore : null;
  }
  if (mode === 'pool') {
    const totalsByUser = normalizePoolScoresByUser(session?.metadata || {});
    const totalScore = Number(totalsByUser[String(numericUserId)]);
    return Number.isFinite(totalScore) ? totalScore : 0;
  }
  return null;
}

function buildDealContextFields(session = {}, options = {}) {
  const mode = resolveSessionGameMode(session);
  if (mode === 'pool') {
    const poolRoundRaw = Number(session?.metadata?.pool_round_no);
    const currentDealRaw = Number(session?.metadata?.current_deal);
    const poolRoundNo = Number.isFinite(poolRoundRaw) && poolRoundRaw >= 1
      ? Math.floor(poolRoundRaw)
      : (Number.isFinite(currentDealRaw) && currentDealRaw >= 1 ? Math.floor(currentDealRaw) : 1);
    return {
      deal_no: poolRoundNo,
      total_deals: null,
      pool_round_no: poolRoundNo,
      deal_scores: null,
      deal_base_score: null,
      deal_score_totals_by_user: null,
    };
  }
  if (!isDealLikeMode(mode)) {
    return {
      deal_no: null,
      total_deals: null,
      pool_round_no: null,
      deal_scores: null,
      deal_base_score: null,
      deal_score_totals_by_user: null,
    };
  }

  const resolvedDealNo = Number(options?.dealNo);
  const dealNo = Number.isFinite(resolvedDealNo) && resolvedDealNo >= 1
    ? Math.floor(resolvedDealNo)
    : resolveCurrentDeal(session);

  const resolvedTotalDeals = Number(options?.totalDeals);
  const totalDeals = Number.isFinite(resolvedTotalDeals) && resolvedTotalDeals >= 2
    ? Math.floor(resolvedTotalDeals)
    : resolveTotalDeals(session);

  const rawDealScores = Array.isArray(options?.dealScores)
    ? options.dealScores
    : normalizeDealScoreHistory(session.metadata || {});
  const dealScores = normalizeDealScoreHistory({ deal_scores: rawDealScores });
  const dealBaseScore = resolveDealBaseScore(session, totalDeals);
  const dealScoreTotalsByUser = normalizeDealScoreTotalsByUser(session, {
    totalDeals,
    totalsByUser: options?.dealScoreTotalsByUser,
  });

  return {
    deal_no: dealNo,
    total_deals: totalDeals,
    pool_round_no: null,
    deal_scores: dealScores,
    deal_base_score: dealBaseScore,
    deal_score_totals_by_user: dealScoreTotalsByUser,
  };
}

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function resolveEntryPotPlayerCount(session = {}) {
  const mode = resolveSessionGameMode(session);
  if (mode === 'deals_2') {
    const seats = Number(session?.max_players);
    if (Number.isFinite(seats) && seats > 0) return Math.floor(seats);
  }
  if (!Array.isArray(session?.players)) return 0;
  return session.players.filter((player) => ['joined', 'disconnected'].includes(player?.status)).length;
}

function buildSessionPrizePoolFields(session = null) {
  if (!session) {
    return {
      winning_balance: null,
      prize_pool: {
        player_count: 0,
        entry_fee: null,
        total_entry: null,
        admin_commission_percent: null,
        admin_commission_amount: null,
        winning_balance: null,
      },
    };
  }
  const mode = resolveSessionGameMode(session);
  if (mode === 'pool') {
    return buildPoolSessionPrizePoolFields(session);
  }
  const isEntryPotMode = isDealLikeMode(mode) || mode === 'pool';
  const entryFee = Number(session?.contest?.entry);
  const playerCount = resolveEntryPotPlayerCount(session);

  let totalEntry = null;
  let adminCommissionAmount = null;
  let winningBalance = null;
  if (isEntryPotMode && Number.isFinite(entryFee) && entryFee > 0 && playerCount > 0) {
    if (mode === 'spin_go') {
      const configuredWin = Number(session?.contest?.win_upto);
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

function buildJoinAckSessionPayload(session = null) {
  if (!session) return null;

  const dealContext = buildDealContextFields(session);
  const prizePoolFields = buildSessionPrizePoolFields(session);

  return {
    ...session,
    ...dealContext,
    ...prizePoolFields,
  };
}

function safeRandomInt(maxExclusive) {
  const max = Number(maxExclusive);
  if (!Number.isFinite(max) || max <= 0) return 0;

  if (typeof crypto.randomInt === 'function') {
    return crypto.randomInt(max);
  }

  if (typeof crypto.randomBytes === 'function') {
    const upperBound = 0x100000000;
    const cutoff = upperBound - (upperBound % max);
    let value = upperBound;

    while (value >= cutoff) {
      value = crypto.randomBytes(4).readUInt32BE(0);
    }

    return value % max;
  }
  throw new Error('Secure RNG unavailable: crypto.randomInt/randomBytes required');
}

function shuffleRuntimeCards(cards = []) {
  const deck = [...cards];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = safeRandomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function reshuffleClosedDeck(distribution = {}) {
  const discardPile = Array.isArray(distribution?.discard_pile) ? [...distribution.discard_pile] : [];
  const closedDeck = Array.isArray(distribution?.closed_deck) ? [...distribution.closed_deck] : [];

  if (closedDeck.length > 0) {
    return {
      changed: false,
      insufficientCards: false,
      distribution: {
        ...distribution,
        discard_pile: discardPile,
        closed_deck: closedDeck,
        closed_deck_count: closedDeck.length,
      },
      discardTop: discardPile[0] || null,
      closedDeckCount: closedDeck.length,
      reshuffledCards: 0,
    };
  }

  if (discardPile.length <= 1) {
    return {
      changed: false,
      insufficientCards: true,
      distribution: {
        ...distribution,
        discard_pile: discardPile,
        closed_deck: [],
        closed_deck_count: 0,
      },
      discardTop: discardPile[0] || null,
      closedDeckCount: 0,
      reshuffledCards: 0,
    };
  }

  const [discardTop, ...reshuffleCandidates] = discardPile;
  const reshuffledClosedDeck = shuffleRuntimeCards(reshuffleCandidates);

  return {
    changed: true,
    insufficientCards: false,
    distribution: {
      ...distribution,
      discard_pile: discardTop ? [discardTop] : [],
      closed_deck: reshuffledClosedDeck,
      closed_deck_count: reshuffledClosedDeck.length,
    },
    discardTop: discardTop || null,
    closedDeckCount: reshuffledClosedDeck.length,
    reshuffledCards: reshuffledClosedDeck.length,
  };
}

function resetPlayerMetadataForNextDeal(metadata = {}) {
  const nextMetadata = {
    ...(metadata || {}),
    ready: false,
    auto_ready: false,
  };

  delete nextMetadata.is_dropped;
  delete nextMetadata.drop_status;
  delete nextMetadata.dropped_at;
  delete nextMetadata.drop_type;
  delete nextMetadata.elimination_reason;
  // Per-deal pack / invalid-show flags must not carry into the next hand —
  // otherwise clients keep spectator UI while the seat is playable again.
  delete nextMetadata.is_packed;
  delete nextMetadata.packed;
  delete nextMetadata.packed_in_current_deal;
  delete nextMetadata.invalid_declaration;
  delete nextMetadata.invalid_declaration_penalty_points;
  delete nextMetadata.timeout_eliminated;
  // soft_table_away intentionally retained so away players keep pending-rejoin
  // until they reconnect for the next deal.

  return nextMetadata;
}

function computeDealScoreboardTimeline(session = {}, dealScores = []) {
  const players = Array.isArray(session?.players) ? session.players : [];
  const totalDeals = resolveTotalDeals(session);
  const dealBaseScore = resolveDealBaseScore(session, totalDeals);
  const scoreByUserId = new Map();
  const lossTotalsByUserId = new Map();

  players.forEach((player) => {
    const userId = Number(player?.user_id);
    if (Number.isNaN(userId)) return;
    scoreByUserId.set(userId, dealBaseScore);
    lossTotalsByUserId.set(userId, 0);
  });

  const normalizedDealScores = normalizeDealScoreHistory({ deal_scores: dealScores });
  const enrichedDealScores = normalizedDealScores.map((deal) => {
    const results = Array.isArray(deal?.results) ? deal.results : [];
    const winnerUserId = Number(deal?.winner_user_id);
    const roundLossByUserId = new Map();

    results.forEach((result) => {
      const userId = Number(result?.user_id);
      if (Number.isNaN(userId)) return;
      const roundPoints = Math.max(0, Number(result?.round_points ?? result?.points) || 0);
      roundLossByUserId.set(userId, roundPoints);
      lossTotalsByUserId.set(userId, (lossTotalsByUserId.get(userId) || 0) + roundPoints);
      if (!scoreByUserId.has(userId)) {
        scoreByUserId.set(userId, dealBaseScore);
      }
    });

    let winnerGain = 0;
    roundLossByUserId.forEach((roundLoss, userId) => {
      if (Number(userId) !== winnerUserId) {
        winnerGain += roundLoss;
      }
    });

    scoreByUserId.forEach((currentScore, userId) => {
      if (Number(userId) === winnerUserId) {
        scoreByUserId.set(userId, currentScore + winnerGain);
      } else {
        scoreByUserId.set(userId, currentScore - (roundLossByUserId.get(userId) || 0));
      }
    });

    const enrichedResults = results.map((result) => {
      const userId = Number(result?.user_id);
      const roundPoints = Math.max(0, Number(result?.round_points ?? result?.points) || 0);
      const totalScore = Number.isNaN(userId) ? null : (scoreByUserId.get(userId) ?? null);
      return {
        ...result,
        round_points: roundPoints,
        total_score: totalScore,
        score_model: 'deal_base_plus_minus',
      };
    });

    const totalScoresByUser = {};
    scoreByUserId.forEach((value, userId) => {
      totalScoresByUser[String(userId)] = value;
    });

    return {
      ...deal,
      deal_base_score: dealBaseScore,
      score_model: 'deal_base_plus_minus',
      total_scores_by_user: totalScoresByUser,
      results: enrichedResults,
    };
  });

  const scoreTotalsByUser = {};
  scoreByUserId.forEach((value, userId) => {
    scoreTotalsByUser[String(userId)] = value;
  });

  return {
    dealBaseScore,
    scoreTotalsByUser,
    lossTotalsByUserId,
    enrichedDealScores,
  };
}

function buildAggregateResultsFromDealScores(session = {}, dealScores = []) {
  const players = Array.isArray(session?.players) ? session.players : [];
  const {
    scoreTotalsByUser,
    lossTotalsByUserId,
  } = computeDealScoreboardTimeline(session, dealScores);
  const lastDeal = Array.isArray(dealScores) && dealScores.length > 0
    ? dealScores[dealScores.length - 1]
    : null;
  const lastDealResultsByUser = new Map(
    (Array.isArray(lastDeal?.results) ? lastDeal.results : [])
      .map((row) => [Number(row?.user_id), row])
      .filter(([userId]) => !Number.isNaN(userId))
  );

  const aggregate = players.map((player) => {
    const userId = Number(player.user_id);
    const lastDealResult = lastDealResultsByUser.get(userId) || null;
    const lastRoundPoints = lastDealResult == null
      ? null
      : Math.max(0, Number(lastDealResult.round_points ?? lastDealResult.points) || 0);
    return {
    user_id: player.user_id,
    seat_no: player.seat_no,
    points: lossTotalsByUserId.get(userId) || 0,
    round_points: lastRoundPoints,
    total_score: Number(scoreTotalsByUser[String(player.user_id)]) || 0,
    score_model: 'deal_base_plus_minus',
    grouped_points: null,
    ungrouped_points: null,
    valid_for_declare: null,
    invalid_group_count: null,
    all_cards_grouped: null,
    submission_mode: 'aggregate',
    submission_status: 'aggregate',
    dropped: false,
  };
  });

  const sorted = [...aggregate].sort((a, b) => {
    if ((b.total_score || 0) !== (a.total_score || 0)) return (b.total_score || 0) - (a.total_score || 0);
    if (a.points !== b.points) return a.points - b.points;
    return a.seat_no - b.seat_no;
  });
  const winnerUserId = sorted[0]?.user_id || null;
  const topTotalScore = sorted[0]?.total_score ?? null;
  const topPoints = sorted[0]?.points ?? null;
  const tiedWinnerUserIds = (topTotalScore == null || topPoints == null)
    ? []
    : sorted
      .filter((entry) => Number(entry?.total_score) === Number(topTotalScore) && Number(entry?.points) === Number(topPoints))
      .map((entry) => Number(entry.user_id))
      .filter((id) => !Number.isNaN(id));
  const tiedWinnerSet = new Set(tiedWinnerUserIds);

  const finalized = aggregate.map((entry) => {
    const isWinner = tiedWinnerSet.has(Number(entry.user_id));
    const lastDealRow = lastDealResultsByUser.get(Number(entry.user_id));
    const lastDealDeclareBy = Number(lastDeal?.declare_by_user_id);
    const lastDealDeclareValid = lastDeal?.declare_valid;
    const wasInvalidDeclarer = !Number.isNaN(lastDealDeclareBy)
      && Number(entry.user_id) === lastDealDeclareBy
      && lastDealDeclareValid === false;
    // Preserve wrong-show label on the final deals scoreboard (do not remap to plain "lost").
    const playerStatus = isWinner && tiedWinnerSet.size > 1
      ? 'tie'
      : (isWinner
        ? 'won'
        : (wasInvalidDeclarer
          || lastDealRow?.player_status === 'invalid_declaration'
          ? 'invalid_declaration'
          : 'lost'));
    return {
      ...entry,
      is_winner: isWinner,
      player_status: playerStatus,
      status_color: resolveStatusColor(playerStatus),
    };
  });

  return {
    winnerUserId,
    tiedWinnerUserIds,
    finalizedResults: finalized,
  };
}

function resolvePoolLimit(session = {}) {
  const explicit = Number(session?.metadata?.pool_limit);
  if (Number.isFinite(explicit) && explicit >= 1) return Math.floor(explicit);

  const gameName = String(session?.game?.name || '');
  const match = gameName.match(/(101|201)/);
  if (match) return Number(match[1]);
  return 101;
}

function normalizePoolScoresByUser(metadata = {}) {
  const raw = metadata?.pool_scores_by_user || {};
  const entries = Object.entries(raw || {});
  const normalized = {};
  entries.forEach(([userId, points]) => {
    const numericUserId = Number(userId);
    if (Number.isNaN(numericUserId)) return;
    normalized[String(numericUserId)] = Math.max(0, Number(points) || 0);
  });
  return normalized;
}

function buildPoolRoundHistoryEntry(roundProgress = {}, payload = {}) {
  const roundNo = Math.max(1, Number(roundProgress?.currentRoundNo) || 1);
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const scoresByUser = {};
  const enrichedResults = results.map((result) => {
    const userId = Number(result?.user_id);
    const roundPoints = Math.max(0, Number(result?.round_points ?? result?.points) || 0);
    if (!Number.isNaN(userId)) {
      scoresByUser[String(userId)] = roundPoints;
    }
    const cumulativeRaw = roundProgress?.scoresByUser?.[String(userId)];
    const cumulativeTotal = Number.isFinite(Number(cumulativeRaw))
      ? Number(cumulativeRaw)
      : roundPoints;
    return {
      user_id: userId,
      round_points: roundPoints,
      cumulative_total: cumulativeTotal,
    };
  });

  return {
    round_no: roundNo,
    winner_user_id: payload?.winner_user_id ?? null,
    scores_by_user: scoresByUser,
    cumulative_by_user: { ...(roundProgress?.scoresByUser || {}) },
    results: enrichedResults,
    completed_at: payload?.server_time || new Date().toISOString(),
  };
}

function appendPoolRoundHistory(existingHistory = [], entry = null) {
  if (!entry || !Number.isFinite(Number(entry.round_no))) {
    return Array.isArray(existingHistory) ? existingHistory : [];
  }
  const history = Array.isArray(existingHistory) ? [...existingHistory] : [];
  const roundNo = Math.floor(Number(entry.round_no));
  const existingIndex = history.findIndex((row) => Number(row?.round_no) === roundNo);
  if (existingIndex >= 0) {
    history[existingIndex] = entry;
  } else {
    history.push(entry);
  }
  return history.sort((a, b) => (Number(a?.round_no) || 0) - (Number(b?.round_no) || 0));
}

function mergePoolRoundHistoryIntoMetadata(sessionMetadata = {}, roundProgress = {}, payload = {}) {
  const entry = buildPoolRoundHistoryEntry(roundProgress, payload);
  return appendPoolRoundHistory(sessionMetadata?.pool_round_history, entry);
}

function normalizePoolRoundHistory(metadata = {}) {
  const raw = Array.isArray(metadata?.pool_round_history) ? metadata.pool_round_history : [];
  return raw
    .map((entry) => {
      const roundNo = Number(entry?.round_no);
      if (!Number.isFinite(roundNo) || roundNo < 1) return null;
      return {
        round_no: Math.floor(roundNo),
        winner_user_id: entry?.winner_user_id ?? null,
        scores_by_user: entry?.scores_by_user || {},
        cumulative_by_user: entry?.cumulative_by_user || {},
        results: Array.isArray(entry?.results) ? entry.results : [],
        completed_at: entry?.completed_at || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.round_no - b.round_no);
}

function buildScoreboardPlayers(session = {}) {
  return (Array.isArray(session?.players) ? session.players : [])
    .slice()
    .sort((a, b) => (Number(a?.seat_no) || 0) - (Number(b?.seat_no) || 0))
    .map((player) => ({
      user_id: player.user_id,
      name: player.name || player.view_id || `Player ${player.seat_no || ''}`.trim(),
      view_id: player.view_id || null,
      seat_no: player.seat_no,
      avatar: player.avatar || null,
      status: player.status || null,
      is_eliminated: ['eliminated', 'left'].includes(String(player?.status || '').toLowerCase()),
    }));
}

function normalizeWildJokerCardId(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed || null;
  }
  if (typeof raw === 'object') {
    if (raw.card_id) {
      const cardId = String(raw.card_id).trim();
      if (cardId) return cardId;
    }
    if (raw.cardId) {
      const cardId = String(raw.cardId).trim();
      if (cardId) return cardId;
    }
    const rank = raw.rank != null ? String(raw.rank) : null;
    const suit = raw.suit != null ? String(raw.suit) : null;
    if (suit && rank) {
      return `${suit[0].toUpperCase()}${rank}`;
    }
  }
  return null;
}

function resolveWildJokerCardId(session = {}) {
  const distribution = session?.metadata?.distribution || {};
  return normalizeWildJokerCardId(distribution.wild_joker_card_id)
    || normalizeWildJokerCardId(distribution.wild_joker)
    || normalizeWildJokerCardId(distribution.wildJokerCardId)
    || null;
}

function enrichLastDealScoreEntry(dealScores = [], enrichments = {}) {
  if (!Array.isArray(dealScores) || dealScores.length === 0) return dealScores;
  const next = [...dealScores];
  const lastIndex = next.length - 1;
  next[lastIndex] = {
    ...next[lastIndex],
    ...enrichments,
  };
  return next;
}

function enrichLastPoolRoundHistoryEntry(history = [], enrichments = {}) {
  if (!Array.isArray(history) || history.length === 0) return history;
  const next = [...history];
  const lastIndex = next.length - 1;
  next[lastIndex] = {
    ...next[lastIndex],
    ...enrichments,
  };
  return next;
}

function buildLastDealResultPayload(session = {}, enrichedDealScores = []) {
  if (!Array.isArray(enrichedDealScores) || enrichedDealScores.length === 0) {
    return null;
  }

  const lastDeal = enrichedDealScores[enrichedDealScores.length - 1];
  const metadata = session.metadata || {};
  const metaResult = metadata.result || {};
  const dealNo = Number(lastDeal.deal_no);
  if (!Number.isFinite(dealNo) || dealNo < 1) return null;

  let players = Array.isArray(lastDeal.players) ? lastDeal.players : null;
  let wildJokerCardId = lastDeal.wild_joker_card_id || null;

  if ((!players || players.length === 0) && Number(metaResult.deal_no) === dealNo) {
    players = Array.isArray(metaResult.players) ? metaResult.players : null;
    wildJokerCardId = wildJokerCardId
      || metaResult.wild_joker_card_id
      || resolveWildJokerCardId(session);
  }

  if (!players || players.length === 0) {
    const totalDeals = resolveTotalDeals(session);
    players = buildDeclarationTablePlayers({
      session,
      distribution: metadata.distribution || null,
      state: {
        responses: new Map(),
        declareByUserId: lastDeal.declare_by_user_id || null,
      },
      isFinal: true,
      isGameFinal: dealNo >= totalDeals,
      finalizedResults: lastDeal.results || [],
      settlement: null,
      winnerUserId: lastDeal.winner_user_id,
      declarerValid: lastDeal.declare_valid ?? null,
    });
  }

  return {
    session_id: session.id,
    session_code: session.session_code || null,
    server_time: new Date().toISOString(),
    status: 'completed',
    is_final: false,
    deal_no: dealNo,
    total_deals: resolveTotalDeals(session),
    winner_user_id: lastDeal.winner_user_id ?? null,
    declare_by_user_id: lastDeal.declare_by_user_id ?? null,
    declare_valid: lastDeal.declare_valid ?? null,
    finish_card: lastDeal.finish_card ?? null,
    reason: lastDeal.reason ?? null,
    score_model: lastDeal.score_model || 'deal_base_plus_minus',
    wild_joker_card_id: normalizeWildJokerCardId(wildJokerCardId)
      || resolveWildJokerCardId(session),
    players,
    pending_count: 0,
  };
}

function buildLastPoolRoundResultPayload(session = {}) {
  const metadata = session.metadata || {};
  const metaResult = metadata.result || {};
  const history = normalizePoolRoundHistory(metadata);
  const lastHistory = history.length > 0 ? history[history.length - 1] : null;
  const resultRoundNo = Number(metaResult.pool_round_no);
  const historyRoundNo = Number(lastHistory?.round_no);
  const roundNo = Number.isFinite(historyRoundNo) && historyRoundNo >= 1
    ? historyRoundNo
    : (Number.isFinite(resultRoundNo) && resultRoundNo >= 1 ? resultRoundNo : null);

  let players = Array.isArray(lastHistory?.players) ? lastHistory.players : null;
  let wildJokerCardId = lastHistory?.wild_joker_card_id || null;
  let winnerUserId = lastHistory?.winner_user_id ?? null;
  let finalizedResults = Array.isArray(lastHistory?.results) ? lastHistory.results : [];

  const metaHasRoundResult = ['round_completed', 'completed'].includes(
    String(metaResult?.status || '').toLowerCase()
  ) || metaResult?.is_final === true;

  if (
    metaHasRoundResult
    && Array.isArray(metaResult.players)
    && metaResult.players.length > 0
    && (!roundNo || !Number.isFinite(resultRoundNo) || resultRoundNo === roundNo)
  ) {
    players = metaResult.players;
    wildJokerCardId = metaResult.wild_joker_card_id || wildJokerCardId || resolveWildJokerCardId(session);
    winnerUserId = metaResult.winner_user_id ?? winnerUserId;
    finalizedResults = Array.isArray(metaResult.results) ? metaResult.results : finalizedResults;
  }

  if ((!players || players.length === 0) && finalizedResults.length > 0) {
    players = buildDeclarationTablePlayers({
      session,
      distribution: metadata.distribution || null,
      state: {
        responses: new Map(),
        declareByUserId: metaResult.declare_by_user_id || null,
      },
      isFinal: true,
      isGameFinal: metaResult?.is_final === true,
      finalizedResults,
      settlement: null,
      winnerUserId,
      declarerValid: metaResult.declare_valid ?? null,
    });
  }

  if (!players || players.length === 0 || !roundNo) return null;

  return {
    session_id: session.id,
    session_code: session.session_code || null,
    server_time: new Date().toISOString(),
    status: 'completed',
    is_final: false,
    deal_no: roundNo,
    pool_round_no: roundNo,
    winner_user_id: winnerUserId,
    declare_by_user_id: metaResult.declare_by_user_id ?? null,
    declare_valid: metaResult.declare_valid ?? null,
    finish_card: metaResult.finish_card ?? null,
    reason: metaResult.reason ?? lastHistory?.reason ?? null,
    score_model: 'pool_loss_cumulative',
    wild_joker_card_id: normalizeWildJokerCardId(wildJokerCardId)
      || resolveWildJokerCardId(session),
    players,
    pending_count: 0,
  };
}

function buildLastResultFromSessionResult(session = {}, metaResult = {}, mode = 'points') {
  const players = Array.isArray(metaResult?.players) ? metaResult.players : null;
  if (!players || players.length === 0) return null;

  const status = String(metaResult?.status || '').toLowerCase();
  const hasCompletedResult = ['deal_completed', 'round_completed', 'completed'].includes(status)
    || metaResult?.is_final === true;
  if (!hasCompletedResult) return null;

  const dealNo = Number(metaResult.deal_no);
  const poolRoundNo = Number(metaResult.pool_round_no);
  const roundNo = Number.isFinite(dealNo) && dealNo >= 1
    ? dealNo
    : (Number.isFinite(poolRoundNo) && poolRoundNo >= 1 ? poolRoundNo : null);

  return {
    session_id: session.id,
    session_code: session.session_code || null,
    server_time: metaResult.server_time || new Date().toISOString(),
    status: 'completed',
    is_final: false,
    deal_no: roundNo,
    pool_round_no: mode === 'pool' ? roundNo : null,
    total_deals: isDealLikeMode(mode) ? resolveTotalDeals(session) : null,
    winner_user_id: metaResult.winner_user_id ?? null,
    declare_by_user_id: metaResult.declare_by_user_id ?? null,
    declare_valid: metaResult.declare_valid ?? null,
    finish_card: metaResult.finish_card ?? null,
    reason: metaResult.reason ?? null,
    score_model: metaResult.score_model
      || (mode === 'pool' ? 'pool_loss_cumulative' : 'deal_base_plus_minus'),
    wild_joker_card_id: normalizeWildJokerCardId(metaResult.wild_joker_card_id)
      || resolveWildJokerCardId(session),
    players,
    pending_count: 0,
  };
}

function buildLastRoundResultPayload(session = {}) {
  const mode = resolveSessionGameMode(session);
  const metadata = session.metadata || {};
  const metaResult = metadata.result || {};

  const fromSessionResult = buildLastResultFromSessionResult(session, metaResult, mode);
  if (fromSessionResult) return fromSessionResult;

  if (isDealLikeMode(mode)) {
    const rawDealScores = normalizeDealScoreHistory(metadata);
    const { enrichedDealScores } = computeDealScoreboardTimeline(session, rawDealScores);
    return buildLastDealResultPayload(session, enrichedDealScores);
  }

  if (mode === 'pool') {
    return buildLastPoolRoundResultPayload(session);
  }

  return null;
}

function buildScoreboardPayload(session = {}) {
  const mode = resolveSessionGameMode(session);
  const players = buildScoreboardPlayers(session);

  const base = {
    session_id: session.id,
    session_code: session.session_code || null,
    game_mode: mode,
    game_name: session?.game?.name || null,
    server_time: new Date().toISOString(),
    players,
  };

  if (isDealLikeMode(mode)) {
    const totalDeals = resolveTotalDeals(session);
    const currentDeal = resolveCurrentDeal(session);
    const rawDealScores = normalizeDealScoreHistory(session.metadata || {});
    const {
      dealBaseScore,
      scoreTotalsByUser,
      enrichedDealScores,
    } = computeDealScoreboardTimeline(session, rawDealScores);

    const rows = enrichedDealScores.map((deal) => ({
      row_no: deal.deal_no,
      label: mode === 'spin_go' ? 'Game' : `Deal ${deal.deal_no}`,
      winner_user_id: deal.winner_user_id ?? null,
      scores_by_user: Object.fromEntries(
        (deal.results || []).map((result) => [
          String(result.user_id),
          Math.max(0, Number(result.round_points ?? result.points) || 0),
        ])
      ),
      cumulative_by_user: deal.total_scores_by_user || {},
      results: deal.results || [],
    }));

    return {
      ...base,
      scoreboard_type: 'deals',
      current_deal: currentDeal,
      total_deals: totalDeals,
      deal_base_score: dealBaseScore,
      rows,
      cumulative_scores_by_user: scoreTotalsByUser,
      placeholder_rows: Math.max(0, totalDeals - rows.length),
      last_deal_result: buildLastRoundResultPayload(session),
    };
  }

  if (mode === 'pool') {
    const poolLimit = resolvePoolLimit(session);
    const cumulative = normalizePoolScoresByUser(session.metadata || {});
    const history = normalizePoolRoundHistory(session.metadata || {});

    return {
      ...base,
      scoreboard_type: 'pool',
      pool_limit: poolLimit,
      current_round: Math.max(1, Number(session.metadata?.pool_round_no) || 1),
      rows: history.map((row) => ({
        row_no: row.round_no,
        label: `Round ${row.round_no}`,
        winner_user_id: row.winner_user_id,
        scores_by_user: row.scores_by_user,
        cumulative_by_user: row.cumulative_by_user,
        results: row.results,
      })),
      cumulative_scores_by_user: cumulative,
      eliminated_user_ids: session.metadata?.pool_eliminated_user_ids || [],
      placeholder_rows: 0,
      last_deal_result: buildLastRoundResultPayload(session),
    };
  }

  return {
    ...base,
    scoreboard_type: 'unsupported',
    rows: [],
    cumulative_scores_by_user: {},
    placeholder_rows: 0,
  };
}

function appendAbsentEliminatedPoolPlayersToRoundResults(session = {}, roundResults = [], poolProgress = {}) {
  const players = Array.isArray(session?.players) ? session.players : [];
  const eliminatedSet = new Set(
    (Array.isArray(poolProgress?.eliminatedUserIds) ? poolProgress.eliminatedUserIds : [])
      .map((id) => Number(id))
      .filter((id) => !Number.isNaN(id))
  );
  const presentUserIds = new Set(
    (Array.isArray(roundResults) ? roundResults : [])
      .map((row) => Number(row?.user_id))
      .filter((id) => !Number.isNaN(id))
  );
  const scoresByUser = poolProgress?.scoresByUser
    || normalizePoolScoresByUser(session?.metadata || {});

  const appended = Array.isArray(roundResults) ? [...roundResults] : [];
  players.forEach((player) => {
    const userId = Number(player.user_id);
    if (Number.isNaN(userId) || presentUserIds.has(userId)) return;
    if (!eliminatedSet.has(userId)) return;

    const cumulativePoints = Math.max(0, Number(scoresByUser[String(userId)]) || 0);
    appended.push({
      user_id: player.user_id,
      seat_no: player.seat_no,
      points: 0,
      round_points: 0,
      cumulative_points: cumulativePoints,
      total_score: cumulativePoints,
      score_model: 'pool_loss_cumulative',
      grouped_points: null,
      ungrouped_points: null,
      valid_for_declare: null,
      invalid_group_count: null,
      all_cards_grouped: null,
      submission_mode: 'aggregate',
      submission_status: 'aggregate',
      player_status: 'eliminated',
      status_color: resolveStatusColor('eliminated'),
      dropped: false,
      is_winner: false,
    });
  });

  return appended.sort((a, b) => (Number(a?.seat_no) || 0) - (Number(b?.seat_no) || 0));
}

function buildPoolRoundProgress(session = {}, roundResults = []) {
  const poolLimit = resolvePoolLimit(session);
  const scoresByUser = normalizePoolScoresByUser(session?.metadata || {});
  const eliminatedSet = new Set(
    (Array.isArray(session?.metadata?.pool_eliminated_user_ids) ? session.metadata.pool_eliminated_user_ids : [])
      .map((id) => Number(id))
      .filter((id) => !Number.isNaN(id))
  );

  roundResults.forEach((result) => {
    const userId = Number(result?.user_id);
    if (Number.isNaN(userId)) return;
    const key = String(userId);
    // Penalty already written into pool_scores_by_user at pack time — do not add again.
    if (result?.pool_score_already_applied === true) {
      if ((scoresByUser[key] || 0) >= poolLimit) {
        eliminatedSet.add(userId);
      }
      return;
    }
    const points = Math.max(0, Number(result?.points) || 0);
    scoresByUser[key] = (scoresByUser[key] || 0) + points;
    if (scoresByUser[key] >= poolLimit) {
      eliminatedSet.add(userId);
    }
  });

  const players = Array.isArray(session?.players) ? session.players : [];
  // Pool "active" = not pool-eliminated by score/limit. Do NOT use player.status here:
  // mid-deal drop/timeout temporarily sets status=eliminated while the player remains
  // in the pool until their cumulative score crosses the limit.
  const activeUserIds = players
    .map((player) => Number(player.user_id))
    .filter((userId) => !Number.isNaN(userId) && !eliminatedSet.has(userId));

  const currentRoundNo = Math.max(1, Number(session?.metadata?.pool_round_no) || 1);
  return {
    poolLimit,
    scoresByUser,
    eliminatedUserIds: Array.from(eliminatedSet),
    activeUserIds,
    currentRoundNo,
    nextRoundNo: currentRoundNo + 1,
  };
}

async function tryTransitionPoolRoundAfterSinglePlayerRemaining(
  io,
  session,
  {
    sessionId,
    winnerUserId,
    packedUserId,
    outcomeType,
    reason,
  }
) {
  const mode = resolveSessionGameMode(session);
  if (mode !== 'pool') return null;

  const perRoundResults = (session.players || []).map((item) => {
    const itemUserId = Number(item.user_id);
    const itemIsWinner = Number(itemUserId) === Number(winnerUserId);
    const itemIsPacked = Number(itemUserId) === Number(packedUserId);
    let points = 0;
    let playerStatus = 'lost';
    if (itemIsWinner) {
      playerStatus = 'won';
    } else if (itemIsPacked) {
      points = outcomeType === 'timeout'
        ? (resolveDropLossPoints(session, itemUserId, { forceMiddleDrop: true }) || 0)
        : (resolveDropLossPoints(session, itemUserId) || 0);
      playerStatus = outcomeType === 'timeout' ? 'timeout' : 'dropped';
    } else {
      points = resolveDropLossPoints(session, itemUserId) || 0;
    }
    return {
      user_id: item.user_id,
      seat_no: item.seat_no,
      points,
      round_points: points,
      grouped_points: null,
      ungrouped_points: null,
      valid_for_declare: null,
      invalid_group_count: 0,
      all_cards_grouped: null,
      submission_mode: 'auto',
      submission_status: 'auto',
      player_status: playerStatus,
      status_color: resolveStatusColor(playerStatus),
      dropped: outcomeType === 'dropped' && itemIsPacked,
      is_winner: itemIsWinner,
    };
  });

  const poolProgress = buildPoolRoundProgress(session, perRoundResults);
  const roundResultsWithPool = perRoundResults.map((item) => {
    const uid = Number(item.user_id);
    const cumulativePoints = Number(poolProgress.scoresByUser[String(uid)]) || 0;
    const isEliminated = (poolProgress.eliminatedUserIds || []).some((id) => Number(id) === uid);
    const preservePlayerStatus = item?.is_winner === true
      || item?.dropped === true
      || item?.player_status === 'dropped'
      || item?.player_status === 'timeout';
    const nextPlayerStatus = preservePlayerStatus
      ? item.player_status
      : (isEliminated ? 'eliminated' : item.player_status);
    return {
      ...item,
      cumulative_points: cumulativePoints,
      total_score: cumulativePoints,
      score_model: 'pool_loss_cumulative',
      player_status: nextPlayerStatus,
      status_color: resolveStatusColor(nextPlayerStatus),
    };
  });

  if ((poolProgress.activeUserIds || []).length <= 1) {
    return null;
  }

  const rejoinContext = buildPoolRejoinContext({
    players: session.players || [],
    scoresByUser: poolProgress.scoresByUser,
    eliminatedUserIds: poolProgress.eliminatedUserIds,
    poolLimit: poolProgress.poolLimit,
  });
  const rejoinJoiningFee = roundCurrency(Number(session?.contest?.entry) || 0);
  const prizePoolSummary = buildPoolPrizePoolSummary({
    entryFee: rejoinJoiningFee,
    baseEntryCount: resolvePoolBaseEntryCount(session),
    rejoinEntryCount: resolvePoolRejoinEntryCount(session?.metadata || {}),
    projectedExtraEntries: rejoinContext.can_rejoin_table ? 1 : 0,
  });
  const rejoinInfo = buildPoolRejoinInfoPayload({
    rejoinContext,
    joiningFee: rejoinJoiningFee,
    prizePoolSummary,
  });
  const poolEliminationContext = buildPoolEliminationContextFields(session, poolProgress);
  const resultPayload = {
    session_id: sessionId,
    server_time: new Date().toISOString(),
    event: 'game:result',
    status: 'round_completed',
    is_final: false,
    reason,
    declare_by_user_id: null,
    declare_valid: null,
    winner_user_id: winnerUserId,
    tie_break_policy: 'pool_limit_then_lowest_points',
    finish_card: null,
    auto_declared_user_ids: [],
    pool_limit: poolProgress.poolLimit,
    pool_round_no: poolProgress.currentRoundNo,
    pool_scores_by_user: poolProgress.scoresByUser,
    pool_eliminated_user_ids: poolProgress.eliminatedUserIds,
    pool_previous_eliminated_user_ids: poolEliminationContext.pool_previous_eliminated_user_ids,
    pool_newly_eliminated_user_ids: poolEliminationContext.pool_newly_eliminated_user_ids,
    can_rejoin_table: rejoinContext.can_rejoin_table,
    rejoin_threshold: rejoinContext.rejoin_threshold,
    rejoin_candidate_user_ids: rejoinContext.rejoin_candidate_user_ids,
    rejoin_start_points_by_user: rejoinContext.rejoin_start_points_by_user,
    rejoin_at_points_by_user: rejoinContext.rejoin_start_points_by_user,
    joining_fee: rejoinInfo.joining_fee,
    current_prize_pool: rejoinInfo.current_prize_pool,
    updated_prize_pool_if_rejoin: rejoinInfo.updated_prize_pool_if_rejoin,
    rejoin_info: rejoinInfo,
    results: roundResultsWithPool,
    settlement: null,
    deal_no: null,
    total_deals: null,
    deal_scores: null,
  };
  resultPayload.players = buildDeclarationTablePlayers({
    session,
    distribution: session.metadata?.distribution || null,
    state: { responses: new Map(), declareByUserId: null },
    isFinal: true,
    isGameFinal: false,
    finalizedResults: roundResultsWithPool,
    settlement: null,
    winnerUserId,
    declarerValid: null,
    previousPoolEliminatedUserIds: poolEliminationContext.previousPoolEliminatedUserIds,
  });

  cleanupTurnState(sessionId);
  return transitionToNextPoolRound(io, session, resultPayload, poolProgress);
}

function resolvePoolRejoinThreshold(poolLimit) {
  const numericLimit = Number(poolLimit);
  if (!Number.isFinite(numericLimit)) return null;
  if (numericLimit >= 201) return POOL_REJOIN_THRESHOLD_BY_LIMIT[201];
  if (numericLimit >= 101) return POOL_REJOIN_THRESHOLD_BY_LIMIT[101];
  return null;
}

function resolvePoolBotDropBlockScore(poolLimit) {
  const numericLimit = Number(poolLimit);
  if (!Number.isFinite(numericLimit)) return POOL_BOT_DROP_BLOCK_SCORE_BY_LIMIT[101];
  if (numericLimit >= 201) return POOL_BOT_DROP_BLOCK_SCORE_BY_LIMIT[201];
  if (numericLimit >= 101) return POOL_BOT_DROP_BLOCK_SCORE_BY_LIMIT[101];
  return POOL_BOT_DROP_BLOCK_SCORE_BY_LIMIT[101];
}

function isBotPoolDropBlockedByScore(session, userId) {
  if (resolveSessionGameMode(session) !== 'pool') return false;
  const poolLimit = resolvePoolLimit(session);
  if (!Number.isFinite(Number(poolLimit))) return false;
  const scoresByUser = session?.metadata?.pool_scores_by_user || {};
  const currentScore = Number(scoresByUser[String(userId)]) || 0;
  // Block when this drop would eliminate the bot (e.g. 79 + middle 40 in 101).
  // Prefer projected drop penalty; fall back to legacy absolute block scores.
  const dropPenalty = Number(resolveDropLossPoints(session, userId));
  if (Number.isFinite(dropPenalty) && dropPenalty > 0) {
    return (currentScore + dropPenalty) >= Number(poolLimit);
  }
  const blockScore = resolvePoolBotDropBlockScore(poolLimit);
  return currentScore >= blockScore;
}

function buildPoolRejoinContext({
  players = [],
  scoresByUser = {},
  eliminatedUserIds = [],
  poolLimit = null,
  forceDisabled = false,
}) {
  const threshold = resolvePoolRejoinThreshold(poolLimit);
  if (forceDisabled || !Number.isFinite(threshold)) {
    return {
      can_rejoin_table: false,
      rejoin_threshold: threshold,
      rejoin_candidate_user_ids: [],
      rejoin_start_points_by_user: {},
    };
  }

  const playerIds = (Array.isArray(players) ? players : [])
    .map((player) => Number(player?.user_id))
    .filter((userId) => !Number.isNaN(userId));
  const playerIdSet = new Set(playerIds);
  const eliminatedSet = new Set(
    (Array.isArray(eliminatedUserIds) ? eliminatedUserIds : [])
      .map((userId) => Number(userId))
      .filter((userId) => !Number.isNaN(userId) && playerIdSet.has(userId))
  );
  const activeUserIds = playerIds.filter((userId) => !eliminatedSet.has(userId));
  // Pool rejoin is only offered while at least two players are still in the game.
  if (activeUserIds.length < 2) {
    return {
      can_rejoin_table: false,
      rejoin_threshold: threshold,
      rejoin_candidate_user_ids: [],
      rejoin_start_points_by_user: {},
    };
  }

  const activeScores = activeUserIds.map((userId) => Math.max(0, Number(scoresByUser[String(userId)]) || 0));
  const allActiveBelowThreshold = activeScores.every((score) => score < threshold);
  if (!allActiveBelowThreshold) {
    return {
      can_rejoin_table: false,
      rejoin_threshold: threshold,
      rejoin_candidate_user_ids: [],
      rejoin_start_points_by_user: {},
    };
  }

  const highestActiveScore = activeScores.length > 0 ? Math.max(...activeScores) : 0;
  const startPoints = highestActiveScore + 1;
  const rejoinOptedOutUserIds = new Set(
    (Array.isArray(players) ? players : [])
      .filter((player) => (
        player?.metadata?.table_left === true
        || player?.metadata?.pool_rejoin_opt_out === true
      ))
      .map((player) => Number(player?.user_id))
      .filter((userId) => !Number.isNaN(userId))
  );
  const rejoinCandidateUserIds = Array.from(eliminatedSet)
    .filter((userId) => !rejoinOptedOutUserIds.has(Number(userId)));
  const rejoinStartPointsByUser = {};
  rejoinCandidateUserIds.forEach((userId) => {
    rejoinStartPointsByUser[String(userId)] = startPoints;
  });

  return {
    can_rejoin_table: rejoinCandidateUserIds.length > 0,
    rejoin_threshold: threshold,
    rejoin_candidate_user_ids: rejoinCandidateUserIds,
    rejoin_start_points_by_user: rejoinStartPointsByUser,
  };
}

function distributeByWeights(totalAmount, weightedRows = []) {
  const total = roundCurrency(Number(totalAmount) || 0);
  if (total <= 0 || !Array.isArray(weightedRows) || weightedRows.length === 0) return [];
  const safeRows = weightedRows.map((row) => ({
    ...row,
    weight: Math.max(1, Number(row?.weight) || 1),
  }));
  const weightSum = safeRows.reduce((sum, row) => sum + row.weight, 0);
  if (weightSum <= 0) {
    return safeRows.map((row) => ({ ...row, amount: 0 }));
  }
  let allocated = 0;
  const withAmount = safeRows.map((row, idx) => {
    if (idx === safeRows.length - 1) {
      const amount = roundCurrency(total - allocated);
      return { ...row, amount };
    }
    const amount = roundCurrency((total * row.weight) / weightSum);
    allocated = roundCurrency(allocated + amount);
    return { ...row, amount };
  });
  return withAmount;
}

/**
 * Drops remaining = how many first-drop penalties fit under the pool limit
 * after the player's cumulative score (includes the round just finished).
 * Example 101 Pool: score 0 → 5, score 20 → 4, score 80 → 1.
 */
function resolvePoolSplitDropsRemaining(poolLimit, totalScore) {
  const safeLimit = Number(poolLimit) >= 201 ? 201 : 101;
  const dropUnit = resolvePoolSplitDropUnit(safeLimit);
  const score = Math.max(0, Number(totalScore) || 0);
  if (score >= safeLimit) return 0;
  const remainingCapacity = Math.max(0, (safeLimit - 1) - score);
  return Math.floor(remainingCapacity / dropUnit);
}

function buildPoolSplitPlan(session = {}, roundProgress = {}, payload = null) {
  if (!POOL_SPLIT_ENABLED && session?.metadata?.pool_split_enabled !== true) {
    return { can_split: false, reason: 'split_feature_disabled' };
  }
  const mode = resolveSessionGameMode(session);
  if (mode !== 'pool') {
    return { can_split: false, reason: 'not_pool_mode' };
  }

  const players = Array.isArray(session?.players) ? session.players : [];
  const playersByUser = new Map(players.map((player) => [Number(player.user_id), player]));
  const eliminatedSet = new Set(
    (Array.isArray(roundProgress?.eliminatedUserIds) ? roundProgress.eliminatedUserIds : [])
      .map((userId) => Number(userId))
      .filter((userId) => !Number.isNaN(userId))
  );
  const activeUserIds = (Array.isArray(roundProgress?.activeUserIds) ? roundProgress.activeUserIds : [])
    .map((userId) => Number(userId))
    .filter((userId) => {
      if (Number.isNaN(userId) || eliminatedSet.has(userId)) return false;
      const player = playersByUser.get(userId);
      // Only exclude players who explicitly left the table — deal-drop uses
      // status=eliminated temporarily and must still be eligible for split/next round.
      if (player?.metadata?.table_left === true) return false;
      const status = String(player?.status || '').toLowerCase();
      if (status === 'left') return false;
      return true;
    });
  // Offer split whenever 2–3 players remain (including 2-max tables with a bot).
  // Admin profit is enforced by bots accepting/rejecting — never by hiding the button.
  if (activeUserIds.length < 2 || activeUserIds.length > 3) {
    return { can_split: false, reason: 'active_players_out_of_range' };
  }
  const poolLimit = resolvePoolLimit(session);
  const rowsWeighted = activeUserIds
    .map((userId) => {
      const player = playersByUser.get(userId) || {};
      const totalScore = Number(roundProgress?.scoresByUser?.[String(userId)]) || 0;
      const dropsRemaining = resolvePoolSplitDropsRemaining(poolLimit, totalScore);
      const splitWeight = dropsRemaining > 0 ? dropsRemaining : 0.5;
      return {
        user_id: userId,
        seat_no: Number(player?.seat_no) || 0,
        name: player?.name || null,
        avatar: player?.avatar || null,
        total_score: totalScore,
        drops_remaining: dropsRemaining,
        weight: splitWeight,
      };
    })
    .sort((a, b) => {
      if (a.total_score !== b.total_score) return a.total_score - b.total_score;
      return a.seat_no - b.seat_no;
    });

  const prizePoolSummary = buildPoolPrizePoolSummary({
    entryFee: Number(session?.contest?.entry) || 0,
    baseEntryCount: resolvePoolBaseEntryCount(session),
    rejoinEntryCount: resolvePoolRejoinEntryCount(session?.metadata || {}),
    projectedExtraEntries: 0,
  });
  const totalSplitAmount = roundCurrency(Number(prizePoolSummary?.current_prize_pool) || 0);
  if (totalSplitAmount <= 0) {
    return { can_split: false, reason: 'split_amount_non_positive' };
  }
  const rowsWithAmount = distributeByWeights(totalSplitAmount, rowsWeighted)
    .map((row) => ({
      user_id: row.user_id,
      seat_no: row.seat_no,
      name: row.name,
      avatar: row.avatar,
      score: row.total_score,
      total_score: row.total_score,
      drops_remaining: row.drops_remaining,
      split_weight: row.weight,
      split_amount: row.amount,
      amount: row.amount,
      decision: 'pending',
    }));

  const adminProfitProtection = evaluateAdminProfitProtection(session, rowsWithAmount, {
    participantUserIds: activeUserIds,
  });
  logGame(
    session?.id || 'pool_split',
    `[SPLIT_PROTECTION] offer_visible decision=${adminProfitProtection.decision} ${JSON.stringify(adminProfitProtection)}`
  );

  return {
    can_split: true,
    active_user_ids: activeUserIds,
    total_split_amount: totalSplitAmount,
    rows: rowsWithAmount,
    score_model: 'pool_loss_cumulative',
    source_status: payload?.status || 'round_completed',
    // Informational only — bots reject when not ACCEPT; UI still shows Split.
    admin_profit_protection: adminProfitProtection,
  };
}

function evaluateAdminProfitProtection(session = {}, splitRows = [], options = {}) {
  const participants = Array.isArray(options?.participantUserIds)
    ? options.participantUserIds.map((id) => Number(id)).filter((id) => !Number.isNaN(id))
    : [];
  const participantSet = participants.length > 0 ? new Set(participants) : null;
  const players = (Array.isArray(session?.players) ? session.players : [])
    .filter((player) => {
      const userId = Number(player?.user_id);
      if (Number.isNaN(userId)) return false;
      if (!participantSet) return true;
      return participantSet.has(userId);
    });
  const hasBot = players.some((player) => player?.metadata?.is_bot === true);
  const rows = Array.isArray(splitRows) ? splitRows : [];
  const payoutByUserId = new Map(rows.map((row) => {
    const userId = Number(row?.user_id);
    const amount = Number(row?.amount) || Number(row?.split_amount) || 0;
    return [userId, amount];
  }));

  if (!hasBot) {
    return {
      total_real_contribution: 0,
      total_real_payout: 0,
      total_bot_payout: 0,
      decision: 'ACCEPT',
      reason: 'ADMIN_PROFIT_PROTECTION_SKIPPED_NO_BOT',
    };
  }

  const entryFee = Math.max(0, Number(session?.contest?.entry) || 0);
  let totalRealContribution = 0;
  let totalRealPayout = 0;
  let totalBotPayout = 0;
  players.forEach((player) => {
    const userId = Number(player?.user_id);
    if (Number.isNaN(userId)) return;
    const payout = Number(payoutByUserId.get(userId)) || 0;
    if (player?.metadata?.is_bot === true) {
      totalBotPayout += payout;
      return;
    }
    totalRealContribution += entryFee;
    totalRealPayout += payout;
  });

  const decision = totalRealPayout <= totalRealContribution ? 'ACCEPT' : 'REJECT';
  return {
    total_real_contribution: roundCurrency(totalRealContribution),
    total_real_payout: roundCurrency(totalRealPayout),
    total_bot_payout: roundCurrency(totalBotPayout),
    decision,
    reason: 'ADMIN_PROFIT_PROTECTION',
  };
}

function buildPoolFinalResults(
  session = {},
  scoresByUser = {},
  winnerUserId = null,
  eliminatedUserIds = [],
  lastRoundResults = [],
) {
  const eliminatedSet = new Set(
    (Array.isArray(eliminatedUserIds) ? eliminatedUserIds : [])
      .map((id) => Number(id))
      .filter((id) => !Number.isNaN(id))
  );
  const lastRoundByUserId = new Map(
    (Array.isArray(lastRoundResults) ? lastRoundResults : [])
      .map((row) => [Number(row?.user_id), row])
      .filter(([userId]) => !Number.isNaN(userId))
  );
  const players = Array.isArray(session?.players) ? session.players : [];
  return players.map((player) => {
    const userId = Number(player.user_id);
    const totalPoints = Math.max(0, Number(scoresByUser[String(userId)]) || 0);
    const lastRound = lastRoundByUserId.get(userId) || null;
    const roundPoints = lastRound == null
      ? null
      : Math.max(0, Number(lastRound.round_points ?? lastRound.points) || 0);
    const isWinner = Number(userId) === Number(winnerUserId);
    const isDropped = Boolean(
      player?.metadata?.is_dropped === true
      || player?.metadata?.drop_status === 'dropped'
      || player?.metadata?.elimination_reason === 'dropped'
    );
    const isTimeout = player?.metadata?.elimination_reason === 'timeout';
    const playerStatus = isWinner
      ? 'won'
      : (isDropped
        ? 'dropped'
        : (isTimeout
          ? 'timeout'
          : (eliminatedSet.has(userId) ? 'eliminated' : 'lost')));
    return {
      user_id: player.user_id,
      seat_no: player.seat_no,
      points: roundPoints ?? 0,
      round_points: roundPoints,
      total_score: totalPoints,
      score_model: 'pool_loss_cumulative',
      grouped_points: null,
      ungrouped_points: null,
      valid_for_declare: null,
      invalid_group_count: null,
      all_cards_grouped: null,
      submission_mode: 'aggregate',
      submission_status: 'aggregate',
      dropped: isDropped,
      cumulative_points: totalPoints,
      is_winner: isWinner,
      player_status: playerStatus,
      status_color: resolveStatusColor(playerStatus),
    };
  });
}

function buildDealResultSnapshot({
  dealNo,
  reason,
  winnerUserId,
  declareByUserId = null,
  declarerValid = null,
  finishCard = null,
  autoDeclaredUserIds = [],
  finalizedResults = [],
}) {
  return {
    deal_no: dealNo,
    reason,
    completed_at: new Date().toISOString(),
    winner_user_id: winnerUserId,
    declare_by_user_id: declareByUserId,
    declare_valid: declarerValid,
    finish_card: finishCard,
    auto_declared_user_ids: autoDeclaredUserIds,
    results: (Array.isArray(finalizedResults) ? finalizedResults : []).map((row) => ({
      ...row,
      won_amount: row?.won_amount ?? 0,
    })),
  };
}

async function transitionToNextDeal(io, session, snapshot) {
  const sessionId = session.id;
  const totalDeals = resolveTotalDeals(session);
  const currentDeal = resolveCurrentDeal(session);
  const nextDeal = currentDeal + 1;
  const rawDealScores = [...normalizeDealScoreHistory(session.metadata || {}), snapshot];
  const {
    dealBaseScore,
    scoreTotalsByUser,
    enrichedDealScores,
  } = computeDealScoreboardTimeline(session, rawDealScores);
  const dealScores = enrichedDealScores;
  const latestDeal = dealScores[dealScores.length - 1] || snapshot;

  await Promise.all((session.players || []).map((player) => {
    const nextPlayerMetadata = resetPlayerMetadataForNextDeal(player.metadata || {});
    const nextStatus = (
      nextPlayerMetadata.connection_status === 'disconnected'
      || player.status === 'disconnected'
    )
      ? 'disconnected'
      : 'joined';
    return gameSessionModel.updatePlayerState(sessionId, player.user_id, {
      status: nextStatus,
      leftAt: null,
      metadata: nextPlayerMetadata,
    });
  }));

  const nextMetadata = {
    ...(session.metadata || {}),
    phase: 'inter_deal',
    phase_updated_at: new Date().toISOString(),
    current_deal: nextDeal,
    total_deals: totalDeals,
    deal_scores: dealScores,
    deal_base_score: dealBaseScore,
    deal_score_totals_by_user: scoreTotalsByUser,
  };

  delete nextMetadata.result;
  delete nextMetadata.declaration;
  delete nextMetadata.distribution;
  delete nextMetadata.discard_history;
  delete nextMetadata.game_state;
  delete nextMetadata.turn;
  delete nextMetadata.toss;
  delete nextMetadata.countdown;
  delete nextMetadata.turn_eliminated_user_ids;
  delete nextMetadata.turn_timeout_eliminated_user_ids;

  const dealContext = buildDealContextFields(session, {
    dealNo: currentDeal,
    totalDeals,
    dealScores,
    dealScoreTotalsByUser: scoreTotalsByUser,
  });

  const payload = {
    session_id: sessionId,
    server_time: new Date().toISOString(),
    event: 'game:result',
    status: 'deal_completed',
    is_final: false,
    ...dealContext,
    next_deal_no: nextDeal,
    winner_user_id: snapshot.winner_user_id,
    declare_by_user_id: snapshot.declare_by_user_id,
    declare_valid: snapshot.declare_valid,
    finish_card: snapshot.finish_card,
    auto_declared_user_ids: snapshot.auto_declared_user_ids,
    reason: snapshot.reason,
    score_model: 'deal_base_plus_minus',
    results: latestDeal.results,
    settlement: null,
  };

  payload.players = buildDeclarationTablePlayers({
    session,
    distribution: session.metadata?.distribution || null,
    state: { responses: new Map(), declareByUserId: snapshot.declare_by_user_id || null },
    isFinal: true,
    isGameFinal: false,
    finalizedResults: latestDeal.results,
    settlement: null,
    winnerUserId: snapshot.winner_user_id,
    declarerValid: snapshot.declare_valid ?? null,
  });

  const dealScoresWithDetails = enrichLastDealScoreEntry(dealScores, {
    players: payload.players,
    wild_joker_card_id: resolveWildJokerCardId(session),
    finish_card: snapshot.finish_card || null,
    declare_by_user_id: snapshot.declare_by_user_id,
    declare_valid: snapshot.declare_valid,
    reason: snapshot.reason,
    first_turn_user_id: session?.metadata?.first_turn_user_id ?? null,
    last_turn_user_id: session?.metadata?.last_turn_user_id ?? null,
  });

  nextMetadata.deal_scores = dealScoresWithDetails;
  nextMetadata.result = payload;
  await gameSessionModel.updateSessionStatus(sessionId, 'ready', {
    endedAt: null,
    currentTurnUserId: null,
    metadata: nextMetadata,
  });

  await gameSessionModel.insertEvent({
    sessionId,
    userId: snapshot.winner_user_id,
    eventType: 'deal_completed',
    payload,
  });

  io.to(sessionRoom(sessionId)).emit('game:result', payload);
  await emitSessionState(io, sessionId, { includeEvents: false });

  const nextDealParticipants = getActivePlayers(session);
  const rotatedFirstTurnUserId = resolveNextDealFirstTurnUserId(session, nextDealParticipants);

  await continuePoolDealFlow(
    io,
    sessionId,
    rotatedFirstTurnUserId || null,
    'deals_next_deal',
    { countdownSeconds: 5 },
  );

  return payload;
}

function declarationFinalizeKey(sessionId, sequence) {
  return `idem:declare:finalize:session:${sessionId}:seq:${sequence}`;
}

function armDeclareDurableTimer(state) {
  if (!state?.sessionId || !state?.sequence || !state?.endsAt) return;
  const fireAtMs = Date.parse(state.endsAt);
  if (!Number.isFinite(fireAtMs)) return;
  const awaiting = state.visibilityStage === DECLARATION_VISIBILITY_AWAITING_DECLARER;
  const kind = awaiting ? 'declare_awaiting' : 'declare_finalize';
  // Cancel sibling kind so stage transitions don't double-fire.
  durableTimer.cancel({
    kind: awaiting ? 'declare_finalize' : 'declare_awaiting',
    sessionId: state.sessionId,
    token: state.sequence,
  }).catch(() => {});
  durableTimer.arm({
    kind,
    sessionId: state.sessionId,
    token: state.sequence,
    fireAtMs,
    payload: {
      sequence: state.sequence,
      visibility_stage: state.visibilityStage,
      declare_by_user_id: state.declareByUserId,
    },
  }).catch(() => {});
}

function persistDeclareState(state) {
  if (!state?.sessionId) return Promise.resolve(false);
  const saved = ephemeralSessionState.saveDeclareSnapshot(state.sessionId, state);
  armDeclareDurableTimer(state);
  return saved;
}

async function rebuildDeclareStateFromStore(sessionId, entry = null) {
  const sid = Number(sessionId);
  if (Number.isNaN(sid)) return null;
  const existing = activeDeclareBySession.get(sid);
  if (existing) return existing;

  const session = await gameplayService.getSessionState(sid);
  if (!session) return null;
  const declaration = session.metadata?.declaration || {};
  const snap = await ephemeralSessionState.loadDeclareSnapshot(sid);
  const sequence = entry?.payload?.sequence
    || entry?.token
    || snap?.sequence
    || declaration.sequence;
  if (!sequence) return null;

  const responses = ephemeralSessionState.deserializeDeclareResponses(
    snap?.responses || {},
  );
  const state = {
    sessionId: sid,
    sequence,
    declareByUserId: Number(
      snap?.declare_by_user_id
      || declaration.declare_by_user_id
      || entry?.payload?.declare_by_user_id
      || 0,
    ),
    participantUserIds: Array.isArray(snap?.participant_user_ids)
      ? snap.participant_user_ids
      : (Array.isArray(session.players) ? session.players.map((p) => p.user_id) : []),
    visibilityStage: snap?.visibility_stage
      || declaration.visibility_stage
      || entry?.payload?.visibility_stage
      || DECLARATION_VISIBILITY_OPEN_FOR_ALL,
    startedAt: snap?.started_at || declaration.started_at || null,
    endsAt: snap?.ends_at || declaration.ends_at || null,
    finishCard: snap?.finish_card || declaration.finish_card || null,
    responses,
    countdownInterval: null,
    timeoutHandle: null,
    recovered: true,
  };
  activeDeclareBySession.set(sid, state);
  return state;
}

function cleanupDeclareState(sessionId) {
  const state = activeDeclareBySession.get(sessionId);
  if (!state) {
    ephemeralSessionState.clearDeclareSnapshot(sessionId).catch(() => {});
    return;
  }

  if (state.countdownInterval) {
    clearInterval(state.countdownInterval);
  }
  if (state.timeoutHandle) {
    clearTimeout(state.timeoutHandle);
  }

  if (state.sequence) {
    durableTimer.cancel({
      kind: 'declare_finalize',
      sessionId,
      token: state.sequence,
    }).catch(() => {});
    durableTimer.cancel({
      kind: 'declare_awaiting',
      sessionId,
      token: state.sequence,
    }).catch(() => {});
  }

  activeDeclareBySession.delete(sessionId);
  ephemeralSessionState.clearDeclareSnapshot(sessionId).catch(() => {});
}

/** True while a declaration response window is open — turn timers must not run in parallel. */
function isDeclarationWindowActive(sessionId, metadata = {}) {
  if (sessionId != null && activeDeclareBySession.has(sessionId)) {
    return true;
  }
  const sid = Number(sessionId);
  if (!Number.isNaN(sid) && sid !== sessionId && activeDeclareBySession.has(sid)) {
    return true;
  }
  return String(metadata?.phase || '').toLowerCase() === 'declaration_window';
}

function cleanupTurnTimeoutOnly(sessionId) {
  const state = activeTurnBySession.get(sessionId);
  if (!state) return;

  if (state.timeoutHandle) {
    clearTimeout(state.timeoutHandle);
  }

  const turnId = state.turnId;
  activeTurnBySession.delete(sessionId);

  // Dual-write cancel — no-op when Redis/ARM disabled. Does not change local clock.
  if (turnId != null) {
    durableTimer.cancelTurnTimeout(sessionId, turnId).catch(() => {});
  }
}

function cleanupTurnState(sessionId) {
  cleanupTurnTimeoutOnly(sessionId);
  cleanupBotActionState(sessionId);
}

function cleanupBotActionState(sessionId) {
  const state = activeBotActionBySession.get(sessionId);
  if (!state) return;

  if (state.timeoutHandle) {
    clearTimeout(state.timeoutHandle);
  }

  if (state.turnId != null && state.phase) {
    durableTimer.cancel({
      kind: 'bot_turn',
      sessionId,
      token: `${state.turnId}:${state.phase}`,
    }).catch(() => {});
  }

  activeBotActionBySession.delete(sessionId);
}

/** Clear process-local bot timer only — leave Redis durable timer for other workers. */
function clearLocalBotActionStateOnly(sessionId) {
  const state = activeBotActionBySession.get(sessionId);
  if (!state) return;
  if (state.timeoutHandle) {
    clearTimeout(state.timeoutHandle);
  }
  activeBotActionBySession.delete(sessionId);
}

function getActiveBotActionState(sessionId) {
  return activeBotActionBySession.get(sessionId) || null;
}

function botTurnPhaseClaimKey(sessionId, turnId, phase) {
  const normalizedPhase = phase === 'discard' ? 'discard' : 'pick';
  return `idem:bot-turn:session:${sessionId}:turn:${turnId}:phase:${normalizedPhase}`;
}

async function botPhaseStillNeeded(sessionId, expectedTurnId, phase) {
  const normalizedPhase = phase === 'discard' ? 'discard' : 'pick';
  const session = await loadBotActionSession(sessionId);
  if (!session || session.status !== 'active') return false;
  // Finish opens a declare window but keeps the same turn + has_picked.
  // That must not be treated as "discard still needed" or the bot throws a
  // second card (finish + discard) and the result hand drops to 12.
  if (isDeclarationWindowActive(sessionId, session.metadata)) return false;
  const turn = session.metadata?.turn;
  if (!turn || Number(turn.turn_id) !== Number(expectedTurnId)) return false;
  if (!isBotTurn(session, turn.user_id)) return false;
  if (normalizedPhase === 'pick') return turn.has_picked !== true;
  return turn.has_picked === true;
}

function normalizeAttemptsUsedByUser(metadata = {}) {
  const raw = metadata?.turn_bonus?.attempts_used_by_user || {};
  const normalized = {};

  Object.entries(raw).forEach(([userId, count]) => {
    const parsed = Number(count);
    normalized[String(userId)] = Number.isNaN(parsed) ? 0 : Math.max(0, Math.floor(parsed));
  });

  return normalized;
}

function getMaxBonusAttempts(session) {
  const fromMeta = Number(session?.metadata?.turn_bonus?.max_attempts_per_player);
  if (!Number.isNaN(fromMeta) && fromMeta > 0) {
    return Math.floor(fromMeta);
  }
  const fromGame = Number(session?.game?.bonus_attempts_per_player);
  if (!Number.isNaN(fromGame) && fromGame > 0) {
    return Math.floor(fromGame);
  }
  return MAX_BONUS_ATTEMPTS_PER_PLAYER;
}

/** Normal turn duration for the next player — game config only, never current bonus turn metadata. */
function resolveNormalTurnTimerSeconds(session, fallback = 30) {
  const fromGame = Number(session?.game?.turn_timer_seconds);
  if (Number.isFinite(fromGame) && fromGame > 0) return Math.floor(fromGame);
  return fallback;
}

function isFirstDropEligible(playerDistribution) {
  if (!playerDistribution) return false;
  if (playerDistribution.has_picked === true) return false;
  if (playerDistribution.first_turn_cycle_complete === true) return false;
  return true;
}

function resolveFirstRoundNoChanceDeclarePenalty(points, playerDistribution) {
  if (!isFirstDropEligible(playerDistribution)) return points;
  const numericPoints = Number(points);
  if (!Number.isFinite(numericPoints) || numericPoints <= 0) return points;
  return Math.min(MAX_ROUND_LOSS_POINTS, Math.ceil(numericPoints / 2));
}

function markDepartingPlayerFirstTurnCycleComplete(playersDistribution, departingUserId) {
  if (!Array.isArray(playersDistribution) || departingUserId == null) {
    return playersDistribution;
  }
  const idx = playersDistribution.findIndex(
    (pd) => Number(pd?.user_id) === Number(departingUserId)
  );
  if (idx < 0) return playersDistribution;
  const pd = playersDistribution[idx];
  if (pd?.has_picked === true || pd?.first_turn_cycle_complete === true) {
    return playersDistribution;
  }
  const updated = [...playersDistribution];
  updated[idx] = { ...pd, first_turn_cycle_complete: true };
  return updated;
}

function buildPlayerDealFlags(playersDistribution = []) {
  if (!Array.isArray(playersDistribution)) return [];
  return playersDistribution.map((pd) => ({
    user_id: pd?.user_id,
    has_picked: pd?.has_picked === true,
    first_turn_cycle_complete: pd?.first_turn_cycle_complete === true,
  }));
}

function buildTurnWindow(turnTimerSeconds, graceMs = TURN_START_GRACE_MS) {
  const durationMs = Math.max(0, Number(turnTimerSeconds) || 0) * 1000;
  const safeGraceMs = Math.max(0, Number(graceMs) || 0);
  const startedAtMs = Date.now() + safeGraceMs;
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    endsAt: new Date(startedAtMs + durationMs).toISOString(),
  };
}

function buildTurnPayload({
  session,
  userId,
  turnId,
  type,
  attemptNo,
  attemptsUsedCount,
  startedAt,
  endsAt,
  turnTimerSeconds,
  hasPicked = false,
  pickedCardUid = null,
}) {
  const maxBonusAttempts = getMaxBonusAttempts(session);
  const safeAttemptNo = Math.max(0, Number(attemptNo) || 0);
  const safeAttemptsUsedCount = Math.max(0, Number(attemptsUsedCount) || 0);
  const attemptsLeft = Math.max(0, maxBonusAttempts - safeAttemptsUsedCount);

  const payload = {
    turn_id: Number(turnId) || Date.now(),
    user_id: userId,
    started_at: startedAt,
    ends_at: endsAt,
    turn_timer_seconds: turnTimerSeconds,
    type: type === 'bonus' ? 'bonus' : 'normal',
    attempt_no: safeAttemptNo,
    max_bonus_attempts: maxBonusAttempts,
    attempts_left: attemptsLeft,
    has_picked: hasPicked === true,
  };
  if (hasPicked === true && pickedCardUid != null) {
    const uid = String(pickedCardUid).trim();
    if (uid) payload.picked_card_uid = uid;
  }
  return payload;
}

function emitTurn(io, sessionId, turn, extras = {}) {
  // Never leak closed-deck identity on the room broadcast.
  const {
    session,
    distribution,
    closed_deck_top: _ignoredClosedTop,
    ...publicExtras
  } = extras || {};

  const turnPayload = traceSessionBroadcast({
    sessionId,
    eventName: 'game:turn',
    payload: {
      session_id: sessionId,
      server_time: new Date().toISOString(),
      event: 'game:turn',
      ...publicExtras,
      turn,
    },
    targetUserId: turn?.user_id ?? null,
  });
  io.to(sessionRoom(sessionId)).emit('game:turn', turnPayload);

  const dist = distribution || session?.metadata?.distribution || null;
  if (dist) {
    emitClosedDeckPreviewToTurnPlayer(io, sessionId, turn, dist);
  } else {
    console.warn(
      `[closed_deck_preview] emitTurn missing distribution session=${sessionId} turn=${turn?.turn_id}`,
    );
    scheduleClosedDeckPreviewFromSession(io, sessionId, turn);
  }

  maybeScheduleBotTurnAction(io, sessionId, turn).catch((err) => {
    errorGame(sessionId, `Bot turn scheduling failed: ${err.message}`);
  });
  maybeScheduleAutoDropAction(io, sessionId, turn).catch((err) => {
    errorGame(sessionId, `Auto-drop scheduling failed: ${err.message}`);
  });
}

async function maybeScheduleAutoDropAction(io, sessionId, turn) {
  const turnUserId = Number(turn?.user_id);
  const turnId = Number(turn?.turn_id);
  if (Number.isNaN(sessionId) || Number.isNaN(turnUserId) || Number.isNaN(turnId)) return;
  // Same fields as before (status / turn / players / auto_drop flags) — skip
  // events + game/contest joins that were loaded on every discard for no reason.
  const session = await gameplayService.loadTurnActionSession(sessionId);
  if (!session || session.status !== 'active') return;
  if (Number(session.current_turn_user_id) !== turnUserId) return;
  if (activeDeclareBySession.has(sessionId)) return;
  const player = (session.players || []).find((item) => Number(item.user_id) === turnUserId);
  if (!player) return;
  if (player?.metadata?.is_bot === true) return;
  if (player.status === 'eliminated' || player.status === 'left') return;
  if (player?.metadata?.is_dropped === true || String(player?.metadata?.drop_status || '').toLowerCase() === 'dropped') return;
  if (player?.metadata?.auto_drop_enabled !== true) return;

  const idemKey = `auto_drop:${sessionId}:${turnId}:${turnUserId}`;
  const claimed = await redisLockService.claimEventIdempotency(idemKey, AUTO_DROP_IDEMPOTENCY_TTL_SECONDS);
  if (!claimed) return;

  logGame(sessionId, `Auto-drop executing uid=${turnUserId} turn=${turnId}`);
  const outcome = await dropPlayerFromSession(io, sessionId, turnUserId);
  io.to(sessionRoom(sessionId)).emit('player:auto_drop:executed', {
    session_id: sessionId,
    server_time: new Date().toISOString(),
    event: 'player:auto_drop:executed',
    user_id: turnUserId,
    turn_id: turnId,
    result_status: outcome?.result?.status || null,
  });
}

function emitDeckReshuffled(io, sessionId, extras = {}) {
  const payload = {
    session_id: sessionId,
    server_time: new Date().toISOString(),
    event: 'game:deck_reshuffled',
    reason: 'closed_deck_exhausted',
    ...extras,
  };

  logGame(
    sessionId,
    `Emitting game:deck_reshuffled — triggeredBy=uid:${payload.triggered_by_user_id || 'unknown'} ` +
    `reshuffledCards=${payload.reshuffled_cards || 0} closedDeck=${payload.closed_deck_count ?? 'n/a'} ` +
    `discardTop=${payload.discard_top?.card_uid || 'none'}`
  );

  io.to(sessionRoom(sessionId)).emit('game:deck_reshuffled', payload);

  // Current turn player needs a fresh closed-top preview after reshuffle.
  Promise.resolve()
    .then(() => gameSessionModel.findSessionById(sessionId))
    .then((row) => {
      const turn = row?.metadata?.turn;
      if (!turn || turn.has_picked === true) return;
      emitClosedDeckPreviewToTurnPlayer(
        io,
        sessionId,
        turn,
        row?.metadata?.distribution
      );
    })
    .catch(() => {});

  return payload;
}

/** Room broadcast so opponents can animate bot/human discards (mirrors `game:pick`). */
function emitBotDiscardBroadcast(io, sessionId, userId, discardedCard, discardTop, extras = {}) {
  const payload = traceSessionBroadcast({
    sessionId,
    eventName: 'game:discard',
    payload: {
      session_id: sessionId,
      server_time: new Date().toISOString(),
      event: 'game:discard',
      success: true,
      user_id: userId,
      data: {
        user_id: userId,
        discarded_by_user_id: userId,
        discarded_card: discardedCard,
        discard_top: discardTop || null,
      },
      ...extras,
    },
    targetUserId: userId,
  });
  io.to(sessionRoom(sessionId)).emit('game:discard', payload);
  return payload;
}

/** Same `data` shape as `player:discard` ack — sent only to the given user (e.g. turn-timeout auto discard). */
function emitGameDiscardAckToUser(io, sessionId, userId, data, extras = {}) {
  const payload = {
    session_id: sessionId,
    server_time: new Date().toISOString(),
    event: 'game:discard',
    success: true,
    data,
    ...extras,
  };
  console.log('emitGameDiscardAckToUser', payload);
  const uidNum = Number(userId);
  const socketIds = new Set([
    ...socketRegistry.getSocketIds(Number.isNaN(uidNum) ? userId : uidNum),
    ...socketRegistry.getSocketIds(userId),
  ]);
  for (const sid of socketIds) {
    const sock = io.sockets.sockets.get(sid);
    if (sock) sock.emit('game:discard', payload);
  }
}

function trimDiscardHistoryTimeline(timeline = [], maxEntries = DISCARD_HISTORY_MAX_ENTRIES) {
  if (!Array.isArray(timeline) || timeline.length <= maxEntries) return timeline;
  return timeline.slice(timeline.length - maxEntries);
}

function normalizeDiscardHistoryState(metadata = {}, distribution = null) {
  const raw = metadata?.discard_history || {};
  const rawTimeline = Array.isArray(raw?.timeline) ? raw.timeline : [];
  let timeline = rawTimeline
    .map((entry) => ({ ...entry, seq: Number(entry?.seq) || 0 }))
    .filter((entry) => entry.seq > 0)
    .sort((a, b) => a.seq - b.seq);
  timeline = trimDiscardHistoryTimeline(timeline);

  let seq = Number(raw?.seq) || 0;
  if (timeline.length > 0) {
    const maxSeq = Math.max(...timeline.map((entry) => Number(entry.seq) || 0));
    seq = Math.max(seq, maxSeq);
  }

  let initialDiscardCard = raw?.initial_discard_card || null;
  if (!initialDiscardCard) {
    const discardPile = Array.isArray(distribution?.discard_pile) ? distribution.discard_pile : [];
    if (discardPile.length > 0) {
      initialDiscardCard = discardPile[discardPile.length - 1] || discardPile[0] || null;
    }
  }

  return {
    seq,
    timeline,
    initial_discard_card: initialDiscardCard,
  };
}

function buildDiscardHistoryEntry(entry = {}) {
  const discardedCard = entry?.discarded_card || null;
  return {
    seq: Number(entry?.seq) || 0,
    card_uid: entry?.card_uid || discardedCard?.card_uid || null,
    card_id: entry?.card_id || discardedCard?.card_id || null,
    discarded_by_user_id: entry?.discarded_by_user_id ?? null,
    discarded_at: entry?.discarded_at || null,
    picked_by_user_id: entry?.picked_by_user_id ?? null,
    picked_at: entry?.picked_at || null,
    turn_id: entry?.turn_id ?? null,
    discarded_card: discardedCard,
  };
}

function appendDiscardHistoryEntry(metadata = {}, distribution = null, payload = {}) {
  const state = normalizeDiscardHistoryState(metadata, distribution);
  const nextSeq = state.seq + 1;
  const discardedCard = payload?.discarded_card || null;
  const entry = buildDiscardHistoryEntry({
    seq: nextSeq,
    card_uid: discardedCard?.card_uid || payload?.card_uid || null,
    card_id: discardedCard?.card_id || payload?.card_id || null,
    discarded_by_user_id: payload?.discarded_by_user_id ?? null,
    discarded_at: payload?.discarded_at || new Date().toISOString(),
    picked_by_user_id: null,
    picked_at: null,
    turn_id: payload?.turn_id ?? null,
    discarded_card: discardedCard,
  });

  const nextDiscardHistory = {
    seq: nextSeq,
    initial_discard_card: state.initial_discard_card,
    timeline: trimDiscardHistoryTimeline([...state.timeline, entry]),
  };

  return {
    discardHistory: nextDiscardHistory,
    latestEntry: entry,
  };
}

function markDiscardHistoryPicked(metadata = {}, distribution = null, payload = {}) {
  const state = normalizeDiscardHistoryState(metadata, distribution);
  const pickedCard = payload?.picked_card || null;
  const pickedCardUid = pickedCard?.card_uid || payload?.card_uid || null;
  if (!pickedCardUid) {
    return {
      discardHistory: {
        seq: state.seq,
        initial_discard_card: state.initial_discard_card,
        timeline: state.timeline,
      },
      latestEntry: null,
      changed: false,
    };
  }

  let changed = false;
  let latestEntry = null;
  const nextTimeline = [...state.timeline];
  for (let i = nextTimeline.length - 1; i >= 0; i -= 1) {
    const item = nextTimeline[i];
    if (String(item?.card_uid || '') !== String(pickedCardUid)) continue;
    if (item?.picked_by_user_id != null) continue;

    const patched = buildDiscardHistoryEntry({
      ...item,
      picked_by_user_id: payload?.picked_by_user_id ?? null,
      picked_at: payload?.picked_at || new Date().toISOString(),
    });
    nextTimeline[i] = patched;
    latestEntry = patched;
    changed = true;
    break;
  }

  return {
    discardHistory: {
      seq: state.seq,
      initial_discard_card: state.initial_discard_card,
      timeline: trimDiscardHistoryTimeline(nextTimeline),
    },
    latestEntry,
    changed,
  };
}

function buildDiscardHistoryPlayers(session = {}, timeline = []) {
  const players = Array.isArray(session?.players) ? session.players : [];
  const playersByUserId = new Map(players.map((player) => [Number(player.user_id), player]));
  const groupedByDiscarder = new Map();

  timeline.forEach((entry) => {
    const uid = Number(entry?.discarded_by_user_id);
    if (Number.isNaN(uid)) return;
    if (!groupedByDiscarder.has(uid)) {
      groupedByDiscarder.set(uid, []);
    }
    groupedByDiscarder.get(uid).push(buildDiscardHistoryEntry(entry));
  });

  const orderedPlayers = [...players].sort(
    (a, b) => (Number(a?.seat_no) || 0) - (Number(b?.seat_no) || 0),
  );

  const result = orderedPlayers.map((player) => {
    const uid = Number(player.user_id);
    return {
      id: uid,
      name: player?.name || null,
      discarded_cards: groupedByDiscarder.get(uid) || [],
    };
  });

  groupedByDiscarder.forEach((discardedCards, uid) => {
    if (playersByUserId.has(uid)) return;
    result.push({
      id: uid,
      name: null,
      discarded_cards: discardedCards,
    });
  });

  return result;
}

function buildDiscardHistoryPayload(session = {}, extras = {}) {
  const distribution = session?.metadata?.distribution || null;
  const state = normalizeDiscardHistoryState(session?.metadata || {}, distribution);
  return {
    session_id: session.id,
    server_time: new Date().toISOString(),
    event: 'game:discard_history:update',
    seq: state.seq,
    initial_discard_card: state.initial_discard_card,
    players: buildDiscardHistoryPlayers(session, state.timeline),
    timeline: state.timeline.map((entry) => buildDiscardHistoryEntry(entry)),
    ...extras,
  };
}

function emitDiscardHistoryUpdate(io, session = {}, extras = {}) {
  if (!io || !session?.id) return null;
  const payload = buildDiscardHistoryPayload(session, extras);
  io.to(sessionRoom(session.id)).emit('game:discard_history:update', payload);
  return payload;
}

function isJokerCard(card = null, wildJoker = null) {
  return isJokerCardWithWild(card, wildJoker);
}

function canPickDiscardJokerInCurrentTurn(session = {}) {
  const turn = session?.metadata?.turn || {};
  const gameState = session?.metadata?.game_state || {};
  const currentUserId = Number(turn.user_id);
  const firstTurnUserId = Number(
    gameState.first_turn_user_id
      ?? session?.metadata?.first_turn_user_id
      ?? 0,
  );

  // Opening discard is still on the pile only while nobody has discarded yet.
  const timeline = Array.isArray(session?.metadata?.discard_history?.timeline)
    ? session.metadata.discard_history.timeline
    : [];
  if (timeline.length > 0) return false;

  // First seat of the deal may take an opening joker on their normal or bonus
  // turn (bonus bumps turn_id; initial_turn_id alone would wrongly block it).
  if (Number.isFinite(firstTurnUserId) && firstTurnUserId > 0
      && Number.isFinite(currentUserId) && currentUserId > 0) {
    return currentUserId === firstTurnUserId;
  }

  // Legacy fallback when first_turn_user_id is missing.
  const currentTurnId = Number(turn.turn_id);
  const initialTurnId = Number(gameState.initial_turn_id);
  if (Number.isNaN(currentTurnId) || Number.isNaN(initialTurnId)) return false;
  return currentTurnId === initialTurnId;
}

function isBotTurn(session, userId) {
  const targetUserId = Number(userId);
  if (Number.isNaN(targetUserId)) return false;

  const player = (session?.players || []).find((item) => Number(item.user_id) === targetUserId);
  return player?.metadata?.is_bot === true;
}

/** User ids still in the table at finish, excluding the winner (pool / spin_go style). */
function resolveNonWinningJoinedUserIds(session, winnerUserId) {
  const w = Number(winnerUserId);
  const players = Array.isArray(session?.players) ? session.players : [];
  const ids = players
    .filter((p) => ['joined', 'disconnected', 'eliminated', 'left'].includes(p?.status))
    .map((p) => Number(p.user_id))
    .filter((uid) => !Number.isNaN(uid) && uid !== w);
  return [...new Set(ids)];
}

async function lockOrCreateWalletByUserId(client, userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid)) return null;

  await client.query(
    `INSERT INTO wallets (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
    [uid]
  );

  const walletRes = await client.query(
    'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
    [uid]
  );
  return walletRes.rows[0] || null;
}

async function resolveHumanEntryPoolForSession(client, session = {}, fallbackUserIds = []) {
  const sessionId = Number(session?.id);
  if (!Number.isFinite(sessionId)) return 0;

  const sid = sessionId;
  const playersRes = await client.query(
    `SELECT user_id, metadata
     FROM game_session_players
     WHERE game_session_id = $1`,
    [sid]
  );
  const humanIds = (playersRes.rows || [])
    .filter((row) => row?.metadata?.is_bot !== true)
    .map((row) => Number(row.user_id))
    .filter((uid) => !Number.isNaN(uid));

  const scopedHumanIds = (Array.isArray(fallbackUserIds) && fallbackUserIds.length > 0)
    ? humanIds.filter((uid) => fallbackUserIds.includes(uid))
    : humanIds;

  let paidPool = 0;
  if (scopedHumanIds.length > 0) {
    const paidRes = await client.query(
      `SELECT COALESCE(SUM(ABS(amount)), 0) AS total
       FROM wallet_transactions
       WHERE reference_type = 'game_session'
         AND reference_id = $1
         AND transaction_type = 'game_entry_debit'
         AND user_id = ANY($2::int[])`,
      [sid, scopedHumanIds]
    );
    paidPool = roundCurrency(Number(paidRes.rows[0]?.total || 0));
  }

  if (paidPool > 0) return paidPool;

  const entryFee = roundCurrency(Number(session?.contest?.entry) || 0);
  if (entryFee <= 0 || scopedHumanIds.length <= 0) return 0;
  return roundCurrency(entryFee * scopedHumanIds.length);
}

function hasBotPlayer(session) {
  const players = Array.isArray(session?.players) ? session.players : [];
  return players.some((player) => player?.metadata?.is_bot === true);
}

function isBotSoftRiggingEnabled(session = null) {
  const envEnabled = String(process.env.ENABLE_BOT_SOFT_RIGGING || 'false').trim().toLowerCase() === 'true';
  const metadata = session?.metadata || {};
  const runtimeToggle = metadata?.bot_soft_rigging_enabled;
  const runtimeEnabled = runtimeToggle == null ? envEnabled : runtimeToggle === true;
  return runtimeEnabled && hasBotPlayer(session);
}

function buildBotPlayContext(session = {}, userId = null) {
  const mode = resolveSessionGameMode(session);
  const poolLimit = resolvePoolLimit(session);
  const scoresByUser = session?.metadata?.pool_scores_by_user || {};
  const currentPoolScore = Number(scoresByUser[String(userId)]) || 0;
  const safePoolLimit = Number.isFinite(poolLimit) ? poolLimit : 101;
  const scoreHeadroom = safePoolLimit - currentPoolScore;
  const dealLike = isDealLikeMode(mode);

  let urgency = 0.55;
  let playToWin = false;
  if (dealLike) {
    urgency = 0.9;
    playToWin = true;
  } else if (mode === 'pool') {
    if (scoreHeadroom > BOT_POOL_COMFORTABLE_HEADROOM) {
      urgency = 0.82;
      playToWin = true;
    } else if (scoreHeadroom <= BOT_POOL_NEAR_ELIMINATION_HEADROOM) {
      urgency = 0.38;
      playToWin = false;
    } else {
      urgency = 0.62;
      playToWin = true;
    }
  } else if (mode === 'points') {
    urgency = 0.68;
    playToWin = true;
  }

  return {
    mode,
    playToWin,
    urgency,
    scoreHeadroom,
    currentPoolScore,
    poolLimit: safePoolLimit,
    dealLike,
  };
}

function calculateRiggingNeedScore(summary = {}) {
  const pureCount = Number(summary?.pure_sequence_count) || 0;
  const sequenceCount = Number(summary?.sequence_count) || 0;
  const ungroupedPoints = Number(summary?.ungrouped_points) || 0;
  const validForDeclare = summary?.valid_for_declare === true;
  if (validForDeclare) return 0;

  let score = 0;
  if (pureCount === 0) score += 0.25;
  if (sequenceCount === 0) score += 0.2;
  score += Math.min(0.35, ungroupedPoints / 240);
  return Math.min(0.8, Math.max(0, score));
}

// Soft-rigging helper: subtly finds a useful card in closed deck.
function tryFindBotCardInClosedDeck(closedDeck, botCards, wildJoker, options = {}) {
  if (!Array.isArray(closedDeck) || closedDeck.length === 0 || options?.softRiggingEnabled !== true) {
    return null;
  }

  const riggingSeed = options?.decisionSeed
    || buildDecisionSeed(options?.sessionId, options?.turnId, options?.userId);
  const groupingOptions = buildGroupingTieBreakOptions(riggingSeed);
  const botGrouping = groupingService.buildBestGrouping(botCards, wildJoker, groupingOptions);
  const currentSummary = botGrouping?.summary || {};
  if (currentSummary.valid_for_declare === true) {
    return null;
  }

  const currentUngrouped = Number(currentSummary.ungrouped_points) || 0;
  const currentGrouped = Number(currentSummary.grouped_cards_count) || 0;
  // Avoid soft rigging on hands that are already structurally reasonable; only assist when the bot is clearly behind.
  if (currentUngrouped <= 18 || currentGrouped >= 8) {
    return null;
  }

  const needScore = calculateRiggingNeedScore(currentSummary);
  const playToWin = options?.playToWin === true;
  const urgency = Math.max(0, Math.min(1, Number(options?.playUrgency) || 0.5));
  const activationBase = playToWin ? 0.28 : 0.18;
  const activationCap = playToWin ? 0.72 : 0.55;
  const activationChance = Math.max(
    activationBase,
    Math.min(activationCap, activationBase + (needScore * (playToWin ? 0.75 : 0.6)) + (urgency * 0.08))
  );
  if (Math.random() > activationChance) {
    return null;
  }

  const helpfulCards = [];
  // Only scan the top of the closed deck — full-deck × buildBestGrouping was blocking
  // the event loop for hundreds of ms (and spiking client socket:ping to ~1s).
  const maxScan = Math.min(
    closedDeck.length,
    Math.max(BOT_SOFT_RIGGING_DECK_LOOKAHEAD, Number(process.env.BOT_SOFT_RIGGING_MAX_SCAN) || 6)
  );
  const scanBudgetMs = Math.max(5, Number(process.env.BOT_SOFT_RIGGING_SCAN_BUDGET_MS) || 20);
  const scanStartedAt = Date.now();
  for (let i = 0; i < maxScan; i++) {
    if ((Date.now() - scanStartedAt) >= scanBudgetMs) break;
    const card = closedDeck[i];
    const testHand = [...botCards, card];
    const testGrouping = groupingService.buildBestGrouping(testHand, wildJoker, groupingOptions);
    const nextSummary = testGrouping?.summary || {};
    const groupedDelta = (Number(nextSummary.grouped_cards_count) || 0) - (Number(currentSummary.grouped_cards_count) || 0);
    const pureDelta = (Number(nextSummary.pure_sequence_count) || 0) - (Number(currentSummary.pure_sequence_count) || 0);
    const sequenceDelta = (Number(nextSummary.sequence_count) || 0) - (Number(currentSummary.sequence_count) || 0);
    const pointGain = (Number(currentSummary.ungrouped_points) || 0) - (Number(nextSummary.ungrouped_points) || 0);

    const weightedGain = (groupedDelta * 4.5) + (pureDelta * 3.5) + (sequenceDelta * 2.5) + (pointGain / 8);
    if (nextSummary.valid_for_declare === true) {
      helpfulCards.push({ index: i, card, score: 8 + Math.max(0, weightedGain) });
    } else if (weightedGain >= 1.2) {
      helpfulCards.push({ index: i, card, score: weightedGain });
    }
  }

  if (helpfulCards.length === 0) {
    return null;
  }

  helpfulCards.sort((a, b) => b.score - a.score);
  const lookaheadWindow = Math.min(BOT_SOFT_RIGGING_DECK_LOOKAHEAD, helpfulCards.length);
  const candidateWindow = helpfulCards.slice(0, lookaheadWindow);
  const cappedCandidates = candidateWindow.slice(0, Math.min(BOT_SOFT_RIGGING_MAX_HELPFUL_CANDIDATES, candidateWindow.length));
  const weightedTotal = cappedCandidates.reduce((sum, item) => sum + Math.max(1, item.score), 0);
  let roll = Math.random() * weightedTotal;
  let selected = cappedCandidates[0];
  for (const candidate of cappedCandidates) {
    roll -= Math.max(1, candidate.score);
    if (roll <= 0) {
      selected = candidate;
      break;
    }
  }

  const pickedCard = closedDeck.splice(selected.index, 1)[0];
  if (!pickedCard) return null;

  logGame(
    options?.sessionId || 'rigging',
    `[SOFT-RIGGING] Bot closed-deck assist applied uid=${options?.userId || 'unknown'} ` +
    `card=${pickedCard.card_uid || `${pickedCard.rank}${pickedCard.suit || ''}`} candidates=${helpfulCards.length}`
  );

  return pickedCard;
}

const FINISH_PLAN_HAND_CARD_COUNT = 14;
const DECLARE_HAND_CARD_COUNT = 13;

function getSubmittedGroupCardUids(submittedGroups = []) {
  const uids = new Set();
  (Array.isArray(submittedGroups) ? submittedGroups : []).forEach((group) => {
    (Array.isArray(group?.cards) ? group.cards : []).forEach((uid) => {
      const normalized = String(uid || '').trim();
      if (normalized) uids.add(normalized);
    });
  });
  return uids;
}

function tryBuildFinishPlanFromSubmittedGroups(cards = [], wildJoker = null, options = {}) {
  const submittedGroups = options?.submittedGroups;
  if (!Array.isArray(cards) || cards.length !== FINISH_PLAN_HAND_CARD_COUNT) return null;
  if (!Array.isArray(submittedGroups) || submittedGroups.length === 0) return null;

  const tieBreakSeed = String(options?.tieBreakSeed || '');
  const groupedUids = getSubmittedGroupCardUids(submittedGroups);
  const ungroupedCards = cards.filter((card) => {
    const uid = String(card?.card_uid || '').trim();
    return uid && !groupedUids.has(uid);
  });

  let layoutGrouping = null;
  try {
    layoutGrouping = groupingService.evaluateSubmittedGrouping(cards, wildJoker, submittedGroups);
  } catch (_) {
    layoutGrouping = null;
  }
  const cardToLayoutMeta = new Map();
  (layoutGrouping?.groups || []).forEach((group) => {
    const type = String(group?.type || '');
    const cardsInGroup = Array.isArray(group?.cards) ? group.cards : [];
    const isInvalidSingle = type === 'invalid_single'
      || (group?.is_valid_meld !== true && cardsInGroup.length === 1);
    cardsInGroup.forEach((card) => {
      if (!card?.card_uid) return;
      cardToLayoutMeta.set(String(card.card_uid).trim(), {
        type,
        isInvalidSingle,
        groupPoints: Number(group?.group_points) || 0,
      });
    });
  });

  const candidates = [];
  const finishPool = ungroupedCards.length > 0 ? ungroupedCards : cards;
  const maxCandidates = Number.isFinite(Number(options?.maxCandidates))
    ? Math.max(1, Number(options.maxCandidates))
    : (options?.earlyExit === true ? 4 : finishPool.length);
  const earlyExitUtility = Number.isFinite(Number(options?.earlyExitUtility))
    ? Number(options.earlyExitUtility)
    : 1500;

  // Prefer likely leftovers first so earlyExit still finds a good finish card.
  const orderedPool = [...finishPool].sort((a, b) => {
    const aUid = String(a?.card_uid || '').trim();
    const bUid = String(b?.card_uid || '').trim();
    const aMeta = cardToLayoutMeta.get(aUid) || {};
    const bMeta = cardToLayoutMeta.get(bUid) || {};
    const aScore = (aMeta.isInvalidSingle ? 2000 : 0)
      + (ungroupedCards.some((c) => String(c?.card_uid || '').trim() === aUid) ? 1000 : 0)
      + getCardValue(a, wildJoker);
    const bScore = (bMeta.isInvalidSingle ? 2000 : 0)
      + (ungroupedCards.some((c) => String(c?.card_uid || '').trim() === bUid) ? 1000 : 0)
      + getCardValue(b, wildJoker);
    if (bScore !== aScore) return bScore - aScore;
    return aUid.localeCompare(bUid);
  }).slice(0, maxCandidates);

  for (const finishCard of orderedPool) {
    if (!finishCard?.card_uid) continue;
    const finishUid = String(finishCard.card_uid).trim();
    const nextHandCards = cards.filter((card) => String(card?.card_uid || '').trim() !== finishUid);
    if (nextHandCards.length !== DECLARE_HAND_CARD_COUNT) continue;

    let nextSubmittedGroups;
    try {
      nextSubmittedGroups = sanitizeSubmittedGroups(
        removeCardFromGroups(submittedGroups, finishUid),
        nextHandCards
      );
    } catch (_) {
      continue;
    }

    let nextGrouping;
    try {
      nextGrouping = groupingService.evaluateSubmittedGrouping(
        nextHandCards,
        wildJoker,
        nextSubmittedGroups
      );
    } catch (_) {
      continue;
    }

    if (nextGrouping?.summary?.valid_for_declare !== true) continue;

    const cardValue = getCardValue(finishCard, wildJoker);
    const isUngrouped = ungroupedCards.some(
      (card) => String(card?.card_uid || '').trim() === finishUid
    );
    const layoutMeta = cardToLayoutMeta.get(finishUid) || {};
    let utilityScore = isUngrouped ? 1500 : 0;
    if (layoutMeta.isInvalidSingle) utilityScore += 1450;
    else if (!isUngrouped && layoutMeta.groupPoints > 0) utilityScore += 900;
    utilityScore -= cardValue * 10;
    if (isCardIsolated(finishCard, cards, wildJoker)) utilityScore += 50;

    candidates.push({
      finishCard,
      nextHandCards,
      nextGrouping,
      nextSubmittedGroups,
      utilityScore,
      cardValue,
      isolated: isCardIsolated(finishCard, cards, wildJoker),
      fromType: isUngrouped ? 'ungrouped' : 'grouped',
      fromMeldSize: 1,
      seededTieRoll: tieBreakSeed
        ? deterministicRoll(tieBreakSeed, `finish:${finishUid}`)
        : 0,
    });

    if (options?.earlyExit === true && utilityScore >= earlyExitUtility) {
      break;
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (b.utilityScore !== a.utilityScore) return b.utilityScore - a.utilityScore;
    if (a.cardValue !== b.cardValue) return a.cardValue - b.cardValue;
    if (a.isolated !== b.isolated) return a.isolated ? -1 : 1;
    if (a.seededTieRoll !== b.seededTieRoll) return b.seededTieRoll - a.seededTieRoll;
    return String(a.finishCard?.card_uid || '').localeCompare(String(b.finishCard?.card_uid || ''));
  });

  const selected = candidates[0];
  return {
    finishCard: selected.finishCard,
    nextHandCards: selected.nextHandCards,
    submittedGroups: selected.nextSubmittedGroups,
    preview: selected.nextGrouping,
    explain: {
      utility_score: selected.utilityScore,
      from_group_type: selected.fromType,
      from_group_size: selected.fromMeldSize,
      card_value: selected.cardValue,
      isolated: selected.isolated,
      source: 'submitted_groups',
    },
  };
}

function tryBuildFinishPlan(cards = [], wildJoker = null, options = {}) {
  const fromSubmitted = tryBuildFinishPlanFromSubmittedGroups(cards, wildJoker, options);
  if (fromSubmitted) return fromSubmitted;

  const submittedGroups = options?.submittedGroups;
  if (Array.isArray(submittedGroups) && submittedGroups.length > 0) {
    // A player/autogroup layout exists but no valid finish from that layout.
    // Never substitute a hidden bot-best grouping — that auto-selects a finish card
    // the player does not see and leads to invalid declarations.
    return null;
  }

  return tryBuildBotFinishPlan(cards, wildJoker, options);
}

function buildFinishPlanCallbackExtras(finishPlan) {
  return {
    finish_card_suggestion: finishPlan?.finishCard || null,
    finish_plan: finishPlan
      ? {
        finish_card: finishPlan.finishCard,
        submitted_groups: finishPlan.submittedGroups,
        valid_for_declare_after_finish: finishPlan?.preview?.summary?.valid_for_declare === true,
      }
      : null,
  };
}

function resolveFinishPlanForPlayerHand(cards, wildJoker, submittedGroups, sessionId, userId, turnId) {
  if (!Array.isArray(cards) || cards.length !== FINISH_PLAN_HAND_CARD_COUNT) {
    return null;
  }
  const turnIdForSeed = Number(turnId) || 0;
  const decisionSeed = buildDecisionSeed(sessionId, turnIdForSeed, userId);
  return tryBuildFinishPlan(cards, wildJoker, {
    submittedGroups,
    groupingOptions: buildGroupingTieBreakOptions(decisionSeed),
    tieBreakSeed: decisionSeed,
    sessionId,
    userId,
    turnId: turnIdForSeed,
  });
}

function tryBuildBotFinishPlan(cards = [], wildJoker = null, options = {}) {
  if (!Array.isArray(cards) || cards.length !== FINISH_PLAN_HAND_CARD_COUNT) {
    return null;
  }
  const startedAtMs = Date.now();
  const evalBudgetMs = Number.isFinite(Number(options?.evalBudgetMs))
    ? Math.max(5, Number(options.evalBudgetMs))
    : BOT_FINISH_EVAL_BUDGET_MS;
  const maxCardsToTry = Number.isFinite(Number(options?.maxCardsToTry))
    ? Math.max(1, Math.min(14, Number(options.maxCardsToTry)))
    : BOT_FINISH_EVAL_MAX_CARDS;

  const groupingOptions = options?.groupingOptions || {};
  const tieBreakSeed = String(options?.tieBreakSeed || '');
  const currentGrouping = groupingService.buildBestGrouping(cards, wildJoker, groupingOptions);
  const preferredFinishUid = String(currentGrouping?.summary?.finish_card_uid || '').trim();
  const canFinishKnown = currentGrouping?.summary?.can_finish_after_one_discard === true;

  const cardToGroupMeta = new Map();
  (Array.isArray(currentGrouping?.groups) ? currentGrouping.groups : []).forEach((group) => {
    const groupCards = Array.isArray(group?.cards) ? group.cards : [];
    groupCards.forEach((card) => {
      if (!card?.card_uid) return;
      cardToGroupMeta.set(card.card_uid, {
        type: String(group?.type || ''),
        size: groupCards.length,
        isValidMeld: group?.is_valid_meld === true,
      });
    });
  });

  // Layout re-eval is only needed to rank leftovers; skip when grouping already named a finish card.
  const cardToLayoutMeta = new Map();
  if (!preferredFinishUid) {
    const currentSubmitted = toSubmittedGroupsFromGrouping(currentGrouping);
    let layoutGrouping = null;
    try {
      layoutGrouping = groupingService.evaluateSubmittedGrouping(cards, wildJoker, currentSubmitted);
    } catch (_) {
      layoutGrouping = null;
    }
    (layoutGrouping?.groups || []).forEach((group) => {
      const type = String(group?.type || '');
      const cardsInGroup = Array.isArray(group?.cards) ? group.cards : [];
      const isInvalidSingle = type === 'invalid_single'
        || (group?.is_valid_meld !== true && cardsInGroup.length === 1);
      cardsInGroup.forEach((card) => {
        if (!card?.card_uid) return;
        cardToLayoutMeta.set(String(card.card_uid).trim(), {
          type,
          isInvalidSingle,
          groupPoints: Number(group?.group_points) || 0,
        });
      });
    });
  }

  const scoreFinishCandidate = (finishCard, nextHandCards, nextGrouping) => {
    const meta = cardToGroupMeta.get(finishCard.card_uid) || {
      type: '',
      size: 1,
      isValidMeld: false,
    };
    const fromMeldSize = Number(meta.size) || 1;
    const fromValidMeld = meta.isValidMeld === true;
    const fromType = String(meta.type || '');
    const cardValue = getCardValue(finishCard, wildJoker);
    const isolated = isCardIsolated(finishCard, cards, wildJoker);
    const layoutMeta = cardToLayoutMeta.get(String(finishCard.card_uid || '').trim()) || {};

    // "Most useless card" heuristic:
    // - Prefer true leftovers / invalid singles from best-group layout.
    // - Prefer removing extra cards from oversized melds (4/5 cards) first.
    // - Avoid breaking minimal 3-card melds unless no other safe option.
    let utilityScore = 0;
    if (layoutMeta.isInvalidSingle) utilityScore += 1650;
    else if (!fromValidMeld) utilityScore += 1500;
    else if (layoutMeta.groupPoints > 0) utilityScore += 850;
    if (fromValidMeld && fromMeldSize > 3) utilityScore += (fromMeldSize - 3) * 80;
    if (fromValidMeld && fromMeldSize === 3) utilityScore -= 35;
    if (fromType === 'set' && fromMeldSize === 3) utilityScore -= 20;
    if (fromType === 'pure_sequence' && fromMeldSize === 3) utilityScore -= 12;
    utilityScore += cardValue * 6;
    if (isolated) utilityScore += 18;
    utilityScore += (Number(nextGrouping?.summary?.decision_margin) || 0) * 0.01;
    if (preferredFinishUid && String(finishCard.card_uid).trim() === preferredFinishUid) {
      utilityScore += 2000;
    }

    return {
      finishCard,
      nextHandCards,
      nextGrouping,
      utilityScore,
      cardValue,
      isolated,
      fromType,
      fromMeldSize,
      seededTieRoll: tieBreakSeed
        ? deterministicRoll(tieBreakSeed, `finish:${finishCard.card_uid}`)
        : 0,
    };
  };

  const tryFinishCard = (finishCard) => {
    if (!finishCard?.card_uid) return null;
    const finishIndex = cards.findIndex((card) => card?.card_uid === finishCard.card_uid);
    if (finishIndex < 0) return null;
    const nextHandCards = [...cards];
    nextHandCards.splice(finishIndex, 1);
    if (nextHandCards.length !== DECLARE_HAND_CARD_COUNT) return null;
    const nextGrouping = groupingService.buildBestGrouping(
      nextHandCards,
      wildJoker,
      groupingOptions
    );
    if (nextGrouping?.summary?.valid_for_declare !== true) return null;
    return scoreFinishCandidate(finishCard, nextHandCards, nextGrouping);
  };

  // Fast path: grouping already proved a finish card — validate only that card.
  if (canFinishKnown && preferredFinishUid) {
    const preferredCard = cards.find(
      (card) => String(card?.card_uid || '').trim() === preferredFinishUid
    );
    const preferredCandidate = tryFinishCard(preferredCard);
    if (preferredCandidate) {
      const evalMs = Date.now() - startedAtMs;
      if (evalMs >= BOT_FINISH_EVAL_WARN_MS) {
        warnGame(
          options?.sessionId || 'finish_plan',
          `Finish evaluation slow — uid=${options?.userId || 'unknown'} turn=${options?.turnId || 'na'} ` +
          `candidates=1 earlyStop=true evalMs=${evalMs}`
        );
      }
      if (BOT_FINISH_DEBUG_LOG_ENABLED) {
        logGame(
          options?.sessionId || 'finish_plan',
          `Finish selected uid=${options?.userId || 'unknown'} turn=${options?.turnId || 'na'} ` +
          `card=${preferredCandidate.finishCard?.card_uid || 'na'} candidates=1 ` +
          `earlyStop=true evalMs=${evalMs}`
        );
      }
      return {
        finishCard: preferredCandidate.finishCard,
        nextHandCards: preferredCandidate.nextHandCards,
        submittedGroups: toSubmittedGroupsFromGrouping(preferredCandidate.nextGrouping),
        preview: preferredCandidate.nextGrouping,
        explain: {
          utility_score: preferredCandidate.utilityScore,
          from_group_type: preferredCandidate.fromType,
          from_group_size: preferredCandidate.fromMeldSize,
          card_value: preferredCandidate.cardValue,
          isolated: preferredCandidate.isolated,
          early_stop: true,
          source: 'grouping_finish_uid',
        },
      };
    }
  }

  // Grouping already ran finish-ready detection and found nothing. A full 14-card
  // re-scan here used to burn 200–500ms for a guaranteed miss — bail immediately.
  if (!canFinishKnown) {
    const evalMs = Date.now() - startedAtMs;
    if (evalMs >= BOT_FINISH_EVAL_WARN_MS) {
      warnGame(
        options?.sessionId || 'finish_plan',
        `Finish evaluation slow (no candidate) — uid=${options?.userId || 'unknown'} ` +
        `turn=${options?.turnId || 'na'} evalMs=${evalMs}`
      );
    }
    return null;
  }

  // Try likely finish cards first so a hard CPU budget still finds a valid declare path.
  const cardsToTry = [...cards].sort((a, b) => {
    const aUid = String(a?.card_uid || '').trim();
    const bUid = String(b?.card_uid || '').trim();
    if (preferredFinishUid) {
      if (aUid === preferredFinishUid && bUid !== preferredFinishUid) return -1;
      if (bUid === preferredFinishUid && aUid !== preferredFinishUid) return 1;
    }
    const aLayout = cardToLayoutMeta.get(aUid) || {};
    const bLayout = cardToLayoutMeta.get(bUid) || {};
    const aMeta = cardToGroupMeta.get(a?.card_uid) || {};
    const bMeta = cardToGroupMeta.get(b?.card_uid) || {};
    const aScore = (aLayout.isInvalidSingle ? 3000 : 0)
      + (!aMeta.isValidMeld ? 2000 : 0)
      + (Number(aMeta.size) > 3 ? (Number(aMeta.size) - 3) * 100 : 0)
      + getCardValue(a, wildJoker);
    const bScore = (bLayout.isInvalidSingle ? 3000 : 0)
      + (!bMeta.isValidMeld ? 2000 : 0)
      + (Number(bMeta.size) > 3 ? (Number(bMeta.size) - 3) * 100 : 0)
      + getCardValue(b, wildJoker);
    if (bScore !== aScore) return bScore - aScore;
    return aUid.localeCompare(bUid);
  }).slice(0, maxCardsToTry);

  const safeCandidates = [];
  let stoppedEarly = false;
  let cardsTried = 0;
  for (const finishCard of cardsToTry) {
    // Hard budget: always stop, even with zero candidates (bot discards normally).
    if ((Date.now() - startedAtMs) >= evalBudgetMs) {
      stoppedEarly = true;
      break;
    }
    cardsTried += 1;
    const candidate = tryFinishCard(finishCard);
    if (!candidate) continue;
    safeCandidates.push(candidate);

    if (
      candidate.utilityScore >= BOT_FINISH_EARLY_EXIT_UTILITY
      || canFinishKnown
      || (Date.now() - startedAtMs) >= evalBudgetMs
    ) {
      stoppedEarly = true;
      break;
    }
  }

  if (safeCandidates.length === 0) {
    const evalMs = Date.now() - startedAtMs;
    if (currentGrouping?.summary?.valid_for_declare === true) {
      warnGame(
        options?.sessionId || 'finish_plan',
        `Finish plan missing despite valid grouping — uid=${options?.userId || 'unknown'} ` +
        `turn=${options?.turnId || 'na'} cards=${cards.length} tried=${cardsTried} evalMs=${evalMs}`
      );
    }
    if (evalMs >= BOT_FINISH_EVAL_WARN_MS) {
      warnGame(
        options?.sessionId || 'finish_plan',
        `Finish evaluation slow (no candidate) — uid=${options?.userId || 'unknown'} ` +
        `turn=${options?.turnId || 'na'} tried=${cardsTried} earlyStop=${stoppedEarly} evalMs=${evalMs}`
      );
    }
    return null;
  }

  safeCandidates.sort((a, b) => {
    if (b.utilityScore !== a.utilityScore) return b.utilityScore - a.utilityScore;
    if (b.fromMeldSize !== a.fromMeldSize) return b.fromMeldSize - a.fromMeldSize;
    if (b.cardValue !== a.cardValue) return b.cardValue - a.cardValue;
    if (a.isolated !== b.isolated) return a.isolated ? -1 : 1;
    if (a.seededTieRoll !== b.seededTieRoll) return b.seededTieRoll - a.seededTieRoll;
    return String(a.finishCard?.card_uid || '').localeCompare(String(b.finishCard?.card_uid || ''));
  });

  const selected = safeCandidates[0];
  const submittedGroups = toSubmittedGroupsFromGrouping(selected.nextGrouping);
  const evalMs = Date.now() - startedAtMs;
  if (evalMs >= BOT_FINISH_EVAL_WARN_MS) {
    warnGame(
      options?.sessionId || 'finish_plan',
      `Finish evaluation slow — uid=${options?.userId || 'unknown'} turn=${options?.turnId || 'na'} ` +
      `candidates=${safeCandidates.length} tried=${cardsTried} earlyStop=${stoppedEarly} evalMs=${evalMs}`
    );
  }
  if (BOT_FINISH_DEBUG_LOG_ENABLED) {
    logGame(
      options?.sessionId || 'finish_plan',
      `Finish selected uid=${options?.userId || 'unknown'} turn=${options?.turnId || 'na'} ` +
      `card=${selected.finishCard?.card_uid || 'na'} candidates=${safeCandidates.length} ` +
      `tried=${cardsTried} earlyStop=${stoppedEarly} evalMs=${evalMs}`
    );
  }
  return {
    finishCard: selected.finishCard,
    nextHandCards: selected.nextHandCards,
    submittedGroups,
    preview: selected.nextGrouping,
    explain: {
      utility_score: selected.utilityScore,
      from_group_type: selected.fromType,
      from_group_size: selected.fromMeldSize,
      card_value: selected.cardValue,
      isolated: selected.isolated,
      early_stop: stoppedEarly,
    },
  };
}

function toSubmittedGroupsFromGrouping(grouping = {}) {
  const groups = Array.isArray(grouping?.groups) ? grouping.groups : [];
  return groups
    .map((group, idx) => {
      const cards = Array.isArray(group?.cards)
        ? group.cards.map((card) => card?.card_uid).filter(Boolean)
        : [];
      if (cards.length === 0) return null;
      return {
        group_id: group?.group_id || idx + 1,
        cards,
      };
    })
    .filter(Boolean);
}

function randomIntBetween(minInclusive, maxInclusive) {
  const min = Math.ceil(minInclusive);
  const max = Math.floor(maxInclusive);
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function resolveBotActionDelayMs(turn, options = {}) {
  if (BOT_ACTION_DELAY_MS > 0) {
    return BOT_ACTION_DELAY_MS;
  }

  const cfgMin = Math.min(BOT_ACTION_DELAY_MIN_MS, BOT_ACTION_DELAY_MAX_MS);
  const cfgMax = Math.max(BOT_ACTION_DELAY_MIN_MS, BOT_ACTION_DELAY_MAX_MS);
  const randomizedDelay = randomIntBetween(cfgMin, cfgMax);
  const startedAtTs = Date.parse(turn?.started_at || '');
  const startDelayMs = Number.isNaN(startedAtTs) ? 0 : Math.max(0, startedAtTs - Date.now());

  const endsAtTs = Date.parse(turn?.ends_at || '');
  if (Number.isNaN(endsAtTs)) return startDelayMs + randomizedDelay;

  const remainingMs = endsAtTs - Date.now();
  const isBonusTurn = String(turn?.type || '').toLowerCase() === 'bonus';
  const discardReserveMs = options?.phase === 'pick'
    ? BOT_POST_PICK_DELAY_MAX_MS + 1200
    : 0;
  const safeRemaining = Math.max(250, remainingMs - 350 - discardReserveMs);
  let finalDelay = Math.max(250, Math.min(startDelayMs + randomizedDelay, safeRemaining));
  if (isBonusTurn) {
    finalDelay = Math.min(finalDelay, Math.max(250, safeRemaining * 0.45));
  }
  if (options?.aggressiveEnabled === true) {
    const aggressiveMultiplier = BOT_AGGRESSIVE_PICK_DELAY_MIN_MULTIPLIER
      + (Math.random() * (BOT_AGGRESSIVE_PICK_DELAY_MAX_MULTIPLIER - BOT_AGGRESSIVE_PICK_DELAY_MIN_MULTIPLIER));
    finalDelay = Math.max(250, Math.floor(finalDelay * aggressiveMultiplier));
  }
  if (options?.softRiggingEnabled === true) {
    const multiplier = BOT_SOFT_RIGGING_MIN_PICK_MULTIPLIER
      + (Math.random() * (BOT_SOFT_RIGGING_MAX_PICK_MULTIPLIER - BOT_SOFT_RIGGING_MIN_PICK_MULTIPLIER));
    finalDelay = Math.max(250, Math.floor(finalDelay * multiplier));
  }

  return finalDelay;
}

function resolveBotDiscardDelayMs(turn, options = {}) {
  if (BOT_POST_PICK_DELAY_MS > 0) {
    return BOT_POST_PICK_DELAY_MS;
  }

  const cfgMin = Math.min(BOT_POST_PICK_DELAY_MIN_MS, BOT_POST_PICK_DELAY_MAX_MS);
  const cfgMax = Math.max(BOT_POST_PICK_DELAY_MIN_MS, BOT_POST_PICK_DELAY_MAX_MS);
  let randomizedDelay = randomIntBetween(cfgMin, cfgMax);

  const endsAtTs = Date.parse(turn?.ends_at || '');
  if (Number.isNaN(endsAtTs)) return randomizedDelay;

  const remainingMs = endsAtTs - Date.now();
  const turnExpiryBufferMs = 800;
  // Never schedule past the turn clock (old Math.max(cfgMin, remaining) could push
  // discard 2s+ after ends_at when little time remained — looked like "bot after timer").
  const maxDelay = Math.max(250, remainingMs - turnExpiryBufferMs);
  let finalDelay = Math.min(randomizedDelay, maxDelay);

  // Soft rigging may shorten discard slightly, but keep human-plausible pacing.
  if (options?.softRiggingEnabled === true) {
    const multiplier = BOT_SOFT_RIGGING_MIN_DISCARD_MULTIPLIER
      + (Math.random() * (BOT_SOFT_RIGGING_MAX_DISCARD_MULTIPLIER - BOT_SOFT_RIGGING_MIN_DISCARD_MULTIPLIER));
    finalDelay = Math.floor(finalDelay * multiplier);
  }

  // Human think-time before discard — do not apply aggressive speed multipliers here.
  const urgencyMs = 1500;
  if (remainingMs > urgencyMs && maxDelay >= cfgMin) {
    finalDelay = Math.max(cfgMin, Math.min(finalDelay, maxDelay));
  } else {
    finalDelay = Math.max(250, Math.min(finalDelay, maxDelay));
  }

  return finalDelay;
}

function isBotAggressionEnabled(session = {}) {
  if (session?.metadata?.bot_aggression_enabled === false) return false;
  return BOT_AGGRESSION_ENABLED;
}

function resolveProjectedDropLoss(summary = {}) {
  const ungroupedPoints = Number(summary.ungrouped_points) || 0;
  return Math.min(80, Math.max(0, Number(summary.display_point) || ungroupedPoints || 0));
}

function isHopelessHandForDrop(summary = {}, turnId = 0) {
  if (Number(turnId) < BOT_HOPELESS_TURN_MIN) return false;
  const pureCount = Number(summary.pure_sequence_count) || 0;
  const sequenceCount = Number(summary.sequence_count) || 0;
  if (pureCount > 0) return false;
  if (sequenceCount >= 2) return false;
  return resolveProjectedDropLoss(summary) >= BOT_HOPELESS_DISPLAY_POINT;
}

function doesStructureBlockStrategicDrop(summary = {}) {
  const pureCount = Number(summary.pure_sequence_count) || 0;
  const sequenceCount = Number(summary.sequence_count) || 0;
  const groupedCardsCount = Number(summary.grouped_cards_count) || 0;
  const ungroupedPoints = Number(summary.ungrouped_points) || 0;

  if (pureCount >= 1 && ungroupedPoints <= BOT_STRUCTURE_BLOCK_UNGROUPED_MAX) return true;
  if (sequenceCount >= 2 && ungroupedPoints <= BOT_STRUCTURE_BLOCK_UNGROUPED_MAX) return true;
  if (groupedCardsCount >= 9 && ungroupedPoints <= 25) return true;
  return false;
}

function resolveStrategicDropBenefitThreshold(summary = {}, turnId = 0) {
  if (isHopelessHandForDrop(summary, turnId)) {
    return BOT_HOPELESS_DROP_BENEFIT_MIN;
  }
  return BOT_DROP_BENEFIT_THRESHOLD;
}

function canMeaningfullyImproveWithPickedCard(handCards = [], pickedCard = null, wildJoker = null) {
  if (!pickedCard?.card_uid) return false;
  const before = groupingService.buildBestGrouping(handCards, wildJoker);
  const after = groupingService.buildBestGrouping([...handCards, pickedCard], wildJoker);
  const beforeSummary = before?.summary || {};
  const afterSummary = after?.summary || {};

  if (afterSummary.valid_for_declare === true) return true;

  const pureDelta = (Number(afterSummary.pure_sequence_count) || 0)
    - (Number(beforeSummary.pure_sequence_count) || 0);
  if (pureDelta > 0) return true;

  const ungroupedReduction = (Number(beforeSummary.ungrouped_points) || 0)
    - (Number(afterSummary.ungrouped_points) || 0);
  if (ungroupedReduction >= BOT_EARLY_DROP_MEANINGFUL_UNGROUPED_REDUCTION) return true;

  const sequenceDelta = (Number(afterSummary.sequence_count) || 0)
    - (Number(beforeSummary.sequence_count) || 0);
  if (sequenceDelta > 0 && ungroupedReduction >= 6) return true;

  return false;
}

function shouldBotStrategicallyDrop(session, userId, cards = [], wildJoker = null, options = {}) {
  if (BOT_STRATEGIC_DROP_ENABLED !== true) return false;
  const mode = resolveSessionGameMode(session);
  if (!['pool', 'points'].includes(mode)) return false;
  if (isDealLikeMode(mode)) return false;
  if (!Array.isArray(cards) || cards.length === 0) return false;
  if (isBotPoolDropBlockedByScore(session, userId)) return false;
  // Points: never middle-drop (company loss). First-drop only when still eligible.
  if (mode === 'points' && !isFirstDropEligible(options?.playerDistribution)) {
    return false;
  }

  const playContext = buildBotPlayContext(session, userId);
  const turnId = Number(options?.turn?.turn_id) || 0;
  const isDeadHand = !hasAnyValidMeld(cards, wildJoker);
  if (turnId > 0 && turnId < BOT_STRATEGIC_DROP_EARLY_TURN_GATE && !isDeadHand) return false;

  const groupingOptions = buildGroupingTieBreakOptions(options?.decisionSeed);
  const grouping = groupingService.buildBestGrouping(cards, wildJoker, groupingOptions);
  const summary = grouping?.summary || {};
  // Prefer summary finish flag on 14-card hands; avoid a second O(n) finish scan.
  if (
    summary.can_finish_after_one_discard === true
    || summary.valid_for_declare === true
    || (
      Array.isArray(cards)
      && cards.length !== 14
      && canFinishAfterOneDiscard(cards, wildJoker, { groupingOptions })
    )
  ) {
    return false;
  }
  if (BOT_CONSERVATIVE_PLAY_ON_LOW_CONFIDENCE && isLowConfidenceGrouping(summary)) return false;

  const hopeless = isHopelessHandForDrop(summary, turnId);
  if (!hopeless && doesStructureBlockStrategicDrop(summary)) return false;

  const projectedLoss = resolveProjectedDropLoss(summary);
  const dropLoss = Number(resolveDropLossPoints(session, userId));
  if (!Number.isFinite(dropLoss)) return false;

  if (mode === 'pool') {
    const scoreHeadroom = playContext.scoreHeadroom;
    const currentPoolScore = playContext.currentPoolScore;
    const nearElimination = scoreHeadroom <= BOT_POOL_NEAR_ELIMINATION_HEADROOM;
    const highCumulativeScore = currentPoolScore >= BOT_POOL_HIGH_SCORE_DROP_AT;
    // Plenty of pool buffer and low cumulative score: play the deal out.
    if (!nearElimination && !highCumulativeScore && scoreHeadroom > BOT_POOL_COMFORTABLE_HEADROOM) {
      return false;
    }
    if (!hopeless && !highCumulativeScore && currentPoolScore < 30 && projectedLoss < 65) return false;
    if (!hopeless && !highCumulativeScore && scoreHeadroom > (dropLoss + 18) && projectedLoss < 55) {
      return false;
    }
    // Hopeless fold only when near elimination (unless cumulative score is already high).
    if (hopeless && !highCumulativeScore && scoreHeadroom > BOT_POOL_NEAR_ELIMINATION_HEADROOM) {
      return false;
    }
  }

  if (mode === 'points' && !hopeless && playContext.playToWin && projectedLoss < 52) {
    return false;
  }

  const benefit = projectedLoss - dropLoss;
  const benefitThreshold = resolveStrategicDropBenefitThreshold(summary, turnId);
  if (benefit < benefitThreshold) return false;

  const maxProbability = mode === 'pool'
    ? BOT_POOL_STRATEGIC_DROP_MAX_PROBABILITY
    : BOT_STRATEGIC_DROP_MAX_PROBABILITY;
  const poolScoreBoost = mode === 'pool' && playContext.currentPoolScore >= BOT_POOL_HIGH_SCORE_DROP_AT
    ? 0.18
    : 0;
  const confidence = hopeless
    ? Math.min(maxProbability + poolScoreBoost, Math.max(0.12, benefit / 120) + poolScoreBoost)
    : Math.min((maxProbability * 0.75) + poolScoreBoost, Math.max(0.08, benefit / 140) + poolScoreBoost);
  const seededRoll = Number(options?.seededRoll);
  if (Number.isFinite(seededRoll)) return seededRoll < confidence;
  return Math.random() < confidence;
}

function buildStrategicDropExplainability(session, userId, cards = [], wildJoker = null, options = {}) {
  const mode = resolveSessionGameMode(session);
  const turnId = Number(options?.turn?.turn_id) || 0;
  const turnWindowOk = !(turnId > 0 && turnId < BOT_STRATEGIC_DROP_EARLY_TURN_GATE);

  const grouping = groupingService.buildBestGrouping(cards, wildJoker, buildGroupingTieBreakOptions(options?.decisionSeed));
  const summary = grouping?.summary || {};
  const hopeless = isHopelessHandForDrop(summary, turnId);
  const projectedLoss = resolveProjectedDropLoss(summary);
  const dropLoss = Number(resolveDropLossPoints(session, userId));
  const benefit = projectedLoss - dropLoss;
  const benefitThreshold = resolveStrategicDropBenefitThreshold(summary, turnId);
  const structureBlocksDrop = !hopeless && doesStructureBlockStrategicDrop(summary);

  let poolScoreHeadroom = null;
  let poolHeadroomGateOk = true;
  if (mode === 'pool' && Number.isFinite(dropLoss)) {
    const poolLimit = resolvePoolLimit(session);
    const scoresByUser = session?.metadata?.pool_scores_by_user || {};
    const currentScore = Number(scoresByUser[String(userId)]) || 0;
    const safePoolLimit = Number.isFinite(poolLimit) ? poolLimit : 101;
    poolScoreHeadroom = safePoolLimit - currentScore;
    poolHeadroomGateOk = hopeless || projectedLoss >= 40 || poolScoreHeadroom <= (dropLoss + 12);
  }

  return {
    mode,
    turn_id: turnId,
    policy_flag_on: BOT_STRATEGIC_DROP_ENABLED === true,
    mode_ok: ['pool', 'points'].includes(mode),
    turn_window_ok: turnWindowOk,
    has_picked_in_deal: options?.playerDistribution?.has_picked === true,
    first_turn_cycle_complete: options?.playerDistribution?.first_turn_cycle_complete === true,
    is_first_drop_eligible: isFirstDropEligible(options?.playerDistribution),
    can_finish_after_one_discard: canFinishAfterOneDiscard(cards, wildJoker),
    hand_summary: compactGroupingSummary(summary),
    grouping_confidence: Number(summary.grouping_confidence),
    decision_margin: Number(summary.decision_margin),
    alternative_count: Number(summary.alternative_count),
    low_confidence: isLowConfidenceGrouping(summary),
    valid_for_declare: summary.valid_for_declare === true,
    hopeless_hand: hopeless,
    structure_blocks_drop: structureBlocksDrop,
    sequence_count: Number(summary.sequence_count) || 0,
    pure_sequence_count: Number(summary.pure_sequence_count) || 0,
    grouped_cards_count: Number(summary.grouped_cards_count) || 0,
    ungrouped_points: Number(summary.ungrouped_points) || 0,
    projected_loss: projectedLoss,
    drop_loss: Number.isFinite(dropLoss) ? dropLoss : null,
    benefit,
    benefit_threshold: benefitThreshold,
    benefit_ok: benefit >= benefitThreshold,
    pool_score_headroom: poolScoreHeadroom,
    pool_near_elim_gate_ok: poolHeadroomGateOk,
  };
}

function hasAnyValidMeld(cards = [], wildJoker = null) {
  const grouping = groupingService.buildBestGrouping(cards, wildJoker);
  const groups = Array.isArray(grouping?.groups) ? grouping.groups : [];
  return groups.some((group) => (
    group?.is_valid_meld === true
    && ['pure_sequence', 'impure_sequence', 'set'].includes(String(group?.type || ''))
  ));
}

function canCreateAnyMeldWithPickedCard(handCards = [], pickedCard = null, wildJoker = null) {
  if (!pickedCard?.card_uid) return false;
  const nextHand = [...handCards, pickedCard];
  return hasAnyValidMeld(nextHand, wildJoker);
}

function shouldBotTakeEarlyDrop(session, userId, handCards = [], distribution = null, wildJoker = null) {
  if (BOT_EARLY_DROP_DEAD_HAND_ENABLED !== true) return false;
  if (!Array.isArray(handCards) || handCards.length === 0) return false;
  if (!distribution) return false;

  const mode = resolveSessionGameMode(session);
  if (!['pool', 'points'].includes(mode)) return false;
  if (isDealLikeMode(mode)) return false;
  if (isBotPoolDropBlockedByScore(session, userId)) return false;

  const playerDistribution = getPlayerDistribution(distribution, userId);
  // Points: never middle-drop. Pool: also respect first/middle eligibility for block score.
  if (mode === 'points' && !isFirstDropEligible(playerDistribution)) {
    return false;
  }
  // Pool: block any drop (first or middle) once score threshold is reached — already covered
  // by isBotPoolDropBlockedByScore above.

  const playContext = buildBotPlayContext(session, userId);
  if (mode === 'pool' && playContext.scoreHeadroom > BOT_POOL_COMFORTABLE_HEADROOM) {
    return false;
  }

  // If bot already has any valid meld structure, continue.
  if (hasAnyValidMeld(handCards, wildJoker)) return false;

  const discardTop = Array.isArray(distribution?.discard_pile) ? distribution.discard_pile[0] : null;
  if (canMeaningfullyImproveWithPickedCard(handCards, discardTop, wildJoker)) {
    return false;
  }

  const closedDeck = Array.isArray(distribution?.closed_deck) ? distribution.closed_deck : [];
  const hasClosedPotential = closedDeck.some((card) =>
    canMeaningfullyImproveWithPickedCard(handCards, card, wildJoker));
  if (hasClosedPotential) return false;

  const projectedGrouping = groupingService.buildBestGrouping(handCards, wildJoker);
  if (BOT_CONSERVATIVE_PLAY_ON_LOW_CONFIDENCE && isLowConfidenceGrouping(projectedGrouping?.summary || {})) {
    return false;
  }
  const projectedLoss = resolveProjectedDropLoss(projectedGrouping?.summary || {});
  const dropLoss = Number(resolveDropLossPoints(session, userId));
  if (!Number.isFinite(dropLoss)) return false;

  // First-drop only when dead hand and continuing is clearly worse than folding.
  return projectedLoss >= (dropLoss + BOT_EARLY_DROP_MIN_MARGIN);
}

function buildEarlyDropExplainability(session, userId, handCards = [], distribution, wildJoker = null) {
  const mode = resolveSessionGameMode(session);
  const playContext = buildBotPlayContext(session, userId);
  const projectedGrouping = groupingService.buildBestGrouping(handCards, wildJoker);
  const projectedLoss = resolveProjectedDropLoss(projectedGrouping?.summary || {});
  const dropLoss = Number(resolveDropLossPoints(session, userId));
  const discardTop = Array.isArray(distribution?.discard_pile) ? distribution.discard_pile[0] : null;
  const closedDeck = Array.isArray(distribution?.closed_deck) ? distribution.closed_deck : [];

  return {
    policy_flag_on: BOT_EARLY_DROP_DEAD_HAND_ENABLED === true,
    mode,
    hand_summary: compactGroupingSummary(projectedGrouping?.summary || {}),
    grouping_confidence: Number(projectedGrouping?.summary?.grouping_confidence),
    decision_margin: Number(projectedGrouping?.summary?.decision_margin),
    alternative_count: Number(projectedGrouping?.summary?.alternative_count),
    low_confidence: isLowConfidenceGrouping(projectedGrouping?.summary || {}),
    has_any_valid_meld: hasAnyValidMeld(handCards, wildJoker),
    open_pick_would_create_meld: discardTop
      ? canMeaningfullyImproveWithPickedCard(handCards, discardTop, wildJoker)
      : false,
    closed_has_potential_meld: closedDeck.some((card) =>
      canMeaningfullyImproveWithPickedCard(handCards, card, wildJoker)),
    projected_loss: projectedLoss,
    drop_loss: Number.isFinite(dropLoss) ? dropLoss : null,
    passes_dead_hand_margin: Number.isFinite(dropLoss)
      ? projectedLoss >= (dropLoss + BOT_EARLY_DROP_MIN_MARGIN)
      : false,
    play_context: playContext,
  };
}

function getPlayerDistribution(distribution, userId) {
  const players = Array.isArray(distribution?.players) ? distribution.players : [];
  const uid = Number(userId);
  if (!Number.isNaN(uid)) {
    const byNumber = players.find((pd) => Number(pd?.user_id) === uid);
    if (byNumber) return byNumber;
  }
  // Fallback for non-numeric ids (should not happen in production seats).
  return players.find((pd) => pd?.user_id === userId) || null;
}

/**
 * Number-safe lookup into declare response Map (keys may be number or string).
 */
function getDeclareResponseEntry(responses, userId) {
  if (!responses || typeof responses.get !== 'function') return null;
  if (responses.has(userId)) return responses.get(userId) || null;
  const uid = Number(userId);
  if (!Number.isNaN(uid) && responses.has(uid)) return responses.get(uid) || null;
  const asString = String(userId);
  if (responses.has(asString)) return responses.get(asString) || null;
  if (typeof responses.entries === 'function') {
    for (const [key, value] of responses.entries()) {
      if (Number(key) === uid && !Number.isNaN(uid)) return value || null;
    }
  }
  return null;
}

function hasDeclareResponseEntry(responses, userId) {
  return getDeclareResponseEntry(responses, userId) != null;
}

/**
 * Resolve declarer validity for finalize without false wrong-shows from desync.
 *
 * Rules (safe / product-preserving):
 * 1. Prefer in-memory declare response groups when they evaluate cleanly.
 * 2. If response is missing/empty/throws (UID drift), try distribution.submitted_groups.
 * 3. Only when response was missing/empty/threw — rescue via buildBestGrouping if
 *    the hand is declare-ready (covers lost bot/human finish snapshots).
 * 4. Never rescue an explicitly submitted invalid layout with best-grouping.
 * 5. On confirmed invalid, prefer showing the submitted/stored layout (not a
 *    silent best-grouping that looks legal on the result screen).
 */
function resolveDeclarerGroupingForFinalize({
  cards = [],
  wildJoker = null,
  responseGroups = null,
  storedGroups = null,
  sessionId = null,
  declarerUserId = null,
} = {}) {
  const handCards = Array.isArray(cards) ? cards : [];

  const tryEval = (groups, source) => {
    const coerced = coerceSubmittedGroupsForHand(groups, handCards);
    if (!coerced.length) {
      return { grouping: null, source, threw: false, empty: true };
    }
    try {
      const grouping = groupingService.evaluateSubmittedGrouping(
        handCards,
        wildJoker,
        coerced
      );
      return { grouping, source, threw: false, empty: false };
    } catch (err) {
      return {
        grouping: null,
        source,
        threw: true,
        empty: false,
        error: err,
      };
    }
  };

  const responseList = Array.isArray(responseGroups) ? responseGroups : [];
  const primary = tryEval(responseList, 'response');
  if (primary.grouping?.summary?.valid_for_declare === true) {
    return {
      grouping: primary.grouping,
      valid: true,
      source: 'response',
      displayIsOptimisticBest: false,
    };
  }

  // Explicit, evaluable wrong layout → real wrong-show. Do not rescue.
  const primaryExplicitInvalid = responseList.length > 0
    && primary.threw !== true
    && primary.grouping != null
    && primary.grouping?.summary?.valid_for_declare !== true;

  if (primaryExplicitInvalid) {
    return {
      grouping: primary.grouping,
      valid: false,
      source: 'response_invalid',
      displayIsOptimisticBest: false,
    };
  }

  const allowRescue = responseList.length === 0
    || primary.threw === true
    || primary.empty === true
    || primary.grouping == null;

  if (allowRescue) {
    const stored = tryEval(storedGroups, 'stored');
    if (stored.grouping?.summary?.valid_for_declare === true) {
      if (sessionId != null) {
        logGame(
          sessionId,
          `Declarer uid=${declarerUserId} recovered valid layout from stored submitted_groups ` +
          `(response missing/stale)`
        );
      }
      return {
        grouping: stored.grouping,
        valid: true,
        source: 'stored',
        displayIsOptimisticBest: false,
      };
    }

    try {
      const best = groupingService.buildBestGrouping(handCards, wildJoker);
      if (best?.summary?.valid_for_declare === true) {
        if (sessionId != null) {
          logGame(
            sessionId,
            `Declarer uid=${declarerUserId} recovered valid layout from best grouping ` +
            `(response missing/stale; hand declare-ready)`
          );
        }
        return {
          grouping: best,
          valid: true,
          source: 'best_rescue',
          displayIsOptimisticBest: false,
        };
      }
    } catch (_) {
      // fall through to invalid
    }

    if (stored.grouping) {
      return {
        grouping: {
          ...stored.grouping,
          summary: {
            ...(stored.grouping.summary || {}),
            valid_for_declare: false,
          },
        },
        valid: false,
        source: stored.threw ? 'stored_unresolved' : 'stored_invalid',
        displayIsOptimisticBest: false,
      };
    }
  }

  if (primary.threw && sessionId != null) {
    warnGame(
      sessionId,
      `Declarer grouping unresolved uid=${declarerUserId} (${primary.error?.message || 'error'}) ` +
      `— treating as invalid declaration`
    );
  }

  // Confirmed invalid / unrecoverable — avoid optimistic best layout for display.
  if (primary.grouping) {
    return {
      grouping: primary.grouping,
      valid: false,
      source: 'response_invalid',
      displayIsOptimisticBest: false,
    };
  }

  try {
    const best = groupingService.buildBestGrouping(handCards, wildJoker);
    return {
      grouping: best?.summary
        ? { ...best, summary: { ...best.summary, valid_for_declare: false } }
        : { summary: { valid_for_declare: false } },
      valid: false,
      source: 'best_forced_invalid',
      // Caller must not present this as the player's declared layout.
      displayIsOptimisticBest: true,
    };
  } catch (_) {
    return {
      grouping: { summary: { valid_for_declare: false } },
      valid: false,
      source: 'empty_invalid',
      displayIsOptimisticBest: false,
    };
  }
}

/**
 * Prefer submitted/stored layout on result screens; never throw.
 * When allowBestFallback is false (invalid declarer), do not silently replace
 * a failed layout with buildBestGrouping — that made wrong-shows look legal.
 */
function resolveResultHandGrouping(playerCards, wildJoker, groups = null, options = {}) {
  const handCards = Array.isArray(playerCards) ? playerCards : [];
  const allowBestFallback = options?.allowBestFallback !== false;
  const coerced = coerceSubmittedGroupsForHand(groups, handCards);
  if (coerced.length > 0) {
    try {
      return groupingService.evaluateSubmittedGrouping(handCards, wildJoker, coerced);
    } catch (_) {
      // Fall through.
    }
  }
  if (!allowBestFallback) {
    // Keep coerced groups visible even when melds are invalid / partial.
    if (coerced.length > 0) {
      try {
        // Re-run after coerce may still throw on duplicates; build a minimal display.
        return {
          groups: coerced.map((group, idx) => ({
            group_id: group.group_id || idx + 1,
            type: 'invalid_mixed',
            cards: (group.cards || [])
              .map((uid) => handCards.find((c) => c?.card_uid === uid))
              .filter(Boolean),
            group_points: 0,
            is_valid_meld: false,
          })),
          ungrouped_cards: handCards.filter(
            (c) => !coerced.some((g) => (g.cards || []).includes(c?.card_uid))
          ),
          summary: {
            valid_for_declare: false,
            all_cards_grouped: false,
            invalid_group_count: coerced.length,
          },
        };
      } catch (_) {
        return null;
      }
    }
    return null;
  }
  try {
    return groupingService.buildBestGrouping(handCards, wildJoker);
  } catch (_) {
    return null;
  }
}

function hasTurnStarted(turn) {
  const startedAtTs = Date.parse(turn?.started_at || '');
  if (Number.isNaN(startedAtTs)) return true;
  return startedAtTs <= Date.now();
}

function assertTurnStarted(turn) {
  if (!hasTurnStarted(turn)) {
    throw new Error('Turn has not started yet');
  }
}

function sanitizeSubmittedGroups(groups, handCards) {
  if (!Array.isArray(groups)) return [];

  const handCardIds = new Set((handCards || []).map((card) => card.card_uid));
  const used = new Set();

  return groups
    .map((group, idx) => {
      const rawCards = Array.isArray(group?.cards) ? group.cards : [];
      const cardIds = rawCards
        .map((card) => (typeof card === 'string' ? card : card?.card_uid))
        .filter(Boolean);

      if (cardIds.length === 0) return null;

      cardIds.forEach((cardId) => {
        if (!handCardIds.has(cardId)) {
          throw new Error(`Submitted card ${cardId} does not belong to your hand`);
        }
        if (used.has(cardId)) {
          throw new Error(`Duplicate submitted card ${cardId}`);
        }
        used.add(cardId);
      });

      return {
        group_id: group?.group_id || idx + 1,
        cards: cardIds,
      };
    })
    .filter(Boolean);
}

/**
 * Display-only: keep groups that still match the hand; drop stale/unknown UIDs.
 * Never throws — used by result / leave / finalize so one bad layout cannot stick the table.
 */
function coerceSubmittedGroupsForHand(groups, handCards) {
  if (!Array.isArray(groups)) return [];
  const handCardIds = new Set(
    (Array.isArray(handCards) ? handCards : [])
      .map((card) => card?.card_uid)
      .filter(Boolean)
  );
  const used = new Set();
  const next = [];

  groups.forEach((group, idx) => {
    const rawCards = Array.isArray(group?.cards) ? group.cards : [];
    const cardIds = rawCards
      .map((card) => (typeof card === 'string' ? card : card?.card_uid))
      .filter((cardId) => Boolean(cardId) && handCardIds.has(cardId) && !used.has(cardId));
    cardIds.forEach((cardId) => used.add(cardId));
    if (cardIds.length === 0) return;
    next.push({
      group_id: group?.group_id || idx + 1,
      cards: cardIds,
    });
  });

  return next;
}

function resolveSubmittedGroupsInput(rawGroups, fallbackGroups, handCards) {
  const sourceGroups = Array.isArray(rawGroups) ? rawGroups : fallbackGroups;
  return sanitizeSubmittedGroups(sourceGroups, handCards || []);
}

function reindexSubmittedGroups(groups = []) {
  return groups.map((group, idx) => ({
    group_id: idx + 1,
    cards: Array.isArray(group?.cards) ? [...group.cards] : [],
  }));
}

function insertCardIntoGroupCards(existingCards = [], cardUid, position = null) {
  const cards = Array.isArray(existingCards) ? [...existingCards] : [];

  // Append to end when no position is provided.
  if (position == null) {
    cards.push(cardUid);
    return cards;
  }

  // Out-of-range or invalid positions gracefully fall back to "append to end".
  const clamped = Math.max(0, Math.min(cards.length, Math.floor(position)));
  cards.splice(clamped, 0, cardUid);
  return cards;
}

function normalizeCardPosition(rawPosition) {
  if (rawPosition == null) return null;
  const numeric = Number(rawPosition);
  if (Number.isNaN(numeric) || !Number.isFinite(numeric) || numeric < 0) {
    throw new Error('position must be a non-negative integer');
  }
  return Math.floor(numeric);
}

function appendCardToLastGroup(groups = [], cardUid, position = null) {
  if (!cardUid) return reindexSubmittedGroups(groups);

  const nextGroups = reindexSubmittedGroups(groups);
  if (nextGroups.length === 0) {
    return [{ group_id: 1, cards: [cardUid] }];
  }

  const lastIndex = nextGroups.length - 1;
  nextGroups[lastIndex] = {
    ...nextGroups[lastIndex],
    cards: insertCardIntoGroupCards(nextGroups[lastIndex].cards, cardUid, position),
  };

  return reindexSubmittedGroups(nextGroups);
}

function appendCardToSpecifiedGroupOrLast(groups = [], cardUid, targetGroupId = null, position = null) {
  if (!cardUid) return reindexSubmittedGroups(groups);

  const nextGroups = reindexSubmittedGroups(groups);
  if (targetGroupId == null) {
    return appendCardToLastGroup(nextGroups, cardUid, position);
  }

  const normalizedGroupId = Number(targetGroupId);
  if (Number.isNaN(normalizedGroupId) || normalizedGroupId < 1) {
    throw new Error('Valid group_id is required');
  }

  if (nextGroups.length === 0) {
    if (normalizedGroupId !== 1) {
      throw new Error('Target group_id not found');
    }
    return [{ group_id: 1, cards: [cardUid] }];
  }

  const targetIndex = nextGroups.findIndex((group) => Number(group?.group_id) === normalizedGroupId);
  if (targetIndex < 0) {
    throw new Error('Target group_id not found');
  }

  nextGroups[targetIndex] = {
    ...nextGroups[targetIndex],
    cards: insertCardIntoGroupCards(nextGroups[targetIndex].cards, cardUid, position),
  };

  return reindexSubmittedGroups(nextGroups);
}

function removeCardFromGroups(groups = [], cardUid, fromGroupId = null) {
  const normalizedFromGroupId = fromGroupId != null ? Number(fromGroupId) : null;

  const nextGroups = groups
    .map((group) => {
      const groupId = Number(group?.group_id);
      const cards = Array.isArray(group?.cards) ? [...group.cards] : [];
      const shouldTargetThisGroup = normalizedFromGroupId != null
        ? groupId === normalizedFromGroupId
        : cards.includes(cardUid);

      if (!shouldTargetThisGroup) {
        return {
          group_id: groupId,
          cards,
        };
      }

      return {
        group_id: groupId,
        cards: cards.filter((id) => id !== cardUid),
      };
    })
    .filter((group) => group.cards.length > 0);

  return reindexSubmittedGroups(nextGroups);
}

function buildGroupingResponseData(grouping) {
  return {
    grouping,
  };
}

function resolveGroupingSnapshot(handCards, wildJoker, submittedGroups) {
  if (Array.isArray(submittedGroups)) {
    const sanitizedGroups = sanitizeSubmittedGroups(submittedGroups, handCards || []);
    const grouping = groupingService.evaluateSubmittedGrouping(
      handCards || [],
      wildJoker,
      sanitizedGroups
    );

    return {
      grouping,
      submittedGroups: sanitizedGroups,
    };
  }

  const grouping = groupingService.buildBestGrouping(handCards || [], wildJoker);
  return {
    grouping,
    submittedGroups: toSubmittedGroupsFromGrouping(grouping),
  };
}

function isAutoBestGroupEnabled(playerDistribution) {
  return playerDistribution?.auto_best_group === true;
}

function buildAutoBestGroupingResult(handCards, wildJoker, options = {}) {
  const groupingOptions = options.groupingOptions || {};
  // On the pick hot-path (fastFinishPlan=true) skip the O(n×DFS) discard scan
  // fallback. The partition path covers ~95% of finishable hands and we read
  // finish_card_uid from the grouping summary for the remaining 5%.
  const buildOpts = options.fastFinishPlan === true
    ? { ...groupingOptions, skipDiscardScan: true }
    : groupingOptions;
  const best = groupingService.buildBestGrouping(handCards, wildJoker, buildOpts);
  const submittedGroups = toSubmittedGroupsFromGrouping(best);
  // Hot-path optimization: when `fastFinishPlan` is enabled (pick ACK),
  // the `best` grouping is already fully evaluated (types + summary + display
  // points). Re-evaluating submitted groups here is redundant and expensive.
  const grouping = options.fastFinishPlan === true
    ? best
    : groupingService.evaluateSubmittedGrouping(handCards, wildJoker, submittedGroups);

  // Fast path for pick ACK: trust finish_card_uid from buildBestGrouping instead of
  // re-scanning every leftover (that scan was a major pick-latency source).
  let finishPlan = null;
  const preferredUid = String(best?.summary?.finish_card_uid || '').trim();
  if (options.fastFinishPlan === true && preferredUid) {
    const finishCard = (Array.isArray(handCards) ? handCards : [])
      .find((card) => String(card?.card_uid || '').trim() === preferredUid);
    if (finishCard) {
      const nextHandCards = handCards.filter(
        (card) => String(card?.card_uid || '').trim() !== preferredUid
      );
      if (nextHandCards.length === DECLARE_HAND_CARD_COUNT) {
        let nextSubmitted;
        try {
          nextSubmitted = sanitizeSubmittedGroups(
            removeCardFromGroups(submittedGroups, preferredUid),
            nextHandCards
          );
        } catch (_) {
          nextSubmitted = null;
        }
        if (nextSubmitted) {
          try {
            const preview = groupingService.evaluateSubmittedGrouping(
              nextHandCards,
              wildJoker,
              nextSubmitted
            );
            if (preview?.summary?.valid_for_declare === true) {
              finishPlan = {
                finishCard,
                nextHandCards,
                submittedGroups: nextSubmitted,
                preview,
                explain: { source: 'auto_best_finish_uid', early_stop: true },
              };
            }
          } catch (_) {
            finishPlan = null;
          }
        }
      }
    }
  } else if (options.skipFinishPlan !== true) {
    finishPlan = tryBuildFinishPlan(handCards, wildJoker, {
      submittedGroups,
      groupingOptions,
      tieBreakSeed: options.tieBreakSeed || '',
      sessionId: options.sessionId,
      userId: options.userId,
      turnId: options.turnId,
    });
  }

  return { grouping, submittedGroups, finishPlan };
}

/** Attach evaluated meld types/points to each player row for session:refresh. */
function enrichSessionDistributionWithGroupingSnapshots(session) {
  const distribution = session?.metadata?.distribution;
  if (!Array.isArray(distribution?.players) || distribution.players.length === 0) {
    return session;
  }

  const wildJoker = distribution.wild_joker || null;
  const players = distribution.players.map((playerDistribution) => {
    const handCards = Array.isArray(playerDistribution?.cards)
      ? playerDistribution.cards
      : [];
    const submittedGroups = Array.isArray(playerDistribution?.submitted_groups)
      ? playerDistribution.submitted_groups
      : [];
    if (handCards.length === 0 || submittedGroups.length === 0) {
      return playerDistribution;
    }

    try {
      const { grouping } = resolveGroupingSnapshot(handCards, wildJoker, submittedGroups);
      return { ...playerDistribution, grouping_snapshot: grouping };
    } catch (_) {
      return playerDistribution;
    }
  });


  // --->

  return {
    ...session,
    metadata: {
      ...session.metadata,
      distribution: {
        ...distribution,
        players,
      },
    },
  };
}

function scoreFromBestGrouping(cards, wildJoker) {
  const grouping = groupingService.buildBestGrouping(cards || [], wildJoker);
  const points = resolvePenaltyPointsFromGrouping(grouping);
  return {
    grouping,
    points,
  };
}

function scoreFromSubmittedGrouping(cards, wildJoker, submittedGroups = []) {
  const grouping = groupingService.evaluateSubmittedGrouping(cards || [], wildJoker, submittedGroups || []);
  const points = resolvePenaltyPointsFromGrouping(grouping);
  return {
    grouping,
    points,
  };
}

function resolvePenaltyPointsFromGrouping(grouping) {
  const summary = grouping?.summary || {};
  const isValidDeclare = summary.valid_for_declare === true;
  if (isValidDeclare) return 0;

  const displayPoints = Number(summary.display_point);
  if (!Number.isNaN(displayPoints)) {
    return Math.min(80, Math.max(0, displayPoints));
  }

  // Fallback for older summaries that may not include display_point.
  const ungroupedPoints = Number(summary.ungrouped_points) || 0;
  return Math.min(80, Math.max(0, ungroupedPoints));
}

function resolveDropLossPoints(session, userId, options = {}) {
  const forceMiddleDrop = options?.forceMiddleDrop === true;
  const distribution = session?.metadata?.distribution;
  if (!distribution) return null;

  const playerDistribution = getPlayerDistribution(distribution, userId)
    || (Array.isArray(distribution.players)
      ? distribution.players.find((pd) => Number(pd?.user_id) === Number(userId))
      : null);

  if (!playerDistribution) return null;

  // Check if player has left the game (post-result leave)
  const leftUserIds = new Set(
    (Array.isArray(session.metadata?.post_result_left_user_ids) ? session.metadata.post_result_left_user_ids : [])
      .map((id) => Number(id))
      .filter((id) => !Number.isNaN(id))
  );
  if (leftUserIds.has(Number(userId))) {
    return 80; // Total points loss for leaving game
  }

  const mode = resolveSessionGameMode(session);
  if (isDealLikeMode(mode)) {
    return MAX_ROUND_LOSS_POINTS;
  }
  if (mode === 'pool') {
    const poolLimit = resolvePoolLimit(session);
    const firstDropPenalty = poolLimit >= 201 ? 25 : 20;
    const middleDropPenalty = poolLimit >= 201 ? 50 : 40;
    if (forceMiddleDrop) return middleDropPenalty;
    return isFirstDropEligible(playerDistribution) ? firstDropPenalty : middleDropPenalty;
  }

  if (forceMiddleDrop) {
    return 40;
  }
  return isFirstDropEligible(playerDistribution) ? 20 : 40;
}

function buildRankByUserId(results = []) {
  const sorted = [...results].sort((a, b) => {
    if ((a?.points || 0) !== (b?.points || 0)) return (a?.points || 0) - (b?.points || 0);
    return (a?.seat_no || 0) - (b?.seat_no || 0);
  });

  return new Map(sorted.map((result, index) => [result.user_id, index + 1]));
}

function isPlayerDropped(player, playerDistribution, result = null) {
  return Boolean(
    result?.player_status === 'dropped'
    || result?.dropped === true
    || player?.status === 'dropped'
    || player?.metadata?.is_dropped === true
    || player?.metadata?.status === 'dropped'
    || player?.metadata?.drop_status === 'dropped'
    || player?.metadata?.elimination_reason === 'dropped'
    || playerDistribution?.is_dropped === true
    || playerDistribution?.status === 'dropped'
    || playerDistribution?.drop_status === 'dropped'
  );
}

function isPlayerInactiveForDeclaration(session, player, distribution) {
  const userId = Number(player?.user_id);
  if (Number.isNaN(userId)) return false;
  const playerDistribution = getPlayerDistribution(distribution, userId);
  if (isPlayerDropped(player, playerDistribution)) return true;
  if (isInvalidDeclarationPackedPlayer(player)) return true;
  if (getEliminatedUserIdSet(session?.metadata || {}).has(userId)) return true;
  if (getTimeoutEliminatedUserIdSet(session?.metadata || {}).has(userId)) return true;
  if (getTurnEliminatedUserIdSet(session?.metadata || {}).has(userId)) return true;
  if (String(player?.status || '').toLowerCase() === 'eliminated') return true;
  if (player?.metadata?.elimination_reason === 'pool_limit') return true;
  return false;
}

function prefillDroppedPlayersInDeclareResponses(session, distribution, players, responses, submittedAt) {
  prefillInactivePlayersInDeclareResponses(session, distribution, players, responses, submittedAt);
}

function prefillInactivePlayersInDeclareResponses(session, distribution, players, responses, submittedAt) {
  if (!distribution || !responses) return;
  const wildJoker = distribution?.wild_joker || null;
  (Array.isArray(players) ? players : []).forEach((player) => {
    const userId = player?.user_id;
    if (userId == null || hasDeclareResponseEntry(responses, userId)) return;
    if (!isPlayerInactiveForDeclaration(session, player, distribution)) return;
    const playerDistribution = getPlayerDistribution(distribution, userId);
    const playerCards = playerDistribution?.cards || [];
    // Prefer last known layout (manual declare / finish arrangement) over inventing best.
    // True auto-declare (no stored groups) still falls through to buildBestGrouping.
    // Coerce against the CURRENT hand so a layout captured before a finish/pick/discard
    // (stale card_uid) can never carry a card the player no longer holds into finalize.
    const storedGroups = Array.isArray(playerDistribution?.submitted_groups)
      ? coerceSubmittedGroupsForHand(playerDistribution.submitted_groups, playerCards)
      : [];
    const uidNum = Number(userId);
    const responseKey = Number.isNaN(uidNum) ? userId : uidNum;
    if (storedGroups.length > 0) {
      responses.set(responseKey, {
        submitted_at: submittedAt || new Date().toISOString(),
        auto: false,
        groups: storedGroups,
      });
      return;
    }
    const autoGrouping = groupingService.buildBestGrouping(playerCards, wildJoker);
    responses.set(responseKey, {
      submitted_at: submittedAt || new Date().toISOString(),
      auto: true,
      groups: toSubmittedGroupsFromGrouping(autoGrouping),
    });
  });
}

function resolvePlayerStatus({
  isFinal = false,
  isGameFinal = null,
  isDropped = false,
  isWinner = false,
  submitted = false,
  userId = null,
  declareByUserId = null,
  declarerValid = null,
  mode = null,
}) {
  if (isDropped) return 'dropped';
  if (isFinal !== true) return submitted ? 'submitted' : 'pending';
  const gameFinal = isGameFinal ?? true;
  if (
    declareByUserId != null
    && userId != null
    && Number(userId) === Number(declareByUserId)
    && declarerValid === false
  ) {
    return 'invalid_declaration';
  }
  if (isWinner) {
    if (gameFinal) return 'won';
    if (mode === 'pool' || isDealLikeMode(mode)) return 'deal_winner';
    return 'won';
  }
  return 'lost';
}

function resolveSubmissionStatus({ isFinal = false, submitted = false, submissionMode = null }) {
  if (isFinal !== true) {
    return submitted ? 'submitted' : 'pending';
  }

  if (!submitted) return 'not_submitted';
  return submissionMode === 'auto' ? 'auto' : 'manual';
}

function resolveStatusColor(playerStatus = null) {
  switch (playerStatus) {
    case 'active':
      return '#16A34A';
    case 'pending':
      return '#F59E0B';
    case 'submitted':
      return '#2563EB';
    case 'won':
    case 'deal_winner':
    case 'round_winner':
      return '#16A34A';
    case 'tie':
      return '#0EA5E9';
    case 'lost':
      return '#DC2626';
    case 'invalid_declaration':
      return '#EA580C';
    case 'dropped':
      return '#6B7280';
    case 'disconnected':
      return '#475569';
    case 'eliminated':
      return '#6B7280';
    case 'timeout':
      return '#7C3AED';
    default:
      return '#6B7280';
  }
}

/**
 * Normalize hand arrangement groups (submitted_groups / auto_groups) to
 * evaluateSubmittedGrouping shape: [{ group_id, cards: [card_uid, ...] }].
 */
function normalizeArrangementGroupsForTip(playerDistribution = null) {
  const submitted = Array.isArray(playerDistribution?.submitted_groups)
    ? playerDistribution.submitted_groups
    : null;
  if (submitted && submitted.length > 0) {
    return submitted.map((group, idx) => ({
      group_id: group?.group_id || idx + 1,
      cards: (Array.isArray(group?.cards) ? group.cards : [])
        .map((card) => (typeof card === 'string' ? card : card?.card_uid))
        .filter((uid) => typeof uid === 'string' && uid.length > 0),
    })).filter((group) => group.cards.length > 0);
  }

  const autoGroups = Array.isArray(playerDistribution?.auto_groups?.groups)
    ? playerDistribution.auto_groups.groups
    : null;
  if (autoGroups && autoGroups.length > 0) {
    return autoGroups.map((group, idx) => ({
      group_id: group?.group_id || idx + 1,
      cards: (Array.isArray(group?.cards) ? group.cards : [])
        .map((card) => (typeof card === 'string' ? card : card?.card_uid))
        .filter((uid) => typeof uid === 'string' && uid.length > 0),
    })).filter((group) => group.cards.length > 0);
  }

  return [];
}

/**
 * View-only educational tip for every mode: attach best_grouping whenever a
 * better layout exists than the displayed / last-arranged hand. Never changes scores.
 * Covers manual declare, auto-declare, drop, timeout, and all other hand outcomes.
 */
function resolveBestDeclareGroupingTip({
  playerCards,
  wildJoker,
  grouping,
  playerDistribution = null,
} = {}) {
  if (!Array.isArray(playerCards) || playerCards.length === 0) {
    return { best_grouping: null, best_score: null };
  }

  let best;
  try {
    best = groupingService.buildBestGrouping(playerCards, wildJoker);
  } catch (_) {
    return { best_grouping: null, best_score: null };
  }

  const bestPoint = Number(best?.summary?.display_point);
  if (!Number.isFinite(bestPoint)) {
    return { best_grouping: null, best_score: null };
  }

  let baselinePoint = Number(grouping?.summary?.display_point);
  const arrangementGroups = normalizeArrangementGroupsForTip(playerDistribution);
  if (arrangementGroups.length > 0) {
    try {
      const arranged = groupingService.evaluateSubmittedGrouping(
        playerCards,
        wildJoker,
        arrangementGroups
      );
      const arrangedPoint = Number(arranged?.summary?.display_point);
      if (Number.isFinite(arrangedPoint)) {
        baselinePoint = Number.isFinite(baselinePoint)
          ? Math.max(baselinePoint, arrangedPoint)
          : arrangedPoint;
      }
    } catch (_) {
      // Ignore bad/stale arrangement snapshots; fall back to displayed grouping.
    }
  }

  if (!Number.isFinite(baselinePoint) || bestPoint >= baselinePoint) {
    return { best_grouping: null, best_score: null };
  }

  return {
    best_grouping: best,
    best_score: Math.min(MAX_ROUND_LOSS_POINTS, Math.max(0, Math.floor(bestPoint))),
  };
}

function buildDeclarationTablePlayers({
  session,
  distribution,
  state,
  isFinal = false,
  isGameFinal = null,
  finalizedResults = [],
  settlement = null,
  winnerUserId = null,
  declarerValid = null,
  previousPoolEliminatedUserIds = null,
}) {
  const mode = resolveSessionGameMode(session);
  const gameFinal = isGameFinal ?? isFinal;
  const players = Array.isArray(session?.players) ? session.players : [];
  const wildJoker = distribution?.wild_joker || null;
  const resultByUserId = new Map((finalizedResults || []).map((result) => [result.user_id, result]));
  const settlementByUserId = new Map((settlement?.per_player || []).map((entry) => [entry.user_id, entry]));
  const rankByUserId = isFinal ? buildRankByUserId(finalizedResults || []) : new Map();

  const previousPoolEliminatedSet = new Set(
    (Array.isArray(previousPoolEliminatedUserIds) ? previousPoolEliminatedUserIds : [])
      .map((id) => Number(id))
      .filter((id) => !Number.isNaN(id))
  );
  const shouldHidePreviousPoolEliminated = (
    !gameFinal
    && mode === 'pool'
    && Array.isArray(previousPoolEliminatedUserIds)
  );

  const visiblePlayers = shouldHidePreviousPoolEliminated
    ? players.filter((player) => {
      const userId = Number(player?.user_id);
      if (Number.isNaN(userId)) return false;
      return !previousPoolEliminatedSet.has(userId);
    })
    : players;

  return visiblePlayers.map((player) => {
    const playerDistribution = getPlayerDistribution(distribution, player.user_id);
    const playerCards = playerDistribution?.cards || [];
    const playerResponse = getDeclareResponseEntry(state?.responses, player.user_id);
    const submitted = Boolean(playerResponse);
    const submissionMode = submitted ? (playerResponse.auto ? 'auto' : 'manual') : null;
    const result = resultByUserId.get(player.user_id)
      || resultByUserId.get(Number(player.user_id))
      || null;
    const settlementEntry = settlementByUserId.get(player.user_id)
      || settlementByUserId.get(Number(player.user_id))
      || null;
    const isWinner = result?.is_winner ?? (
      isFinal
        ? Number(player.user_id) === Number(winnerUserId)
        : null
    );
    const isDropped = isPlayerDropped(player, playerDistribution, result);
    const isInactiveForDeclare = isPlayerInactiveForDeclaration(session, player, distribution);
    const playerStatus = resolvePlayerStatus({
      isFinal,
      isGameFinal: gameFinal,
      isDropped,
      isWinner,
      submitted,
      userId: player.user_id,
      declareByUserId: state?.declareByUserId,
      declarerValid,
      mode,
    });
    const submissionStatus = resolveSubmissionStatus({
      isFinal,
      submitted,
      submissionMode: result?.submission_mode ?? submissionMode,
    });
    const resolvedPlayerStatus = (() => {
      if (!isFinal) {
        if (isInactiveForDeclare) {
          return resolveLivePlayerStatus(session, player);
        }
        return result?.player_status ?? playerStatus;
      }
      const fromResult = result?.player_status;
      if (
        fromResult === 'eliminated'
        || fromResult === 'timeout'
        || fromResult === 'dropped'
        || fromResult === 'invalid_declaration'
      ) {
        return fromResult;
      }
      return playerStatus;
    })();
    let roundPoints = result?.round_points ?? result?.points ?? null;
    let totalScore = result?.total_score
      ?? (mode === 'pool' ? (result?.cumulative_points ?? null) : null);
    if (!isFinal && isDropped) {
      const dropPenalty = resolveDropLossPoints(session, player.user_id);
      if (Number.isFinite(dropPenalty)) {
        roundPoints = dropPenalty;
      }
      if (mode === 'pool') {
        const poolScoresByUser = normalizePoolScoresByUser(session?.metadata || {});
        const previousScore = Number(poolScoresByUser[String(player.user_id)]) || 0;
        totalScore = previousScore + (Number.isFinite(dropPenalty) ? dropPenalty : 0);
      }
    }
    // Wrong-show is always full max loss — never hand/ungrouped display points.
    if (
      isFinal
      && !isWinner
      && (
        result?.player_status === 'invalid_declaration'
        || resolvedPlayerStatus === 'invalid_declaration'
        || isInvalidDeclarationPackedPlayer(player)
      )
    ) {
      roundPoints = MAX_ROUND_LOSS_POINTS;
    }
    const scoreModel = result?.score_model
      ?? (mode === 'pool' ? 'pool_loss_cumulative' : (isDealLikeMode(mode) ? 'deal_base_plus_minus' : null));
    const resolvedWonAmount = settlementEntry?.amount ?? (isFinal ? 0 : null);

    let cards = null;
    let grouping = null;
    let bestGrouping = null;
    let bestScore = null;

    const isInvalidDeclarerSeat = (
      declarerValid === false
      && state?.declareByUserId != null
      && Number(player.user_id) === Number(state.declareByUserId)
    ) || resolvedPlayerStatus === 'invalid_declaration'
      || result?.player_status === 'invalid_declaration';

    if (isFinal) {
      cards = playerCards;
      const responseGroups = playerResponse?.groups || null;
      const storedGroups = Array.isArray(playerDistribution?.submitted_groups)
        ? playerDistribution.submitted_groups
        : null;
      // Manual declare/response first; stored finish/declare layout next; best last.
      // Never throw — leave/finalize used to get stuck on stale card UIDs.
      // Invalid declarer: never replace failed layout with optimistic best grouping.
      grouping = resolveResultHandGrouping(
        playerCards,
        wildJoker,
        responseGroups || storedGroups,
        { allowBestFallback: !isInvalidDeclarerSeat }
      );
    } else if (submitted) {
      cards = playerCards;
      const submittedGroups = playerResponse?.groups || [];
      if ((isDropped || isInactiveForDeclare) && submittedGroups.length === 0) {
        const storedGroups = Array.isArray(playerDistribution?.submitted_groups)
          ? playerDistribution.submitted_groups
          : [];
        grouping = resolveResultHandGrouping(playerCards, wildJoker, storedGroups);
      } else {
        grouping = resolveResultHandGrouping(playerCards, wildJoker, submittedGroups);
      }
    }

    const isTimeoutOrDropped = isDropped
      || resolvedPlayerStatus === 'timeout'
      || resolvedPlayerStatus === 'dropped'
      || result?.player_status === 'timeout'
      || result?.player_status === 'dropped'
      || result?.dropped === true;

    const tip = resolveBestDeclareGroupingTip({
      playerCards,
      wildJoker,
      grouping,
      playerDistribution,
    });
    bestGrouping = tip.best_grouping;
    bestScore = tip.best_score;

    if ((mode === 'pool' || isDealLikeMode(mode)) && isFinal && grouping?.summary != null && !isWinner && !isTimeoutOrDropped) {
      const displayPoint = Number(grouping.summary.display_point);
      const roundPointsNum = Number(roundPoints);
      if (Number.isFinite(displayPoint) && !Number.isFinite(roundPointsNum)) {
        roundPoints = Math.min(MAX_ROUND_LOSS_POINTS, Math.max(0, displayPoint));
      }
    }

    if (roundPoints != null && Number.isFinite(Number(roundPoints))) {
      const normalizedRound = Math.max(0, Number(roundPoints));
      roundPoints = isWinner
        ? normalizedRound
        : Math.min(MAX_ROUND_LOSS_POINTS, normalizedRound);
    }

    return {
      user_id: player.user_id,
      name: player.name || null,
      phone: player.phone || null,
      avatar: player.avatar || null,
      view_id: player.view_id || null,
      seat_no: player.seat_no,
      submitted,
      submission_mode: result?.submission_mode ?? submissionMode,
      submission_status: submissionStatus,
      declare_status: isFinal
        ? (submitted ? submissionMode || 'manual' : 'auto')
        : (isDropped ? 'auto' : (submitted ? 'submitted' : 'pending')),
      cards,
      grouping,
      best_grouping: bestGrouping,
      best_score: bestScore,
      score: roundPoints,
      // mode === 'pool'
      //   ? roundPoints
      //   : (totalScore ?? roundPoints),
      points: roundPoints,
      round_points: roundPoints,
      total_score: totalScore,
      score_model: scoreModel,
      grouped_points: result?.grouped_points ?? grouping?.summary?.grouped_points ?? null,
      ungrouped_points: result?.ungrouped_points ?? grouping?.summary?.ungrouped_points ?? null,
      valid_for_declare: isInvalidDeclarerSeat
        ? false
        : (result?.valid_for_declare ?? (grouping?.summary?.valid_for_declare ?? null)),
      invalid_group_count: result?.invalid_group_count ?? (grouping?.summary?.invalid_group_count ?? null),
      all_cards_grouped: result?.all_cards_grouped ?? (grouping?.summary?.all_cards_grouped ?? null),
      won_amount: resolvedWonAmount,
      is_winner: isWinner,
      player_status: resolvedPlayerStatus,
      status_color: resolveStatusColor(resolvedPlayerStatus),
      dropped: result?.dropped ?? isDropped,
      rank: rankByUserId.get(player.user_id) || null,
    };
  });
}

function attachWonAmountToResults(finalizedResults = [], settlement = null) {
  const list = Array.isArray(finalizedResults) ? finalizedResults : [];
  const settlementByUserId = new Map(
    (Array.isArray(settlement?.per_player) ? settlement.per_player : [])
      .map((entry) => [Number(entry?.user_id), Number(entry?.amount) || 0])
  );
  return list.map((row) => {
    const userId = Number(row?.user_id);
    return {
      ...row,
      won_amount: settlementByUserId.has(userId) ? settlementByUserId.get(userId) : 0,
    };
  });
}

function buildResultShapeFieldsForDeclareState({
  session,
  isFinal = false,
  isGameFinal = null,
  reason = null,
  winnerUserId = null,
  declarerValid = null,
  finalizedResults = [],
  settlement = null,
  state = null,
}) {
  const mode = resolveSessionGameMode(session);
  const gameFinal = isGameFinal ?? isFinal;
  const entryFee = roundCurrency(Number(session?.contest?.entry) || 0);
  const poolLimit = mode === 'pool' ? resolvePoolLimit(session) : null;
  const poolScoresByUser = mode === 'pool'
    ? normalizePoolScoresByUser(session?.metadata || {})
    : {};
  const poolEliminatedUserIds = mode === 'pool'
    ? Array.from(
      new Set(
        (Array.isArray(session?.metadata?.pool_eliminated_user_ids) ? session.metadata.pool_eliminated_user_ids : [])
          .map((id) => Number(id))
          .filter((id) => !Number.isNaN(id))
      )
    )
    : [];
  const rejoinContext = mode === 'pool'
    ? buildPoolRejoinContext({
      players: session?.players || [],
      scoresByUser: poolScoresByUser,
      eliminatedUserIds: poolEliminatedUserIds,
      poolLimit,
      forceDisabled: !isFinal,
    })
    : {
      can_rejoin_table: false,
      rejoin_threshold: null,
      rejoin_candidate_user_ids: [],
      rejoin_start_points_by_user: {},
    };
  const prizePoolSummary = mode === 'pool'
    ? buildPoolPrizePoolSummary({
      entryFee,
      baseEntryCount: resolvePoolBaseEntryCount(session),
      rejoinEntryCount: resolvePoolRejoinEntryCount(session?.metadata || {}),
      projectedExtraEntries: 0,
    })
    : null;
  const rejoinInfo = buildPoolRejoinInfoPayload({
    rejoinContext,
    joiningFee: entryFee,
    prizePoolSummary,
  });
  return {
    status: isFinal ? 'completed' : 'declaring',
    is_final: gameFinal === true,
    reason,
    declare_by_user_id: state?.declareByUserId ?? null,
    declare_valid: declarerValid,
    winner_user_id: winnerUserId,
    tie_break_policy: mode === 'pool' ? 'pool_limit_then_lowest_points' : null,
    finish_card: state?.finishCard || session?.metadata?.declaration?.finish_card || null,
    auto_declared_user_ids: isFinal ? [] : null,
    pool_limit: poolLimit,
    pool_round_no: mode === 'pool' ? (buildDealContextFields(session).pool_round_no ?? null) : null,
    pool_scores_by_user: mode === 'pool' ? poolScoresByUser : null,
    pool_eliminated_user_ids: mode === 'pool' ? poolEliminatedUserIds : [],
    can_rejoin_table: mode === 'pool' ? Boolean(rejoinContext.can_rejoin_table && isFinal) : false,
    rejoin_threshold: mode === 'pool' ? rejoinContext.rejoin_threshold : null,
    rejoin_candidate_user_ids: mode === 'pool' ? rejoinContext.rejoin_candidate_user_ids : [],
    rejoin_start_points_by_user: mode === 'pool' ? rejoinContext.rejoin_start_points_by_user : {},
    rejoin_at_points_by_user: mode === 'pool' ? rejoinContext.rejoin_start_points_by_user : {},
    joining_fee: mode === 'pool' ? rejoinInfo.joining_fee : 0,
    current_prize_pool: mode === 'pool' ? rejoinInfo.current_prize_pool : 0,
    updated_prize_pool_if_rejoin: mode === 'pool' ? rejoinInfo.updated_prize_pool_if_rejoin : 0,
    rejoin_info: mode === 'pool' ? rejoinInfo : null,
    settlement: settlement || null,
    deal_scores: null,
    can_split: mode === 'pool' ? false : null,
    split_candidate_user_ids: mode === 'pool' ? [] : null,
    split_offer_id: null,
    split_window_end_at: null,
    split_accepted_user_ids: [],
    split_rejected_user_ids: [],
    results: attachWonAmountToResults(finalizedResults, settlement),
  };
}

function buildDeclarationStatePayload({
  session,
  state,
  distribution = null,
  reason = null,
  isFinal = false,
  isGameFinal = null,
  finalizedResults = [],
  settlement = null,
  winnerUserId = null,
  declarerValid = null,
}) {
  const gameFinal = isGameFinal ?? isFinal;
  const allPlayers = Array.isArray(session?.players) ? session.players : [];
  const participantUserIds = Array.isArray(state?.participantUserIds) && state.participantUserIds.length > 0
    ? state.participantUserIds
    : allPlayers.map((player) => player.user_id);
  const participantSet = new Set(participantUserIds.map((id) => Number(id)).filter((id) => !Number.isNaN(id)));
  const players = allPlayers.filter((player) => participantSet.has(Number(player.user_id)));
  const activeDistribution = distribution || session.metadata?.distribution || null;
  const pendingUserIds = players
    .map((player) => player.user_id)
    .filter((userId) => !hasDeclareResponseEntry(state.responses, userId));
  const submittedUserIds = players
    .map((player) => player.user_id)
    .filter((userId) => hasDeclareResponseEntry(state.responses, userId));
  const dealContext = buildDealContextFields(session);
  const resultShapeFields = buildResultShapeFieldsForDeclareState({
    session,
    isFinal,
    isGameFinal: gameFinal,
    reason,
    winnerUserId,
    declarerValid,
    finalizedResults,
    settlement,
    state,
  });

  return {
    session_id: session.id,
    server_time: new Date().toISOString(),
    event: 'game:declare:state',
    ...resultShapeFields,
    sequence: state.sequence,
    visibility_stage: state.visibilityStage || DECLARATION_VISIBILITY_OPEN_FOR_ALL,
    open_for_all: (state.visibilityStage || DECLARATION_VISIBILITY_OPEN_FOR_ALL) === DECLARATION_VISIBILITY_OPEN_FOR_ALL,
    started_at: state.startedAt,
    ends_at: state.endsAt,
    duration_seconds: state.startedAt && state.endsAt
      ? Math.max(0, Math.round((Date.parse(state.endsAt) - Date.parse(state.startedAt)) / 1000))
      : null,
    ...dealContext,
    pending_count: pendingUserIds.length,
    pending_user_ids: pendingUserIds,
    submitted_user_ids: submittedUserIds,
    players: buildDeclarationTablePlayers({
      session,
      distribution: activeDistribution,
      state,
      isFinal,
      isGameFinal: gameFinal,
      finalizedResults,
      settlement,
      winnerUserId,
      declarerValid,
    }),
  };
}

function emitDeclarationState(io, session, state, options = {}) {
  if (!session || !state) return null;
  const payload = buildDeclarationStatePayload({
    session,
    state,
    distribution: options.distribution,
    reason: options.reason || null,
    isFinal: options.isFinal === true,
    isGameFinal: options.isGameFinal,
    finalizedResults: options.finalizedResults || [],
    settlement: options.settlement || null,
    winnerUserId: options.winnerUserId || null,
    declarerValid: options.declarerValid ?? null,
  });
  io.to(sessionRoom(session.id)).emit('game:declare:state', payload);
  return payload;
}

// ── Game Settlement Engine ────────────────────────────────────────────────────
// Atomically debit losers and credit the winner in a single DB transaction.
// Returns the settlement summary or null if skipped (no DB / no point_value).
async function settleGameResult(sessionId, finalizedResults, winnerUserId, pointValue) {
  if (!pool) {
    warnGame(sessionId, 'Settlement skipped — DATABASE_URL not configured');
    return null;
  }

  const numericPointValue = parseFloat(pointValue) || 0;
  if (numericPointValue <= 0) {
    warnGame(sessionId, `Settlement skipped — point_value=${pointValue} (free game / no monetary stake)`);
    return null;
  }

  const winners = finalizedResults.filter((r) => r.is_winner);
  const losers = finalizedResults.filter((r) => !r.is_winner);

  if (!winners.length) {
    warnGame(sessionId, 'Settlement skipped — no winner in results');
    return null;
  }

  // Round to 2 dp throughout to avoid floating-point drift.
  const totalLossPool = losers.reduce(
    (sum, l) => sum + Math.round((Number(l.points) || 0) * numericPointValue * 100) / 100,
    0
  );
  const totalCommission = Math.round(totalLossPool * 0.12 * 100) / 100;
  const totalWinnerPool = Math.round((totalLossPool - totalCommission) * 100) / 100;
  const winnerCount = winners.length;
  const winnerShare = winnerCount > 0 ? Math.round((totalWinnerPool / winnerCount) * 100) / 100 : 0;
  const lastWinnerShare = winnerCount > 0
    ? Math.round((totalWinnerPool - (winnerShare * (winnerCount - 1))) * 100) / 100
    : 0;
  const commissionShare = winnerCount > 0 ? Math.round((totalCommission / winnerCount) * 100) / 100 : 0;
  const lastCommissionShare = winnerCount > 0
    ? Math.round((totalCommission - (commissionShare * (winnerCount - 1))) * 100) / 100
    : 0;
  const winnerRank = new Map(
    winners
      .slice()
      .sort((a, b) => (Number(a?.seat_no) || 0) - (Number(b?.seat_no) || 0))
      .map((row, idx) => [Number(row.user_id), idx])
  );

  const perPlayer = finalizedResults.map((r) => {
    if (r.is_winner) {
      const rank = winnerRank.get(Number(r.user_id)) || 0;
      const isLastWinner = rank === Math.max(0, winnerCount - 1);
      const commission = isLastWinner ? lastCommissionShare : commissionShare;
      const winnerAmount = isLastWinner ? lastWinnerShare : winnerShare;
      return {
        user_id: r.user_id,
        seat_no: r.seat_no,
        points: r.points,
        is_winner: true,
        amount: winnerAmount,
        commission: commission,
        transaction_type: 'game_win_credit',
      };
    }
    const loss = Math.round(r.points * numericPointValue * 100) / 100;
    return {
      user_id: r.user_id,
      seat_no: r.seat_no,
      points: r.points,
      is_winner: false,
      amount: -loss,
      transaction_type: 'game_loss_debit',
    };
  });

  const winnerGain = perPlayer.filter((p) => p.is_winner).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  logGame(sessionId, `Settlement starting — point_value=₹${numericPointValue} winner_pool=₹${winnerGain} winners=${winnerCount} players=${perPlayer.length}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '15s'");
    const botFlagMap = await adminLedgerService.loadSessionPlayerBotFlags(client, sessionId);
    const realHumanPoolCap = roundCurrency(
      perPlayer
        .filter((entry) => !entry.is_winner && !adminLedgerService.isUserBotFromMap(botFlagMap, entry.user_id))
        .reduce((sum, entry) => sum + Math.max(0, Number(entry.amount) * -1), 0)
    );

    for (const entry of perPlayer) {
      const isBotPlayer = adminLedgerService.isUserBotFromMap(botFlagMap, entry.user_id);
      if (isBotPlayer) continue;
      if (entry.is_winner) {
        // Credit winner's withdrawable wallet bucket
        const wallet = await lockOrCreateWalletByUserId(client, entry.user_id);
        if (!wallet) {
          warnGame(sessionId, `Winner wallet not found uid=${entry.user_id} — credit skipped`);
          continue;
        }
        await client.query(
          `UPDATE wallets
           SET withdrawable = withdrawable + $2,
               total_balance = total_balance + $2,
               updated_at    = NOW()
           WHERE id = $1`,
          [wallet.id, entry.amount]
        );
        await client.query(
          `INSERT INTO wallet_transactions
             (user_id, wallet_id, transaction_type, amount, source, reference_type, reference_id, metadata)
           VALUES ($1, $2, 'game_win_credit', $3, 'game', 'game_session', $4, $5::jsonb)`,
          [
            entry.user_id,
            wallet.id,
            entry.amount,
            sessionId,
            JSON.stringify({
              points: entry.points,
              point_value: numericPointValue,
              commission: entry.commission,
              gross_amount: entry.amount + entry.commission,
              role: 'winner'
            }),
          ]
        );
        logGame(sessionId, `✓ Credited winner uid=${entry.user_id} +₹${entry.amount} (${entry.points} pts × ₹${numericPointValue})`);
      } else {
        // Debit loser's deposit wallet.
        // Use GREATEST(0, ...) as a hard floor so the column never goes negative,
        // even in the unlikely edge-case of a concurrent settlement or data drift.
        const lossAmt = Math.abs(entry.amount);
        const wallet = await lockOrCreateWalletByUserId(client, entry.user_id);
        if (!wallet) {
          warnGame(sessionId, `Loser wallet not found uid=${entry.user_id} — debit skipped`);
          continue;
        }
        const debitSplit = computeWalletDebitSplit(wallet, lossAmt);
        if (debitSplit.available < lossAmt) {
          warnGame(
            sessionId,
            `Loser uid=${entry.user_id} has ₹${debitSplit.available} but owes ₹${lossAmt} — capping debit to available balance`
          );
        }
        const actualDebit = debitSplit.actualDebit;
        if (actualDebit <= 0) {
          warnGame(sessionId, `Loser uid=${entry.user_id} has zero balance — debit skipped`);
          continue;
        }
        const nextTotal = roundCurrency(Number(wallet.total_balance || 0) - actualDebit);
        await client.query(
          `UPDATE wallets
           SET deposit         = $2,
               released_bonus  = $3,
               withdrawable    = $4,
               total_balance     = $5,
               updated_at        = NOW()
           WHERE id = $1`,
          [
            wallet.id,
            debitSplit.nextDeposit,
            debitSplit.nextReleasedBonus,
            debitSplit.nextWithdrawable,
            nextTotal,
          ]
        );
        await releasePendingBonusAfterPlay(client, {
          userId: entry.user_id,
          sessionId,
          basisAmount: actualDebit,
          prelockedWallet: wallet,
          metadata: {
            based_on_loss_amount: actualDebit,
            role: 'loser',
            settlement: 'points_loss',
          },
        });
        await client.query(
          `INSERT INTO wallet_transactions
             (user_id, wallet_id, transaction_type, amount, source, reference_type, reference_id, metadata)
           VALUES ($1, $2, 'game_loss_debit', $3, 'game', 'game_session', $4, $5::jsonb)`,
          [
            entry.user_id,
            wallet.id,
            actualDebit,
            sessionId,
            JSON.stringify({ points: entry.points, point_value: numericPointValue, role: 'loser', original_loss: lossAmt }),
          ]
        );
        logGame(sessionId, `✓ Debited loser  uid=${entry.user_id} -₹${actualDebit} (${entry.points} pts × ₹${numericPointValue})`);
      }
    }

    await client.query('SAVEPOINT admin_ledger_points');
    try {
      await adminLedgerService.recordCommission(client, {
        sessionId,
        amount: totalCommission,
        mode: 'points',
      });
      let remainingBotCap = roundCurrency(realHumanPoolCap);
      for (const entry of perPlayer) {
        if (!entry.is_winner || !(Number(entry.amount) > 0)) continue;
        if (!adminLedgerService.isUserBotFromMap(botFlagMap, entry.user_id)) continue;
        const cappedAmount = roundCurrency(Math.min(Number(entry.amount) || 0, Math.max(0, remainingBotCap)));
        if (!(cappedAmount > 0)) continue;
        logGame(
          sessionId,
          `BOT_ADMIN_CREDIT mode=points uid=${entry.user_id} gross_win=₹${roundCurrency(Number(entry.amount) || 0)} cap=₹${realHumanPoolCap} credited=₹${cappedAmount}`
        );
        await adminLedgerService.recordBotWinCredit(client, {
          sessionId,
          userId: entry.user_id,
          amount: cappedAmount,
          mode: 'points',
        });
        remainingBotCap = roundCurrency(remainingBotCap - cappedAmount);
      }
      for (const entry of perPlayer) {
        if (entry.is_winner) continue;
        if (!adminLedgerService.isUserBotFromMap(botFlagMap, entry.user_id)) continue;
        const lossAmt = roundCurrency(Math.abs(Number(entry.amount) || 0));
        if (!(lossAmt > 0)) continue;
        logGame(
          sessionId,
          `BOT_ADMIN_DEBIT mode=points uid=${entry.user_id} loss=₹${lossAmt}`
        );
        await adminLedgerService.recordBotLossDebit(client, {
          sessionId,
          userId: entry.user_id,
          amount: lossAmt,
          mode: 'points',
        });
      }
      await client.query('RELEASE SAVEPOINT admin_ledger_points');
    } catch (ledgerErr) {
      await client.query('ROLLBACK TO SAVEPOINT admin_ledger_points');
      warnGame(sessionId, `Admin ledger (points) skipped: ${ledgerErr.message}`);
    }

    await client.query('COMMIT');
    logGame(sessionId, `Settlement committed successfully — winner uid=${winnerUserId} net_pool=+₹${winnerGain} winners=${winnerCount}`);

    return {
      point_value: numericPointValue,
      winner_user_id: winnerUserId,
      winner_gain: winnerGain,
      is_tie: winnerCount > 1,
      tied_user_ids: winnerCount > 1 ? winners.map((w) => Number(w.user_id)).filter((id) => !Number.isNaN(id)) : [],
      per_player: perPlayer.map((p) => ({
        user_id: p.user_id,
        seat_no: p.seat_no,
        points: p.points,
        is_winner: p.is_winner,
        amount: p.amount,
        ...(p.commission !== undefined && { commission: p.commission }),
      })),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    errorGame(sessionId, `Settlement FAILED, rolled back: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

async function settlePoolPotResult(session = {}, winnerUserId = null) {
  const sessionId = session?.id;
  if (!sessionId || !winnerUserId) return null;
  if (!pool) {
    warnGame(sessionId, 'Pool settlement skipped — DATABASE_URL not configured');
    return null;
  }

  const entryFee = Number(session?.contest?.entry);
  const playerCount = resolvePoolBaseEntryCount(session);
  const rejoinEntryCount = resolvePoolRejoinEntryCount(session?.metadata || {});
  const totalEntries = playerCount + rejoinEntryCount;
  if (!Number.isFinite(entryFee) || entryFee <= 0 || totalEntries <= 0) {
    warnGame(
      sessionId,
      `Pool settlement skipped — invalid entry=${entryFee} players=${playerCount} rejoins=${rejoinEntryCount}`
    );
    return null;
  }

  const totalEntry = roundCurrency(entryFee * totalEntries);
  const commissionAmount = roundCurrency(totalEntry * 0.12);
  const winnerAmount = roundCurrency(totalEntry - commissionAmount);
  if (winnerAmount <= 0) {
    warnGame(sessionId, `Pool settlement skipped — winner amount non-positive (${winnerAmount})`);
    return null;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '15s'");
    const winnerIsBot = isBotTurn(session, winnerUserId);
    const realHumanPoolCap = await resolveHumanEntryPoolForSession(client, session);

    if (!winnerIsBot) {
      const wallet = await lockOrCreateWalletByUserId(client, winnerUserId);
      if (!wallet) {
        warnGame(sessionId, `Pool winner wallet not found uid=${winnerUserId} — settlement skipped`);
        await client.query('ROLLBACK');
        return null;
      }

      await client.query(
        `UPDATE wallets
         SET withdrawable = withdrawable + $2,
             total_balance = total_balance + $2,
             updated_at    = NOW()
         WHERE id = $1`,
        [wallet.id, winnerAmount]
      );
      await client.query(
        `INSERT INTO wallet_transactions
           (user_id, wallet_id, transaction_type, amount, source, reference_type, reference_id, metadata)
         VALUES ($1, $2, 'game_win_credit', $3, 'game', 'game_session', $4, $5::jsonb)`,
        [
          winnerUserId,
          wallet.id,
          winnerAmount,
          sessionId,
          JSON.stringify({
            mode: 'pool',
            settlement_type: 'pool_pot',
            entry_fee: entryFee,
            player_count: playerCount,
            rejoin_entry_count: rejoinEntryCount,
            total_entries: totalEntries,
            total_entry: totalEntry,
            commission_percent: 12,
            commission_amount: commissionAmount,
          }),
        ]
      );
    }

    const loserUserIds = resolveNonWinningJoinedUserIds(session, winnerUserId);
    const loserPerPlayer = [];
    for (const uid of loserUserIds) {
      if (isBotTurn(session, uid)) {
        const safeEntryFee = roundCurrency(Number.isFinite(entryFee) ? entryFee : 0);
        if (safeEntryFee > 0) {
          loserPerPlayer.push({
            user_id: uid,
            amount: -safeEntryFee,
            is_winner: false,
          });
        }
        continue;
      }
      let basis = await resolveEntryFeesPaidForSession(client, uid, sessionId);
      if (!(basis > 0)) basis = roundCurrency(Number.isFinite(entryFee) ? entryFee : 0);
      if (!(basis > 0)) continue;
      loserPerPlayer.push({
        user_id: uid,
        amount: -basis,
        is_winner: false,
      });
      await releasePendingBonusAfterPlay(client, {
        userId: uid,
        sessionId,
        basisAmount: basis,
        metadata: {
          mode: 'pool',
          role: 'loser',
          settlement: 'pool_pot_complete',
        },
      });
    }

    await client.query('SAVEPOINT admin_ledger_pool');
    try {
      await adminLedgerService.recordCommission(client, {
        sessionId,
        amount: commissionAmount,
        mode: 'pool',
      });
      if (winnerIsBot) {
        const cappedBotAmount = roundCurrency(Math.min(winnerAmount, realHumanPoolCap));
        if (cappedBotAmount > 0) {
        logGame(
          sessionId,
          `BOT_ADMIN_CREDIT mode=pool uid=${winnerUserId} gross_win=₹${winnerAmount} cap=₹${realHumanPoolCap} credited=₹${cappedBotAmount}`
        );
        await adminLedgerService.recordBotWinCredit(client, {
          sessionId,
          userId: winnerUserId,
            amount: cappedBotAmount,
          mode: 'pool',
        });
        }
      } else {
        const safeEntryFee = roundCurrency(Number.isFinite(entryFee) ? entryFee : 0);
        const losingBotIds = resolveNonWinningJoinedUserIds(session, winnerUserId)
          .filter((uid) => isBotTurn(session, uid));
        for (const botUid of losingBotIds) {
          if (!(safeEntryFee > 0)) continue;
          logGame(
            sessionId,
            `BOT_ADMIN_DEBIT mode=pool uid=${botUid} loss=₹${safeEntryFee}`
          );
          await adminLedgerService.recordBotLossDebit(client, {
            sessionId,
            userId: botUid,
            amount: safeEntryFee,
            mode: 'pool',
          });
        }
      }
      await client.query('RELEASE SAVEPOINT admin_ledger_pool');
    } catch (ledgerErr) {
      await client.query('ROLLBACK TO SAVEPOINT admin_ledger_pool');
      warnGame(sessionId, `Admin ledger (pool) skipped: ${ledgerErr.message}`);
    }

    await client.query('COMMIT');
    return {
      settlement_type: 'pool_pot',
      winner_user_id: winnerUserId,
      entry_fee: entryFee,
      player_count: playerCount,
      rejoin_entry_count: rejoinEntryCount,
      total_entries: totalEntries,
      total_entry: totalEntry,
      commission_percent: 12,
      commission_amount: commissionAmount,
      winner_gain: winnerAmount,
      per_player: [
        {
          user_id: winnerUserId,
          amount: winnerAmount,
          is_winner: true,
        },
        ...loserPerPlayer,
      ],
    };
  } catch (err) {
    await client.query('ROLLBACK');
    errorGame(sessionId, `Pool settlement FAILED, rolled back: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

async function settlePoolSplitResult(session = {}, splitRows = [], offerId = null) {
  const sessionId = session?.id;
  if (!sessionId || !Array.isArray(splitRows) || splitRows.length === 0) return null;
  if (!pool) {
    warnGame(sessionId, 'Pool split settlement skipped — DATABASE_URL not configured');
    return null;
  }

  const payableRows = splitRows
    .map((row) => ({
      user_id: Number(row?.user_id),
      amount: roundCurrency(Number(row?.split_amount) || 0),
    }))
    .filter((row) => !Number.isNaN(row.user_id) && row.amount > 0);
  if (payableRows.length === 0) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '15s'");
    const realHumanPoolCap = await resolveHumanEntryPoolForSession(client, session);
    let remainingBotCap = roundCurrency(realHumanPoolCap);

    const entryFeeForSplit = roundCurrency(Number(session?.contest?.entry) || 0);
    const paidBotUserIds = new Set();

    for (const row of payableRows) {
      if (isBotTurn(session, row.user_id)) {
        paidBotUserIds.add(Number(row.user_id));
        const cappedBotAmount = roundCurrency(Math.min(Number(row.amount) || 0, Math.max(0, remainingBotCap)));
        if (cappedBotAmount > 0) {
          logGame(
            sessionId,
            `BOT_ADMIN_CREDIT mode=pool_split uid=${row.user_id} gross_win=₹${roundCurrency(Number(row.amount) || 0)} cap_remaining=₹${remainingBotCap} credited=₹${cappedBotAmount}`
          );
          await adminLedgerService.recordBotWinCredit(client, {
            sessionId,
            userId: row.user_id,
            amount: cappedBotAmount,
            mode: 'pool',
          });
          remainingBotCap = roundCurrency(remainingBotCap - cappedBotAmount);
        }
        continue;
      }
      const wallet = await lockOrCreateWalletByUserId(client, row.user_id);
      if (!wallet) {
        warnGame(sessionId, `Pool split wallet not found uid=${row.user_id} — settlement skipped`);
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        `UPDATE wallets
         SET withdrawable = withdrawable + $2,
             total_balance = total_balance + $2,
             updated_at    = NOW()
         WHERE id = $1`,
        [wallet.id, row.amount]
      );
      await client.query(
        `INSERT INTO wallet_transactions
           (user_id, wallet_id, transaction_type, amount, source, reference_type, reference_id, metadata)
         VALUES ($1, $2, 'game_win_credit', $3, 'game', 'game_session', $4, $5::jsonb)`,
        [
          row.user_id,
          wallet.id,
          row.amount,
          sessionId,
          JSON.stringify({
            mode: 'pool',
            settlement_type: 'pool_split',
            offer_id: offerId || null,
            split_user_count: payableRows.length,
          }),
        ]
      );
    }

    // Bots that received no split payout lost their stake (entry).
    if (entryFeeForSplit > 0) {
      const players = Array.isArray(session?.players) ? session.players : [];
      for (const player of players) {
        const botUid = Number(player?.user_id);
        if (Number.isNaN(botUid)) continue;
        if (!isBotTurn(session, botUid)) continue;
        if (paidBotUserIds.has(botUid)) continue;
        if (!['joined', 'disconnected', 'eliminated', 'left'].includes(player?.status)) continue;
        logGame(
          sessionId,
          `BOT_ADMIN_DEBIT mode=pool_split uid=${botUid} loss=₹${entryFeeForSplit}`
        );
        await adminLedgerService.recordBotLossDebit(client, {
          sessionId,
          userId: botUid,
          amount: entryFeeForSplit,
          mode: 'pool',
        });
      }
    }

    await client.query('COMMIT');
    return {
      settlement_type: 'pool_split',
      offer_id: offerId || null,
      per_player: payableRows.map((row) => ({
        user_id: row.user_id,
        amount: row.amount,
        is_winner: false,
      })),
      total_amount: roundCurrency(payableRows.reduce((sum, row) => sum + row.amount, 0)),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    errorGame(sessionId, `Pool split settlement FAILED, rolled back: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

async function persistSplitOfferMetadata(sessionId, splitOffer = null) {
  const session = await gameplayService.getSessionState(sessionId);
  if (!session) return;
  const nextMetadata = {
    ...(session.metadata || {}),
    split_offer: splitOffer,
  };
  await gameSessionModel.updateSessionStatus(sessionId, session.status, {
    metadata: nextMetadata,
  });
}

async function settleDealsPotResult(session = {}, finalizedResults = [], winnerUserId = null) {
  const sessionId = session?.id;
  if (!sessionId) return null;
  if (!pool) {
    warnGame(sessionId, 'Deals settlement skipped — DATABASE_URL not configured');
    return null;
  }

  const winners = (Array.isArray(finalizedResults) ? finalizedResults : []).filter((row) => row?.is_winner === true);
  const tiedWinnerIds = winners
    .map((row) => Number(row?.user_id))
    .filter((id) => !Number.isNaN(id));
  if (tiedWinnerIds.length === 0) {
    warnGame(sessionId, 'Deals settlement skipped — no winner in final results');
    return null;
  }

  const participants = (Array.isArray(finalizedResults) ? finalizedResults : []).filter((row) => Number.isFinite(Number(row?.user_id)));
  const entryFee = roundCurrency(Number(session?.contest?.entry) || 0);
  const playerCount = participants.length;
  if (entryFee <= 0 || playerCount <= 0) {
    warnGame(sessionId, `Deals settlement skipped — invalid entry=${entryFee} players=${playerCount}`);
    return null;
  }

  const totalEntry = roundCurrency(entryFee * playerCount);
  const totalCommission = roundCurrency(totalEntry * 0.12);
  const totalWinnerPool = roundCurrency(totalEntry - totalCommission);
  if (totalWinnerPool <= 0) {
    warnGame(sessionId, `Deals settlement skipped — winner pool non-positive (${totalWinnerPool})`);
    return null;
  }

  const winnerCount = tiedWinnerIds.length;
  const winnerShare = roundCurrency(totalWinnerPool / winnerCount);
  const lastWinnerShare = roundCurrency(totalWinnerPool - (winnerShare * (winnerCount - 1)));
  const commissionShare = roundCurrency(totalCommission / winnerCount);
  const lastCommissionShare = roundCurrency(totalCommission - (commissionShare * (winnerCount - 1)));

  const sortedWinners = winners
    .slice()
    .sort((a, b) => (Number(a?.seat_no) || 0) - (Number(b?.seat_no) || 0));
  const winnerRank = new Map(
    sortedWinners.map((row, idx) => [Number(row.user_id), idx])
  );

  const perPlayer = participants.map((row) => {
    const userId = Number(row.user_id);
    const isWinner = tiedWinnerIds.includes(userId);
    if (!isWinner) {
      return {
        user_id: row.user_id,
        seat_no: row.seat_no,
        points: row.points,
        is_winner: false,
        amount: -roundCurrency(Number.isFinite(entryFee) ? entryFee : 0),
        transaction_type: 'game_loss_debit',
      };
    }
    const rank = winnerRank.get(userId) || 0;
    const isLastWinner = rank === Math.max(0, winnerCount - 1);
    return {
      user_id: row.user_id,
      seat_no: row.seat_no,
      points: row.points,
      is_winner: true,
      amount: isLastWinner ? lastWinnerShare : winnerShare,
      commission: isLastWinner ? lastCommissionShare : commissionShare,
      transaction_type: 'game_win_credit',
    };
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '15s'");
    const realHumanPoolCap = await resolveHumanEntryPoolForSession(client, session);
    let remainingBotCap = roundCurrency(realHumanPoolCap);

    for (const entry of perPlayer) {
      if (!entry.is_winner || Number(entry.amount) <= 0) continue;
      if (isBotTurn(session, entry.user_id)) continue;

      const wallet = await lockOrCreateWalletByUserId(client, entry.user_id);
      if (!wallet) {
        warnGame(sessionId, `Deals winner wallet not found uid=${entry.user_id} — credit skipped`);
        continue;
      }

      await client.query(
        `UPDATE wallets
         SET withdrawable = withdrawable + $2,
             total_balance = total_balance + $2,
             updated_at    = NOW()
         WHERE id = $1`,
        [wallet.id, entry.amount]
      );
      await client.query(
        `INSERT INTO wallet_transactions
           (user_id, wallet_id, transaction_type, amount, source, reference_type, reference_id, metadata)
         VALUES ($1, $2, 'game_win_credit', $3, 'game', 'game_session', $4, $5::jsonb)`,
        [
          entry.user_id,
          wallet.id,
          entry.amount,
          sessionId,
          JSON.stringify({
            mode: 'deals_2',
            settlement_type: winnerCount > 1 ? 'deals_tie_split' : 'deals_single_winner',
            entry_fee: entryFee,
            player_count: playerCount,
            total_entry: totalEntry,
            commission_percent: 12,
            commission_amount: entry.commission,
            total_commission: totalCommission,
            tied_winner_count: winnerCount,
          }),
        ]
      );
    }

    for (const entry of perPlayer) {
      if (entry.is_winner) continue;
      const uid = Number(entry.user_id);
      if (Number.isNaN(uid)) continue;
      if (isBotTurn(session, uid)) continue;
      let basis = await resolveEntryFeesPaidForSession(client, uid, sessionId);
      if (!(basis > 0)) basis = entryFee;
      await releasePendingBonusAfterPlay(client, {
        userId: uid,
        sessionId,
        basisAmount: basis,
        metadata: {
          mode: 'deals_2',
          role: 'loser',
          settlement: 'deals_pot_complete',
        },
      });
    }

    await client.query('SAVEPOINT admin_ledger_deals');
    try {
      await adminLedgerService.recordCommission(client, {
        sessionId,
        amount: totalCommission,
        mode: 'deals_2',
      });
      for (const entry of perPlayer) {
        if (!entry.is_winner || !(Number(entry.amount) > 0)) continue;
        if (!isBotTurn(session, entry.user_id)) continue;
        const cappedBotAmount = roundCurrency(Math.min(Number(entry.amount) || 0, Math.max(0, remainingBotCap)));
        if (!(cappedBotAmount > 0)) continue;
        logGame(
          sessionId,
          `BOT_ADMIN_CREDIT mode=deals uid=${entry.user_id} gross_win=₹${roundCurrency(Number(entry.amount) || 0)} cap_remaining=₹${remainingBotCap} credited=₹${cappedBotAmount}`
        );
        await adminLedgerService.recordBotWinCredit(client, {
          sessionId,
          userId: entry.user_id,
          amount: cappedBotAmount,
          mode: 'deals_2',
        });
        remainingBotCap = roundCurrency(remainingBotCap - cappedBotAmount);
      }
      for (const entry of perPlayer) {
        if (entry.is_winner) continue;
        if (!isBotTurn(session, entry.user_id)) continue;
        if (!(entryFee > 0)) continue;
        logGame(
          sessionId,
          `BOT_ADMIN_DEBIT mode=deals uid=${entry.user_id} loss=₹${entryFee}`
        );
        await adminLedgerService.recordBotLossDebit(client, {
          sessionId,
          userId: entry.user_id,
          amount: entryFee,
          mode: 'deals_2',
        });
      }
      await client.query('RELEASE SAVEPOINT admin_ledger_deals');
    } catch (ledgerErr) {
      await client.query('ROLLBACK TO SAVEPOINT admin_ledger_deals');
      warnGame(sessionId, `Admin ledger (deals) skipped: ${ledgerErr.message}`);
    }

    await client.query('COMMIT');
    return {
      settlement_type: winnerCount > 1 ? 'deals_tie_split' : 'deals_single_winner',
      winner_user_id: winnerUserId,
      winner_gain: totalWinnerPool,
      is_tie: winnerCount > 1,
      tied_user_ids: winnerCount > 1 ? tiedWinnerIds : [],
      entry_fee: entryFee,
      player_count: playerCount,
      total_entry: totalEntry,
      commission_percent: 12,
      commission_amount: totalCommission,
      per_player: perPlayer.map((p) => ({
        user_id: p.user_id,
        seat_no: p.seat_no,
        points: p.points,
        is_winner: p.is_winner,
        amount: p.amount,
        ...(p.commission !== undefined && { commission: p.commission }),
      })),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    errorGame(sessionId, `Deals settlement FAILED, rolled back: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

async function settleSpinGoResult(session = {}, winnerUserId = null) {
  const sessionId = session?.id;
  if (!sessionId || !winnerUserId) return null;
  if (!pool) {
    warnGame(sessionId, 'Spin & Go settlement skipped — DATABASE_URL not configured');
    return null;
  }

  const prizeAmountRaw = Number(session?.contest?.win_upto);
  const prizeAmount = Number.isFinite(prizeAmountRaw) && prizeAmountRaw > 0
    ? roundCurrency(prizeAmountRaw)
    : 0;
  if (prizeAmount <= 0) {
    warnGame(sessionId, `Spin & Go settlement skipped — invalid win_upto=${session?.contest?.win_upto}`);
    return null;
  }

  const entryFee = Number(session?.contest?.entry);
  const playerCount = Array.isArray(session?.players) ? session.players.length : 0;
  const multiplierX = (
    Number.isFinite(entryFee) && entryFee > 0
      ? roundCurrency(prizeAmount / entryFee)
      : null
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '15s'");
    const winnerIsBot = isBotTurn(session, winnerUserId);
    const realHumanPoolCap = await resolveHumanEntryPoolForSession(client, session);

    if (!winnerIsBot) {
      const wallet = await lockOrCreateWalletByUserId(client, winnerUserId);
      if (!wallet) {
        warnGame(sessionId, `Spin & Go winner wallet not found uid=${winnerUserId} — settlement skipped`);
        await client.query('ROLLBACK');
        return null;
      }

      await client.query(
        `UPDATE wallets
         SET withdrawable = withdrawable + $2,
             total_balance = total_balance + $2,
             updated_at    = NOW()
         WHERE id = $1`,
        [wallet.id, prizeAmount]
      );

      await client.query(
        `INSERT INTO wallet_transactions
           (user_id, wallet_id, transaction_type, amount, source, reference_type, reference_id, metadata)
         VALUES ($1, $2, 'game_win_credit', $3, 'game', 'game_session', $4, $5::jsonb)`,
        [
          winnerUserId,
          wallet.id,
          prizeAmount,
          sessionId,
          JSON.stringify({
            mode: 'spin_go',
            settlement_type: 'spin_go_multiplier',
            entry_fee: Number.isFinite(entryFee) ? roundCurrency(entryFee) : null,
            player_count: playerCount > 0 ? playerCount : null,
            multiplier_x: Number.isFinite(multiplierX) && multiplierX > 0 ? multiplierX : null,
            win_upto: prizeAmount,
          }),
        ]
      );
    }

    const spinLoserIds = resolveNonWinningJoinedUserIds(session, winnerUserId);
    const safeEntryFee = Number.isFinite(entryFee) ? roundCurrency(entryFee) : 0;
    const spinLoserPerPlayer = [];
    for (const uid of spinLoserIds) {
      if (isBotTurn(session, uid)) {
        if (safeEntryFee > 0) {
          spinLoserPerPlayer.push({
            user_id: uid,
            amount: -safeEntryFee,
            is_winner: false,
          });
        }
        continue;
      }
      let basis = await resolveEntryFeesPaidForSession(client, uid, sessionId);
      if (!(basis > 0)) basis = safeEntryFee;
      if (!(basis > 0)) continue;
      spinLoserPerPlayer.push({
        user_id: uid,
        amount: -basis,
        is_winner: false,
      });
      await releasePendingBonusAfterPlay(client, {
        userId: uid,
        sessionId,
        basisAmount: basis,
        metadata: {
          mode: 'spin_go',
          role: 'loser',
          settlement: 'spin_go_complete',
        },
      });
    }

    await client.query('SAVEPOINT admin_ledger_spin');
    try {
      if (winnerIsBot) {
        const cappedBotAmount = roundCurrency(Math.min(prizeAmount, realHumanPoolCap));
        if (cappedBotAmount > 0) {
        logGame(
          sessionId,
          `BOT_ADMIN_CREDIT mode=spin_go uid=${winnerUserId} gross_win=₹${prizeAmount} cap=₹${realHumanPoolCap} credited=₹${cappedBotAmount}`
        );
        await adminLedgerService.recordBotWinCredit(client, {
          sessionId,
          userId: winnerUserId,
            amount: cappedBotAmount,
          mode: 'spin_go',
        });
        }
      } else {
        const botLossAmount = safeEntryFee > 0 ? safeEntryFee : 0;
        const losingBotIds = spinLoserIds.filter((uid) => isBotTurn(session, uid));
        for (const botUid of losingBotIds) {
          if (!(botLossAmount > 0)) continue;
          logGame(
            sessionId,
            `BOT_ADMIN_DEBIT mode=spin_go uid=${botUid} loss=₹${botLossAmount}`
          );
          await adminLedgerService.recordBotLossDebit(client, {
            sessionId,
            userId: botUid,
            amount: botLossAmount,
            mode: 'spin_go',
          });
        }
      }
      await client.query('RELEASE SAVEPOINT admin_ledger_spin');
    } catch (ledgerErr) {
      await client.query('ROLLBACK TO SAVEPOINT admin_ledger_spin');
      warnGame(sessionId, `Admin ledger (spin_go) skipped: ${ledgerErr.message}`);
    }

    await client.query('COMMIT');
    return {
      settlement_type: 'spin_go_multiplier',
      winner_user_id: winnerUserId,
      entry_fee: Number.isFinite(entryFee) ? roundCurrency(entryFee) : null,
      player_count: playerCount > 0 ? playerCount : null,
      multiplier_x: Number.isFinite(multiplierX) && multiplierX > 0 ? multiplierX : null,
      winner_gain: prizeAmount,
      per_player: [
        {
          user_id: winnerUserId,
          amount: prizeAmount,
          is_winner: true,
        },
        ...spinLoserPerPlayer,
      ],
    };
  } catch (err) {
    await client.query('ROLLBACK');
    errorGame(sessionId, `Spin & Go settlement FAILED, rolled back: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

async function processPoolRejoinRequest({ sessionId, userId }) {
  if (!pool) {
    const err = new Error('Pool rejoin unavailable — DATABASE_URL not configured');
    err.code = 'POOL_REJOIN_UNAVAILABLE';
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '15s'");

    const sessionRes = await client.query(
      `SELECT
         gs.*,
         g.name AS game_name,
         c.entry AS contest_entry
       FROM game_sessions gs
       JOIN games g ON g.id = gs.game_id
       LEFT JOIN contests c ON c.id = gs.contest_id
       WHERE gs.id = $1
       FOR UPDATE OF gs`,
      [sessionId]
    );
    const sessionRow = sessionRes.rows[0] || null;
    if (!sessionRow) {
      const err = new Error('Session not found');
      err.code = 'SESSION_NOT_FOUND';
      throw err;
    }

    const sessionMetadata = sessionRow.metadata || {};
    const mode = resolveSessionGameMode({
      metadata: sessionMetadata,
      game: { name: sessionRow.game_name },
    });
    if (mode !== 'pool') {
      const err = new Error('Pool rejoin is available only in pool tables');
      err.code = 'INVALID_REJOIN_MODE';
      throw err;
    }

    const phase = String(sessionMetadata?.phase || '').toLowerCase();
    if (!['inter_deal', 'countdown'].includes(phase)) {
      const err = new Error('Rejoin window closed');
      err.code = 'REJOIN_WINDOW_CLOSED';
      throw err;
    }

    const playersRes = await client.query(
      `SELECT *
       FROM game_session_players
       WHERE game_session_id = $1
       ORDER BY seat_no ASC
       FOR UPDATE`,
      [sessionId]
    );
    const players = playersRes.rows || [];
    const targetPlayer = players.find((player) => Number(player.user_id) === Number(userId)) || null;
    if (!targetPlayer) {
      const err = new Error('Player not found in session');
      err.code = 'PLAYER_NOT_FOUND';
      throw err;
    }

    const poolScoresByUser = normalizePoolScoresByUser(sessionMetadata);
    const poolEliminatedUserIds = (
      Array.isArray(sessionMetadata?.pool_eliminated_user_ids)
        ? sessionMetadata.pool_eliminated_user_ids
        : []
    )
      .map((id) => Number(id))
      .filter((id) => !Number.isNaN(id));
    const poolLimit = resolvePoolLimit({
      metadata: sessionMetadata,
      game: { name: sessionRow.game_name },
    });
    const rejoinContext = buildPoolRejoinContext({
      players,
      scoresByUser: poolScoresByUser,
      eliminatedUserIds: poolEliminatedUserIds,
      poolLimit,
    });
    const rejoinCandidateSet = new Set(
      (rejoinContext.rejoin_candidate_user_ids || [])
        .map((id) => Number(id))
        .filter((id) => !Number.isNaN(id))
    );
    if (!rejoinCandidateSet.has(Number(userId))) {
      const err = new Error('Player is not eligible to rejoin this round');
      err.code = 'POOL_REJOIN_NOT_ELIGIBLE';
      throw err;
    }

    const rejoinScore = Number(rejoinContext.rejoin_start_points_by_user?.[String(userId)]);
    if (!Number.isFinite(rejoinScore) || rejoinScore < 0) {
      const err = new Error('Unable to resolve rejoin score');
      err.code = 'POOL_REJOIN_SCORE_INVALID';
      throw err;
    }

    const entryFee = roundCurrency(Number(sessionRow.contest_entry) || 0);
    const currentRejoinEntryCount = resolvePoolRejoinEntryCount(sessionMetadata);
    const nextRejoinEntryCount = entryFee > 0
      ? currentRejoinEntryCount + 1
      : currentRejoinEntryCount;
    if (entryFee > 0) {
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
        [userId, wallet.id, -entryFee, sessionId, JSON.stringify({
          reason: 'pool_rejoin_entry_debit',
          mode: 'pool',
          session_id: sessionId,
          contest_id: sessionRow.contest_id,
          entry_fee: entryFee,
          rejoin_score: rejoinScore,
          rejoin_threshold: rejoinContext.rejoin_threshold ?? null,
        })]
      );
    }

    const nextPoolEliminatedUserIds = poolEliminatedUserIds.filter((id) => Number(id) !== Number(userId));
    const nextPoolScoresByUser = {
      ...poolScoresByUser,
      [String(userId)]: rejoinScore,
    };
    const nextMetadata = {
      ...sessionMetadata,
      pool_scores_by_user: nextPoolScoresByUser,
      pool_eliminated_user_ids: nextPoolEliminatedUserIds,
      pool_rejoin_entry_count: nextRejoinEntryCount,
      phase_updated_at: new Date().toISOString(),
    };
    await client.query(
      `UPDATE game_sessions
       SET metadata = $2::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [sessionId, JSON.stringify(nextMetadata)]
    );

    const nextPlayerMetadata = resetPlayerMetadataForNextDeal(targetPlayer.metadata || {});
    await client.query(
      `UPDATE game_session_players
       SET status = 'joined',
           left_at = NULL,
           metadata = $3::jsonb
       WHERE game_session_id = $1
         AND user_id = $2`,
      [sessionId, userId, JSON.stringify(nextPlayerMetadata)]
    );

    await client.query(
      `INSERT INTO game_session_events (game_session_id, user_id, event_type, payload)
       VALUES ($1, $2, 'pool_rejoin', $3::jsonb)`,
      [sessionId, userId, JSON.stringify({
        user_id: userId,
        rejoin_score: rejoinScore,
        phase,
      })]
    );

    await client.query('COMMIT');
    if (sessionCache.isEnabled()) await sessionCache.invalidate(sessionId);
    if (liveSessionState.isEnabled()) await liveSessionState.drop(sessionId);
    const baseEntryCount = players.filter((player) => ['joined', 'disconnected', 'eliminated', 'left'].includes(player?.status)).length;
    const prizePoolSummary = buildPoolPrizePoolSummary({
      entryFee,
      baseEntryCount,
      rejoinEntryCount: nextRejoinEntryCount,
      projectedExtraEntries: 0,
    });
    return {
      sessionId,
      userId,
      rejoinScore,
      joiningFee: entryFee,
      rejoinThreshold: rejoinContext.rejoin_threshold ?? null,
      poolScoresByUser: nextPoolScoresByUser,
      poolEliminatedUserIds: nextPoolEliminatedUserIds,
      poolRejoinEntryCount: nextRejoinEntryCount,
      prizePoolSummary,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function clearPoolSplitStartTimer(sessionId) {
  const pending = pendingPoolSplitStartBySession.get(sessionId);
  if (!pending) return;
  if (pending.startTimeoutHandle) {
    clearTimeout(pending.startTimeoutHandle);
  }
  pendingPoolSplitStartBySession.delete(sessionId);
}

async function continuePoolDealFlow(io, sessionId, preferredFirstTurnUserId = null, reason = 'split_not_used', options = {}) {
  const preserveSplitStartWindow = options.preserveSplitStartWindow === true;
  const countdownSeconds = Math.max(1, Number(options.countdownSeconds) || POOL_NEXT_DEAL_COUNTDOWN_SECONDS);
  if (!preserveSplitStartWindow) {
    clearPoolSplitStartTimer(sessionId);
  }
  const splitState = activePoolSplitBySession.get(sessionId);
  if (splitState?.timeoutHandle) {
    clearTimeout(splitState.timeoutHandle);
  }
  activePoolSplitBySession.delete(sessionId);

  const maxAttempts = Math.max(1, Number(options.pregameRetryAttempts) || 3);
  const retryDelayMs = Math.max(250, Number(options.pregameRetryDelayMs) || 750);
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await startPregame(io, sessionId, {
        interDealFastStart: true,
        preferredFirstTurnUserId: preferredFirstTurnUserId || null,
        countdownSeconds,
      });
      return;
    } catch (pregameErr) {
      lastErr = pregameErr;
      errorGame(
        sessionId,
        `Failed to start next pool round pregame (${reason}) attempt=${attempt}/${maxAttempts}: ${pregameErr.message}`
      );
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  }
  if (lastErr) {
    errorGame(sessionId, `Gave up starting next pool round pregame (${reason}): ${lastErr.message}`);
  }
}

function emitPoolSplitState(io, sessionId, state, reason = 'state') {
  if (!state) return null;
  const acceptedSet = new Set((state.accepted_user_ids || []).map((id) => Number(id)));
  const rejectedSet = new Set((state.rejected_user_ids || []).map((id) => Number(id)));
  const rows = (state.rows || []).map((row) => {
    const userId = Number(row.user_id);
    let decision = 'pending';
    if (acceptedSet.has(userId)) decision = 'accepted';
    if (rejectedSet.has(userId)) decision = 'rejected';
    return {
      ...row,
      decision,
    };
  });
  const payload = {
    session_id: sessionId,
    server_time: new Date().toISOString(),
    event: 'pool:split:state',
    reason,
    offer_id: state.offer_id,
    status: state.status,
    started_at: state.started_at,
    expires_at: state.expires_at,
    initiated_by_user_id: state.initiated_by_user_id,
    eligible_user_ids: state.eligible_user_ids || [],
    accepted_user_ids: state.accepted_user_ids || [],
    rejected_user_ids: state.rejected_user_ids || [],
    rows,
    total_split_amount: state.total_split_amount || 0,
    pending_user_ids: (state.eligible_user_ids || []).filter(
      (userId) => !acceptedSet.has(Number(userId)) && !rejectedSet.has(Number(userId))
    ),
  };
  io.to(sessionRoom(sessionId)).emit('pool:split:state', payload);
  return payload;
}

function shouldBotAcceptSplitOffer(session = {}, state = {}, userId) {
  // Bots only accept when the split is not a loss for admin.
  const protection = evaluateAdminProfitProtection(session, state?.rows || [], {
    participantUserIds: state?.eligible_user_ids || [],
  });
  return protection.decision === 'ACCEPT';
}

function buildSplitOfferExplainability(session = {}, state = {}, userId) {
  const rows = Array.isArray(state?.rows) ? state.rows : [];
  const row = rows.find((entry) => Number(entry?.user_id) === Number(userId));
  const splitAmount = Number(row?.amount) || Number(row?.split_amount) || 0;
  const dropsRemaining = Number(row?.drops_remaining);
  const entryFee = roundCurrency(Number(session?.contest?.entry) || 0);
  const scoreByUser = session?.metadata?.pool_scores_by_user || {};
  const totalScore = Number(scoreByUser[String(userId)]) || 0;
  const poolLimit = resolvePoolLimit(session);
  const nearElimination = Number.isFinite(poolLimit) && (poolLimit - totalScore) <= 18;
  const minGain = entryFee > 0 ? roundCurrency(entryFee * BOT_SPLIT_MIN_GAIN_MULTIPLIER) : 0;

  return {
    has_row: Boolean(row),
    split_amount: splitAmount,
    drops_remaining: dropsRemaining,
    entry_fee: entryFee,
    pool_total_score: totalScore,
    pool_limit: poolLimit,
    near_elimination: nearElimination,
    min_gain_threshold: minGain,
    rule_near_elim: nearElimination && splitAmount > 0,
    rule_low_drops: Number.isFinite(dropsRemaining) && dropsRemaining <= 1 && splitAmount > 0,
    rule_min_gain: splitAmount >= minGain && splitAmount > 0,
  };
}

function scheduleBotSplitAutoResponses(io, sessionId, offerId) {
  const initialState = activePoolSplitBySession.get(sessionId);
  if (!initialState || initialState.offer_id !== offerId) return;

  gameplayService.getSessionState(sessionId).then((session) => {
    if (!session) return;

    const botCandidates = (session.players || [])
      .filter((player) => player?.metadata?.is_bot === true)
      .map((player) => Number(player.user_id))
      .filter((userId) => !Number.isNaN(userId));

    const eligibleSet = new Set((initialState.eligible_user_ids || []).map((id) => Number(id)));
    const pendingBotUserIds = botCandidates.filter((userId) => eligibleSet.has(userId));

    pendingBotUserIds.forEach((userId, index) => {
      const delay = randomIntBetween(BOT_SPLIT_AUTO_RESPONSE_MIN_MS, BOT_SPLIT_AUTO_RESPONSE_MAX_MS) + (index * 120);
      setTimeout(async () => {
        const state = activePoolSplitBySession.get(sessionId);
        if (!state || state.offer_id !== offerId) return;

        const acceptedSet = new Set((state.accepted_user_ids || []).map((id) => Number(id)));
        const rejectedSet = new Set((state.rejected_user_ids || []).map((id) => Number(id)));
        if (acceptedSet.has(userId) || rejectedSet.has(userId)) return;

        const freshSession = await gameplayService.getSessionState(sessionId);
        if (!freshSession) return;

        const protection = evaluateAdminProfitProtection(freshSession, state?.rows || [], {
          participantUserIds: state?.eligible_user_ids || [],
        });
        logGame(sessionId, `[SPLIT_PROTECTION] ${JSON.stringify(protection)}`);
        if (protection.decision !== 'ACCEPT') {
          const splitExplainBlocked = buildSplitOfferExplainability(freshSession, state, userId);
          logBotDecisionExplainability(sessionId, {
            phase: 'split',
            user_id: userId,
            offer_id: offerId,
            decision: 'reject',
            explain: {
              ...splitExplainBlocked,
              admin_profit_protection: protection,
            },
          });
          acceptedSet.delete(userId);
          rejectedSet.add(userId);
          state.accepted_user_ids = Array.from(acceptedSet);
          state.rejected_user_ids = Array.from(rejectedSet);
          state.rows = (state.rows || []).map((row) => {
            const rowUserId = Number(row.user_id);
            let decision = 'pending';
            if (acceptedSet.has(rowUserId)) decision = 'accepted';
            if (rejectedSet.has(rowUserId)) decision = 'rejected';
            return { ...row, decision };
          });
          await persistSplitOfferMetadata(sessionId, {
            offer_id: state.offer_id,
            status: state.status,
            started_at: state.started_at,
            expires_at: state.expires_at,
            initiated_by_user_id: state.initiated_by_user_id,
            eligible_user_ids: state.eligible_user_ids || [],
            accepted_user_ids: state.accepted_user_ids || [],
            rejected_user_ids: state.rejected_user_ids || [],
          });
          emitPoolSplitState(io, sessionId, state, 'bot_rejected_admin_profit_protection');
          await terminatePoolSplitOffer(io, sessionId, state, 'bot_rejected');
          return;
        }

        const accept = shouldBotAcceptSplitOffer(freshSession, state, userId);
        const splitExplain = buildSplitOfferExplainability(freshSession, state, userId);
        logBotDecisionExplainability(sessionId, {
          phase: 'split',
          user_id: userId,
          offer_id: offerId,
          decision: accept ? 'accept' : 'reject',
          explain: splitExplain,
        });
        if (accept) {
          rejectedSet.delete(userId);
          acceptedSet.add(userId);
        } else {
          acceptedSet.delete(userId);
          rejectedSet.add(userId);
        }

        state.accepted_user_ids = Array.from(acceptedSet);
        state.rejected_user_ids = Array.from(rejectedSet);
        state.rows = (state.rows || []).map((row) => {
          const rowUserId = Number(row.user_id);
          let decision = 'pending';
          if (acceptedSet.has(rowUserId)) decision = 'accepted';
          if (rejectedSet.has(rowUserId)) decision = 'rejected';
          return {
            ...row,
            decision,
          };
        });

        await persistSplitOfferMetadata(sessionId, {
          offer_id: state.offer_id,
          status: state.status,
          started_at: state.started_at,
          expires_at: state.expires_at,
          initiated_by_user_id: state.initiated_by_user_id,
          eligible_user_ids: state.eligible_user_ids || [],
          accepted_user_ids: state.accepted_user_ids || [],
          rejected_user_ids: state.rejected_user_ids || [],
        });

        emitPoolSplitState(io, sessionId, state, accept ? 'bot_accepted' : 'bot_rejected');
        if (!accept) {
          await terminatePoolSplitOffer(io, sessionId, state, 'bot_rejected');
          return;
        }

        const everyoneAccepted = (state.eligible_user_ids || []).every((id) => acceptedSet.has(Number(id)));
        if (everyoneAccepted) {
          await finalizePoolSplitOffer(io, sessionId, state);
        }
      }, delay);
    });
  }).catch((err) => {
    errorGame(sessionId, `Bot split auto-response scheduling failed: ${err.message}`);
  });
}

async function terminatePoolSplitOffer(io, sessionId, state, reason = 'cancelled') {
  if (!state) return;
  if (state.timeoutHandle) {
    clearTimeout(state.timeoutHandle);
  }
  activePoolSplitBySession.delete(sessionId);
  io.to(sessionRoom(sessionId)).emit('pool:split:terminated', {
    session_id: sessionId,
    server_time: new Date().toISOString(),
    event: 'pool:split:terminated',
    reason,
    offer_id: state.offer_id,
    split_window_end_at: state.expires_at,
    accepted_user_ids: state.accepted_user_ids || [],
    rejected_user_ids: state.rejected_user_ids || [],
  });
  await persistSplitOfferMetadata(sessionId, null);
  await continuePoolDealFlow(
    io,
    sessionId,
    state.preferred_first_turn_user_id || null,
    `split_${reason}`
  );
}

async function finalizePoolSplitOffer(io, sessionId, state) {
  if (!state) return null;
  if (state.timeoutHandle) {
    clearTimeout(state.timeoutHandle);
  }
  activePoolSplitBySession.delete(sessionId);
  clearPoolSplitStartTimer(sessionId);

  const session = await gameplayService.getSessionState(sessionId);
  if (!session) return null;

  const settlement = await settlePoolSplitResult(session, state.rows || [], state.offer_id);
  const winnerAmountByUser = new Map(
    ((settlement?.per_player || []).map((entry) => [Number(entry.user_id), Number(entry.amount) || 0]))
  );
  const splitParticipantSet = new Set(
    (state.accepted_user_ids || state.eligible_user_ids || [])
      .map((userId) => Number(userId))
      .filter((userId) => !Number.isNaN(userId))
  );
  const baseResult = state.base_result_payload || session.metadata?.result || {};
  const updatedResults = (Array.isArray(baseResult?.results) ? baseResult.results : []).map((entry) => {
    const userId = Number(entry?.user_id);
    const isSplitParticipant = splitParticipantSet.has(userId);
    return {
      ...entry,
      won_amount: winnerAmountByUser.get(userId) || 0,
      player_status: isSplitParticipant ? 'split' : entry?.player_status,
      status: isSplitParticipant ? 'split' : entry?.status,
    };
  });
  const finalizedPayload = {
    ...baseResult,
    server_time: new Date().toISOString(),
    event: 'game:result',
    status: 'split_finalized',
    is_final: true,
    reason: 'pool_split_accepted',
    can_split: false,
    split_candidate_user_ids: [],
    settlement,
    split_offer_id: state.offer_id,
    split_window_end_at: state.expires_at,
    split_rows: (state.rows || []).map((row) => ({
      ...row,
      decision: 'accepted',
    })),
    split_accepted_user_ids: state.accepted_user_ids || [],
    split_rejected_user_ids: state.rejected_user_ids || [],
    results: updatedResults,
  };
  if (Array.isArray(baseResult?.players)) {
    finalizedPayload.players = baseResult.players.map((playerEntry) => {
      const userId = Number(playerEntry?.user_id);
      const isSplitParticipant = splitParticipantSet.has(userId);
      return {
        ...playerEntry,
        won_amount: winnerAmountByUser.get(userId) || 0,
        player_status: isSplitParticipant ? 'split' : playerEntry?.player_status,
        status: isSplitParticipant ? 'split' : playerEntry?.status,
      };
    });
  }

  const nextMetadata = {
    ...(session.metadata || {}),
    phase: 'completed',
    phase_updated_at: new Date().toISOString(),
    result: finalizedPayload,
    split_offer: null,
  };
  await completeSessionWithBotRelease(sessionId, {
    endedAt: new Date(),
    metadata: nextMetadata,
  });
  await gameSessionModel.insertEvent({
    sessionId,
    userId: state.initiated_by_user_id || null,
    eventType: 'pool_split_finalized',
    payload: finalizedPayload,
  });
  console.log("finalizedPayload", finalizedPayload);
  io.to(sessionRoom(sessionId)).emit('game:result', finalizedPayload);
  scheduleAutoRematchFromResult(io, sessionId);
  io.to(sessionRoom(sessionId)).emit('pool:split:finalized', {
    session_id: sessionId,
    server_time: new Date().toISOString(),
    event: 'pool:split:finalized',
    offer_id: state.offer_id,
    split_window_end_at: state.expires_at,
    settlement,
    rows: (state.rows || []).map((row) => ({
      ...row,
      decision: 'accepted',
    })),
  });
  await emitSessionState(io, sessionId);
  await Promise.all(
    (session.players || []).map((player) => emitPendingRejoinGameForUser(io, player.user_id, 'game_completed'))
  );
  return finalizedPayload;
}

async function transitionToNextPoolRound(io, session, payload, roundProgress) {
  const sessionId = session.id;
  const previousEliminatedSet = new Set(
    (Array.isArray(session?.metadata?.pool_eliminated_user_ids) ? session.metadata.pool_eliminated_user_ids : [])
      .map((id) => Number(id))
      .filter((id) => !Number.isNaN(id))
  );
  const eliminatedSet = new Set(
    (Array.isArray(roundProgress?.eliminatedUserIds) ? roundProgress.eliminatedUserIds : [])
      .map((id) => Number(id))
      .filter((id) => !Number.isNaN(id))
  );

  await Promise.all((session.players || []).map((player) => {
    const userId = Number(player.user_id);
    const baseMetadata = resetPlayerMetadataForNextDeal(player.metadata || {});
    const isDisconnected = baseMetadata.connection_status === 'disconnected' || player.status === 'disconnected';
    if (eliminatedSet.has(userId)) {
      return gameSessionModel.updatePlayerState(sessionId, player.user_id, {
        status: 'eliminated',
        leftAt: null,
        metadata: {
          ...baseMetadata,
          elimination_reason: 'pool_limit',
        },
      });
    }
    return gameSessionModel.updatePlayerState(sessionId, player.user_id, {
      status: isDisconnected ? 'disconnected' : 'joined',
      leftAt: null,
      metadata: {
        ...baseMetadata,
      },
    });
  }));

  const poolRoundHistory = mergePoolRoundHistoryIntoMetadata(
    session.metadata || {},
    roundProgress,
    payload
  );
  const poolRoundHistoryWithPlayers = enrichLastPoolRoundHistoryEntry(poolRoundHistory, {
    players: Array.isArray(payload?.players) ? payload.players : null,
    wild_joker_card_id: resolveWildJokerCardId(session),
    reason: payload?.reason ?? null,
  });

  const nextMetadata = {
    ...(session.metadata || {}),
    phase: 'inter_deal',
    phase_updated_at: new Date().toISOString(),
    pool_limit: roundProgress.poolLimit,
    pool_round_no: roundProgress.nextRoundNo,
    pool_scores_by_user: roundProgress.scoresByUser,
    pool_eliminated_user_ids: roundProgress.eliminatedUserIds,
    pool_round_history: poolRoundHistoryWithPlayers,
    result: payload,
  };

  delete nextMetadata.declaration;
  delete nextMetadata.distribution;
  delete nextMetadata.discard_history;
  delete nextMetadata.game_state;
  delete nextMetadata.turn;
  delete nextMetadata.toss;
  delete nextMetadata.countdown;
  delete nextMetadata.turn_eliminated_user_ids;
  delete nextMetadata.turn_timeout_eliminated_user_ids;
  const splitPlan = buildPoolSplitPlan(session, roundProgress, payload);
  console.log("splitPlan", splitPlan);
  const splitCandidateUserIds = splitPlan.can_split === true
    ? (splitPlan.active_user_ids || [])
    : [];
  const resultPayload = {
    ...payload,
    can_split: splitPlan.can_split === true,
    split_candidate_user_ids: splitCandidateUserIds,
  };
  nextMetadata.result = resultPayload;

  await gameSessionModel.updateSessionStatus(sessionId, 'ready', {
    endedAt: null,
    currentTurnUserId: null,
    metadata: nextMetadata,
  });

  await gameSessionModel.insertEvent({
    sessionId,
    userId: payload?.winner_user_id || null,
    eventType: 'pool_round_completed',
    payload,
  });

  io.to(sessionRoom(sessionId)).emit('game:result', resultPayload);
  await emitSessionState(io, sessionId);
  const newlyEliminatedUserIds = Array.from(eliminatedSet)
    .filter((id) => !previousEliminatedSet.has(id));
  await Promise.all(
    newlyEliminatedUserIds.map(async (uid) => {
      detachUserFromSessionRoom(io, sessionId, uid);
      logGame(sessionId, `Detached eliminated uid=${uid} after pool round (${'pool_round_eliminated'})`);
      await emitPendingRejoinGameForUser(io, uid, 'pool_round_eliminated');
    })
  );

  // Prefer pool elimination set over stale player.status: mid-deal drop leaves
  // status=eliminated on the in-memory session even after we reset DB rows above.
  const nextDealParticipants = (session.players || []).filter((player) => {
    const userId = Number(player.user_id);
    if (Number.isNaN(userId)) return false;
    if (eliminatedSet.has(userId)) return false;
    if (player?.metadata?.table_left === true) return false;
    if (String(player?.status || '').toLowerCase() === 'left') return false;
    return true;
  });
  const rotatedFirstTurnUserId = resolveNextDealFirstTurnUserId(session, nextDealParticipants);

  if (splitPlan.can_split === true) {
    const splitStartEndsAt = new Date(Date.now() + (POOL_NEXT_DEAL_COUNTDOWN_SECONDS * 1000)).toISOString();
    clearPoolSplitStartTimer(sessionId);
    const startTimeoutHandle = setTimeout(async () => {
      const pending = pendingPoolSplitStartBySession.get(sessionId);
      if (!pending) return;
      pendingPoolSplitStartBySession.delete(sessionId);
    }, POOL_NEXT_DEAL_COUNTDOWN_SECONDS * 1000);
    pendingPoolSplitStartBySession.set(sessionId, {
      session_id: sessionId,
      payload: resultPayload,
      round_progress: roundProgress,
      split_plan: splitPlan,
      preferred_first_turn_user_id: rotatedFirstTurnUserId || null,
      split_start_ends_at: splitStartEndsAt,
      startTimeoutHandle,
    });
    await continuePoolDealFlow(
      io,
      sessionId,
      rotatedFirstTurnUserId || null,
      'split_available_countdown',
      {
        preserveSplitStartWindow: true,
        countdownSeconds: POOL_NEXT_DEAL_COUNTDOWN_SECONDS,
      }
    );
  } else {
    await continuePoolDealFlow(io, sessionId, rotatedFirstTurnUserId || null, 'split_not_eligible', {
      countdownSeconds: POOL_NEXT_DEAL_COUNTDOWN_SECONDS,
    });
  }
  return payload;
}
// ─────────────────────────────────────────────────────────────────────────────

async function emitSessionState(io, sessionIdOrCode, options = {}) {
  const session = await gameplayService.getSessionState(sessionIdOrCode, null, options);
  if (!session) return null;
  io.to(sessionRoom(session.id)).emit('session:state', session);
  return session;
}

function emitSessionStatePayload(io, session) {
  if (!session) return null;
  io.to(sessionRoom(session.id)).emit('session:state', session);
  return session;
}

function isUserPresentInSessionRoom(io, sessionId, userId) {
  const socketIds = typeof socketRegistry?.getSocketIds === 'function'
    ? socketRegistry.getSocketIds(userId)
    : [];
  if (!Array.isArray(socketIds) || socketIds.length === 0) return false;
  const roomSocketIds = io?.sockets?.adapter?.rooms?.get(sessionRoom(sessionId)) || new Set();
  return socketIds.some((socketId) => roomSocketIds.has(socketId));
}

function buildRejoinPendingGamePayload(session, userId, reason = 'connect', options = {}) {
  const { isPresentInSessionRoom = null } = options;
  const player = (session?.players || []).find((item) => Number(item.user_id) === Number(userId)) || null;
  const sessionStatus = String(session?.status || '').toLowerCase();
  const sessionActive = sessionStatus === 'active';
  const sessionOngoing = sessionActive || sessionStatus === 'ready';
  const playerStatus = String(player?.status || '').toLowerCase();
  const playerConnection = String(player?.connection_status || '').toLowerCase();
  const playerDisconnected = playerStatus === 'disconnected'
    || playerConnection === 'disconnected'
    || player?.metadata?.is_connected === false;
  const playerDropped = player?.metadata?.is_dropped === true
    || String(player?.metadata?.drop_status || '').toLowerCase() === 'dropped'
    || String(player?.metadata?.elimination_reason || '').toLowerCase() === 'dropped'
    || String(player?.metadata?.elimination_reason || '').toLowerCase() === 'timeout';
  const playerDealPacked = player?.metadata?.packed_in_current_deal === true
    || player?.metadata?.invalid_declaration === true;
  const softTableAway = player?.metadata?.soft_table_away === true;
  const playerLeftTable = player?.metadata?.table_left === true
    || String(player?.status || '').toLowerCase() === 'left';
  const postResultLeftUserIds = (
    Array.isArray(session?.metadata?.post_result_left_user_ids)
      ? session.metadata.post_result_left_user_ids
      : []
  )
    .map((id) => Number(id))
    .filter((id) => !Number.isNaN(id));
  const explicitlyLeftTable = playerLeftTable
    || postResultLeftUserIds.includes(Number(userId));
  const pendingRejoinOptOut = player?.metadata?.pending_rejoin_opt_out === true
    || player?.metadata?.auto_rematch_opt_out === true;
  const poolEliminatedUserIds = (
    Array.isArray(session?.metadata?.pool_eliminated_user_ids)
      ? session.metadata.pool_eliminated_user_ids
      : []
  )
    .map((id) => Number(id))
    .filter((id) => !Number.isNaN(id));
  const isPoolEliminated = poolEliminatedUserIds.includes(Number(userId));
  const isSixPlayerSoft = Number(session?.max_players) === 6 && sessionOngoing;
  const sessionPhase = String(session?.metadata?.phase || '').toLowerCase();
  const poolRejoinWindow = ['inter_deal', 'countdown'].includes(sessionPhase);
  let poolBuybackEligible = false;
  if (sessionActive && isPoolEliminated && poolRejoinWindow) {
    const poolLimit = resolvePoolLimit({
      metadata: session?.metadata || {},
      game: session?.game || null,
    });
    const rejoinContext = buildPoolRejoinContext({
      players: session?.players || [],
      scoresByUser: normalizePoolScoresByUser(session?.metadata || {}),
      eliminatedUserIds: poolEliminatedUserIds,
      poolLimit,
    });
    poolBuybackEligible = (rejoinContext.rejoin_candidate_user_ids || [])
      .map((id) => Number(id))
      .includes(Number(userId));
  }
  // Hard leave / opt-out always blocks paid pool buyback (unchanged).
  if (explicitlyLeftTable || pendingRejoinOptOut) {
    poolBuybackEligible = false;
  }

  // Classic disconnect resume — unchanged for 2P and non-soft cases.
  const classicPlayerEligible = Boolean(
    session
    && sessionActive
    && ['joined', 'disconnected'].includes(playerStatus)
    && !playerDropped
    && !explicitlyLeftTable
    && !pendingRejoinOptOut
  );

  // 6P only: free disconnect-style return after drop / soft leave / disconnect.
  // Never covers pool score elimination (that remains paid buyback only).
  const softSixPlayerEligible = Boolean(
    session
    && isSixPlayerSoft
    && player
    && !isPoolEliminated
    && !explicitlyLeftTable
    && !pendingRejoinOptOut
    && ['joined', 'disconnected', 'eliminated'].includes(playerStatus)
  );

  const needsTableRejoin = playerDisconnected
    || softTableAway
    || isPresentInSessionRoom === false
    || poolBuybackEligible;

  let canRejoin = Boolean(
    ((classicPlayerEligible || softSixPlayerEligible) && needsTableRejoin)
    || poolBuybackEligible
  );

  // Dropped / packed but still sitting in the room → no banner until they leave/disconnect.
  if (canRejoin && softSixPlayerEligible && (playerDropped || playerDealPacked) && !softTableAway
    && !playerDisconnected && isPresentInSessionRoom === true) {
    canRejoin = false;
  }

  if (canRejoin && !poolBuybackEligible) {
    const maxAgeMinutes = typeof gameplayService.resolveRejoinPendingMaxAgeMinutes === 'function'
      ? gameplayService.resolveRejoinPendingMaxAgeMinutes()
      : 15;
    const updatedAtMs = session?.updated_at ? new Date(session.updated_at).getTime() : NaN;
    const ageMs = Number.isFinite(updatedAtMs) ? (Date.now() - updatedAtMs) : Number.POSITIVE_INFINITY;
    if (ageMs > maxAgeMinutes * 60 * 1000) {
      canRejoin = false;
    }
  }
  if (canRejoin && !poolBuybackEligible && !playerDisconnected && !softTableAway
    && isPresentInSessionRoom === true) {
    canRejoin = false;
  }
  // Hard leave / switch opt-out still blocks (soft leave never sets these).
  if (explicitlyLeftTable || pendingRejoinOptOut) {
    canRejoin = false;
  }
  // Pool buyback path may re-enable only via poolBuybackEligible above; free soft
  // rejoin must never apply to pool-eliminated players.
  if (isPoolEliminated && !poolBuybackEligible) {
    canRejoin = false;
  }

  return {
    server_time: new Date().toISOString(),
    event: 'rejoin_pending_game',
    reason,
    has_pending_game: canRejoin,
    session: (session && canRejoin) ? {
      id: session.id,
      session_code: session.session_code,
      game_id: session.game_id,
      contest_id: session.contest_id,
      host_user_id: session.host_user_id,
      status: session.status,
      phase: session.metadata?.phase || session.status || 'waiting',
      current_turn_user_id: session.current_turn_user_id,
      started_at: session.started_at,
      updated_at: session.updated_at,
      max_players: session.max_players,
      game: session.game ? {
        id: session.game.id,
        name: session.game.name,
        dashboard_banner: session.game.dashboard_banner,
        side_banner: session.game.side_banner,
        badge: session.game.badge,
      } : null,
      contest: session.contest ? {
        id: session.contest.id,
        player_count: session.contest.player_count,
        point_value: session.contest.point_value,
        entry: session.contest.entry,
        win_upto: session.contest.win_upto,
      } : null,
      player: player ? {
        user_id: player.user_id,
        seat_no: player.seat_no,
        status: player.status,
        player_status: player.player_status,
        connection_status: player.connection_status,
      } : null,
      players: (session.players || []).map((item) => ({
        user_id: item.user_id,
        seat_no: item.seat_no,
        name: item.name,
        avatar: item.avatar,
        player_status: item.player_status,
        connection_status: item.connection_status,
      })),
      can_rejoin: canRejoin,
    } : null,
  };
}

async function emitPendingRejoinGame(io, socket, reason = 'connect') {
  if (!socket?.user?.id) return null;

  const pendingSessions = typeof gameplayService.getPendingRejoinSessions === 'function'
    ? await gameplayService.getPendingRejoinSessions(socket.user.id)
    : (
      typeof gameplayService.getPendingRejoinSession === 'function'
        ? [await gameplayService.getPendingRejoinSession(socket.user.id)].filter(Boolean)
        : []
    );

  const sessionPayloads = [];
  for (const session of pendingSessions) {
    if (!session) continue;
    const isPresentInSessionRoom = io
      ? isUserPresentInSessionRoom(io, session.id, socket.user.id)
      : null;
    const one = buildRejoinPendingGamePayload(session, socket.user.id, reason, {
      isPresentInSessionRoom,
    });
    if (one?.has_pending_game && one.session) {
      sessionPayloads.push(one.session);
    }
  }

  const payload = {
    server_time: new Date().toISOString(),
    event: 'rejoin_pending_game',
    reason,
    has_pending_game: sessionPayloads.length > 0,
    // Primary session kept for older clients (single-banner UX).
    session: sessionPayloads[0] || null,
    sessions: sessionPayloads,
    max_concurrent_tables: typeof gameplayService.resolveMaxConcurrentTables === 'function'
      ? gameplayService.resolveMaxConcurrentTables()
      : 3,
  };
  socket.emit('rejoin_pending_game', payload);
  return payload;
}

async function emitPendingRejoinGameForUser(io, userId, reason = 'status_changed') {
  const socketIds = typeof socketRegistry?.getSocketIds === 'function'
    ? socketRegistry.getSocketIds(userId)
    : [];
  if (!Array.isArray(socketIds) || socketIds.length === 0) return [];

  const emitted = await Promise.all(socketIds.map(async (socketId) => {
    const socket = io?.sockets?.sockets?.get(socketId);
    if (!socket) return null;
    try {
      return await emitPendingRejoinGame(io, socket, reason);
    } catch (err) {
      console.error(`[SOCKET] Failed to emit pending rejoin game uid=${userId} socket=${socketId}:`, err.message);
      return null;
    }
  }));

  return emitted.filter(Boolean);
}

async function syncConnectedPresenceForPendingSession(io, socket) {
  if (!io || !socket?.user?.id) return null;
  if (typeof gameplayService.getPendingRejoinSession !== 'function') return null;
  const pendingSession = await gameplayService.getPendingRejoinSession(socket.user.id);
  if (!pendingSession) return null;
  const targetPlayer = (pendingSession.players || []).find(
    (player) => Number(player.user_id) === Number(socket.user.id)
  );
  if (!targetPlayer) return null;
  const isDisconnected = String(targetPlayer.status || '').toLowerCase() === 'disconnected'
    || String(targetPlayer.connection_status || '').toLowerCase() === 'disconnected'
    || targetPlayer?.metadata?.is_connected === false;
  if (!isDisconnected) return pendingSession;
  const presence = await setPlayerConnectionState(
    io,
    pendingSession.id,
    socket.user.id,
    true,
    'socket_connected_pending_rejoin'
  );
  return presence?.session || pendingSession;
}

function resolveLivePlayerStatus(session, player, reason = null) {
  const userId = Number(player?.user_id);
  const timeoutEliminatedSet = getTimeoutEliminatedUserIdSet(session?.metadata || {});
  const turnEliminatedSet = getTurnEliminatedUserIdSet(session?.metadata || {});
  const poolEliminatedSet = getPoolEliminatedUserIdSet(session?.metadata || {});

  if (reason === 'timeout_eliminated' || timeoutEliminatedSet.has(userId)) {
    return 'timeout';
  }

  if (
    player?.metadata?.is_dropped === true
    || player?.metadata?.drop_status === 'dropped'
    || player?.metadata?.status === 'dropped'
    || player?.metadata?.elimination_reason === 'dropped'
  ) {
    return 'dropped';
  }

  // Invalid declare pack is per-deal — do not collapse it into pool "eliminated".
  if (
    reason === 'invalid_declaration_packed'
    || isInvalidDeclarationPackedPlayer(player)
  ) {
    if (poolEliminatedSet.has(userId)
      || player?.metadata?.elimination_reason === 'pool_limit') {
      return 'eliminated';
    }
    return 'invalid_declaration';
  }

  if (
    poolEliminatedSet.has(userId)
    || player?.status === 'eliminated'
    || player?.metadata?.elimination_reason === 'pool_limit'
  ) {
    return 'eliminated';
  }

  // Deal-out via turn_eliminated without pack metadata (legacy / edge).
  if (turnEliminatedSet.has(userId)) {
    return 'eliminated';
  }

  if (player?.player_status
    && player.player_status !== 'disconnected'
    && player.player_status !== 'connected'
    && player.player_status !== 'joined') {
    return player.player_status;
  }

  if (player?.status === 'disconnected' || player?.metadata?.connection_status === 'disconnected') {
    return 'disconnected';
  }

  return 'active';
}

function buildPlayerStatusPayload(session, player, reason = null) {
  if (!session || !player) return null;
  const playerStatus = resolveLivePlayerStatus(session, player, reason);
  const connectionStatus = player.connection_status
    || (player.metadata?.is_connected === false ? 'disconnected' : 'connected');
  const forceMiddleDrop = reason === 'timeout_eliminated' || reason === 'player_disconnected';
  const pointsToLose = (
    playerStatus === 'dropped'
    || reason === 'timeout_eliminated'
    || reason === 'player_disconnected'
  )
    ? resolveDropLossPoints(session, player.user_id, { forceMiddleDrop })
    : null;
  const banners = buildOutOfPlayBannerMessages(playerStatus, {
    isPoolThreshold: isPoolThresholdEliminatedPlayer(session, player),
  });
  return {
    session_id: session.id,
    server_time: new Date().toISOString(),
    event: 'player:status',
    reason,
    user_id: player.user_id,
    seat_no: player.seat_no,
    status: player.status,
    player_status: playerStatus,
    connection_status: connectionStatus,
    status_color: resolveStatusColor(playerStatus),
    left_at: player.left_at || null,
    metadata: player.metadata || {},
    points_to_lose: pointsToLose,
    ...banners,
  };
}

function emitPlayerStatusUpdate(io, session, userId, reason = null) {
  if (!session) return null;
  const player = (session.players || []).find((item) => Number(item.user_id) === Number(userId));
  if (!player) return null;
  const payload = buildPlayerStatusPayload(session, player, reason);
  io.to(sessionRoom(session.id)).emit('player:status', payload);
  return payload;
}

function emitPlayerStatusOverride(io, session, player = {}, overrides = {}, reason = null) {
  if (!session || !player) return null;
  const resolvedPlayerStatus = overrides.player_status || overrides.status || player.status || 'joined';
  const payload = {
    session_id: session.id,
    server_time: new Date().toISOString(),
    event: 'player:status',
    reason,
    user_id: player.user_id,
    seat_no: player.seat_no,
    status: overrides.status || player.status || null,
    player_status: resolvedPlayerStatus,
    connection_status: overrides.connection_status
      || player.connection_status
      || (player.metadata?.is_connected === false ? 'disconnected' : 'connected'),
    status_color: resolveStatusColor(resolvedPlayerStatus),
    left_at: overrides.left_at ?? player.left_at ?? null,
    metadata: {
      ...(player.metadata || {}),
      ...(overrides.metadata || {}),
    },
    ...(overrides.points_to_lose !== undefined ? { points_to_lose: overrides.points_to_lose } : {}),
    ...(overrides.content_message ? { content_message: overrides.content_message } : {}),
    ...(overrides.action_message ? { action_message: overrides.action_message } : {}),
  };
  io.to(sessionRoom(session.id)).emit('player:status', payload);
  return payload;
}

async function setPlayerConnectionState(io, sessionId, userId, isConnected, reason = 'presence_updated') {
  const player = await gameSessionModel.findPlayer(sessionId, userId);
  if (!player) {
    return { session: await gameplayService.getSessionState(sessionId), changed: false, playerFound: false };
  }

  const sessionForPresence = await gameplayService.getSessionState(sessionId);
  // Out of this deal / match (drop, timeout, pool wipe, exit) — update presence only.
  // Do NOT re-broadcast pool-threshold banners on reconnect; those fire at elimination time.
  if (isSeatOutOfActivePlayForPresence(sessionForPresence, player, userId)) {
    const timestamp = new Date().toISOString();
    const nextMetadata = {
      ...(player.metadata || {}),
      connection_status: isConnected ? 'connected' : 'disconnected',
      is_connected: isConnected,
      last_presence_reason: reason,
      last_presence_updated_at: timestamp,
      ...(isConnected ? { connected_at: timestamp } : { disconnected_at: timestamp }),
    };
    if (isConnected) {
      nextMetadata.soft_table_away = false;
      delete nextMetadata.soft_table_away_at;
      delete nextMetadata.soft_table_away_reason;
    }
    const metadataChanged = player.metadata?.connection_status !== nextMetadata.connection_status
      || player.metadata?.is_connected !== isConnected
      || Boolean(player.metadata?.soft_table_away) !== Boolean(nextMetadata.soft_table_away);

    // Preserve DB status: do not promote a still-active seat to eliminated on reconnect.
    const nextDbStatus = String(player.status || '').toLowerCase() === 'eliminated'
      || isPoolThresholdEliminatedPlayer(sessionForPresence, player, userId)
      ? 'eliminated'
      : player.status;

    if (metadataChanged) {
      await gameSessionModel.updatePlayerState(sessionId, userId, {
        status: nextDbStatus,
        metadata: nextMetadata,
      });
    }
    const session = await gameplayService.getSessionState(sessionId);
    if (metadataChanged && session) {
      const livePlayer = (session.players || []).find(
        (item) => Number(item.user_id) === Number(userId)
      ) || { ...player, metadata: nextMetadata, status: nextDbStatus };
      const playerStatus = resolveLivePlayerStatus(session, livePlayer, reason);
      // Presence-only: chips/status sync without repeating elimination banners.
      emitPlayerStatusOverride(io, session, livePlayer, {
        status: nextDbStatus,
        player_status: playerStatus,
        connection_status: nextMetadata.connection_status,
        metadata: nextMetadata,
      }, reason);
    }
    return { session, changed: metadataChanged, playerFound: true };
  }

  const nextConnectionStatus = isConnected ? 'connected' : 'disconnected';
  const currentConnectionStatus = player.status === 'disconnected'
    || player.metadata?.connection_status === 'disconnected'
    ? 'disconnected'
    : 'connected';

  const nextStatus = isConnected
    ? (player.status === 'disconnected' ? 'joined' : player.status)
    : (player.status === 'joined' ? 'disconnected' : player.status);

  const timestamp = new Date().toISOString();
  const nextMetadata = {
    ...(player.metadata || {}),
    connection_status: nextConnectionStatus,
    is_connected: isConnected,
    last_presence_reason: reason,
    last_presence_updated_at: timestamp,
  };

  if (isConnected) {
    nextMetadata.connected_at = timestamp;
    nextMetadata.soft_table_away = false;
    delete nextMetadata.disconnected_at;
    delete nextMetadata.soft_table_away_at;
    delete nextMetadata.soft_table_away_reason;
  } else {
    nextMetadata.disconnected_at = timestamp;
  }

  const metadataChanged = player.metadata?.connection_status !== nextConnectionStatus
    || player.metadata?.is_connected !== isConnected
    || Boolean(player.metadata?.soft_table_away) !== Boolean(nextMetadata.soft_table_away);
  const changed = currentConnectionStatus !== nextConnectionStatus || nextStatus !== player.status || metadataChanged;
  if (changed) {
    await gameSessionModel.updatePlayerState(sessionId, userId, {
      status: nextStatus,
      metadata: nextMetadata,
    });

    const eventType = isConnected
      ? (currentConnectionStatus === 'disconnected' ? 'player_reconnected' : 'player_connected')
      : 'player_disconnected';

    await gameSessionModel.insertEvent({
      sessionId,
      userId,
      eventType,
      payload: {
        reason,
        connection_status: nextConnectionStatus,
      },
    });
  }

  const session = await gameplayService.getSessionState(sessionId);
  if (!session) return { session: null, changed, playerFound: true };

  if (changed) {
    emitPlayerStatusUpdate(io, session, userId, reason);
    emitSessionStatePayload(io, session); // commented out to avoid duplicate state updates
  }

  return { session, changed, playerFound: true };
}

function buildPhaseSyncPlayers(session) {
  return (session?.players || []).map((player) => {
    const playerStatus = resolveLivePlayerStatus(session, player);
    const connectionStatus = player.connection_status
      || player.metadata?.connection_status
      || (player.metadata?.is_connected === false ? 'disconnected' : 'connected');
    const forceMiddleDrop = playerStatus === 'timeout' || playerStatus === 'disconnected';
    const pointsToLose = (
      playerStatus === 'dropped'
      || playerStatus === 'disconnected'
      || playerStatus === 'timeout'
      || playerStatus === 'eliminated'
    )
      ? resolveDropLossPoints(session, player.user_id, { forceMiddleDrop })
      : null;
    const distributionPlayer = Array.isArray(session?.metadata?.distribution?.players)
      ? session.metadata.distribution.players.find(
        (row) => Number(row?.user_id) === Number(player.user_id)
      )
      : null;

    return {
      user_id: player.user_id,
      seat_no: player.seat_no,
      name: player.name,
      avatar: player.avatar,
      total_score: resolvePlayerTotalScore(session, player.user_id),
      metadata: player.metadata || {},
      player_status: playerStatus,
      connection_status: connectionStatus,
      points_to_lose: pointsToLose,
      has_picked: distributionPlayer?.has_picked === true,
      first_turn_cycle_complete: distributionPlayer?.first_turn_cycle_complete === true,
    };
  });
}

function buildCountdownSyncPayload(session) {
  const countdown = session?.metadata?.countdown;
  if (!countdown?.ends_at || !countdown?.started_at) return null;

  const now = new Date();
  const secondsLeft = Math.max(0, Math.ceil((Date.parse(countdown.ends_at) - now.getTime()) / 1000));
  return {
    session_id: session.id,
    session_code: session.session_code,
    phase: 'countdown',
    status: session.status,
    server_time: now.toISOString(),
    event: 'game:countdown',
    countdown: {
      sequence: countdown.sequence,
      started_at: countdown.started_at,
      ends_at: countdown.ends_at,
      seconds_left: secondsLeft,
    },
    players: buildPhaseSyncPlayers(session),
  };
}

function buildTossSyncPayload(session) {
  const toss = session?.metadata?.toss;
  if (!toss?.started_at) return null;

  return {
    session_id: session.id,
    session_code: session.session_code,
    phase: 'toss',
    status: session.status,
    server_time: new Date().toISOString(),
    event: 'game:toss',
    toss: {
      rule: 'highest_card_wins',
      ace_high: true,
      sequence: toss.sequence,
      started_at: toss.started_at,
      deal_starts_at: toss.deal_starts_at || null,
    },
    players: buildPhaseSyncPlayers(session).map((player) => ({
      ...player,
      toss_card: null,
      toss_value: null,
      is_toss_winner: Number(player.user_id) === Number(toss.toss_winner_user_id || toss.winner_user_id),
    })),
    toss_winner_user_id: toss.toss_winner_user_id || toss.winner_user_id || null,
    toss_seed_hash: null,
  };
}

function buildDealSyncPayload(session) {
  const distribution = session?.metadata?.distribution;
  if (!distribution) return null;

  const turn = session?.metadata?.turn || null;
  const gameState = session?.metadata?.game_state || {};
  const turnTimerSeconds = Number(turn?.turn_timer_seconds)
    || Number(session?.game?.turn_timer_seconds)
    || Number(gameState?.turn_timer_seconds)
    || 0;
  const dealContext = buildDealContextFields(session);
  const prizePoolFields = buildSessionPrizePoolFields(session);

  return {
    session_id: session.id,
    session_code: session.session_code,
    phase: 'active',
    status: session.status,
    server_time: new Date().toISOString(),
    event: 'game:deal',
    game_state: {
      ...gameState,
      turn_started_at: turn?.started_at || gameState.turn_started_at || null,
      turn_ends_at: turn?.ends_at || gameState.turn_ends_at || null,
      turn_timer_seconds: turnTimerSeconds,
    },
    toss: session?.metadata?.toss || null,
    turn,
    ...dealContext,
    ...prizePoolFields,
    distribution,
    players: buildPhaseSyncPlayers(session),
  };
}

function buildTurnSyncPayload(session) {
  const turn = session?.metadata?.turn;
  if (!turn) return null;

  return {
    session_id: session.id,
    server_time: new Date().toISOString(),
    event: 'game:turn',
    action: 'sync',
    turn,
  };
}

function syncSocketToSessionPhase(socket, session, reason = 'session_sync') {
  if (!socket || !session) {
    return { phase: 'none', event: null, reason };
  }

  if (session.status === 'completed' && session.metadata?.result) {
    socket.emit('game:result', session.metadata.result);
    return { phase: 'finished', event: 'game:result', reason };
  }

  const phase = session.metadata?.phase;
  if (phase === 'countdown') {
    const payload = buildCountdownSyncPayload(session);
    if (payload) {
      socket.emit('game:countdown', payload);
      return { phase: 'countdown', event: 'game:countdown', reason };
    }
  }

  if (phase === 'toss') {
    const payload = buildTossSyncPayload(session);
    if (payload) {
      socket.emit('game:toss', payload);
      return { phase: 'toss', event: 'game:toss', reason };
    }
  }

  if (session.status === 'active' && session.metadata?.distribution) {
    const dealPayload = buildDealSyncPayload(session);
    if (dealPayload) {
      logGame(
        session.id,
        `Emitting game:deal sync reason=${reason} uid=${socket.user?.id} payload=${JSON.stringify(dealPayload)}`
      );
      socket.emit('game:deal', dealPayload);
      socket.emit('game:discard_history:update', buildDiscardHistoryPayload(session, {
        reason: 'session_sync',
      }));
      const turnPayload = buildTurnSyncPayload(session);
      if (turnPayload) {
        logGame(
          session.id,
          `Emitting game:turn after game:deal sync uid=${socket.user?.id} payload=${JSON.stringify(turnPayload)}`
        );
        socket.emit('game:turn', turnPayload);
        const turn = session.metadata?.turn;
        if (
          turn
          && Number(turn.user_id) === Number(socket.user?.id)
          && turn.has_picked !== true
        ) {
          const preview = resolveClosedDeckTopPreview(session.metadata?.distribution);
          if (preview) {
            socket.emit('player:closed_deck_preview', {
              session_id: session.id,
              server_time: new Date().toISOString(),
              event: 'player:closed_deck_preview',
              turn_id: turn.turn_id,
              closed_deck_top: preview,
            });
          }
        }
      }
      return { phase: 'active', event: 'game:deal', reason };
    }
  }

  return { phase: phase || session.status || 'waiting', event: null, reason };
}

async function attachSocketToSession(io, socket, session, options = {}) {
  const {
    presenceReason = 'session_join',
    startPregameIfReady = false,
    emitStateIfUnchanged = true,
  } = options;

  socket.join(sessionRoom(session.id));
  const presence = await setPlayerConnectionState(io, session.id, socket.user.id, true, presenceReason);
  const liveSession = presence.session || session;

  if (
    liveSession.status === 'active'
    && liveSession.metadata?.turn
    && !isDeclarationWindowActive(liveSession.id, liveSession.metadata)
  ) {
    scheduleTurnTimeout(io, liveSession.id, liveSession.metadata.turn);
    maybeScheduleBotTurnAction(io, liveSession.id, liveSession.metadata.turn).catch((botErr) => {
      errorGame(liveSession.id, `Bot schedule on attachSocketToSession failed: ${botErr.message}`);
    });
  }

  if (presence.playerFound) {
    syncSocketToSessionPhase(socket, liveSession, presenceReason);
    socket.emit('session:state', buildJoinAckSessionPayload(liveSession));
  }

  if (emitStateIfUnchanged && !presence.changed && presence.playerFound) {
    emitSessionStatePayload(io, liveSession);
  }

  if (startPregameIfReady && liveSession.status === 'ready') {
    startPregame(io, liveSession.id).catch((pregameErr) => {
      console.error(`[SOCKET] Failed to start pregame for session=${liveSession.id}:`, pregameErr.message);
    });
  }

  // Keep generic pending-rejoin indicator fresh when a user gets attached to any table.
  emitPendingRejoinGame(io, socket, 'session_attached').catch((rejoinErr) => {
    console.error(`[SOCKET] Failed to emit pending rejoin after attach uid=${socket?.user?.id}:`, rejoinErr.message);
  });

  return { liveSession, presence };
}

function leaveSessionRoom(socket, sessionId = null) {
  if (sessionId == null) return;
  const id = Number(sessionId);
  if (Number.isNaN(id)) return;
  socket.leave(sessionRoom(id));
}

/**
 * Leave every game-session room except keepSessionId (legacy single-table detach).
 * Prefer leaveSessionRoom(sourceId) for multi-table so parallel tables stay attached.
 */
function leaveOtherSessionRooms(socket, keepSessionId = null) {
  const keepId = keepSessionId == null ? null : Number(keepSessionId);
  const sessionIds = getSessionIdsFromSocket(socket);
  sessionIds.forEach((sessionId) => {
    if (keepId != null && Number(sessionId) === keepId) {
      return;
    }
    socket.leave(sessionRoom(sessionId));
  });
  return sessionIds;
}

async function requireSourceSessionForTransition(payload = {}, userId) {
  const sourceSessionId = Number(payload.source_session_id || payload.session_id);
  if (Number.isNaN(sourceSessionId)) {
    throw new Error('Valid source_session_id is required');
  }

  const sourceSession = await gameplayService.getSessionState(sourceSessionId);
  if (!sourceSession) {
    throw new Error('Source session not found');
  }

  const sourcePlayer = (sourceSession.players || []).find((player) => Number(player.user_id) === Number(userId));
  if (!sourcePlayer) {
    throw new Error('Player not found in source session');
  }

  return sourceSession;
}

function resolveTransitionConfig(payload = {}, sourceSession = null) {
  const gameId = Number(payload.game_id || sourceSession?.game_id);
  const contestId = Number(payload.contest_id || sourceSession?.contest_id);
  const maxPlayers = Number(payload.max_players || sourceSession?.max_players);

  if (Number.isNaN(gameId)) {
    throw new Error('Valid game_id is required');
  }
  if (Number.isNaN(contestId)) {
    throw new Error('Valid contest_id is required');
  }

  return {
    gameId,
    contestId,
    maxPlayers: Number.isNaN(maxPlayers) ? undefined : maxPlayers,
  };
}

function buildBotPhone(index, phonePrefix) {
  const suffix = String(index).padStart(6, '0');
  return `${phonePrefix}${suffix}`.slice(0, 15);
}

function generateRandomBotName(length = 10) {
  const bytes = crypto.randomBytes(Math.max(6, length));
  return Array.from(bytes.slice(0, length), (b) => ALPHANUMERIC[b % ALPHANUMERIC.length]).join('');
}

function shouldRefreshBotName(existingName) {
  const normalizedName = String(existingName || '').trim();
  if (!normalizedName) return true;
  if (normalizedName.startsWith(REMATCH_BOT_NAME_PREFIX)) return true;
  return /^rummybot-/i.test(normalizedName);
}

async function ensureRematchBotUser(index) {
  const phone = buildBotPhone(index, REMATCH_BOT_PHONE_PREFIX);
  const existing = await userModel.findByPhone(phone);
  if (existing) {
    const shouldUpdateName = shouldRefreshBotName(existing.name);
    const shouldUpdateAvatar = !existing.avatar || String(existing.avatar).trim() === '';
    if (shouldUpdateName || shouldUpdateAvatar) {
      const nextName = shouldUpdateName ? generateRandomBotName() : existing.name;
      const nextAvatar = shouldUpdateAvatar ? await avatarModel.getRandomAvatarUrl() : existing.avatar;
      await userModel.updateProfile(existing.id, {
        name: nextName,
        avatar: nextAvatar,
      });
      return userModel.findById(existing.id);
    }
    return existing;
  }

  await userModel.create(phone);
  const randomName = generateRandomBotName();
  const randomAvatar = await avatarModel.getRandomAvatarUrl();
  await userModel.verifyOtpAndMarkVerified(phone, randomName, null, randomAvatar);
  return userModel.findByPhone(phone);
}

async function completeSessionWithBotRelease(sessionId, fields = {}) {
  const row = await gameSessionModel.updateSessionStatus(sessionId, 'completed', fields);
  await botLeaseService.releaseBotsForSession(sessionId);
  return row;
}

async function fillSessionWithBotsIfNeeded(sessionId) {
  const session = await gameplayService.getSessionState(sessionId);
  if (!session || session.status !== 'waiting') return session;
  // Rematch / inter-deal fill must respect BOT_ENGINE_ENABLED (lobby scanner already does).
  if (!isBotInjectionEnabled()) {
    logGame(session.id, 'Bot fill skipped — bot injection disabled');
    return session;
  }
  const players = Array.isArray(session.players) ? session.players : [];
  const seatsNeeded = Math.max(0, Number(session.max_players) - players.length);
  if (seatsNeeded <= 0) return session;
  const existingBotIds = new Set(
    players
      .filter((player) => player?.metadata?.is_bot === true)
      .map((player) => Number(player.user_id))
      .filter((id) => !Number.isNaN(id))
  );
  let injectedCount = 0;
  const triedIndices = new Set();

  while (injectedCount < seatsNeeded && triedIndices.size < REMATCH_BOT_POOL_SIZE) {
    const index = botLeaseService.pickRandomUnusedBotIndex(REMATCH_BOT_POOL_SIZE, triedIndices);
    if (index == null) break;
    triedIndices.add(index);
    // eslint-disable-next-line no-await-in-loop
    const botUser = await ensureRematchBotUser(index);
    if (!botUser) continue;
    if (existingBotIds.has(Number(botUser.id))) continue;
    // eslint-disable-next-line no-await-in-loop
    const leased = await botLeaseService.acquireBotLease(session.id, botUser.id, {
      refreshDisplayName: true,
    });
    if (!leased) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const joinedState = await gameplayService.joinSession({
        sessionIdOrCode: session.id,
        userId: botUser.id,
        skipBalanceCheck: true,
      });
      const botPlayer = joinedState.players.find((p) => Number(p.user_id) === Number(botUser.id));
      if (botPlayer) {
        // eslint-disable-next-line no-await-in-loop
        await gameSessionModel.updatePlayerMetadata(session.id, botUser.id, {
          ...(botPlayer.metadata || {}),
          host: false,
          ready: true,
          is_bot: true,
          bot_engine: 'rematch_fast_fill',
        });
      }
      existingBotIds.add(Number(botUser.id));
      injectedCount += 1;
    } catch (err) {
      // eslint-disable-next-line no-await-in-loop
      await botLeaseService.releaseBotLease(session.id, botUser.id);
      warnGame(session.id, `Rematch bot fill join skipped uid=${botUser.id}: ${err.message}`);
    }
  }

  return gameplayService.getSessionState(session.id);
}

async function maybeStartRematchFastDeal(io, targetSessionId, options = {}) {
  const enforceModeGate = options?.enforceModeGate !== false;
  const preferredFirstTurnUserId = Number(options?.preferredFirstTurnUserId);
  const winnerUserId = Number.isNaN(preferredFirstTurnUserId) ? null : preferredFirstTurnUserId;
  let session = await gameplayService.getSessionState(targetSessionId);
  if (!session) return;
  if (!['waiting', 'ready'].includes(session.status)) return;
  if (enforceModeGate && !isAutoRematchAllowedMode(session)) return;

  const joinedCount = Array.isArray(session.players) ? session.players.length : 0;
  if (joinedCount < Number(session.max_players)) {
    await new Promise((resolve) => setTimeout(resolve, REMATCH_FAST_FILL_WAIT_MS));
    session = await gameplayService.getSessionState(targetSessionId);
  }

  const playersAfterWait = Array.isArray(session?.players) ? session.players.length : 0;
  if (!session || playersAfterWait < Number(session.max_players)) {
    session = await fillSessionWithBotsIfNeeded(targetSessionId);
  }

  let finalSession = await gameplayService.getSessionState(targetSessionId);
  if (!finalSession) return;

  // Reserved rematch tables can become unfillable (e.g., peer has insufficient balance).
  // In that case, move connected real users to a fresh non-reserved fallback table.
  const isReservedRematch = finalSession?.metadata?.rematch_reserved === true;
  if (finalSession.status !== 'ready' && isReservedRematch) {
    const connectedRealUsers = (Array.isArray(finalSession.players) ? finalSession.players : [])
      .filter((player) => {
        if (player?.metadata?.is_bot === true) return false;
        const connection = String(player?.metadata?.connection_status || '').toLowerCase();
        if (connection === 'disconnected') return false;
        const socketIds = socketRegistry.getSocketIds(Number(player.user_id));
        return socketIds.some((socketId) => io.sockets.sockets.has(socketId));
      })
      .map((player) => Number(player.user_id))
      .filter((userId) => !Number.isNaN(userId));

    if (connectedRealUsers.length > 0) {
      try {
        const hostUserId = connectedRealUsers[0];
        const fallbackSession = await gameplayService.createSession({
          gameId: Number(finalSession.game_id),
          contestId: Number(finalSession.contest_id),
          hostUserId,
          maxPlayers: Number(finalSession.max_players),
          metadata: {
            transition_action: 'reserved_rematch_unfillable_fallback',
            transition_source_session_id: Number(finalSession.metadata?.continuation_source_session_id) || null,
          },
        });

        for (const userId of connectedRealUsers.slice(1)) {
          try {
            await gameplayService.joinSession({ sessionIdOrCode: fallbackSession.id, userId });
          } catch (joinErr) {
            warnGame(fallbackSession.id, `Fallback join skipped uid=${userId}: ${joinErr.message}`);
          }
        }

        let liveFallback = await gameplayService.getSessionState(fallbackSession.id);
        if (Array.isArray(liveFallback?.players) && liveFallback.players.length < Number(liveFallback.max_players)) {
          liveFallback = await fillSessionWithBotsIfNeeded(fallbackSession.id);
        }

        const liveFallbackSession = await gameplayService.getSessionState(fallbackSession.id);
        for (const userId of connectedRealUsers) {
          const socketIds = socketRegistry.getSocketIds(userId);
          for (const socketId of socketIds) {
            const sock = io.sockets.sockets.get(socketId);
            if (!sock) continue;
            try {
              const { liveSession } = await attachSocketToSession(io, sock, liveFallbackSession, {
                presenceReason: 'reserved_rematch_unfillable_fallback',
                startPregameIfReady: false,
              });
              leaveSessionRoom(sock, finalSession?.id);
              syncSocketToSessionPhase(sock, liveSession, 'reserved_rematch_unfillable_fallback');
            } catch (attachErr) {
              warnGame(fallbackSession.id, `Fallback attach failed uid=${userId} socket=${socketId}: ${attachErr.message}`);
            }
          }
        }

        await emitSessionState(io, fallbackSession.id);

        // Mark this reserved continuation as consumed once we migrate players to fallback,
        // so late table:back/play_again clicks do not reattach to stale reserved seats.
        try {
          await gameSessionModel.updateSessionStatus(finalSession.id, finalSession.status, {
            metadata: {
              ...(finalSession.metadata || {}),
              rematch_reserved_consumed: true,
              rematch_reserved_consumed_at: new Date().toISOString(),
              rematch_reserved_fallback_session_id: Number(fallbackSession.id),
            },
          });
        } catch (markConsumedErr) {
          warnGame(finalSession.id, `Reserved rematch consume flag update failed: ${markConsumedErr.message}`);
        }

        finalSession = await gameplayService.getSessionState(fallbackSession.id);
      } catch (fallbackErr) {
        warnGame(finalSession.id, `Reserved rematch fallback failed: ${fallbackErr.message}`);
      }
    }
  }

  if (!finalSession || finalSession.status !== 'ready') return;

  startPregame(io, finalSession.id, {
    interDealFastStart: true,
    preferredFirstTurnUserId: winnerUserId,
    countdownSeconds: REMATCH_FAST_COUNTDOWN_SECONDS,
  }).catch((err) => {
    warnGame(finalSession.id, `Rematch fast deal start failed: ${err.message}`);
  });
}

function clearAutoRematchTimer(sourceSessionId) {
  const key = Number(sourceSessionId);
  const state = pendingAutoRematchBySourceSession.get(key);
  if (!state) {
    durableTimer.cancel({ kind: 'auto_rematch', sessionId: key, token: 'rematch' }).catch(() => {});
    return;
  }
  if (state.intervalHandle) {
    clearInterval(state.intervalHandle);
  }
  if (state.timeoutHandle) {
    clearTimeout(state.timeoutHandle);
  }
  pendingAutoRematchBySourceSession.delete(key);
  durableTimer.cancel({ kind: 'auto_rematch', sessionId: key, token: 'rematch' }).catch(() => {});
}

function detachUserFromSessionRoom(io, sessionId, userId) {
  const safeSessionId = Number(sessionId);
  const safeUserId = Number(userId);
  if (Number.isNaN(safeSessionId) || Number.isNaN(safeUserId)) return;
  const roomSocketIds = io?.sockets?.adapter?.rooms?.get(sessionRoom(safeSessionId)) || new Set();
  const socketIds = socketRegistry.getSocketIds(safeUserId);
  socketIds.forEach((socketId) => {
    if (!roomSocketIds.has(socketId)) return;
    const sock = io?.sockets?.sockets?.get(socketId);
    if (sock) {
      sock.leave(sessionRoom(safeSessionId));
    }
  });
}

function schedulePoolEliminationDetachAfterNextDealStart(io, sessionId, userId, reason = 'pool_round_eliminated') {
  const safeSessionId = Number(sessionId);
  const safeUserId = Number(userId);
  if (Number.isNaN(safeSessionId) || Number.isNaN(safeUserId)) return;
  const key = `${safeSessionId}:${safeUserId}`;
  if (pendingPoolEliminationDetachByKey.has(key)) return;

  let attempts = 0;
  const maxAttempts = 30;
  const tickMs = 1000;

  const tick = async () => {
    attempts += 1;
    try {
      const session = await gameplayService.getSessionState(safeSessionId);
      if (!session) {
        pendingPoolEliminationDetachByKey.delete(key);
        return;
      }

      const phase = String(session.metadata?.phase || '').toLowerCase();
      const nextDealStarted = session.status === 'active' && phase === 'active';
      if (!nextDealStarted) {
        if (attempts >= maxAttempts) {
          pendingPoolEliminationDetachByKey.delete(key);
          return;
        }
        const handle = setTimeout(() => {
          tick().catch((err) => {
            warnGame(safeSessionId, `Deferred pool detach retry failed uid=${safeUserId}: ${err.message}`);
          });
        }, tickMs);
        pendingPoolEliminationDetachByKey.set(key, handle);
        return;
      }

      const poolEliminatedSet = new Set(
        (Array.isArray(session.metadata?.pool_eliminated_user_ids) ? session.metadata.pool_eliminated_user_ids : [])
          .map((id) => Number(id))
          .filter((id) => !Number.isNaN(id))
      );
      if (poolEliminatedSet.has(safeUserId)) {
        detachUserFromSessionRoom(io, safeSessionId, safeUserId);
        logGame(safeSessionId, `Detached eliminated uid=${safeUserId} after next deal start (${reason})`);
        await emitPendingRejoinGameForUser(io, safeUserId, reason);
      }
      pendingPoolEliminationDetachByKey.delete(key);
    } catch (err) {
      pendingPoolEliminationDetachByKey.delete(key);
      warnGame(safeSessionId, `Deferred pool detach failed uid=${safeUserId}: ${err.message}`);
    }
  };

  const firstHandle = setTimeout(() => {
    tick().catch((err) => {
      warnGame(safeSessionId, `Deferred pool detach initial run failed uid=${safeUserId}: ${err.message}`);
    });
  }, tickMs);
  pendingPoolEliminationDetachByKey.set(key, firstHandle);
}

function resolveAutoRematchEligibleConnectedUserIds(io, sourceSession) {
  const sourceSessionId = Number(sourceSession?.id);
  const sourceRoomSocketIds = Number.isNaN(sourceSessionId)
    ? new Set()
    : (io?.sockets?.adapter?.rooms?.get(sessionRoom(sourceSessionId)) || new Set());
  const players = Array.isArray(sourceSession?.players) ? sourceSession.players : [];
  const leftUserIds = new Set(
    (Array.isArray(sourceSession?.metadata?.post_result_left_user_ids) ? sourceSession.metadata.post_result_left_user_ids : [])
      .map((id) => Number(id))
      .filter((id) => !Number.isNaN(id))
  );
  return players
    .filter((player) => {
      const userId = Number(player?.user_id);
      if (Number.isNaN(userId)) return false;
      if (player?.metadata?.is_bot === true) return false;
      if (leftUserIds.has(userId)) return false;
      const connection = String(player?.metadata?.connection_status || '').toLowerCase();
      // Result-phase statuses like dropped/eliminated are still eligible for rematch.
      // Only explicit table leave (post_result_left_user_ids) should block eligibility.
      if (connection === 'disconnected') return false;
      const socketIds = socketRegistry.getSocketIds(userId);
      // Critical guard: only auto-rematch users who are still attached to the
      // source table room. If a user moved to another table, do not hijack them.
      return socketIds.some((socketId) => (
        io.sockets.sockets.has(socketId) && sourceRoomSocketIds.has(socketId)
      ));
    })
    .map((player) => Number(player.user_id))
    .filter((userId) => !Number.isNaN(userId));
}

async function emitAutoRematchCountdown(io, sourceSessionId, secondsLeft, endsAtIso, reason = 'result_timer') {
  const sourceSession = await gameplayService.getSessionState(sourceSessionId);
  if (!sourceSession) return;
  io.to(sessionRoom(sourceSessionId)).emit('game:countdown', {
    session_id: sourceSessionId,
    session_code: sourceSession.session_code,
    phase: 'countdown',
    status: sourceSession.status || 'completed',
    server_time: new Date().toISOString(),
    event: 'game:countdown',
    countdown: {
      sequence: `auto-rematch:${sourceSessionId}:${endsAtIso}`,
      started_at: new Date(Date.parse(endsAtIso) - (AUTO_REMATCH_COUNTDOWN_SECONDS * 1000)).toISOString(),
      ends_at: endsAtIso,
      seconds_left: Math.max(0, Number(secondsLeft) || 0),
      seconds: AUTO_REMATCH_COUNTDOWN_SECONDS,
      reason,
      mode: 'auto_rematch',
      source_session_id: sourceSessionId,
    },
    players: (sourceSession.players || []).map((p) => ({
      user_id: p.user_id,
      seat_no: p.seat_no,
      name: p.name,
      metadata: p.metadata,
    })),
  });
}

async function runAutoRematchFromSource(io, sourceSessionId) {
  const sourceSession = await gameplayService.getSessionState(sourceSessionId);
  if (!sourceSession || sourceSession.status !== 'completed') return;
  if (!isAutoRematchAllowedMode(sourceSession)) return;
  const preferredFirstTurnUserId = Number(sourceSession?.metadata?.result?.winner_user_id);
  const sourcePlayersByUserId = new Map(
    (Array.isArray(sourceSession.players) ? sourceSession.players : [])
      .map((player) => [Number(player.user_id), player])
      .filter(([userId]) => !Number.isNaN(userId))
  );
  const connectedUserIds = resolveAutoRematchEligibleConnectedUserIds(io, sourceSession);
  if (connectedUserIds.length === 0) return;

  const hostUserId = connectedUserIds[0];
  const continuation = await gameplayService.createOrJoinContinuationSession({
    sourceSessionId: sourceSession.id,
    userId: hostUserId,
  });

  let targetSession = continuation.session || null;
  let transitionType = 'same_table_continuation';
  if (!targetSession && continuation.fallbackToMatchmaking) {
    const config = resolveTransitionConfig({}, sourceSession);
    targetSession = await gameplayService.createSession({
      gameId: config.gameId,
      contestId: config.contestId,
      hostUserId,
      maxPlayers: config.maxPlayers,
      metadata: {
        transition_action: 'auto_table_back_fallback',
        transition_source_session_id: sourceSession.id,
      },
    });
    transitionType = 'same_table_fallback_matchmaking';
  }
  if (!targetSession) return;

  const joinedUserIds = new Set([Number(hostUserId)]);
  for (const userId of connectedUserIds.slice(1)) {
    try {
      await gameplayService.joinSession({ sessionIdOrCode: targetSession.id, userId });
      joinedUserIds.add(Number(userId));
    } catch (err) {
      warnGame(sourceSession.id, `Auto rematch join skipped uid=${userId}: ${err.message}`);
    }
  }

  // Preserve existing bot participants from the source table so rematch continuity
  // works the same across mixed player types and game modes.
  // When bots are fully disabled, do not carry bots onto the next table.
  if (isBotInjectionEnabled()) {
    for (const eligibleUserId of (continuation.eligibleUserIds || [])) {
      const numericUserId = Number(eligibleUserId);
      if (Number.isNaN(numericUserId) || joinedUserIds.has(numericUserId)) continue;
      const sourcePlayer = sourcePlayersByUserId.get(numericUserId);
      if (sourcePlayer?.metadata?.is_bot !== true) continue;
      try {
        const leased = await botLeaseService.acquireBotLease(targetSession.id, numericUserId, {
          refreshDisplayName: true,
        });
        if (!leased) continue;
        await gameplayService.joinSession({
          sessionIdOrCode: targetSession.id,
          userId: numericUserId,
          skipBalanceCheck: true,
        });
        const joinedBotPlayer = await gameSessionModel.findPlayer(targetSession.id, numericUserId);
        if (joinedBotPlayer) {
          await gameSessionModel.updatePlayerState(targetSession.id, numericUserId, {
            metadata: {
              ...(joinedBotPlayer.metadata || {}),
              is_bot: true,
              ready: true,
              bot_engine: 'rematch_carry_forward',
            },
          });
        }
        joinedUserIds.add(numericUserId);
      } catch (err) {
        await botLeaseService.releaseBotLease(targetSession.id, numericUserId);
        warnGame(sourceSession.id, `Auto rematch bot carry-forward skipped uid=${numericUserId}: ${err.message}`);
      }
    }
  } else {
    logGame(sourceSession.id, 'Rematch bot carry-forward skipped — bot injection disabled');
  }

  const liveTargetSession = await gameplayService.getSessionState(targetSession.id);
  for (const userId of connectedUserIds) {
    const socketIds = socketRegistry.getSocketIds(userId);
    for (const socketId of socketIds) {
      const sock = io.sockets.sockets.get(socketId);
      if (!sock) continue;
      try {
        const { liveSession } = await attachSocketToSession(io, sock, liveTargetSession, {
          presenceReason: 'auto_table_back',
          startPregameIfReady: true,
        });
        leaveSessionRoom(sock, sourceSession.id);
        syncSocketToSessionPhase(sock, liveSession, 'auto_table_back');
      } catch (attachErr) {
        warnGame(sourceSession.id, `Auto rematch attach failed uid=${userId} socket=${socketId}: ${attachErr.message}`);
      }
    }
  }

  await emitSessionState(io, targetSession.id);

  logGame(
    sourceSession.id,
    `Auto rematch started target=${targetSession.id} transition=${transitionType} fallback=${continuation.fallbackToMatchmaking === true}`
  );
  await maybeStartRematchFastDeal(io, targetSession.id, {
    preferredFirstTurnUserId: Number.isNaN(preferredFirstTurnUserId) ? null : preferredFirstTurnUserId,
  });
}

function scheduleAutoRematchFromResult(io, sourceSessionId) {
  const key = Number(sourceSessionId);
  if (Number.isNaN(key)) return;
  if (pendingAutoRematchBySourceSession.has(key)) return;
  pendingAutoRematchBySourceSession.set(key, { status: 'checking' });

  gameplayService.getSessionState(key)
    .then((sourceSession) => {
      if (!sourceSession || sourceSession.status !== 'completed') {
        pendingAutoRematchBySourceSession.delete(key);
        return;
      }
      if (!isAutoRematchAllowedMode(sourceSession)) {
        pendingAutoRematchBySourceSession.delete(key);
        return;
      }

      const startedAtMs = Date.now();
      const endsAtMs = startedAtMs + (AUTO_REMATCH_COUNTDOWN_SECONDS * 1000);
      const endsAtIso = new Date(endsAtMs).toISOString();

      emitAutoRematchCountdown(io, key, AUTO_REMATCH_COUNTDOWN_SECONDS, endsAtIso).catch((err) => {
        warnGame(key, `Auto rematch countdown emit failed: ${err.message}`);
      });
      const intervalHandle = setInterval(() => {
        const secondsLeft = Math.ceil((endsAtMs - Date.now()) / 1000);
        emitAutoRematchCountdown(io, key, secondsLeft, endsAtIso).catch((err) => {
          warnGame(key, `Auto rematch countdown tick emit failed: ${err.message}`);
        });
      }, 1000);

      const timeoutHandle = setTimeout(async () => {
        try {
          await emitAutoRematchCountdown(io, key, 0, endsAtIso, 'result_timer_done');
          await runAutoRematchFromSource(io, key);
        } catch (err) {
          warnGame(key, `Auto rematch run failed: ${err.message}`);
        } finally {
          clearAutoRematchTimer(key);
        }
      }, AUTO_REMATCH_COUNTDOWN_SECONDS * 1000);

      pendingAutoRematchBySourceSession.set(key, {
        startedAtMs,
        endsAtIso,
        intervalHandle,
        timeoutHandle,
      });

      durableTimer.arm({
        kind: 'auto_rematch',
        sessionId: key,
        token: 'rematch',
        fireAtMs: endsAtMs,
        payload: { ends_at: endsAtIso },
      }).catch(() => {});
    })
    .catch((err) => {
      pendingAutoRematchBySourceSession.delete(key);
      warnGame(key, `Auto rematch schedule aborted: ${err.message}`);
    });
}

async function tryExecuteBotDropBeforePick(
  io,
  sessionId,
  session,
  turn,
  handCards,
  distribution,
  wildJoker,
  decisionStartedAt
) {
  const userId = turn.user_id;
  const mode = resolveSessionGameMode(session);
  const decisionSeed = buildDecisionSeed(sessionId, turn.turn_id, userId);
  const dealPlayerDist = getPlayerDistribution(distribution, userId) || { user_id: userId };

  if (shouldBotTakeEarlyDrop(session, userId, handCards, distribution, wildJoker)) {
    logBotDecisionExplainability(sessionId, {
      phase: 'early_drop',
      user_id: userId,
      turn_id: Number(turn.turn_id) || 0,
      mode,
      wild_joker: wildJoker && { rank: wildJoker.rank, card_id: wildJoker.card_id },
      explain: buildEarlyDropExplainability(session, userId, handCards, distribution, wildJoker),
      elapsed_ms: Date.now() - decisionStartedAt,
    });
    await dropPlayerFromSession(io, sessionId, userId);
    return true;
  }

  const stratExplain = buildStrategicDropExplainability(
    session,
    userId,
    handCards,
    wildJoker,
    { turn, playerDistribution: dealPlayerDist, decisionSeed }
  );
  const stratSeedRoll = deterministicRoll(decisionSeed, 'strategic_drop');
  const strategicDrop = shouldBotStrategicallyDrop(
    session,
    userId,
    handCards,
    wildJoker,
    { turn, playerDistribution: dealPlayerDist, decisionSeed, seededRoll: stratSeedRoll }
  );
  if (!strategicDrop) return false;

  logBotDecisionExplainability(sessionId, {
    phase: 'strategic_drop',
    user_id: userId,
    turn_id: Number(turn.turn_id) || 0,
    mode,
    wild_joker: wildJoker && { rank: wildJoker.rank, card_id: wildJoker.card_id },
    explain: stratExplain,
    elapsed_ms: Date.now() - decisionStartedAt,
  });
  await dropPlayerFromSession(io, sessionId, userId);
  return true;
}

async function executeBotPickAction(io, sessionId, expectedTurnId) {
  const decisionStartedAt = Date.now();
  const session = await loadBotActionSession(sessionId);
  if (!session || session.status !== 'active') return;
  if (isDeclarationWindowActive(sessionId, session.metadata)) {
    logGame(sessionId, `Bot pick skipped — declaration already open turn=${expectedTurnId}`);
    return;
  }
  const softRiggingEnabled = isBotSoftRiggingEnabled(session);
  const aggressiveEnabled = isBotAggressionEnabled(session);

  const turn = session.metadata?.turn;
  if (!turn) return;
  if (Number(turn.turn_id) !== Number(expectedTurnId)) return;
  if (!hasTurnStarted(turn)) {
    scheduleBotTurnAction(io, sessionId, turn, 'pick', { softRiggingEnabled, aggressiveEnabled });
    return;
  }
  if (!isBotTurn(session, turn.user_id)) return;
  if (turn.has_picked === true) {
    scheduleBotTurnAction(io, sessionId, turn, 'discard', { softRiggingEnabled, aggressiveEnabled });
    return;
  }

  const distribution = session.metadata?.distribution;
  if (!distribution) return;

  const playersDistribution = Array.isArray(distribution.players) ? [...distribution.players] : [];
  const playerIndex = playersDistribution.findIndex((pd) => Number(pd.user_id) === Number(turn.user_id));
  if (playerIndex < 0) return;

  const playerDistribution = {
    ...playersDistribution[playerIndex],
    cards: [...(playersDistribution[playerIndex].cards || [])],
  };
  const wildJoker = distribution.wild_joker || null;
  const mode = resolveSessionGameMode(session);
  const decisionSeed = buildDecisionSeed(sessionId, turn.turn_id, turn.user_id);
  const playContext = buildBotPlayContext(session, turn.user_id);
  const tieBreakOptions = buildGroupingTieBreakOptions(decisionSeed);
  const handBeforePick = evaluateHandStrength(playerDistribution.cards, wildJoker, {
    groupingOptions: tieBreakOptions,
  });
  const conservativeMode = BOT_CONSERVATIVE_PLAY_ON_LOW_CONFIDENCE
    && isLowConfidenceGrouping(handBeforePick.summary || {});
  if (await tryExecuteBotDropBeforePick(
    io,
    sessionId,
    session,
    turn,
    playerDistribution.cards,
    distribution,
    wildJoker,
    decisionStartedAt
  )) {
    return;
  }

  await yieldToEventLoop();

  let discardPile = [...(distribution.discard_pile || [])];
  let closedDeck = [...(distribution.closed_deck || [])];

  let pickedCard = null;
  let source = null;
  let reshufflePayload = null;
  let usedSoftRiggingPick = false;

  const pickExplain = explainPickSourceDecision(
    distribution,
    playerDistribution.cards,
    wildJoker,
    {
      softRiggingEnabled,
      conservativeMode,
      tieBreakSeed: decisionSeed,
      groupingOptions: tieBreakOptions,
      playUrgency: playContext.urgency,
      playToWin: playContext.playToWin,
      mode,
      precomputedBefore: handBeforePick,
    }
  );
  source = pickExplain.chosen;
  if (source === 'discard') {
    if (discardPile.length === 0) {
      source = 'closed';
    } else {
      const discardTop = discardPile[0] || null;
      const topIsJoker = isJokerCard(discardTop, wildJoker);
      if (topIsJoker && !canPickDiscardJokerInCurrentTurn(session)) {
        source = 'closed';
      } else {
        pickedCard = discardPile.shift();
      }
    }
  }

  await yieldToEventLoop();

  if (source === 'closed' && closedDeck.length === 0) {
    logGame(
      sessionId,
      `Bot pick found closed deck empty — uid=${turn.user_id} discardCount=${discardPile.length}. Attempting reshuffle.`
    );

    const reshuffle = reshuffleClosedDeck(distribution);
    if (reshuffle.changed) {
      discardPile = [...(reshuffle.distribution.discard_pile || [])];
      closedDeck = [...(reshuffle.distribution.closed_deck || [])];
      reshufflePayload = {
        triggered_by_user_id: turn.user_id,
        closed_deck_count: reshuffle.closedDeckCount,
        discard_top: reshuffle.discardTop,
        reshuffled_cards: reshuffle.reshuffledCards,
      };
      logGame(
        sessionId,
        `Bot reshuffle successful — uid=${turn.user_id} reshuffledCards=${reshuffle.reshuffledCards} ` +
        `discardTop=${reshuffle.discardTop?.card_uid || 'none'}`
      );
    } else {
      warnGame(
        sessionId,
        `Bot reshuffle unavailable — uid=${turn.user_id} discardCount=${discardPile.length}. No cards available to rebuild closed deck.`
      );
    }
  }

  if (source === 'closed') {
    if (closedDeck.length === 0) {
      warnGame(sessionId, `Bot pick aborted — closed deck still empty after reshuffle attempt uid=${turn.user_id}; retrying`);
      scheduleBotTurnAction(io, sessionId, turn, 'pick', { softRiggingEnabled, aggressiveEnabled });
      return;
    }

    // Soft-rigging: try to find a helpful card for the bot (only when enabled)
    const riggingCard = tryFindBotCardInClosedDeck(
      closedDeck,
      playerDistribution.cards,
      distribution.wild_joker || null,
      {
        softRiggingEnabled,
        sessionId,
        turnId: turn.turn_id,
        userId: turn.user_id,
        decisionSeed,
        playToWin: playContext.playToWin,
        playUrgency: playContext.urgency,
      }
    );

    if (riggingCard) {
      pickedCard = riggingCard;
      usedSoftRiggingPick = true;
    } else {
      pickedCard = closedDeck.shift();
    }
  }

  playerDistribution.cards.push(pickedCard);
  playerDistribution.has_picked = true;
  playersDistribution[playerIndex] = playerDistribution;

  const pickedMetadata = {
    ...(session.metadata || {}),
    distribution: {
      ...distribution,
      players: playersDistribution,
      discard_pile: discardPile,
      closed_deck: closedDeck,
      closed_deck_count: closedDeck.length,
    },
    turn: {
      ...(session.metadata?.turn || {}),
      has_picked: true,
      picked_card_uid: pickedCard.card_uid,
      picked_at: new Date().toISOString(),
    },
    phase_updated_at: new Date().toISOString(),
  };

  await gameSessionModel.updateSessionStatus(sessionId, session.status, {
    currentTurnUserId: session.current_turn_user_id,
    metadata: pickedMetadata,
  });

  // Update discard_history picked marker non-blocking after the bot pick persists.
  if (source === 'discard') {
    setImmediate(() => {
      gameSessionModel.findSessionById(sessionId)
        .then((liveRow) => {
          if (!liveRow) return;
          const botPickedUpdate = markDiscardHistoryPicked(
            liveRow.metadata || {},
            liveRow.metadata?.distribution || null,
            {
              picked_card: pickedCard,
              picked_by_user_id: turn.user_id,
              picked_at: new Date().toISOString(),
            }
          );
          if (!botPickedUpdate.changed) return;
          const patchedMetadata = {
            ...(liveRow.metadata || {}),
            discard_history: botPickedUpdate.discardHistory,
          };
          return gameSessionModel.updateSessionStatus(sessionId, liveRow.status, {
            currentTurnUserId: liveRow.current_turn_user_id,
            metadata: patchedMetadata,
          }).then(() => {
            emitDiscardHistoryUpdate(io, { ...liveRow, metadata: patchedMetadata }, {
              reason: 'bot_pick_discard',
              latest: botPickedUpdate.latestEntry,
            });
          });
        })
        .catch(() => {});
    });
  }

  gameSessionModel.insertEvent({
    sessionId,
    userId: turn.user_id,
    eventType: 'bot_pick',
    payload: {
      source,
      card_uid: pickedCard.card_uid,
      card_id: pickedCard.card_id,
    },
  }).catch(() => {});

  // Defer explainability CPU so human socket:ping / pick ACK aren't blocked.
  const elapsedPickMs = Date.now() - decisionStartedAt;
  setImmediate(() => {
    try {
      const afterPickStrength = evaluateHandStrength(playerDistribution.cards, wildJoker, {
        groupingOptions: tieBreakOptions,
      });
      logBotDecisionExplainability(sessionId, {
        phase: 'pick',
        user_id: turn.user_id,
        turn_id: Number(turn.turn_id) || 0,
        mode,
        wild_joker: wildJoker && { rank: wildJoker.rank, card_id: wildJoker.card_id },
        pick_eval: pickExplain,
        effective_pick_source: source,
        chosen_card: {
          card_uid: pickedCard.card_uid,
          rank: pickedCard.rank,
          suit: pickedCard.suit,
        },
        after_pick_hand: compactGroupingSummary(afterPickStrength.summary),
        grouping_confidence: Number(afterPickStrength.summary?.grouping_confidence),
        decision_margin: Number(afterPickStrength.summary?.decision_margin),
        alternative_count: Number(afterPickStrength.summary?.alternative_count),
        conservative_mode: conservativeMode,
        soft_rigging_applied: usedSoftRiggingPick,
        reshuffle_applied: Boolean(reshufflePayload),
        closed_deck_count_after: closedDeck.length,
        elapsed_ms: elapsedPickMs,
      });
    } catch (_) {
      // explainability must never affect gameplay
    }
  });

  if (reshufflePayload) {
    emitDeckReshuffled(io, sessionId, reshufflePayload);
  }

  const pickPayload = traceSessionBroadcast({
    sessionId,
    eventName: 'game:pick',
    payload: {
      session_id: sessionId,
      server_time: new Date().toISOString(),
      event: 'game:pick',
      user_id: turn.user_id,
      source,
      picked_card: pickedCard,
      closed_deck_count: closedDeck.length,
      discard_top: discardPile[0] || null,
    },
    targetUserId: turn.user_id,
  });
  io.to(sessionRoom(sessionId)).emit('game:pick', pickPayload);

  // discard_history picked markers are handled on discards only.

  scheduleBotTurnAction(io, sessionId, {
    ...turn,
    has_picked: true,
    picked_card_uid: pickedCard.card_uid,
    picked_at: pickedMetadata.turn.picked_at,
  }, 'discard', { softRiggingEnabled, aggressiveEnabled });
}

async function executeBotDiscardAction(io, sessionId, expectedTurnId) {
  const refreshed = await loadBotActionSession(sessionId);
  if (!refreshed || refreshed.status !== 'active') return;
  if (isDeclarationWindowActive(sessionId, refreshed.metadata)) {
    logGame(sessionId, `Bot discard skipped — declaration already open turn=${expectedTurnId}`);
    return;
  }
  const softRiggingEnabled = isBotSoftRiggingEnabled(refreshed);
  const aggressiveEnabled = isBotAggressionEnabled(refreshed);
  const refreshedTurn = refreshed.metadata?.turn;
  if (!refreshedTurn || Number(refreshedTurn.turn_id) !== Number(expectedTurnId)) return;
  if (!isBotTurn(refreshed, refreshedTurn.user_id)) return;
  if (refreshedTurn.has_picked !== true) {
    scheduleBotTurnAction(io, sessionId, refreshedTurn, 'pick', { softRiggingEnabled, aggressiveEnabled });
    return;
  }
  if (!refreshedTurn.picked_card_uid) {
    // Guard against stale/partial turn metadata; bot must pick before any discard/finish decision.
    scheduleBotTurnAction(io, sessionId, refreshedTurn, 'pick', { softRiggingEnabled, aggressiveEnabled });
    return;
  }

  const refreshedDistribution = refreshed.metadata?.distribution;
  if (!refreshedDistribution) return;

  const refreshedPlayersDistribution = Array.isArray(refreshedDistribution.players)
    ? [...refreshedDistribution.players]
    : [];
  const refreshedPlayerIndex = refreshedPlayersDistribution
    .findIndex((pd) => Number(pd.user_id) === Number(refreshedTurn.user_id));
  if (refreshedPlayerIndex < 0) return;

  const refreshedPlayer = {
    ...refreshedPlayersDistribution[refreshedPlayerIndex],
    cards: [...(refreshedPlayersDistribution[refreshedPlayerIndex].cards || [])],
  };
  const hasPickedCardInHand = refreshedPlayer.cards
    .some((card) => String(card?.card_uid || '') === String(refreshedTurn.picked_card_uid));
  if (!hasPickedCardInHand) {
    scheduleBotTurnAction(io, sessionId, refreshedTurn, 'pick', { softRiggingEnabled, aggressiveEnabled });
    return;
  }
  // After pick the hand must be 14. A 13-card hand here means finish already
  // removed a card — discarding again is the DQ-then-D10 double action.
  if (refreshedPlayer.cards.length !== FINISH_PLAN_HAND_CARD_COUNT) {
    warnGame(
      sessionId,
      `Bot discard aborted — hand has ${refreshedPlayer.cards.length} cards after pick ` +
      `uid=${refreshedTurn.user_id} (finish already consumed this turn)`
    );
    return;
  }

  const decisionStartedAt = Date.now();
  const decisionSeed = buildDecisionSeed(sessionId, refreshedTurn.turn_id, refreshedTurn.user_id);
  const tieBreakOptions = buildGroupingTieBreakOptions(decisionSeed);
  const handStrengthBeforeDecision = evaluateHandStrength(
    refreshedPlayer.cards,
    refreshedDistribution.wild_joker || null,
    { groupingOptions: tieBreakOptions }
  );
  const conservativeMode = BOT_CONSERVATIVE_PLAY_ON_LOW_CONFIDENCE
    && isLowConfidenceGrouping(handStrengthBeforeDecision.summary || {});

  await yieldToEventLoop();

  let finishPlan = tryBuildBotFinishPlan(
    refreshedPlayer.cards,
    refreshedDistribution.wild_joker || null,
    {
      groupingOptions: tieBreakOptions,
      tieBreakSeed: decisionSeed,
      sessionId,
      userId: refreshedTurn.user_id,
      turnId: refreshedTurn.turn_id,
    }
  );
  if (finishPlan?.preview?.summary?.valid_for_declare !== true) {
    finishPlan = null;
  }
  if (finishPlan) {
    if (typeof declarationRuntime.startWindow !== 'function') {
      throw new Error('Declaration runtime is not initialized');
    }
    if (typeof declarationRuntime.scheduleBotResponses !== 'function') {
      throw new Error('Declaration runtime scheduler is not initialized');
    }

    const updatedPlayerDistribution = {
      ...refreshedPlayer,
      cards: finishPlan.nextHandCards,
      submitted_groups: finishPlan.submittedGroups,
    };
    const updatedPlayersDistribution = refreshedPlayersDistribution.map((pd, idx) =>
      (idx === refreshedPlayerIndex ? updatedPlayerDistribution : pd)
    );
    const updatedDistribution = {
      ...refreshedDistribution,
      players: updatedPlayersDistribution,
    };
    const updatedSession = {
      ...refreshed,
      metadata: {
        ...(refreshed.metadata || {}),
        distribution: updatedDistribution,
      },
    };

    logGame(
      sessionId,
      `Bot finish initiated — uid=${refreshedTurn.user_id} finish=${finishPlan.finishCard.card_uid} ` +
      `groups=${finishPlan.submittedGroups.length} preview_valid=${finishPlan.preview.summary?.valid_for_declare}`
    );

    const mode = resolveSessionGameMode(refreshed);
    const wildForFinish = refreshedDistribution.wild_joker || null;
    const invalidPoolDeclare = mode === 'pool' && finishPlan?.preview?.summary?.valid_for_declare !== true;
    logBotDecisionExplainability(sessionId, {
      phase: 'finish',
      user_id: refreshedTurn.user_id,
      turn_id: Number(refreshedTurn.turn_id) || 0,
      mode,
      wild_joker: wildForFinish && { rank: wildForFinish.rank, card_id: wildForFinish.card_id },
      hand_before_finish: compactGroupingSummary(handStrengthBeforeDecision.summary),
      grouping_confidence: Number(handStrengthBeforeDecision.summary?.grouping_confidence),
      decision_margin: Number(handStrengthBeforeDecision.summary?.decision_margin),
      alternative_count: Number(handStrengthBeforeDecision.summary?.alternative_count),
      conservative_mode: conservativeMode,
      finish_card_uid: finishPlan.finishCard.card_uid,
      preview_valid_for_declare: finishPlan.preview?.summary?.valid_for_declare === true,
      invalid_pool_declare_branch: invalidPoolDeclare === true,
      submitted_group_count: finishPlan.submittedGroups.length,
      elapsed_ms: Date.now() - decisionStartedAt,
    });
    if (invalidPoolDeclare) {
      const poolLimit = resolvePoolLimit(refreshed);
      const currentScores = normalizePoolScoresByUser(refreshed.metadata || {});
      const declarerKey = String(refreshedTurn.user_id);
      const nextScore = (Number(currentScores[declarerKey]) || 0) + 80;
      const nextScores = {
        ...currentScores,
        [declarerKey]: nextScore,
      };
      const poolEliminatedSet = new Set(
        (Array.isArray(refreshed.metadata?.pool_eliminated_user_ids)
          ? refreshed.metadata.pool_eliminated_user_ids
          : [])
          .map((id) => Number(id))
          .filter((id) => !Number.isNaN(id))
      );
      const crossedPoolLimitNow = Number.isFinite(poolLimit) && nextScore >= poolLimit;
      if (crossedPoolLimitNow) {
        poolEliminatedSet.add(Number(refreshedTurn.user_id));
      }
      const turnEliminatedSet = new Set(
        (Array.isArray(refreshed.metadata?.turn_eliminated_user_ids)
          ? refreshed.metadata.turn_eliminated_user_ids
          : [])
          .map((id) => Number(id))
          .filter((id) => !Number.isNaN(id))
      );
      turnEliminatedSet.add(Number(refreshedTurn.user_id));
      const activePlayersAfterPack = (refreshed.players || []).filter((playerItem) => {
        const uid = Number(playerItem.user_id);
        if (Number.isNaN(uid)) return false;
        if (poolEliminatedSet.has(uid)) return false;
        if (turnEliminatedSet.has(uid)) return false;
        return true;
      });
      if (activePlayersAfterPack.length <= 1) {
        const winnerUserId = activePlayersAfterPack[0]?.user_id || null;
        if (winnerUserId != null) {
          await finalizeGameByElimination(
            io,
            {
              ...refreshed,
              metadata: {
                ...(refreshed.metadata || {}),
                pool_scores_by_user: nextScores,
                pool_eliminated_user_ids: Array.from(poolEliminatedSet),
                turn_eliminated_user_ids: Array.from(turnEliminatedSet),
                distribution: updatedDistribution,
              },
            },
            winnerUserId,
            Array.from(poolEliminatedSet),
            'invalid_declaration_last_player_standing'
          );
          return;
        }
      }
      const nextTurnUser = nextTurnUserId(activePlayersAfterPack, refreshedTurn.user_id, {
        currentSeatNo: (refreshed.players || []).find(
          (p) => Number(p.user_id) === Number(refreshedTurn.user_id)
        )?.seat_no,
      });
      if (!nextTurnUser) return;
      const turnTimerSeconds = Number(refreshed?.game?.turn_timer_seconds) || 30;
      const attemptsUsedByUser = normalizeAttemptsUsedByUser(refreshed.metadata || {});
      const nextTurnWindow = buildTurnWindow(turnTimerSeconds);
      const nextTurn = buildTurnPayload({
        session: refreshed,
        userId: nextTurnUser,
        turnId: Number(refreshed?.metadata?.turn?.turn_id || 0) + 1,
        type: 'normal',
        attemptNo: 0,
        attemptsUsedCount: Number(attemptsUsedByUser[String(nextTurnUser)]) || 0,
        startedAt: nextTurnWindow.startedAt,
        endsAt: nextTurnWindow.endsAt,
        turnTimerSeconds,
        hasPicked: false,
      });
      const nextMetadata = {
        ...(refreshed.metadata || {}),
        distribution: updatedDistribution,
        phase: 'active',
        phase_updated_at: new Date().toISOString(),
        turn: nextTurn,
        turn_bonus: {
          max_attempts_per_player: getMaxBonusAttempts(refreshed),
          attempts_used_by_user: attemptsUsedByUser,
        },
        turn_eliminated_user_ids: Array.from(turnEliminatedSet),
        pool_scores_by_user: nextScores,
        pool_eliminated_user_ids: Array.from(poolEliminatedSet),
      };
      delete nextMetadata.declaration;
      await gameSessionModel.updateSessionStatus(sessionId, refreshed.status, {
        currentTurnUserId: nextTurnUser,
        metadata: nextMetadata,
      });
      await gameSessionModel.insertEvent({
        sessionId,
        userId: refreshedTurn.user_id,
        eventType: 'invalid_declaration_packed',
        payload: {
          user_id: refreshedTurn.user_id,
          penalty_points: 80,
          total_score: nextScore,
          next_turn_user_id: nextTurnUser,
          pool_limit: poolLimit,
          eliminated: crossedPoolLimitNow,
          source: 'bot',
        },
      });
      const botPlayer = (refreshed.players || []).find(
        (entry) => Number(entry.user_id) === Number(refreshedTurn.user_id)
      );
      if (botPlayer) {
        await persistInvalidDeclarationPackMetadata(sessionId, refreshedTurn.user_id, {
          penaltyPoints: 80,
          cumulativePoints: nextScore,
          eliminated: crossedPoolLimitNow,
        });
        emitPlayerStatusOverride(io, refreshed, botPlayer, {
          status: crossedPoolLimitNow ? 'eliminated' : botPlayer.status,
          player_status: crossedPoolLimitNow ? 'eliminated' : 'invalid_declaration',
          metadata: {
            invalid_declaration: true,
            packed_in_current_deal: true,
            invalid_declaration_penalty_points: 80,
            cumulative_points: nextScore,
          },
        }, crossedPoolLimitNow ? 'pool_limit_eliminated' : 'invalid_declaration_packed');
      }
      if (crossedPoolLimitNow) {
        schedulePoolEliminationDetachAfterNextDealStart(io, sessionId, refreshedTurn.user_id, 'pool_limit_eliminated');
        await emitPendingRejoinGameForUser(io, refreshedTurn.user_id, 'pool_limit_eliminated');
      }
      emitTurn(io, sessionId, nextTurn, {
        action: 'invalid_declaration_continue',
        previous_turn_id: refreshed?.metadata?.turn?.turn_id || null,
        invalid_declarer_user_id: refreshedTurn.user_id,
        distribution: nextMetadata.distribution,
      });
      scheduleTurnTimeout(io, sessionId, nextTurn);
      await emitSessionState(io, sessionId, { includeEvents: false });
      return;
    }

    await declarationRuntime.startWindow(
      updatedSession,
      refreshedTurn.user_id,
      finishPlan.submittedGroups,
      {
        finishCard: finishPlan.finishCard,
        distribution: updatedDistribution,
      }
    );
    declarationRuntime.scheduleBotResponses(sessionId);
    logGame(
      sessionId,
      `Bot finish complete — discard skipped for this turn uid=${refreshedTurn.user_id} ` +
      `finish=${finishPlan.finishCard.card_uid}`
    );
    return;
  }

  await yieldToEventLoop();

  const discardWild = refreshedDistribution.wild_joker || null;
  const playContext = buildBotPlayContext(refreshed, refreshedTurn.user_id);
  const discardOptions = {
    tieBreakSeed: `${decisionSeed}:discard`,
    conservativeMode,
    groupingOptions: tieBreakOptions,
    playUrgency: playContext.urgency,
    playToWin: playContext.playToWin,
    mode: playContext.mode,
    precomputedGrouping: handStrengthBeforeDecision.grouping,
  };
  let rankedDiscards = buildDiscardCandidateRanking(
    refreshedPlayer.cards,
    discardWild,
    discardOptions
  );
  let discardCard = rankedDiscards[0]?.candidate || null;
  const discardCandidates = rankedDiscards.slice(0, 5).map((row) => ({
    card_uid: row.candidate?.card_uid,
    rank: row.candidate?.rank,
    suit: row.candidate?.suit,
    discardScore: row.discardScore,
    importance: row.importance,
    value: row.value,
    groupedPenalty: row.groupedPenalty,
  }));
  const pickedUid = String(refreshedTurn.picked_card_uid || '').trim();
  if (pickedUid && discardCard?.card_uid === pickedUid) {
    const pickedCardObj = refreshedPlayer.cards.find((card) => card?.card_uid === pickedUid);
    const handBeforePick = refreshedPlayer.cards.filter((card) => card?.card_uid !== pickedUid);
    if (
      pickedCardObj
      && !canMeaningfullyImproveWithPickedCard(handBeforePick, pickedCardObj, discardWild)
    ) {
      rankedDiscards = buildDiscardCandidateRanking(refreshedPlayer.cards, discardWild, {
        ...discardOptions,
        excludeCardUids: [pickedUid],
      });
      discardCard = rankedDiscards[0]?.candidate || null;
    }
  }
  if (!discardCard && refreshedPlayer.cards.length > 0) {
    discardCard = refreshedPlayer.cards[refreshedPlayer.cards.length - 1];
  }
  if (!discardCard) {
    warnGame(sessionId, `Bot discard aborted — no card available uid=${refreshedTurn.user_id}; retrying pick`);
    scheduleBotTurnAction(io, sessionId, refreshedTurn, 'pick', { softRiggingEnabled, aggressiveEnabled });
    return;
  }

  logBotDecisionExplainability(sessionId, {
    phase: 'discard',
    user_id: refreshedTurn.user_id,
    turn_id: Number(refreshedTurn.turn_id) || 0,
    mode: resolveSessionGameMode(refreshed),
    wild_joker: discardWild && { rank: discardWild.rank, card_id: discardWild.card_id },
    hand_before_discard: compactGroupingSummary(
      handStrengthBeforeDecision.summary
    ),
    grouping_confidence: Number(handStrengthBeforeDecision.summary?.grouping_confidence),
    decision_margin: Number(handStrengthBeforeDecision.summary?.decision_margin),
    alternative_count: Number(handStrengthBeforeDecision.summary?.alternative_count),
    conservative_mode: conservativeMode,
    top_discard_candidates: discardCandidates,
    chosen_discard_uid: discardCard.card_uid,
    elapsed_ms: Date.now() - decisionStartedAt,
  });

  const discardIndex = refreshedPlayer.cards.findIndex((card) => card.card_uid === discardCard.card_uid);
  if (discardIndex < 0) {
    warnGame(sessionId, `Bot discard card missing from hand uid=${refreshedTurn.user_id}; retrying discard`);
    scheduleBotTurnAction(io, sessionId, refreshedTurn, 'discard', { softRiggingEnabled, aggressiveEnabled });
    return;
  }

  const [discardedCard] = refreshedPlayer.cards.splice(discardIndex, 1);
  refreshedPlayersDistribution[refreshedPlayerIndex] = refreshedPlayer;
  const nextDiscardPile = [discardedCard, ...(refreshedDistribution.discard_pile || [])];

  const nextTurnUser = nextTurnUserId(getActivePlayers(refreshed), refreshedTurn.user_id, {
    currentSeatNo: (refreshed.players || []).find(
      (p) => Number(p.user_id) === Number(refreshedTurn.user_id)
    )?.seat_no,
  });
  if (!nextTurnUser) {
    warnGame(sessionId, `Bot discard could not resolve next turn uid=${refreshedTurn.user_id}`);
    return;
  }

  const turnTimerSeconds = resolveNormalTurnTimerSeconds(refreshed, 30);
  const attemptsUsedByUser = normalizeAttemptsUsedByUser(refreshed.metadata || {});
  const nextTurnWindow = buildTurnWindow(turnTimerSeconds);
  const nextTurn = buildTurnPayload({
    session: refreshed,
    userId: nextTurnUser,
    turnId: (Number(refreshedTurn.turn_id) || Date.now()) + 1,
    type: 'normal',
    attemptNo: 0,
    attemptsUsedCount: Number(attemptsUsedByUser[String(nextTurnUser)]) || 0,
    startedAt: nextTurnWindow.startedAt,
    endsAt: nextTurnWindow.endsAt,
    turnTimerSeconds,
    hasPicked: false,
  });

  const playersAfterDepartingTurn = markDepartingPlayerFirstTurnCycleComplete(
    refreshedPlayersDistribution,
    refreshedTurn.user_id
  );

  const nextMetadata = {
    ...(refreshed.metadata || {}),
    distribution: {
      ...refreshedDistribution,
      players: playersAfterDepartingTurn,
      discard_pile: nextDiscardPile,
    },
    turn: nextTurn,
    turn_bonus: {
      max_attempts_per_player: getMaxBonusAttempts(refreshed),
      attempts_used_by_user: attemptsUsedByUser,
    },
    phase_updated_at: new Date().toISOString(),
  };

  const botDiscardHistoryAppend = appendDiscardHistoryEntry(nextMetadata, nextMetadata.distribution, {
    discarded_card: discardedCard,
    discarded_by_user_id: refreshedTurn.user_id,
    discarded_at: new Date().toISOString(),
    turn_id: refreshedTurn.turn_id,
  });
  nextMetadata.discard_history = botDiscardHistoryAppend.discardHistory;

  await gameSessionModel.updateSessionStatus(sessionId, refreshed.status, {
    currentTurnUserId: nextTurnUser,
    metadata: nextMetadata,
  });

  await gameSessionModel.insertEvent({
    sessionId,
    userId: refreshedTurn.user_id,
    eventType: 'bot_discard',
    payload: {
      card_uid: discardedCard.card_uid,
      card_id: discardedCard.card_id,
      next_turn_user_id: nextTurnUser,
    },
  });

  emitBotDiscardBroadcast(
    io,
    sessionId,
    refreshedTurn.user_id,
    discardedCard,
    nextDiscardPile[0] || null,
    { reason: 'bot_discard' }
  );

  emitTurn(io, sessionId, nextTurn, {
    action: 'discard',
    previous_turn_user_id: refreshedTurn.user_id,
    previous_turn_id: refreshedTurn.turn_id,
    discarded_card: discardedCard,
    discard_top: nextDiscardPile[0] || null,
    player_deal_flags: buildPlayerDealFlags(playersAfterDepartingTurn),
    distribution: nextMetadata.distribution,
  });

  emitDiscardHistoryUpdate(io, {
    ...refreshed,
    metadata: nextMetadata,
  }, {
    reason: 'bot_discard',
    latest: botDiscardHistoryAppend.latestEntry,
  });

  scheduleTurnTimeout(io, sessionId, nextTurn);
}

const BOT_TURN_DEFER_MARKER = '__botTurnTimeoutDeferMs';
const BOT_TURN_HARD_DEADLINE_PAD_MS = BOT_POST_PICK_DELAY_MAX_MS + BOT_ACTION_DELAY_MAX_MS + 4000;
const BOT_TURN_DURABLE_GRACE_MS = Math.max(
  500,
  Number(process.env.BOT_TURN_DURABLE_GRACE_MS) || 1500,
);

function getBotTurnHardDeadlineMs(turn) {
  const endsAtTs = Date.parse(turn?.ends_at || '');
  if (Number.isNaN(endsAtTs)) return Date.now() + BOT_TURN_HARD_DEADLINE_PAD_MS;
  return endsAtTs + BOT_TURN_HARD_DEADLINE_PAD_MS;
}

function markBotTurnTimeoutDefer(session, deferUntilMs) {
  if (!session || !Number.isFinite(deferUntilMs)) return session;
  Object.defineProperty(session, BOT_TURN_DEFER_MARKER, {
    value: deferUntilMs,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return session;
}

function takeBotTurnTimeoutDeferMs(session) {
  if (!session) return null;
  const deferUntilMs = Number(session[BOT_TURN_DEFER_MARKER]);
  try {
    delete session[BOT_TURN_DEFER_MARKER];
  } catch (_) {
    // ignore
  }
  return Number.isFinite(deferUntilMs) ? deferUntilMs : null;
}

async function peekPendingBotTurnTimer(sessionId, turnId, phase) {
  const normalizedPhase = phase === 'discard' ? 'discard' : 'pick';
  return durableTimer.peek({
    kind: 'bot_turn',
    sessionId,
    token: `${Number(turnId)}:${normalizedPhase}`,
  });
}

function scheduleDeferredTurnTimeout(io, sessionId, turnId, fireAtMs, turnType = 'normal') {
  cleanupTurnTimeoutOnly(sessionId);
  const delayMs = Math.max(50, Number(fireAtMs) - Date.now());
  const timeoutHandle = setTimeout(() => {
    onTurnTimeout(io, sessionId, Number(turnId)).catch((err) => {
      errorGame(sessionId, `Deferred turn timeout handler failed: ${err.message}`);
    });
  }, delayMs);

  activeTurnBySession.set(sessionId, {
    timeoutHandle,
    turnId: Number(turnId),
    type: turnType || 'normal',
    endsAt: new Date(Date.now() + delayMs).toISOString(),
  });

  durableTimer.arm({
    kind: 'turn',
    sessionId,
    token: turnId,
    fireAtMs: Date.now() + delayMs,
    graceMs: 500,
    payload: {
      turn_id: Number(turnId),
      type: turnType || 'normal',
      deferred: true,
    },
  }).catch(() => {});

  logGame(
    sessionId,
    `Turn timeout deferred ${delayMs}ms for bot pacing turn=${turnId}`,
  );
}

/**
 * Multi-instance safe bot flush:
 * - If a durable/local bot action is still pending in the future (and still inside
 *   the turn clock), defer turn penalty so pick/discard keep human-like delays.
 * - Never chain forced pick → forced discard in the same tick.
 * - Only force the current phase when the bot timer is missing/overdue; after a
 *   forced pick, schedule discard normally and defer the turn timeout.
 */
async function flushBotTurnBeforeTimeout(io, sessionId, session, turn) {
  if (!isBotTurn(session, turn.user_id)) return session;
  if (isDeclarationWindowActive(sessionId, session?.metadata)) {
    logGame(sessionId, `Bot flush skipped — declaration window active turn=${turn?.turn_id}`);
    return session;
  }

  const softRiggingEnabled = isBotSoftRiggingEnabled(session);
  const aggressiveEnabled = isBotAggressionEnabled(session);
  const phase = turn.has_picked === true ? 'discard' : 'pick';
  const hardDeadlineMs = getBotTurnHardDeadlineMs(turn);
  const pastHardDeadline = Date.now() >= hardDeadlineMs;
  const endsAtMs = Date.parse(turn?.ends_at || '');
  const withinTurnClock = Number.isNaN(endsAtMs) || Date.now() <= endsAtMs + 50;

  const localBot = getActiveBotActionState(sessionId);
  const localOwnsPending = Boolean(
    localBot
    && Number(localBot.turnId) === Number(turn.turn_id)
    && localBot.phase === phase
    && localBot.timeoutHandle
  );

  const pendingDurable = await peekPendingBotTurnTimer(sessionId, turn.turn_id, phase);
  const pendingFireAtMs = Number(pendingDurable?.fire_at_ms);
  // Only treat as "still pending" when fire time is still ahead (or barely due).
  // Overdue timers mean the owning worker failed — force/recover instead of waiting
  // until after the visible turn timer.
  const durableStillPending = Number.isFinite(pendingFireAtMs)
    && pendingFireAtMs >= Date.now() - 100
    && pendingFireAtMs <= (Number.isNaN(endsAtMs) ? pendingFireAtMs : endsAtMs + 200);

  // Another worker (or this one) still has a scheduled bot action inside the turn.
  if (!pastHardDeadline && withinTurnClock && (localOwnsPending || durableStillPending)) {
    const deferUntilMs = Math.min(
      hardDeadlineMs,
      Math.max(
        Date.now() + 250,
        (durableStillPending ? pendingFireAtMs : Date.now()) + 900,
      ),
    );
    logGame(
      sessionId,
      `Bot flush deferred — pending ${phase} turn=${turn.turn_id} local=${localOwnsPending} durable=${durableStillPending}`,
    );
    return markBotTurnTimeoutDefer(session, deferUntilMs);
  }

  // Orphan / overdue: force only the current phase (not pick+discard together).
  cleanupBotActionState(sessionId);
  try {
    await executeBotTurnAction(io, sessionId, Number(turn.turn_id), phase);
  } catch (err) {
    warnGame(sessionId, `Bot forced action before timeout failed uid=${turn.user_id}: ${err.message}`);
  }

  const refreshed = await loadBotActionSession(sessionId);
  if (!refreshed || refreshed.status !== 'active') return refreshed;

  const refreshedTurn = refreshed.metadata?.turn;
  if (Number(refreshedTurn?.turn_id) !== Number(turn.turn_id)) {
    logGame(sessionId, `Turn timeout skipped — bot completed turn uid=${turn.user_id}`);
    return refreshed;
  }

  // After a forced/late pick, keep normal discard pacing and defer turn timeout.
  if (phase === 'pick' && refreshedTurn?.has_picked === true) {
    if (pastHardDeadline) {
      try {
        await executeBotTurnAction(io, sessionId, Number(turn.turn_id), 'discard');
      } catch (err) {
        warnGame(sessionId, `Bot forced discard before timeout failed uid=${turn.user_id}: ${err.message}`);
      }
      const afterDiscard = await loadBotActionSession(sessionId);
      if (afterDiscard?.metadata?.turn?.turn_id !== turn.turn_id) {
        logGame(sessionId, `Turn timeout skipped — bot discarded uid=${turn.user_id}`);
        return afterDiscard;
      }
      return afterDiscard || refreshed;
    }

    scheduleBotTurnAction(io, sessionId, refreshedTurn, 'discard', {
      softRiggingEnabled,
      aggressiveEnabled,
    });
    const discardPending = await peekPendingBotTurnTimer(sessionId, turn.turn_id, 'discard');
    const discardFireAt = Number(discardPending?.fire_at_ms);
    const deferUntilMs = Math.min(
      hardDeadlineMs,
      Number.isFinite(discardFireAt)
        ? discardFireAt + 900
        : Date.now() + Math.min(BOT_POST_PICK_DELAY_MIN_MS, 1500) + 500,
    );
    logGame(sessionId, `Bot flush scheduled discard with delay — deferring turn timeout turn=${turn.turn_id}`);
    return markBotTurnTimeoutDefer(refreshed, deferUntilMs);
  }

  // Still same phase (force no-op / race): ensure a schedule exists, then defer briefly.
  if (!pastHardDeadline) {
    scheduleBotTurnAction(io, sessionId, refreshedTurn, phase, {
      softRiggingEnabled,
      aggressiveEnabled,
    });
    const again = await peekPendingBotTurnTimer(sessionId, turn.turn_id, phase);
    const fireAt = Number(again?.fire_at_ms);
    const deferUntilMs = Math.min(
      hardDeadlineMs,
      Number.isFinite(fireAt) ? fireAt + 900 : Date.now() + 800,
    );
    return markBotTurnTimeoutDefer(refreshed, deferUntilMs);
  }

  return refreshed;
}

function executeBotTurnAction(io, sessionId, expectedTurnId, phase = 'pick') {
  const normalizedPhase = phase === 'discard' ? 'discard' : 'pick';
  const claimKey = botTurnPhaseClaimKey(sessionId, expectedTurnId, normalizedPhase);

  // Drop this worker's local timer handle only. Do NOT cancel Redis yet — losing the
  // claim race must leave durable recovery intact for the other worker.
  clearLocalBotActionStateOnly(sessionId);

  const run = normalizedPhase === 'discard'
    ? () => executeBotDiscardAction(io, sessionId, expectedTurnId)
    : () => executeBotPickAction(io, sessionId, expectedTurnId);

  // Yield once so inbound socket handlers/ACKs can run before heavy bot CPU.
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      // Keep claim only for a successful action; release on no-op so retries work.
      redisLockService.claimEventIdempotency(claimKey, 45)
        .then(async (claimed) => {
          if (!claimed) {
            return null;
          }

          await durableTimer.cancel({
            kind: 'bot_turn',
            sessionId,
            token: `${Number(expectedTurnId)}:${normalizedPhase}`,
          }).catch(() => {});

          try {
            const result = await Promise.resolve().then(run);
            const stillNeeded = await botPhaseStillNeeded(sessionId, expectedTurnId, normalizedPhase);
            if (stillNeeded) {
              // Validation no-op / turn-not-started reschedule path: free the claim.
              await redisLockService.releaseEventIdempotency(claimKey).catch(() => {});
              const live = await loadBotActionSession(sessionId);
              const liveTurn = live?.metadata?.turn;
              if (
                live
                && live.status === 'active'
                && liveTurn
                && Number(liveTurn.turn_id) === Number(expectedTurnId)
                && isBotTurn(live, liveTurn.user_id)
              ) {
                const softRiggingEnabled = isBotSoftRiggingEnabled(live);
                const aggressiveEnabled = isBotAggressionEnabled(live);
                // Avoid duplicate schedule if executeBot* already re-armed.
                const pending = await peekPendingBotTurnTimer(sessionId, expectedTurnId, normalizedPhase);
                const local = getActiveBotActionState(sessionId);
                const alreadyArmed = Boolean(
                  (local
                    && Number(local.turnId) === Number(expectedTurnId)
                    && local.phase === normalizedPhase)
                  || (pending && Number(pending.fire_at_ms) > Date.now() - 50)
                );
                if (!alreadyArmed) {
                  scheduleBotTurnAction(io, sessionId, liveTurn, normalizedPhase, {
                    softRiggingEnabled,
                    aggressiveEnabled,
                  });
                }
              }
            }
            return result;
          } catch (err) {
            await redisLockService.releaseEventIdempotency(claimKey).catch(() => {});
            throw err;
          }
        })
        .then(resolve)
        .catch(reject);
    });
  });
}

function scheduleBotTurnAction(io, sessionId, turn, phase = 'pick', options = {}) {
  if (!turn || Number.isNaN(Number(turn.turn_id))) return;

  const normalizedPhase = phase === 'discard' ? 'discard' : 'pick';
  const existingState = getActiveBotActionState(sessionId);
  if (
    existingState
    && Number(existingState.turnId) === Number(turn.turn_id)
    && existingState.phase === normalizedPhase
  ) {
    return;
  }

  cleanupBotActionState(sessionId);
  let actionDelayMs = normalizedPhase === 'discard'
    ? resolveBotDiscardDelayMs(turn, options)
    : resolveBotActionDelayMs(turn, { ...options, phase: 'pick' });

  // Never arm a bot action after the visible turn clock when we can still clamp.
  const endsAtTs = Date.parse(turn?.ends_at || '');
  if (!Number.isNaN(endsAtTs)) {
    const maxDelay = Math.max(250, endsAtTs - Date.now() - 400);
    actionDelayMs = Math.min(actionDelayMs, maxDelay);
  }

  const timeoutHandle = setTimeout(() => {
    executeBotTurnAction(io, sessionId, Number(turn.turn_id), normalizedPhase).catch((err) => {
      errorGame(sessionId, `Bot turn action failed: ${err.message}`);
    });
  }, actionDelayMs);

  activeBotActionBySession.set(sessionId, {
    timeoutHandle,
    turnId: Number(turn.turn_id),
    phase: normalizedPhase,
  });

  durableTimer.arm({
    kind: 'bot_turn',
    sessionId,
    token: `${Number(turn.turn_id)}:${normalizedPhase}`,
    fireAtMs: Date.now() + actionDelayMs,
    graceMs: BOT_TURN_DURABLE_GRACE_MS,
    payload: {
      turn_id: Number(turn.turn_id),
      phase: normalizedPhase,
      user_id: turn.user_id || null,
    },
  }).catch(() => {});

  logGame(sessionId, `Bot action scheduled turn=${Number(turn.turn_id)} phase=${normalizedPhase} delay=${actionDelayMs}ms`);
}

async function maybeScheduleBotTurnAction(io, sessionId, turn) {
  if (!turn || Number.isNaN(Number(turn.user_id))) return;
  const session = await loadBotActionSession(sessionId);
  if (!session || session.status !== 'active') return;
  if (isDeclarationWindowActive(sessionId, session.metadata)) return;
  if (!isBotTurn(session, turn.user_id)) return;
  const softRiggingEnabled = isBotSoftRiggingEnabled(session);
  const aggressiveEnabled = isBotAggressionEnabled(session);

  scheduleBotTurnAction(
    io,
    sessionId,
    turn,
    turn.has_picked === true ? 'discard' : 'pick',
    { softRiggingEnabled, aggressiveEnabled }
  );
}

async function finalizeGameByElimination(
  io,
  session,
  winnerUserId,
  eliminatedUserIds = [],
  reason = 'elimination_last_player',
  timeoutEliminatedUserIds = []
) {
  const sessionId = session.id;
  const distribution = session.metadata?.distribution;
  if (!distribution) {
    throw new Error('Card distribution not found for elimination finalize');
  }

  const players = Array.isArray(session.players) ? session.players : [];
  const wildJoker = distribution.wild_joker || null;
  const timeoutEliminatedSet = new Set([
    ...Array.from(getTimeoutEliminatedUserIdSet(session.metadata || {})),
    ...timeoutEliminatedUserIds,
  ].map((id) => Number(id)).filter((id) => !Number.isNaN(id)));
  const turnEliminatedSet = getTurnEliminatedUserIdSet(session.metadata || {});
  // Wrong-show last-standing: pack flags may still be missing on stale players[].
  // Never score those seats from hand/ungrouped points — always full 80.
  const isInvalidDeclareFinalize = String(reason || '').includes('invalid_declaration');

  let finalizedResults = players.map((player) => {
    const playerDistribution = getPlayerDistribution(distribution, player.user_id);
    const playerCards = playerDistribution?.cards || [];
    const scoring = scoreFromBestGrouping(playerCards, wildJoker);
    const isWinner = Number(player.user_id) === Number(winnerUserId);
    const isDropped = isPlayerDropped(player, playerDistribution);
    const uid = Number(player.user_id);
    const isInvalidPacked = isInvalidDeclarationPackedPlayer(player)
      || (
        isInvalidDeclareFinalize
        && !isWinner
        && !isDropped
        && !timeoutEliminatedSet.has(uid)
        && turnEliminatedSet.has(uid)
      );
    let points = scoring.points;
    if (isDropped) {
      const droppedPenalty = resolveDropLossPoints(session, player.user_id);
      if (Number.isFinite(droppedPenalty)) {
        points = droppedPenalty;
      }
    } else if (isInvalidPacked) {
      points = resolveInvalidDeclarationPenaltyPoints(player);
    } else if (timeoutEliminatedSet.has(uid)) {
      const timeoutPenalty = resolveDropLossPoints(session, player.user_id, { forceMiddleDrop: true });
      if (Number.isFinite(timeoutPenalty)) {
        points = timeoutPenalty;
      }
    }
    const playerStatus = isWinner
      ? 'won'
      : isDropped
        ? 'dropped'
        : isInvalidPacked
          ? 'invalid_declaration'
          : timeoutEliminatedSet.has(uid)
            ? 'timeout'
            : 'lost';

    return {
      user_id: player.user_id,
      seat_no: player.seat_no,
      points: isWinner ? 0 : points,
      round_points: isWinner ? 0 : points,
      grouped_points: scoring.grouping.summary.grouped_points,
      ungrouped_points: scoring.grouping.summary.ungrouped_points,
      valid_for_declare: isInvalidPacked ? false : scoring.grouping.summary.valid_for_declare,
      invalid_group_count: Number(scoring.grouping.summary.invalid_group_count) || 0,
      all_cards_grouped: scoring.grouping.summary.all_cards_grouped !== false,
      submission_mode: isInvalidPacked ? 'manual' : 'auto',
      submission_status: isInvalidPacked ? 'manual' : 'auto',
      player_status: playerStatus,
      status_color: resolveStatusColor(playerStatus),
      dropped: isDropped,
      is_winner: isWinner,
    };
  });

  const mode = resolveSessionGameMode(session);
  if (mode === 'pool') {
    const poolScoresByUser = normalizePoolScoresByUser(session.metadata || {});
    const previousPoolEliminatedSet = new Set(
      (Array.isArray(session.metadata?.pool_eliminated_user_ids) ? session.metadata.pool_eliminated_user_ids : [])
        .map((id) => Number(id))
        .filter((id) => !Number.isNaN(id))
    );
    const poolEliminatedSet = new Set([
      ...Array.from(previousPoolEliminatedSet),
      ...eliminatedUserIds,
      ...Array.from(timeoutEliminatedSet),
    ].map((id) => Number(id)).filter((id) => !Number.isNaN(id)));
    const newlyEliminatedUserIds = Array.from(poolEliminatedSet)
      .filter((id) => !previousPoolEliminatedSet.has(id) && Number(id) !== Number(winnerUserId));
    newlyEliminatedUserIds.forEach((userId) => {
      const timeoutPenalty = timeoutEliminatedSet.has(Number(userId));
      const penalty = resolveDropLossPoints(session, userId, { forceMiddleDrop: timeoutPenalty });
      if (!Number.isFinite(penalty)) return;
      const key = String(userId);
      poolScoresByUser[key] = (Number(poolScoresByUser[key]) || 0) + penalty;
    });
    const poolLimit = resolvePoolLimit(session);
    finalizedResults = buildPoolFinalResults(
      session,
      poolScoresByUser,
      winnerUserId,
      Array.from(poolEliminatedSet),
      finalizedResults,
    );

    let settlement = null;
    try {
      settlement = await settlePoolPotResult(session, winnerUserId);
    } catch (settleErr) {
      errorGame(sessionId, `Pool settlement error on elimination finalize (non-fatal): ${settleErr.message}`);
    }

    const resultPayload = {
      session_id: sessionId,
      server_time: new Date().toISOString(),
      event: 'game:result',
      status: 'completed',
      is_final: true,
      reason,
      winner_user_id: winnerUserId,
      eliminated_user_ids: Array.from(poolEliminatedSet),
      timeout_eliminated_user_ids: Array.from(timeoutEliminatedSet),
      tie_break_policy: 'pool_limit_then_last_player_standing',
      pool_limit: poolLimit,
      pool_scores_by_user: poolScoresByUser,
      pool_eliminated_user_ids: Array.from(poolEliminatedSet),
      can_rejoin_table: false,
      rejoin_threshold: null,
      rejoin_candidate_user_ids: [],
      rejoin_start_points_by_user: {},
      rejoin_at_points_by_user: {},
      joining_fee: roundCurrency(Number(session?.contest?.entry) || 0),
      current_prize_pool: buildPoolPrizePoolSummary({
        entryFee: roundCurrency(Number(session?.contest?.entry) || 0),
        baseEntryCount: resolvePoolBaseEntryCount(session),
        rejoinEntryCount: resolvePoolRejoinEntryCount(session?.metadata || {}),
        projectedExtraEntries: 0,
      }).current_prize_pool,
      updated_prize_pool_if_rejoin: buildPoolPrizePoolSummary({
        entryFee: roundCurrency(Number(session?.contest?.entry) || 0),
        baseEntryCount: resolvePoolBaseEntryCount(session),
        rejoinEntryCount: resolvePoolRejoinEntryCount(session?.metadata || {}),
        projectedExtraEntries: 0,
      }).updated_prize_pool,
      rejoin_info: buildPoolRejoinInfoPayload({
        rejoinContext: { rejoin_start_points_by_user: {} },
        joiningFee: roundCurrency(Number(session?.contest?.entry) || 0),
        prizePoolSummary: buildPoolPrizePoolSummary({
          entryFee: roundCurrency(Number(session?.contest?.entry) || 0),
          baseEntryCount: resolvePoolBaseEntryCount(session),
          rejoinEntryCount: resolvePoolRejoinEntryCount(session?.metadata || {}),
          projectedExtraEntries: 0,
        }),
      }),
      results: attachWonAmountToResults(finalizedResults, settlement),
      deal_no: null,
      total_deals: null,
      deal_scores: null,
      settlement,
    };

    resultPayload.players = buildDeclarationTablePlayers({
      session,
      distribution,
      // Prefer live declare responses (manual invalid layout) over empty map.
      state: activeDeclareBySession.get(sessionId)
        || { responses: new Map(), declareByUserId: null },
      isFinal: true,
      finalizedResults,
      settlement,
      winnerUserId,
    });

    const nextMetadata = {
      ...(session.metadata || {}),
      phase: 'finished',
      phase_updated_at: new Date().toISOString(),
      pool_limit: poolLimit,
      pool_scores_by_user: poolScoresByUser,
      pool_eliminated_user_ids: Array.from(poolEliminatedSet),
      result: resultPayload,
      turn_eliminated_user_ids: Array.from(new Set([
        ...(session.metadata?.turn_eliminated_user_ids || []),
        ...Array.from(poolEliminatedSet),
      ])).map((id) => Number(id)).filter((id) => !Number.isNaN(id)),
      turn_timeout_eliminated_user_ids: Array.from(timeoutEliminatedSet),
    };

    await completeSessionWithBotRelease(sessionId, {
      endedAt: new Date(),
      currentTurnUserId: winnerUserId,
      metadata: nextMetadata,
    });

    await gameSessionModel.insertEvent({
      sessionId,
      userId: winnerUserId,
      eventType: 'pool_game_completed_by_elimination',
      payload: resultPayload,
    });

    cleanupTurnState(sessionId);
    io.to(sessionRoom(sessionId)).emit('game:result', resultPayload);
    scheduleAutoRematchFromResult(io, sessionId);
    await Promise.all((players || []).map((item) => emitPendingRejoinGameForUser(io, item.user_id, 'game_completed')));
    return resultPayload;
  }

  const totalDeals = resolveTotalDeals(session);
  const currentDeal = resolveCurrentDeal(session);
  const dealSnapshot = buildDealResultSnapshot({
    dealNo: currentDeal,
    reason,
    winnerUserId,
    finalizedResults,
  });

  if (isDealLikeMode(mode) && currentDeal < totalDeals) {
    cleanupTurnState(sessionId);
    return transitionToNextDeal(io, session, dealSnapshot);
  }

  let completeDealScores = isDealLikeMode(mode)
    ? [...normalizeDealScoreHistory(session.metadata || {}), dealSnapshot]
    : null;
  let dealScoreTotalsByUser = null;
  let dealBaseScore = null;
  if (isDealLikeMode(mode)) {
    const scoreboard = computeDealScoreboardTimeline(session, completeDealScores || []);
    completeDealScores = scoreboard.enrichedDealScores;
    dealScoreTotalsByUser = scoreboard.scoreTotalsByUser;
    dealBaseScore = scoreboard.dealBaseScore;
  }
  const dealContext = buildDealContextFields(session, {
    dealNo: currentDeal,
    totalDeals,
    dealScores: completeDealScores,
    dealScoreTotalsByUser,
  });

  if (isDealLikeMode(mode)) {
    const aggregate = buildAggregateResultsFromDealScores(session, completeDealScores || []);
    winnerUserId = aggregate.winnerUserId || winnerUserId;
    finalizedResults = aggregate.finalizedResults;
  }

  let settlement = null;
  try {
    if (mode === 'spin_go') {
      settlement = await settleSpinGoResult(session, winnerUserId);
    } else if (mode === 'deals_2') {
      settlement = await settleDealsPotResult(session, finalizedResults, winnerUserId);
    } else {
      const pointValue = session.contest?.point_value || session.game?.point_value || 0;
      settlement = await settleGameResult(sessionId, finalizedResults, winnerUserId, pointValue);
    }
  } catch (settleErr) {
    errorGame(sessionId, `Settlement error on elimination finalize (non-fatal): ${settleErr.message}`);
  }

  const resultPayload = {
    session_id: sessionId,
    server_time: new Date().toISOString(),
    event: 'game:result',
    status: 'completed',
    is_final: true,
    reason,
    winner_user_id: winnerUserId,
    eliminated_user_ids: eliminatedUserIds,
    timeout_eliminated_user_ids: Array.from(timeoutEliminatedSet),
    tie_break_policy: 'last_player_standing_then_points',
    results: attachWonAmountToResults(finalizedResults, settlement),
    ...dealContext,
    settlement,
  };

  resultPayload.players = buildDeclarationTablePlayers({
    session,
    distribution,
    // Prefer live declare responses (manual invalid layout) over empty map.
    state: activeDeclareBySession.get(sessionId)
      || { responses: new Map(), declareByUserId: null },
    isFinal: true,
    finalizedResults,
    settlement,
    winnerUserId,
  });

  if (completeDealScores) {
    completeDealScores = enrichLastDealScoreEntry(completeDealScores, {
      players: resultPayload.players,
      wild_joker_card_id: resolveWildJokerCardId(session),
      finish_card: dealSnapshot.finish_card || null,
      declare_by_user_id: dealSnapshot.declare_by_user_id,
      declare_valid: dealSnapshot.declare_valid,
      reason,
      first_turn_user_id: session?.metadata?.first_turn_user_id ?? null,
      last_turn_user_id: session?.metadata?.last_turn_user_id ?? null,
    });
  }

  const nextMetadata = {
    ...(session.metadata || {}),
    phase: 'finished',
    phase_updated_at: new Date().toISOString(),
    result: resultPayload,
    turn_eliminated_user_ids: Array.from(new Set([
      ...(session.metadata?.turn_eliminated_user_ids || []),
      ...eliminatedUserIds,
    ])).map((id) => Number(id)).filter((id) => !Number.isNaN(id)),
    turn_timeout_eliminated_user_ids: Array.from(timeoutEliminatedSet),
    ...(completeDealScores ? {
      current_deal: currentDeal,
      total_deals: totalDeals,
      deal_scores: completeDealScores,
      deal_base_score: dealBaseScore,
      deal_score_totals_by_user: dealScoreTotalsByUser,
    } : {}),
  };

  await completeSessionWithBotRelease(sessionId, {
    endedAt: new Date(),
    currentTurnUserId: winnerUserId,
    metadata: nextMetadata,
  });

  await gameSessionModel.insertEvent({
    sessionId,
    userId: winnerUserId,
    eventType: 'game_completed_by_elimination',
    payload: resultPayload,
  });

  cleanupTurnState(sessionId);
  io.to(sessionRoom(sessionId)).emit('game:result', resultPayload);
  scheduleAutoRematchFromResult(io, sessionId);
  return resultPayload;
}

async function onTurnTimeout(io, sessionId, expectedTurnId) {
  // Prevent local+sweeper double-entry while we decide whether to defer for bot pacing.
  cleanupTurnTimeoutOnly(sessionId);
  await durableTimer.cancelTurnTimeout(sessionId, expectedTurnId).catch(() => {});

  let session = await gameplayService.getSessionState(sessionId);
  if (!session || session.status !== 'active') {
    cleanupTurnState(sessionId);
    return;
  }

  let distribution = session.metadata?.distribution;
  let turn = session.metadata?.turn;
  if (!distribution || !turn) {
    cleanupTurnState(sessionId);
    return;
  }

  if (Number(turn.turn_id) !== Number(expectedTurnId)) {
    return;
  }

  if (isDeclarationWindowActive(sessionId, session.metadata)) {
    logGame(sessionId, 'Turn timeout skipped — declaration window active');
    cleanupTurnState(sessionId);
    return;
  }

  session = await flushBotTurnBeforeTimeout(io, sessionId, session, turn);
  const deferUntilMs = takeBotTurnTimeoutDeferMs(session);
  if (deferUntilMs != null) {
    scheduleDeferredTurnTimeout(
      io,
      sessionId,
      expectedTurnId,
      deferUntilMs,
      turn.type || 'normal',
    );
    return;
  }

  if (!session || session.status !== 'active') {
    cleanupTurnState(sessionId);
    return;
  }

  distribution = session.metadata?.distribution;
  turn = session.metadata?.turn;
  if (!distribution || !turn) {
    cleanupTurnState(sessionId);
    return;
  }

  if (Number(turn.turn_id) !== Number(expectedTurnId)) {
    return;
  }

  const timeoutKey = `idem:turn-timeout:session:${sessionId}:turn:${turn.turn_id}:type:${turn.type || 'normal'}`;
  const claimed = await redisLockService.claimEventIdempotency(
    timeoutKey,
    TURN_TIMEOUT_IDEMPOTENCY_TTL_SECONDS
  );
  if (!claimed) return;

  const turnTimerSeconds = Number(session?.game?.turn_timer_seconds) || 30;
  const bonusTimerSeconds = Number(session?.game?.bonus_timer_seconds) || 10;
  const maxBonusAttempts = getMaxBonusAttempts(session);
  const attemptsUsedByUser = normalizeAttemptsUsedByUser(session.metadata || {});
  const eliminatedSet = getEliminatedUserIdSet(session.metadata || {});
  const timeoutEliminatedSet = getTimeoutEliminatedUserIdSet(session.metadata || {});
  const currentUserId = turn.user_id;

  if (eliminatedSet.has(Number(currentUserId))) {
    warnGame(sessionId, `Turn timeout ignored — current user uid=${currentUserId} is already eliminated`);
    return;
  }

  const activePlayersNow = getActivePlayers(session);
  if (activePlayersNow.length <= 1) {
    const winnerUserId = activePlayersNow[0]?.user_id;
    if (winnerUserId) {
      await finalizeGameByElimination(
        io,
        session,
        winnerUserId,
        Array.from(eliminatedSet),
        'single_player_remaining',
        Array.from(timeoutEliminatedSet)
      );
    }
    return;
  }

  const currentAttemptUsed = Number(attemptsUsedByUser[String(currentUserId)]) || 0;

  const canStartBonusTurn = (turn.type || 'normal') !== 'bonus' && currentAttemptUsed < maxBonusAttempts;

  if (canStartBonusTurn) {
    const nextAttemptNo = currentAttemptUsed + 1;
    const bonusTurnWindow = buildTurnWindow(bonusTimerSeconds);
    const keepPickedState = turn.has_picked === true;
    const nextTurn = buildTurnPayload({
      session,
      userId: currentUserId,
      turnId: Number(turn.turn_id) + 1,
      type: 'bonus',
      attemptNo: nextAttemptNo,
      attemptsUsedCount: nextAttemptNo,
      startedAt: bonusTurnWindow.startedAt,
      endsAt: bonusTurnWindow.endsAt,
      turnTimerSeconds: bonusTimerSeconds,
      hasPicked: keepPickedState,
      pickedCardUid: keepPickedState ? turn.picked_card_uid : null,
    });

    const nextMetadata = {
      ...(session.metadata || {}),
      turn: nextTurn,
      turn_bonus: {
        max_attempts_per_player: maxBonusAttempts,
        attempts_used_by_user: {
          ...attemptsUsedByUser,
          [String(currentUserId)]: nextAttemptNo,
        },
      },
      phase_updated_at: new Date().toISOString(),
    };

    await gameSessionModel.updateSessionStatus(sessionId, session.status, {
      currentTurnUserId: currentUserId,
      metadata: nextMetadata,
    });

    await gameSessionModel.insertEvent({
      sessionId,
      userId: currentUserId,
      eventType: 'turn_bonus_started',
      payload: {
        reason: 'turn_timeout',
        turn_id: nextTurn.turn_id,
        attempt_no: nextAttemptNo,
        ends_at: bonusTurnWindow.endsAt,
      },
    });

    logGame(
      sessionId,
      `Turn timeout — uid=${currentUserId} entered BONUS attempt ${nextAttemptNo}/${maxBonusAttempts} (${bonusTimerSeconds}s)`
    );

    emitTurn(io, sessionId, nextTurn, {
      action: 'bonus_started',
      previous_turn_id: turn.turn_id,
      previous_turn_type: turn.type || 'normal',
      user_id: currentUserId,
      distribution: nextMetadata.distribution || distribution,
    });

    scheduleTurnTimeout(io, sessionId, nextTurn);
    maybeScheduleBotTurnAction(io, sessionId, nextTurn).catch((err) => {
      errorGame(sessionId, `Bot schedule on bonus turn failed: ${err.message}`);
    });
    return;
  }

  const playersDistribution = Array.isArray(distribution.players) ? [...distribution.players] : [];
  const playerIndex = playersDistribution.findIndex((pd) => pd.user_id === currentUserId);
  let discardedCard = null;
  let action = 'auto_pass';

  if (playerIndex >= 0 && turn.has_picked === true) {
    const playerDistribution = {
      ...playersDistribution[playerIndex],
      cards: [...(playersDistribution[playerIndex].cards || [])],
    };
    const hand = playerDistribution.cards;
    if (hand.length > 0) {
      const pickUid = turn.picked_card_uid != null ? String(turn.picked_card_uid).trim() : '';
      let discardIdx = pickUid ? hand.findIndex((c) => c && c.card_uid === pickUid) : -1;
      if (discardIdx < 0) {
        discardIdx = hand.length - 1;
      }
      [discardedCard] = hand.splice(discardIdx, 1);
      const storedTimeoutDiscardGroups = Array.isArray(playerDistribution.submitted_groups)
        ? playerDistribution.submitted_groups
        : [];
      playerDistribution.submitted_groups = discardedCard?.card_uid
        ? removeCardFromGroups(storedTimeoutDiscardGroups, discardedCard.card_uid)
        : storedTimeoutDiscardGroups;
      playersDistribution[playerIndex] = playerDistribution;
      action = 'auto_discard';
    }
  }

  const discardPile = discardedCard
    ? [discardedCard, ...(distribution.discard_pile || [])]
    : [...(distribution.discard_pile || [])];

  const isBonusTurn = String(turn.type || 'normal').toLowerCase() === 'bonus';
  const bonusAttemptsExhausted = currentAttemptUsed >= maxBonusAttempts;
  // With a single bonus attempt, bonus expiry only passes the turn; elimination
  // happens on the next normal-turn timeout once the bonus has been consumed.
  // With 2+ attempts, final bonus expiry still eliminates (legacy behaviour).
  const shouldEliminateCurrentUser =
    bonusAttemptsExhausted && (!isBonusTurn || maxBonusAttempts > 1);

  const nextEliminatedSet = new Set(eliminatedSet);
  if (shouldEliminateCurrentUser) {
    nextEliminatedSet.add(Number(currentUserId));
  }
  const nextTimeoutEliminatedSet = new Set(timeoutEliminatedSet);
  if (shouldEliminateCurrentUser) {
    nextTimeoutEliminatedSet.add(Number(currentUserId));
  }

  const activePlayersAfterTimeout = (session.players || []).filter(
    (p) => !nextEliminatedSet.has(Number(p.user_id))
  );

  if (activePlayersAfterTimeout.length <= 1) {
    const winnerUserId = activePlayersAfterTimeout[0]?.user_id;
    if (winnerUserId) {
      if (shouldEliminateCurrentUser) {
        emitPlayerStatusUpdate(io, session, currentUserId, 'timeout_eliminated');
        await emitPendingRejoinGameForUser(io, currentUserId, 'timeout_eliminated');
      }
      logGame(sessionId, `Elimination — uid=${currentUserId} removed (bonus attempts exhausted), winner uid=${winnerUserId}`);
      if (shouldEliminateCurrentUser) {
        const poolRoundResult = await tryTransitionPoolRoundAfterSinglePlayerRemaining(
          io,
          session,
          {
            sessionId,
            winnerUserId,
            packedUserId: currentUserId,
            outcomeType: 'timeout',
            reason: 'single_player_remaining_after_timeout',
          }
        );
        if (poolRoundResult) {
          return;
        }
      }
      await finalizeGameByElimination(
        io,
        session,
        winnerUserId,
        Array.from(nextEliminatedSet),
        'eliminated_on_timeout_no_bonus_left',
        Array.from(nextTimeoutEliminatedSet)
      );
    }
    return;
  }

  const nextTurnUser = nextTurnUserId(activePlayersAfterTimeout, currentUserId, {
    currentSeatNo: (session.players || []).find(
      (p) => Number(p.user_id) === Number(currentUserId)
    )?.seat_no,
  });
  const nextTurnWindow = buildTurnWindow(turnTimerSeconds);
  const nextTurn = buildTurnPayload({
    session,
    userId: nextTurnUser,
    turnId: Number(turn.turn_id) + 1,
    type: 'normal',
    attemptNo: 0,
    attemptsUsedCount: Number(attemptsUsedByUser[String(nextTurnUser)]) || 0,
    startedAt: nextTurnWindow.startedAt,
    endsAt: nextTurnWindow.endsAt,
    turnTimerSeconds,
    hasPicked: false,
  });

  const playersAfterDepartingTurn = markDepartingPlayerFirstTurnCycleComplete(
    playersDistribution,
    currentUserId
  );

  const nextMetadata = {
    ...(session.metadata || {}),
    distribution: {
      ...distribution,
      players: playersAfterDepartingTurn,
      discard_pile: discardPile,
    },
    turn: nextTurn,
    turn_bonus: {
      max_attempts_per_player: maxBonusAttempts,
      attempts_used_by_user: attemptsUsedByUser,
    },
    turn_eliminated_user_ids: Array.from(nextEliminatedSet),
    turn_timeout_eliminated_user_ids: Array.from(nextTimeoutEliminatedSet),
    phase_updated_at: new Date().toISOString(),
  };

  const timeoutDiscardHistoryAppend = action === 'auto_discard' && discardedCard
    ? appendDiscardHistoryEntry(nextMetadata, nextMetadata.distribution, {
      discarded_card: discardedCard,
      discarded_by_user_id: currentUserId,
      discarded_at: new Date().toISOString(),
      turn_id: turn.turn_id,
    })
    : null;
  if (timeoutDiscardHistoryAppend) {
    nextMetadata.discard_history = timeoutDiscardHistoryAppend.discardHistory;
  }

  await gameSessionModel.updateSessionStatus(sessionId, session.status, {
    currentTurnUserId: nextTurnUser,
    metadata: nextMetadata,
  });

  if (action === 'auto_discard' && discardedCard && playerIndex >= 0) {
    const pd = playersDistribution[playerIndex];
    const wildJoker = distribution.wild_joker || null;
    const { grouping } = resolveGroupingSnapshot(
      pd.cards || [],
      wildJoker,
      Array.isArray(pd.submitted_groups) ? pd.submitted_groups : []
    );
    emitGameDiscardAckToUser(io, sessionId, currentUserId, {
      discarded_card: discardedCard,
      cards_count: (pd.cards || []).length,
      discard_top: discardPile[0] || null,
      turn: nextTurn,
      ...buildGroupingResponseData(grouping),
    }, { reason: 'turn_timeout_auto_discard' });

    if (timeoutDiscardHistoryAppend) {
      emitDiscardHistoryUpdate(io, {
        ...session,
        metadata: nextMetadata,
      }, {
        reason: 'turn_timeout_auto_discard',
        latest: timeoutDiscardHistoryAppend.latestEntry,
      });
    }
  }

  await gameSessionModel.insertEvent({
    sessionId,
    userId: currentUserId,
    eventType: 'turn_timeout_auto_action',
    payload: {
      action,
      discarded_card_uid: discardedCard?.card_uid || null,
      previous_turn_id: turn.turn_id,
      next_turn_user_id: nextTurnUser,
      previous_turn_type: turn.type || 'normal',
    },
  });

  if (shouldEliminateCurrentUser) {
    const updatedSession = await gameplayService.getSessionState(sessionId);
    emitPlayerStatusUpdate(io, updatedSession, currentUserId, 'timeout_eliminated');
    // emitSessionStatePayload(io, updatedSession); // commented because it was causing duplicate updates
    await emitPendingRejoinGameForUser(io, currentUserId, 'timeout_eliminated');
  }

  logGame(
    sessionId,
    `Turn timeout — uid=${currentUserId} action=${action} eliminated=${shouldEliminateCurrentUser} next=uid:${nextTurnUser} timer=${turnTimerSeconds}s`
  );

  emitTurn(io, sessionId, nextTurn, {
    action,
    previous_turn_user_id: currentUserId,
    previous_turn_id: turn.turn_id,
    eliminated_user_id: shouldEliminateCurrentUser ? currentUserId : null,
    eliminated_user_ids: Array.from(nextEliminatedSet),
    discarded_card: discardedCard,
    discard_top: discardPile[0] || null,
    player_deal_flags: buildPlayerDealFlags(playersAfterDepartingTurn),
    distribution: nextMetadata.distribution,
  });

  scheduleTurnTimeout(io, sessionId, nextTurn);
}

function scheduleTurnTimeout(io, sessionId, turn) {
  if (!turn || !turn.ends_at || Number.isNaN(Date.parse(turn.ends_at))) {
    return;
  }

  const nextTurnId = Number(turn.turn_id);
  const pendingBot = getActiveBotActionState(sessionId);
  if (pendingBot && Number(pendingBot.turnId) !== nextTurnId) {
    cleanupBotActionState(sessionId);
  }

  cleanupTurnTimeoutOnly(sessionId);

  const delayMs = Math.max(0, Date.parse(turn.ends_at) - Date.now());
  const timeoutHandle = setTimeout(() => {
    onTurnTimeout(io, sessionId, Number(turn.turn_id)).catch((err) => {
      errorGame(sessionId, `Turn timeout handler failed: ${err.message}`);
    });
  }, delayMs);

  activeTurnBySession.set(sessionId, {
    timeoutHandle,
    turnId: Number(turn.turn_id),
    type: turn.type || 'normal',
    endsAt: turn.ends_at,
  });

  // Dual-write deadline to Redis (grace delayed). Local setTimeout remains primary.
  // Sweeper is OFF by default — enable only after validating idempotent recovery.
  durableTimer.armTurnTimeout(sessionId, turn).catch(() => {});
}

async function dropPlayerFromSession(io, sessionId, userId) {
  const session = await gameplayService.getSessionState(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  if (session.status !== 'active') {
    throw new Error('Session is not active');
  }
  if (activeDeclareBySession.has(sessionId)) {
    throw new Error('Cannot drop while declaration window is active');
  }

  const player = (session.players || []).find((item) => Number(item.user_id) === Number(userId));
  if (!player) {
    throw new Error('Player not found in session');
  }

  const distribution = session.metadata?.distribution;
  const turn = session.metadata?.turn;
  if (!distribution || !turn) {
    throw new Error('Game state is not ready');
  }

  const eliminatedSet = getEliminatedUserIdSet(session.metadata || {});
  if (eliminatedSet.has(Number(userId)) || player.metadata?.is_dropped === true) {
    throw new Error('Player already dropped or eliminated');
  }

  if (Number(turn.user_id) === Number(userId) && turn.has_picked === true) {
    throw new Error('Cannot drop after picking a card this turn — discard first');
  }

  const droppedAt = new Date().toISOString();
  const attemptsUsedByUser = normalizeAttemptsUsedByUser(session.metadata || {});
  const maxBonusAttempts = getMaxBonusAttempts(session);
  const playersDistribution = Array.isArray(distribution.players) ? [...distribution.players] : [];
  const playerIndex = playersDistribution.findIndex((pd) => Number(pd.user_id) === Number(userId));
  let discardedCard = null;
  let dropAction = 'drop';

  if (playerIndex >= 0) {
    const playerDistribution = {
      ...playersDistribution[playerIndex],
      cards: [...(playersDistribution[playerIndex].cards || [])],
    };

    if (Number(turn.user_id) === Number(userId) && turn.has_picked === true) {
      const decisionSeed = buildDecisionSeed(sessionId, turn.turn_id, userId);
      const autoDiscard = chooseBotDiscardCard(playerDistribution.cards, distribution.wild_joker || null, {
        tieBreakSeed: `${decisionSeed}:drop`,
        conservativeMode: BOT_CONSERVATIVE_PLAY_ON_LOW_CONFIDENCE,
        groupingOptions: buildGroupingTieBreakOptions(decisionSeed),
      });
      if (autoDiscard) {
        const cardIndex = playerDistribution.cards.findIndex((card) => card.card_uid === autoDiscard.card_uid);
        if (cardIndex >= 0) {
          [discardedCard] = playerDistribution.cards.splice(cardIndex, 1);
          dropAction = 'drop_auto_discard';
        }
      }
    }

    playersDistribution[playerIndex] = {
      ...playerDistribution,
      is_dropped: true,
      status: 'dropped',
      drop_status: 'dropped',
      dropped_at: droppedAt,
    };
  }

  const discardPile = discardedCard
    ? [discardedCard, ...(distribution.discard_pile || [])]
    : [...(distribution.discard_pile || [])];

  const nextEliminatedSet = new Set(eliminatedSet);
  nextEliminatedSet.add(Number(userId));

  const nextMetadataBase = {
    ...(session.metadata || {}),
    distribution: {
      ...distribution,
      players: playersDistribution,
      discard_pile: discardPile,
    },
    turn_eliminated_user_ids: Array.from(nextEliminatedSet),
    phase_updated_at: droppedAt,
  };

  const dropDiscardHistoryAppend = discardedCard
    ? appendDiscardHistoryEntry(nextMetadataBase, nextMetadataBase.distribution, {
      discarded_card: discardedCard,
      discarded_by_user_id: userId,
      discarded_at: droppedAt,
      turn_id: turn.turn_id,
    })
    : null;
  if (dropDiscardHistoryAppend) {
    nextMetadataBase.discard_history = dropDiscardHistoryAppend.discardHistory;
  }

  const nextPlayerMetadata = {
    ...(player.metadata || {}),
    is_dropped: true,
    drop_status: 'dropped',
    dropped_at: droppedAt,
    elimination_reason: 'dropped',
    is_connected: true,
    connection_status: 'connected',
    auto_drop_enabled: false,
  };

  await gameSessionModel.updatePlayerState(sessionId, userId, {
    status: 'eliminated',
    leftAt: new Date(),
    metadata: nextPlayerMetadata,
  });

  const activePlayersAfterDrop = getActivePlayers({
    ...session,
    metadata: {
      ...(session.metadata || {}),
      turn_eliminated_user_ids: Array.from(nextEliminatedSet),
    },
  });

  if (activePlayersAfterDrop.length <= 1) {
    const winnerUserId = activePlayersAfterDrop[0]?.user_id;
    await gameSessionModel.updateSessionStatus(sessionId, session.status, {
      currentTurnUserId: winnerUserId || session.current_turn_user_id,
      metadata: nextMetadataBase,
    });

    await gameSessionModel.insertEvent({
      sessionId,
      userId,
      eventType: 'player_dropped',
      payload: {
        action: dropAction,
        discarded_card_uid: discardedCard?.card_uid || null,
        previous_turn_id: turn.turn_id,
        remaining_active_players: activePlayersAfterDrop.map((item) => item.user_id),
      },
    });

    const updatedSession = await gameplayService.getSessionState(sessionId);
    emitPlayerStatusUpdate(io, updatedSession, userId, 'player_dropped');
    await emitPendingRejoinGameForUser(io, userId, 'player_dropped');
    if (dropDiscardHistoryAppend) {
      emitDiscardHistoryUpdate(io, updatedSession, {
        reason: 'player_drop_auto_discard',
        latest: dropDiscardHistoryAppend.latestEntry,
      });
    }
    // emitSessionStatePayload(io, updatedSession);

    if (winnerUserId) {
      const poolRoundResult = await tryTransitionPoolRoundAfterSinglePlayerRemaining(
        io,
        updatedSession,
        {
          sessionId,
          winnerUserId,
          packedUserId: userId,
          outcomeType: 'dropped',
          reason: 'single_player_remaining_after_drop',
        }
      );
      if (poolRoundResult) {
        return {
          session: updatedSession,
          result: poolRoundResult,
        };
      }
      return {
        session: updatedSession,
        result: await finalizeGameByElimination(
          io,
          updatedSession,
          winnerUserId,
          Array.from(nextEliminatedSet),
          'single_player_remaining_after_drop',
          Array.from(getTimeoutEliminatedUserIdSet(updatedSession.metadata || {}))
        ),
      };
    }

    return { session: updatedSession, result: null };
  }

  if (Number(turn.user_id) === Number(userId)) {
    const turnTimerSeconds = Number(session?.game?.turn_timer_seconds) || 30;
    const nextTurnUser = nextTurnUserId(activePlayersAfterDrop, userId, {
      currentSeatNo: player.seat_no,
    });
    const nextTurnWindow = buildTurnWindow(turnTimerSeconds);
    const nextTurn = buildTurnPayload({
      session,
      userId: nextTurnUser,
      turnId: Number(turn.turn_id) + 1,
      type: 'normal',
      attemptNo: 0,
      attemptsUsedCount: Number(attemptsUsedByUser[String(nextTurnUser)]) || 0,
      startedAt: nextTurnWindow.startedAt,
      endsAt: nextTurnWindow.endsAt,
      turnTimerSeconds,
      hasPicked: false,
    });

    const nextMetadata = {
      ...nextMetadataBase,
      turn: nextTurn,
      turn_bonus: {
        max_attempts_per_player: maxBonusAttempts,
        attempts_used_by_user: attemptsUsedByUser,
      },
    };

    await gameSessionModel.updateSessionStatus(sessionId, session.status, {
      currentTurnUserId: nextTurnUser,
      metadata: nextMetadata,
    });

    await gameSessionModel.insertEvent({
      sessionId,
      userId,
      eventType: 'player_dropped',
      payload: {
        action: dropAction,
        discarded_card_uid: discardedCard?.card_uid || null,
        previous_turn_id: turn.turn_id,
        next_turn_user_id: nextTurnUser,
      },
    });

    const updatedSession = await gameplayService.getSessionState(sessionId);
    emitPlayerStatusUpdate(io, updatedSession, userId, 'player_dropped');
    await emitPendingRejoinGameForUser(io, userId, 'player_dropped');
    if (dropDiscardHistoryAppend) {
      emitDiscardHistoryUpdate(io, updatedSession, {
        reason: 'player_drop_auto_discard',
        latest: dropDiscardHistoryAppend.latestEntry,
      });
    }
    // emitSessionStatePayload(io, updatedSession);
    emitTurn(io, sessionId, nextTurn, {
      action: dropAction,
      previous_turn_user_id: userId,
      previous_turn_id: turn.turn_id,
      eliminated_user_id: userId,
      eliminated_user_ids: Array.from(nextEliminatedSet),
      discarded_card: discardedCard,
      discard_top: discardPile[0] || null,
      distribution: nextMetadata.distribution,
    });
    scheduleTurnTimeout(io, sessionId, nextTurn);
    return { session: updatedSession, turn: nextTurn };
  }

  await gameSessionModel.updateSessionStatus(sessionId, session.status, {
    currentTurnUserId: session.current_turn_user_id,
    metadata: nextMetadataBase,
  });

  await gameSessionModel.insertEvent({
    sessionId,
    userId,
    eventType: 'player_dropped',
    payload: {
      action: dropAction,
      discarded_card_uid: discardedCard?.card_uid || null,
      previous_turn_id: turn.turn_id,
      next_turn_user_id: session.current_turn_user_id,
    },
  });

  const updatedSession = await gameplayService.getSessionState(sessionId);
  emitPlayerStatusUpdate(io, updatedSession, userId, 'player_dropped');
  await emitPendingRejoinGameForUser(io, userId, 'player_dropped');
  if (dropDiscardHistoryAppend) {
    emitDiscardHistoryUpdate(io, updatedSession, {
      reason: 'player_drop_auto_discard',
      latest: dropDiscardHistoryAppend.latestEntry,
    });
  }
  // emitSessionStatePayload(io, updatedSession);
  return { session: updatedSession };
}

async function finalizeActiveTwoPlayerExit(io, sessionId, userId, reason = 'player_left_table_exit') {
  const session = await gameplayService.getSessionState(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  if (session.status !== 'active') {
    throw new Error('Session is not active');
  }

  const players = Array.isArray(session.players) ? session.players : [];
  const exitingPlayer = players.find((item) => Number(item.user_id) === Number(userId));
  if (!exitingPlayer) {
    throw new Error('Player not found in session');
  }
  const winner = players.find((item) => Number(item.user_id) !== Number(userId));
  if (!winner) {
    throw new Error('Unable to resolve opponent for match exit');
  }

  const nextPlayerMetadata = {
    ...(exitingPlayer.metadata || {}),
    is_dropped: true,
    drop_status: 'dropped',
    dropped_at: new Date().toISOString(),
    elimination_reason: 'player_exit',
    is_connected: true,
    connection_status: 'connected',
    auto_drop_enabled: false,
  };
  await gameSessionModel.updatePlayerState(sessionId, userId, {
    status: 'eliminated',
    leftAt: new Date(),
    metadata: nextPlayerMetadata,
  });
  await gameSessionModel.insertEvent({
    sessionId,
    userId,
    eventType: 'player_left_match_exit',
    payload: {
      reason,
      winner_user_id: winner.user_id,
    },
  });

  const refreshed = await gameplayService.getSessionState(sessionId);
  emitPlayerStatusUpdate(io, refreshed, userId, reason);
  await emitPendingRejoinGameForUser(io, userId, 'player_left_match_exit');

  const eliminatedSet = getEliminatedUserIdSet(refreshed.metadata || {});
  eliminatedSet.add(Number(userId));
  const result = await finalizeGameByElimination(
    io,
    refreshed,
    winner.user_id,
    Array.from(eliminatedSet),
    reason,
    Array.from(getTimeoutEliminatedUserIdSet(refreshed.metadata || {}))
  );
  return {
    session: await gameplayService.getSessionState(sessionId),
    result,
  };
}

function registerSocketServer(httpServer) {
  const transportCsv = String(process.env.SOCKET_TRANSPORTS || 'websocket,polling')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t === 'websocket' || t === 'polling');
  const transports = transportCsv.length ? transportCsv : ['websocket', 'polling'];

  const io = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
      credentials: true,
    },
    // Tighter heartbeats + no deflate — lower CPU and faster disconnect detection.
    pingTimeout: Math.max(5000, Number(process.env.SOCKET_PING_TIMEOUT_MS) || 10000),
    pingInterval: Math.max(8000, Number(process.env.SOCKET_PING_INTERVAL_MS) || 15000),
    maxHttpBufferSize: Math.max(65536, Number(process.env.SOCKET_MAX_BUFFER_BYTES) || 1048576),
    perMessageDeflate: false,
    transports,
  });

  setSocketIO(io);
  startLiveCountBroadcaster(io);

  getSocketAdapterRedisClients()
    .then((clients) => {
      if (!clients) {
        console.log('Socket Redis adapter skipped: REDIS_URL not configured');
        return;
      }

      io.adapter(createAdapter(clients.pubClient, clients.subClient));
      console.log('Socket Redis adapter enabled');
    })
    .catch((err) => {
      console.error('Socket Redis adapter init failed. Continuing without adapter:', err.message);
    });

  io.use(socketAuth);

  setTurnTimerStarter((payload = {}) => {
    const sessionId = Number(payload.session_id);
    if (Number.isNaN(sessionId)) return;
    if (!payload.turn) return;
    scheduleTurnTimeout(io, sessionId, payload.turn);

    loadBotActionSession(sessionId)
      .then((session) => {
        if (!session || session.status !== 'active' || !session.metadata?.turn) return;
        return maybeScheduleBotTurnAction(io, sessionId, session.metadata.turn);
      })
      .catch((err) => {
        errorGame(sessionId, `Initial bot scheduling failed: ${err.message}`);
      });
  });

  // Optional Redis sweeper for orphaned timers (idempotent handlers).
  // Enabled when DURABLE_TIMER_SWEEPER_ENABLED=true (default true when CLUSTER_INSTANCES>1).
  durableTimer.startSweeper({
    kinds: [
      'turn',
      'declare_finalize',
      'declare_awaiting',
      'auto_rematch',
      'bot_turn',
      'post_deal',
      'pregame_deadline',
    ],
    onDue: async (entry) => {
      const sessionId = Number(entry.session_id);
      if (Number.isNaN(sessionId)) return;
      const kind = String(entry.kind || '');

      if (kind === 'turn') {
        const turnId = Number(entry.payload?.turn_id ?? entry.token);
        if (Number.isNaN(turnId)) return;
        await onTurnTimeout(io, sessionId, turnId);
        return;
      }

      if (kind === 'declare_finalize') {
        await rebuildDeclareStateFromStore(sessionId, entry);
        await finalizeDeclarationWindow(sessionId, 'timeout');
        return;
      }

      if (kind === 'declare_awaiting') {
        const liveState = await rebuildDeclareStateFromStore(sessionId, entry);
        if (!liveState || liveState.visibilityStage !== DECLARATION_VISIBILITY_AWAITING_DECLARER) {
          return;
        }
        if (hasDeclareResponseEntry(liveState.responses, liveState.declareByUserId)) {
          await openDeclarationWindowForAll(
            await gameplayService.getSessionState(sessionId),
            liveState,
            {},
          );
          return;
        }
        const liveSession = await gameplayService.getSessionState(sessionId);
        if (!liveSession) return;
        const liveDistribution = liveSession.metadata?.distribution || null;
        const declarerDistribution = getPlayerDistribution(liveDistribution, liveState.declareByUserId);
        let autoGroups = [];
        if (declarerDistribution) {
          const autoGrouping = groupingService.buildBestGrouping(
            declarerDistribution.cards || [],
            liveDistribution?.wild_joker || null,
          );
          autoGroups = toSubmittedGroupsFromGrouping(autoGrouping);
        }
        liveState.responses.set(liveState.declareByUserId, {
          submitted_at: new Date().toISOString(),
          auto: true,
          groups: autoGroups,
        });
        persistDeclareState(liveState);
        const openResult = await openDeclarationWindowForAll(liveSession, liveState, {
          distribution: liveDistribution,
        });
        scheduleBotDeclarationResponses(sessionId);
        if ((openResult?.pending_count || 0) === 0) {
          await finalizeDeclarationWindow(sessionId, 'all_submitted');
        }
        return;
      }

      if (kind === 'auto_rematch') {
        const claimed = await redisLockService.claimEventIdempotency(
          `idem:auto-rematch:session:${sessionId}`,
          180,
        );
        if (!claimed) return;
        try {
          await runAutoRematchFromSource(io, sessionId);
        } finally {
          clearAutoRematchTimer(sessionId);
        }
        return;
      }

      if (kind === 'bot_turn') {
        const turnId = Number(entry.payload?.turn_id ?? String(entry.token || '').split(':')[0]);
        const phase = entry.payload?.phase
          || (String(entry.token || '').includes('discard') ? 'discard' : 'pick');
        if (Number.isNaN(turnId)) return;
        // executeBotTurnAction claims idempotency — safe vs local timeout race.
        await executeBotTurnAction(io, sessionId, turnId, phase);
        return;
      }

      if (kind === 'post_deal' || kind === 'pregame_deadline') {
        try {
          const { recoverPregameDeadline } = require('./pregameOrchestrator');
          if (typeof recoverPregameDeadline === 'function') {
            await recoverPregameDeadline(io, sessionId, entry);
          }
        } catch (err) {
          errorGame(sessionId, `Pregame durable recovery failed: ${err.message}`);
        }
      }
    },
  });

  async function finalizeDeclarationWindow(sessionId, reason = 'timeout') {
    const state = activeDeclareBySession.get(sessionId);
    if (!state) return null;

    logGame(sessionId, `Finalizing declaration window — reason=${reason} sequence=${state.sequence}`);

    const idemKey = declarationFinalizeKey(sessionId, state.sequence);
    const claimed = await redisLockService.claimEventIdempotency(
      idemKey,
      DECLARE_RESULT_IDEMPOTENCY_TTL_SECONDS
    );

    if (!claimed) {
      logGame(sessionId, 'Declaration finalize already claimed by another handler — skipping');
      cleanupDeclareState(sessionId);
      return null;
    }

    try {
      // Skip game_session_events (ORDER BY created_at DESC scan) — finalize
      // only needs players + distribution + scores, not the event audit trail.
      const session = await gameplayService.getSessionState(sessionId, null, {
        includeEvents: false,
        includeGameContest: true,
      });
      if (!session) {
        warnGame(sessionId, 'Session not found during declaration finalize — aborting');
        cleanupDeclareState(sessionId);
        return null;
      }

      const distribution = session.metadata?.distribution;
      if (!distribution) {
        throw new Error('Card distribution not found for declaration finalize');
      }

      const players = Array.isArray(session.players) ? session.players : [];
      const distributionUserIds = new Set(
        (Array.isArray(distribution?.players) ? distribution.players : [])
          .map((player) => Number(player?.user_id))
          .filter((userId) => !Number.isNaN(userId))
      );
      const roundPlayers = players.filter((player) => distributionUserIds.has(Number(player.user_id)));
      const wildJoker = distribution.wild_joker || null;
      const declarerUserId = state.declareByUserId;
      const finishCard = state.finishCard || session.metadata?.declaration?.finish_card || null;
      const autoDeclaredUserIds = [];

      const declarerDistribution = getPlayerDistribution(distribution, declarerUserId);
      const declarerCards = declarerDistribution?.cards || [];
      const declarerResponse = getDeclareResponseEntry(state.responses, declarerUserId);
      const declarerSubmittedGroups = declarerResponse?.groups || [];
      const declarerStoredGroups = Array.isArray(declarerDistribution?.submitted_groups)
        ? declarerDistribution.submitted_groups
        : [];
      const declarerResolved = resolveDeclarerGroupingForFinalize({
        cards: declarerCards,
        wildJoker,
        responseGroups: declarerSubmittedGroups,
        storedGroups: declarerStoredGroups,
        sessionId,
        declarerUserId,
      });
      const declarerGrouping = declarerResolved.grouping
        || { summary: { valid_for_declare: false } };
      const declarerValid = declarerResolved.valid === true
        && declarerGrouping?.summary?.valid_for_declare === true;

      logGame(
        sessionId,
        `Declaration by uid=${declarerUserId} — valid=${declarerValid}  ` +
        `source=${declarerResolved.source || 'unknown'}  ` +
        `pureSeq=${declarerGrouping?.summary?.pure_sequence_count || 0}  ` +
        `seq=${declarerGrouping?.summary?.sequence_count || 0}  ` +
        `ungrouped=${declarerGrouping?.summary?.ungrouped_points || 0}pts`
      );

      const timeoutEliminatedSet = getTimeoutEliminatedUserIdSet(session.metadata || {});
      const turnEliminatedSet = getTurnEliminatedUserIdSet(session.metadata || {});
      // Score each player with a yield between seats so that concurrent finalize
      // calls from N tables don't block the event loop in one long synchronous burst.
      // Each scoring call (buildBestGrouping DFS) can take 10-80ms per player.
      const results = [];
      for (const player of roundPlayers) {
        await yieldToEventLoop(); // eslint-disable-line no-await-in-loop
        const playerDistribution = getPlayerDistribution(distribution, player.user_id);
        const playerCards = playerDistribution?.cards || [];
        const playerResponse = getDeclareResponseEntry(state.responses, player.user_id);
        // A single seat's stale submitted layout must never crash the whole finalize
        // (which was leaving tables frozen). Fall back to best grouping for just that
        // seat; every other seat still settles normally.
        let scoring;
        const isDeclarerSeat = Number(player.user_id) === Number(declarerUserId);
        if (isDeclarerSeat) {
          // Keep declarer score aligned with the same validity decision used for winner.
          const pointsFromDeclarer = declarerValid
            ? 0
            : MAX_ROUND_LOSS_POINTS;
          scoring = {
            grouping: declarerGrouping,
            points: pointsFromDeclarer,
          };
        } else if (playerResponse && playerResponse.auto !== true) {
          try {
            scoring = scoreFromSubmittedGrouping(playerCards, wildJoker, playerResponse.groups || []);
          } catch (scoreErr) {
            warnGame(
              sessionId,
              `Submitted grouping unresolved uid=${player.user_id} (${scoreErr.message}) — scoring best grouping`
            );
            scoring = scoreFromBestGrouping(playerCards, wildJoker);
          }
        } else {
          scoring = scoreFromBestGrouping(playerCards, wildJoker);
        }
        const userId = Number(player.user_id);
        const isDropped = isPlayerDropped(player, playerDistribution);
        const isTimeoutEliminated = timeoutEliminatedSet.has(userId);
        let points = scoring.points;
        const alreadyScoredThisDeal = isInvalidDeclarationPackedPlayer(
          player,
          session.metadata || {}
        );
        let poolScoreAlreadyApplied = false;

        if (isDropped) {
          const droppedPenalty = resolveDropLossPoints(session, player.user_id);
          if (Number.isFinite(droppedPenalty)) {
            points = droppedPenalty;
          }
        }

        if (isTimeoutEliminated) {
          const timeoutPenalty = resolveDropLossPoints(session, player.user_id, { forceMiddleDrop: true });
          if (Number.isFinite(timeoutPenalty)) {
            points = timeoutPenalty;
          }
        }

        if (alreadyScoredThisDeal) {
          // Invalid-declaration pack already applied pool penalty for this round.
          // Keep display points = penalty, but do not add them again to pool totals.
          points = resolveInvalidDeclarationPenaltyPoints(player);
          poolScoreAlreadyApplied = true;
          logGame(
            sessionId,
            `Skipping pool re-score for packed uid=${player.user_id} (already settled this deal @ ${points}pts)`
          );
        } else if (isDeclarerSeat && !declarerValid) {
          points = MAX_ROUND_LOSS_POINTS;
          logGame(sessionId, `Applying 80pt penalty to invalid declarer uid=${player.user_id}`);
        } else if (!isDropped && !isTimeoutEliminated && !isDeclarerSeat) {
          const halfPenalty = resolveFirstRoundNoChanceDeclarePenalty(
            points,
            playerDistribution
          );
          if (halfPenalty !== points) {
            logGame(
              sessionId,
              `No-turn half penalty for uid=${player.user_id}: ${points} -> ${halfPenalty}`
            );
            points = halfPenalty;
          }
        }

        if (!hasDeclareResponseEntry(state.responses, player.user_id)) {
          autoDeclaredUserIds.push(player.user_id);
          logGame(sessionId, `uid=${player.user_id} did not respond — auto-scored ${points}pts (seat=${player.seat_no})`);
        } else {
          logGame(sessionId, `uid=${player.user_id} scored ${points}pts mode=${getDeclareResponseEntry(state.responses, player.user_id)?.auto ? 'auto' : 'manual'} seat=${player.seat_no}`);
        }

        results.push({
          user_id: player.user_id,
          seat_no: player.seat_no,
          points,
          round_points: points,
          pool_score_already_applied: poolScoreAlreadyApplied,
          grouped_points: scoring.grouping?.summary?.grouped_points ?? null,
          ungrouped_points: scoring.grouping?.summary?.ungrouped_points ?? null,
          valid_for_declare: isDeclarerSeat
            ? declarerValid
            : (scoring.grouping?.summary?.valid_for_declare ?? null),
          invalid_group_count: Number(scoring.grouping?.summary?.invalid_group_count) || 0,
          all_cards_grouped: scoring.grouping?.summary?.all_cards_grouped !== false,
          submission_mode: hasDeclareResponseEntry(state.responses, player.user_id)
            ? (getDeclareResponseEntry(state.responses, player.user_id)?.auto ? 'auto' : 'manual')
            : 'auto',
          submission_status: hasDeclareResponseEntry(state.responses, player.user_id)
            ? (getDeclareResponseEntry(state.responses, player.user_id)?.auto ? 'auto' : 'manual')
            : 'not_submitted',
          dropped: isDropped || isTimeoutEliminated,
          packed_in_current_deal: alreadyScoredThisDeal,
        });
      }

      let winnerUserId = declarerUserId;
      if (!declarerValid) {
        const sorted = [...results].sort((a, b) => {
          if (a.points !== b.points) return a.points - b.points;
          return a.seat_no - b.seat_no;
        });
        // Invalid declarer cannot win. Prefer active non-declarer seats.
        const sortedNonDeclarer = sorted.filter((item) => {
          const uid = Number(item.user_id);
          if (uid === Number(declarerUserId)) return false;
          if (turnEliminatedSet.has(uid)) return false;
          if (item.dropped === true || item.packed_in_current_deal === true) return false;
          return true;
        });
        winnerUserId = sortedNonDeclarer[0]?.user_id || sorted[0]?.user_id || declarerUserId;
        logGame(sessionId, `Declarer invalid — winner re-resolved to uid=${winnerUserId} (${sorted[0]?.points}pts)`);
      } else {
        logGame(sessionId, `Declarer valid — winner=uid=${winnerUserId}`);
      }

      const mode = resolveSessionGameMode(session);
      const totalDeals = resolveTotalDeals(session);
      const currentDeal = resolveCurrentDeal(session);

      const preliminaryFinalized = results.map((item) => ({
        ...item,
        is_winner: Number(item.user_id) === Number(winnerUserId),
      }));

      let isGameFinalForStatus = true;
      if (isDealLikeMode(mode) && currentDeal < totalDeals) {
        isGameFinalForStatus = false;
      } else if (mode === 'pool') {
        const poolProgressPreview = buildPoolRoundProgress(session, preliminaryFinalized);
        isGameFinalForStatus = poolProgressPreview.activeUserIds.length <= 1;
      }

      let finalizedResults = preliminaryFinalized.map((item) => ({
        ...item,
        player_status: resolvePlayerStatus({
          isFinal: true,
          isGameFinal: isGameFinalForStatus,
          isDropped: item.dropped === true,
          isWinner: item.is_winner === true,
          userId: item.user_id,
          declareByUserId: declarerUserId,
          declarerValid,
          mode,
        }),
        status_color: resolveStatusColor(resolvePlayerStatus({
          isFinal: true,
          isGameFinal: isGameFinalForStatus,
          isDropped: item.dropped === true,
          isWinner: item.is_winner === true,
          userId: item.user_id,
          declareByUserId: declarerUserId,
          declarerValid,
          mode,
        })),
      }));

      const dealSnapshot = buildDealResultSnapshot({
        dealNo: currentDeal,
        reason,
        winnerUserId,
        declareByUserId: declarerUserId,
        declarerValid,
        finishCard,
        autoDeclaredUserIds,
        finalizedResults,
      });

      if (isDealLikeMode(mode) && currentDeal < totalDeals) {
        const dealResultPayload = await transitionToNextDeal(io, session, dealSnapshot);

        emitDeclarationState(io, session, state, {
          distribution,
          reason,
          isFinal: true,
          isGameFinal: false,
          finalizedResults,
          settlement: null,
          winnerUserId,
          declarerValid,
        });

        cleanupDeclareState(sessionId);
        return dealResultPayload;
      }

      if (mode === 'pool') {
        const previouslyEliminatedSet = new Set(
          (Array.isArray(session?.metadata?.pool_eliminated_user_ids) ? session.metadata.pool_eliminated_user_ids : [])
            .map((id) => Number(id))
            .filter((id) => !Number.isNaN(id))
        );
        const poolProgress = buildPoolRoundProgress(session, finalizedResults);
        const eliminatedSet = new Set(
          poolProgress.eliminatedUserIds
            .map((id) => Number(id))
            .filter((id) => !Number.isNaN(id))
        );

        const roundResultsWithPool = finalizedResults.map((item) => {
          const userId = Number(item.user_id);
          const roundPoints = Math.max(0, Number(item?.round_points ?? item?.points) || 0);
          const cumulativePoints = Number(poolProgress.scoresByUser[String(userId)]) || 0;
          const isEliminated = eliminatedSet.has(userId);
          const preservePlayerStatus = item?.is_winner === true
            || item?.dropped === true
            || item?.player_status === 'dropped'
            || item?.player_status === 'timeout';
          const nextPlayerStatus = preservePlayerStatus
            ? item.player_status
            : (isEliminated ? 'eliminated' : item.player_status);
          return {
            ...item,
            round_points: roundPoints,
            cumulative_points: cumulativePoints,
            total_score: cumulativePoints,
            score_model: 'pool_loss_cumulative',
            player_status: nextPlayerStatus,
            status_color: resolveStatusColor(nextPlayerStatus),
          };
        });

        if (declarerValid === false) {
          const declarerResult = roundResultsWithPool.find(
            (entry) => Number(entry.user_id) === Number(declarerUserId)
          );
          const declarerPlayer = (session.players || []).find(
            (entry) => Number(entry.user_id) === Number(declarerUserId)
          );
          if (declarerResult && declarerPlayer) {
            const declarerEliminated = declarerResult.player_status === 'eliminated'
              || eliminatedSet.has(Number(declarerUserId));
            emitPlayerStatusOverride(io, session, declarerPlayer, {
              status: declarerEliminated ? 'eliminated' : declarerPlayer.status,
              player_status: declarerEliminated ? 'eliminated' : 'invalid_declaration',
              metadata: {
                invalid_declaration: true,
                packed_in_current_deal: true,
                invalid_declaration_penalty_points: declarerResult.points,
                cumulative_points: declarerResult.total_score ?? null,
              },
              content_message: declarerEliminated
                ? 'Invalid declaration and threshold reached. You are eliminated from this pool game.'
                : 'Invalid declaration. You are packed for this deal and scored penalty points.',
              action_message: declarerEliminated
                ? 'Please wait for game completion or use rejoin option if available.'
                : 'Please wait for the next deal/round.',
            }, declarerEliminated ? 'pool_limit_eliminated' : 'invalid_declaration_packed');
          }
        }

        const newlyEliminatedUserIds = Array.from(eliminatedSet)
          .filter((id) => !previouslyEliminatedSet.has(id));
        newlyEliminatedUserIds.forEach((uid) => {
          if (Number(uid) === Number(declarerUserId) && declarerValid === false) return;
          const eliminatedPlayer = (session.players || []).find(
            (entry) => Number(entry.user_id) === Number(uid)
          );
          if (!eliminatedPlayer) return;
          const cumulativePoints = Number(poolProgress.scoresByUser[String(uid)]) || 0;
          emitPlayerStatusOverride(io, session, eliminatedPlayer, {
            status: 'eliminated',
            player_status: 'eliminated',
            metadata: {
              elimination_reason: 'pool_limit',
              cumulative_points: cumulativePoints,
              pool_limit: poolProgress.poolLimit,
            },
            content_message: 'You reached the pool threshold and are eliminated.',
            action_message: 'Please wait for game completion or use rejoin option if available.',
          }, 'pool_limit_eliminated');
        });

        if (poolProgress.activeUserIds.length > 1) {
          const rejoinContext = buildPoolRejoinContext({
            players: session.players || [],
            scoresByUser: poolProgress.scoresByUser,
            eliminatedUserIds: poolProgress.eliminatedUserIds,
            poolLimit: poolProgress.poolLimit,
          });
          const rejoinJoiningFee = roundCurrency(Number(session?.contest?.entry) || 0);
          const prizePoolSummary = buildPoolPrizePoolSummary({
            entryFee: rejoinJoiningFee,
            baseEntryCount: resolvePoolBaseEntryCount(session),
            rejoinEntryCount: resolvePoolRejoinEntryCount(session?.metadata || {}),
            projectedExtraEntries: rejoinContext.can_rejoin_table ? 1 : 0,
          });
          const rejoinInfo = buildPoolRejoinInfoPayload({
            rejoinContext,
            joiningFee: rejoinJoiningFee,
            prizePoolSummary,
          });
          const poolEliminationContext = buildPoolEliminationContextFields(session, poolProgress);
          const intermediatePayload = {
            session_id: sessionId,
            server_time: new Date().toISOString(),
            event: 'game:result',
            status: 'round_completed',
            is_final: false,
            reason,
            declare_by_user_id: declarerUserId,
            declare_valid: declarerValid,
            winner_user_id: winnerUserId,
            tie_break_policy: 'pool_limit_then_lowest_points',
            finish_card: finishCard,
            auto_declared_user_ids: autoDeclaredUserIds,
            pool_limit: poolProgress.poolLimit,
            pool_round_no: poolProgress.currentRoundNo,
            pool_scores_by_user: poolProgress.scoresByUser,
            pool_eliminated_user_ids: poolProgress.eliminatedUserIds,
            pool_previous_eliminated_user_ids: poolEliminationContext.pool_previous_eliminated_user_ids,
            pool_newly_eliminated_user_ids: poolEliminationContext.pool_newly_eliminated_user_ids,
            can_rejoin_table: rejoinContext.can_rejoin_table,
            rejoin_threshold: rejoinContext.rejoin_threshold,
            rejoin_candidate_user_ids: rejoinContext.rejoin_candidate_user_ids,
            rejoin_start_points_by_user: rejoinContext.rejoin_start_points_by_user,
            rejoin_at_points_by_user: rejoinContext.rejoin_start_points_by_user,
            joining_fee: rejoinInfo.joining_fee,
            current_prize_pool: rejoinInfo.current_prize_pool,
            updated_prize_pool_if_rejoin: rejoinInfo.updated_prize_pool_if_rejoin,
            rejoin_info: rejoinInfo,
            results: roundResultsWithPool,
            settlement: null,
            deal_no: null,
            total_deals: null,
            deal_scores: null,
          };

          const completeRoundResultsWithPool = appendAbsentEliminatedPoolPlayersToRoundResults(
            session,
            roundResultsWithPool,
            poolProgress,
          );

          intermediatePayload.results = completeRoundResultsWithPool;
          intermediatePayload.players = buildDeclarationTablePlayers({
            session,
            distribution,
            state,
            isFinal: true,
            isGameFinal: false,
            finalizedResults: completeRoundResultsWithPool,
            settlement: null,
            winnerUserId,
            declarerValid,
            previousPoolEliminatedUserIds: poolEliminationContext.previousPoolEliminatedUserIds,
          });

          emitDeclarationState(io, session, state, {
            distribution,
            reason,
            isFinal: true,
            isGameFinal: false,
            finalizedResults: completeRoundResultsWithPool,
            settlement: null,
            winnerUserId,
            declarerValid,
          });

          cleanupDeclareState(sessionId);
          return transitionToNextPoolRound(io, session, intermediatePayload, poolProgress);
        }

        let poolWinnerUserId = Number(poolProgress.activeUserIds[0]) || null;
        if (!poolWinnerUserId) {
          const sortedByScore = Object.entries(poolProgress.scoresByUser)
            .map(([userId, points]) => ({ user_id: Number(userId), points: Number(points) || 0 }))
            .filter((entry) => !Number.isNaN(entry.user_id))
            .sort((a, b) => a.points - b.points);
          poolWinnerUserId = sortedByScore[0]?.user_id || winnerUserId;
        }

        finalizedResults = buildPoolFinalResults(
          session,
          poolProgress.scoresByUser,
          poolWinnerUserId,
          poolProgress.eliminatedUserIds,
          roundResultsWithPool,
        );
        winnerUserId = poolWinnerUserId;

        let settlement = null;
        try {
          settlement = await settlePoolPotResult(session, winnerUserId);
        } catch (settleErr) {
          errorGame(sessionId, `Pool settlement error (non-fatal): ${settleErr.message}`);
        }

        const resultPayload = {
          session_id: sessionId,
          server_time: new Date().toISOString(),
          event: 'game:result',
          status: 'completed',
          is_final: true,
          reason,
          declare_by_user_id: declarerUserId,
          declare_valid: declarerValid,
          winner_user_id: winnerUserId,
          tie_break_policy: 'pool_limit_then_lowest_points',
          finish_card: finishCard,
          auto_declared_user_ids: autoDeclaredUserIds,
          pool_limit: poolProgress.poolLimit,
          pool_round_no: poolProgress.currentRoundNo,
          pool_scores_by_user: poolProgress.scoresByUser,
          pool_eliminated_user_ids: poolProgress.eliminatedUserIds,
          can_rejoin_table: false,
          rejoin_threshold: null,
          rejoin_candidate_user_ids: [],
          rejoin_start_points_by_user: {},
          rejoin_at_points_by_user: {},
          joining_fee: roundCurrency(Number(session?.contest?.entry) || 0),
          current_prize_pool: buildPoolPrizePoolSummary({
            entryFee: roundCurrency(Number(session?.contest?.entry) || 0),
            baseEntryCount: resolvePoolBaseEntryCount(session),
            rejoinEntryCount: resolvePoolRejoinEntryCount(session?.metadata || {}),
            projectedExtraEntries: 0,
          }).current_prize_pool,
          updated_prize_pool_if_rejoin: buildPoolPrizePoolSummary({
            entryFee: roundCurrency(Number(session?.contest?.entry) || 0),
            baseEntryCount: resolvePoolBaseEntryCount(session),
            rejoinEntryCount: resolvePoolRejoinEntryCount(session?.metadata || {}),
            projectedExtraEntries: 0,
          }).updated_prize_pool,
          rejoin_info: buildPoolRejoinInfoPayload({
            rejoinContext: { rejoin_start_points_by_user: {} },
            joiningFee: roundCurrency(Number(session?.contest?.entry) || 0),
            prizePoolSummary: buildPoolPrizePoolSummary({
              entryFee: roundCurrency(Number(session?.contest?.entry) || 0),
              baseEntryCount: resolvePoolBaseEntryCount(session),
              rejoinEntryCount: resolvePoolRejoinEntryCount(session?.metadata || {}),
              projectedExtraEntries: 0,
            }),
          }),
          results: attachWonAmountToResults(finalizedResults, settlement),
          settlement,
          deal_no: null,
          total_deals: null,
          deal_scores: null,
        };

        resultPayload.players = buildDeclarationTablePlayers({
          session,
          distribution,
          state,
          isFinal: true,
          finalizedResults,
          settlement,
          winnerUserId,
          declarerValid,
        });

        const poolRoundHistory = mergePoolRoundHistoryIntoMetadata(
          session.metadata || {},
          poolProgress,
          resultPayload
        );

        const nextMetadata = {
          ...(session.metadata || {}),
          phase: 'finished',
          phase_updated_at: new Date().toISOString(),
          pool_limit: poolProgress.poolLimit,
          pool_round_no: poolProgress.currentRoundNo,
          pool_scores_by_user: poolProgress.scoresByUser,
          pool_eliminated_user_ids: poolProgress.eliminatedUserIds,
          pool_round_history: poolRoundHistory,
          declaration: {
            ...(session.metadata?.declaration || {}),
            sequence: state.sequence,
            status: 'completed',
            completed_at: new Date().toISOString(),
            reason,
            declare_by_user_id: declarerUserId,
            declare_valid: declarerValid,
            finish_card: finishCard,
            winner_user_id: winnerUserId,
            auto_declared_user_ids: autoDeclaredUserIds,
            responses: Array.from(state.responses.entries()).map(([userId, value]) => ({
              user_id: userId,
              submitted_at: value.submitted_at,
              auto: value.auto,
            })),
          },
          result: resultPayload,
        };

        await completeSessionWithBotRelease(sessionId, {
          endedAt: new Date(),
          currentTurnUserId: winnerUserId,
          metadata: nextMetadata,
        });

        await gameSessionModel.insertEvent({
          sessionId,
          userId: declarerUserId,
          eventType: 'pool_game_completed',
          payload: resultPayload,
        });

        cleanupTurnState(sessionId);
        emitDeclarationState(io, session, state, {
          distribution,
          reason,
          isFinal: true,
          finalizedResults,
          settlement,
          winnerUserId,
          declarerValid,
        });
        io.to(sessionRoom(sessionId)).emit('game:result', resultPayload);
        scheduleAutoRematchFromResult(io, sessionId);
        cleanupDeclareState(sessionId);
        return resultPayload;
      }

      let completeDealScores = isDealLikeMode(mode)
        ? [...normalizeDealScoreHistory(session.metadata || {}), dealSnapshot]
        : null;
      let dealScoreTotalsByUser = null;
      let dealBaseScore = null;
      if (isDealLikeMode(mode)) {
        const scoreboard = computeDealScoreboardTimeline(session, completeDealScores || []);
        completeDealScores = scoreboard.enrichedDealScores;
        dealScoreTotalsByUser = scoreboard.scoreTotalsByUser;
        dealBaseScore = scoreboard.dealBaseScore;
      }
      const dealContext = buildDealContextFields(session, {
        dealNo: currentDeal,
        totalDeals,
        dealScores: completeDealScores,
        dealScoreTotalsByUser,
      });

      if (isDealLikeMode(mode)) {
        const aggregate = buildAggregateResultsFromDealScores(session, completeDealScores || []);
        winnerUserId = aggregate.winnerUserId || winnerUserId;
        finalizedResults = aggregate.finalizedResults;
      }

      // ── Settlement: debit losers, credit winner ───────────────────────────
      let settlement = null;
      try {
        if (mode === 'spin_go') {
          settlement = await settleSpinGoResult(session, winnerUserId);
        } else if (mode === 'deals_2') {
          settlement = await settleDealsPotResult(session, finalizedResults, winnerUserId);
        } else {
          const pointValue = session.contest?.point_value || session.game?.point_value || 0;
          settlement = await settleGameResult(sessionId, finalizedResults, winnerUserId, pointValue);
        }
      } catch (settleErr) {
        // Settlement failure must NOT block result broadcast — log and continue.
        errorGame(sessionId, `Settlement error (non-fatal): ${settleErr.message}`);
      }
      // ─────────────────────────────────────────────────────────────────────

      const resultPayload = {
        session_id: sessionId,
        server_time: new Date().toISOString(),
        event: 'game:result',
        status: 'completed',
        is_final: true,
        reason,
        declare_by_user_id: declarerUserId,
        declare_valid: declarerValid,
        winner_user_id: winnerUserId,
        tie_break_policy: 'lowest_points_then_lowest_seat_no',
        finish_card: finishCard,
        auto_declared_user_ids: autoDeclaredUserIds,
        results: attachWonAmountToResults(finalizedResults, settlement),
        ...dealContext,
        settlement,
      };

      resultPayload.players = buildDeclarationTablePlayers({
        session,
        distribution,
        state,
        isFinal: true,
        finalizedResults,
        settlement,
        winnerUserId,
        declarerValid,
      });

      if (completeDealScores) {
        completeDealScores = enrichLastDealScoreEntry(completeDealScores, {
          players: resultPayload.players,
          wild_joker_card_id: resolveWildJokerCardId(session),
          finish_card: finishCard,
          declare_by_user_id: declarerUserId,
          declare_valid: declarerValid,
          reason,
          first_turn_user_id: session?.metadata?.first_turn_user_id ?? null,
          last_turn_user_id: session?.metadata?.last_turn_user_id ?? null,
        });
      }

      const nextMetadata = {
        ...(session.metadata || {}),
        phase: 'finished',
        phase_updated_at: new Date().toISOString(),
        declaration: {
          ...(session.metadata?.declaration || {}),
          sequence: state.sequence,
          status: 'completed',
          completed_at: new Date().toISOString(),
          reason,
          declare_by_user_id: declarerUserId,
          declare_valid: declarerValid,
          finish_card: finishCard,
          winner_user_id: winnerUserId,
          auto_declared_user_ids: autoDeclaredUserIds,
          responses: Array.from(state.responses.entries()).map(([userId, value]) => ({
            user_id: userId,
            submitted_at: value.submitted_at,
            auto: value.auto,
          })),
        },
        ...(completeDealScores ? {
          current_deal: currentDeal,
          total_deals: totalDeals,
          deal_scores: completeDealScores,
          deal_base_score: dealBaseScore,
          deal_score_totals_by_user: dealScoreTotalsByUser,
        } : {}),
        result: resultPayload,
      };

      await completeSessionWithBotRelease(sessionId, {
        endedAt: new Date(),
        currentTurnUserId: winnerUserId,
        metadata: nextMetadata,
      });

      await gameSessionModel.insertEvent({
        sessionId,
        userId: declarerUserId,
        eventType: 'declaration_finalized',
        payload: resultPayload,
      });

      cleanupTurnState(sessionId);

      emitDeclarationState(io, session, state, {
        distribution,
        reason,
        isFinal: true,
        finalizedResults,
        settlement,
        winnerUserId,
        declarerValid,
      });

      logGame(sessionId, `Emitting game:result — winner=uid:${winnerUserId} reason=${reason} settled=${settlement !== null}`);
      io.to(sessionRoom(sessionId)).emit('game:result', resultPayload);
      scheduleAutoRematchFromResult(io, sessionId);
      cleanupDeclareState(sessionId);
      return resultPayload;
    } catch (err) {
      errorGame(sessionId, `finalizeDeclarationWindow error: ${err.message}`, err.stack);
      cleanupDeclareState(sessionId);
      throw err;
    }
  }

  async function startDeclarationWindow(session, declareByUserId, declareGroups = [], options = {}) {
    const sessionId = session.id;
    if (activeDeclareBySession.has(sessionId)) {
      throw new Error('Declaration window already active');
    }

    cleanupTurnState(sessionId);

    const durationSeconds = DECLARE_WINDOW_SECONDS;
    const finishCard = options?.finishCard || null;
    const nextDistribution = options?.distribution || session.metadata?.distribution;
    const openForAll = options?.openForAll !== false;
    const prefillDeclarerResponse = openForAll && options?.prefillDeclarerResponse !== false;
    logGame(
      sessionId,
      `Declaration window starting — declarer=uid:${declareByUserId} duration=${durationSeconds}s ` +
      `prefill=${prefillDeclarerResponse} open_for_all=${openForAll}`
    );
    const requestedAt = new Date();
    const startedAt = requestedAt;
    const endsAt = new Date(requestedAt.getTime() + (durationSeconds * 1000));
    const sequence = `${sessionId}:${Date.now()}`;
    const allPlayers = Array.isArray(session.players) ? session.players : [];
    const distributionUserIds = new Set(
      (Array.isArray(nextDistribution?.players) ? nextDistribution.players : [])
        .map((player) => Number(player?.user_id))
        .filter((userId) => !Number.isNaN(userId))
    );
    const players = distributionUserIds.size > 0
      ? allPlayers.filter((player) => distributionUserIds.has(Number(player.user_id)))
      : allPlayers;

    const responses = new Map();
    const declarerIdNum = Number(declareByUserId);
    const declarerKey = Number.isNaN(declarerIdNum) ? declareByUserId : declarerIdNum;
    if (prefillDeclarerResponse) {
      responses.set(declarerKey, {
        submitted_at: startedAt.toISOString(),
        auto: false,
        groups: declareGroups,
      });
    }
    prefillDroppedPlayersInDeclareResponses(
      session,
      nextDistribution,
      players,
      responses,
      startedAt.toISOString()
    );

    activeDeclareBySession.set(sessionId, {
      sessionId,
      sequence,
      declareByUserId: declarerKey,
      participantUserIds: players.map((player) => player.user_id),
      visibilityStage: openForAll
        ? DECLARATION_VISIBILITY_OPEN_FOR_ALL
        : DECLARATION_VISIBILITY_AWAITING_DECLARER,
      startedAt: startedAt ? startedAt.toISOString() : null,
      endsAt: endsAt ? endsAt.toISOString() : null,
      finishCard,
      responses,
      countdownInterval: null,
      timeoutHandle: null,
    });

    const pendingUserIds = players
      .map((p) => p.user_id)
      .filter((userId) => !hasDeclareResponseEntry(responses, userId));

    const nextMetadata = {
      ...(session.metadata || {}),
      ...(nextDistribution ? {
        distribution: nextDistribution,
      } : {}),
      phase: 'declaration_window',
      phase_updated_at: new Date().toISOString(),
      declaration: {
        sequence,
        status: openForAll
          ? 'waiting_responses'
          : DECLARATION_VISIBILITY_AWAITING_DECLARER,
        visibility_stage: openForAll
          ? DECLARATION_VISIBILITY_OPEN_FOR_ALL
          : DECLARATION_VISIBILITY_AWAITING_DECLARER,
        declare_by_user_id: declareByUserId,
        requested_at: requestedAt.toISOString(),
        started_at: startedAt ? startedAt.toISOString() : null,
        ends_at: endsAt ? endsAt.toISOString() : null,
        duration_seconds: durationSeconds,
        pending_user_ids: pendingUserIds,
        finish_card: finishCard,
      },
    };

    await gameSessionModel.updateSessionStatus(sessionId, session.status, {
      metadata: nextMetadata,
    });

    await gameSessionModel.insertEvent({
      sessionId,
      userId: declareByUserId,
      eventType: 'declaration_started',
      payload: {
        sequence,
        requested_at: requestedAt.toISOString(),
        started_at: startedAt ? startedAt.toISOString() : null,
        ends_at: endsAt ? endsAt.toISOString() : null,
        duration_seconds: durationSeconds,
        finish_card: finishCard,
      },
    });

    if (finishCard) {
      io.to(sessionRoom(sessionId)).emit('game:finish', {
        session_id: sessionId,
        server_time: new Date().toISOString(),
        event: 'game:finish',
        sequence,
        declare_by_user_id: declareByUserId,
        finish_card: finishCard,
      });
    }

    const declarationDealContext = buildDealContextFields({
      ...session,
      metadata: nextMetadata,
    });

    const declarationRequestedPayload = {
      session_id: sessionId,
      server_time: new Date().toISOString(),
      event: 'game:declare:requested',
      sequence,
      declare_by_user_id: declareByUserId,
      started_at: startedAt ? startedAt.toISOString() : null,
      ends_at: endsAt ? endsAt.toISOString() : null,
      duration_seconds: durationSeconds,
      ...declarationDealContext,
      pending_user_ids: pendingUserIds,
      finish_card: finishCard,
      visibility_stage: openForAll
        ? DECLARATION_VISIBILITY_OPEN_FOR_ALL
        : DECLARATION_VISIBILITY_AWAITING_DECLARER,
      open_for_all: openForAll,
    };

    if (openForAll) {
      io.to(sessionRoom(sessionId)).emit('game:declare:requested', declarationRequestedPayload);
    } else {
      emitToUserInSession(io, sessionId, declareByUserId, 'game:declare:requested', declarationRequestedPayload);
    }

    const state = activeDeclareBySession.get(sessionId);
    const scopedSession = {
      ...session,
      metadata: nextMetadata,
    };
    const declarationStatePayload = buildDeclarationStatePayload({
      session: scopedSession,
      state,
      distribution: nextDistribution,
      reason: null,
      isFinal: false,
      finalizedResults: [],
      settlement: null,
      winnerUserId: null,
      declarerValid: null,
    });
    if (openForAll) {
      io.to(sessionRoom(sessionId)).emit('game:declare:state', declarationStatePayload);
    } else {
      emitToUserInSession(io, sessionId, declareByUserId, 'game:declare:state', declarationStatePayload);
    }

    if (openForAll) {
      state.timeoutHandle = setTimeout(() => {
        logGame(sessionId, 'Declaration window timed out — auto-finalizing');
        finalizeDeclarationWindow(sessionId, 'timeout').catch((err) => {
          errorGame(sessionId, `Failed to finalize declaration on timeout: ${err.message}`);
        });
      }, durationSeconds * 1000);
    } else {
      state.timeoutHandle = setTimeout(async () => {
        try {
          const liveState = activeDeclareBySession.get(sessionId);
          if (!liveState || liveState.visibilityStage !== DECLARATION_VISIBILITY_AWAITING_DECLARER) {
            return;
          }

          if (!hasDeclareResponseEntry(liveState.responses, liveState.declareByUserId)) {
            const liveSession = await gameplayService.getSessionState(sessionId);
            if (!liveSession) return;

            const liveDistribution = liveSession.metadata?.distribution || null;
            const declarerDistribution = getPlayerDistribution(liveDistribution, liveState.declareByUserId);
            let autoGroups = [];
            if (declarerDistribution) {
              const autoGrouping = groupingService.buildBestGrouping(
                declarerDistribution.cards || [],
                liveDistribution?.wild_joker || null
              );
              autoGroups = toSubmittedGroupsFromGrouping(autoGrouping);
            }

            liveState.responses.set(liveState.declareByUserId, {
              submitted_at: new Date().toISOString(),
              auto: true,
              groups: autoGroups,
            });
            persistDeclareState(liveState);

            io.to(sessionRoom(sessionId)).emit('game:declare:submitted', {
              session_id: sessionId,
              server_time: new Date().toISOString(),
              event: 'game:declare:submitted',
              user_id: liveState.declareByUserId,
              pending_count: Math.max(
                0,
                (Array.isArray(liveState.participantUserIds) ? liveState.participantUserIds.length : 0) -
                liveState.responses.size
              ),
              auto: true,
            });

            logGame(sessionId, `Declarer timeout reached — auto-submitted uid=${liveState.declareByUserId}`);

            const openResult = await openDeclarationWindowForAll(liveSession, liveState, {
              distribution: liveDistribution,
            });
            scheduleBotDeclarationResponses(sessionId);

            if ((openResult?.pending_count || 0) === 0) {
              logGame(sessionId, 'Declarer timeout auto-opened declaration window with no pending players — finalizing');
              await finalizeDeclarationWindow(sessionId, 'all_submitted');
            }
          }
        } catch (err) {
          errorGame(sessionId, `Failed to auto-submit declarer on timeout: ${err.message}`);
        }
      }, durationSeconds * 1000);
    }

    persistDeclareState(state);

    return {
      sequence,
      started_at: startedAt ? startedAt.toISOString() : null,
      ends_at: endsAt ? endsAt.toISOString() : null,
      duration_seconds: durationSeconds,
      pending_user_ids: pendingUserIds,
      finish_card: finishCard,
      visibility_stage: state.visibilityStage,
      open_for_all: openForAll,
    };
  }

  async function openDeclarationWindowForAll(session, state, options = {}) {
    if (!session || !state) {
      throw new Error('Declaration state unavailable');
    }
    if (state.visibilityStage === DECLARATION_VISIBILITY_OPEN_FOR_ALL) {
      const totalPlayers = Array.isArray(state.participantUserIds)
        ? state.participantUserIds.length
        : (session.players || []).length;
      const pendingCount = Math.max(0, totalPlayers - state.responses.size);
      return {
        opened: false,
        sequence: state.sequence,
        started_at: state.startedAt,
        ends_at: state.endsAt,
        pending_count: pendingCount,
      };
    }

    const sessionId = session.id;
    const durationSeconds = DECLARE_WINDOW_SECONDS;
    const nextDistribution = options?.distribution || session.metadata?.distribution;
    const now = new Date();
    const startedAtIso = now.toISOString();
    const endsAtIso = new Date(now.getTime() + (durationSeconds * 1000)).toISOString();
    state.visibilityStage = DECLARATION_VISIBILITY_OPEN_FOR_ALL;
    state.startedAt = startedAtIso;
    state.endsAt = endsAtIso;

    const allPlayers = Array.isArray(session.players) ? session.players : [];
    const participantUserIds = Array.isArray(state.participantUserIds) && state.participantUserIds.length > 0
      ? state.participantUserIds
      : allPlayers.map((player) => player.user_id);
    const participantSet = new Set(
      participantUserIds.map((id) => Number(id)).filter((id) => !Number.isNaN(id))
    );
    const players = allPlayers.filter((player) => participantSet.has(Number(player.user_id)));
    prefillDroppedPlayersInDeclareResponses(
      session,
      nextDistribution,
      players,
      state.responses,
      startedAtIso
    );
    const pendingUserIds = participantUserIds
      .filter((userId) => !hasDeclareResponseEntry(state.responses, userId));
    const nextMetadata = {
      ...(session.metadata || {}),
      ...(nextDistribution ? { distribution: nextDistribution } : {}),
      phase: 'declaration_window',
      phase_updated_at: new Date().toISOString(),
      declaration: {
        ...(session.metadata?.declaration || {}),
        sequence: state.sequence,
        status: 'waiting_responses',
        visibility_stage: DECLARATION_VISIBILITY_OPEN_FOR_ALL,
        declare_by_user_id: state.declareByUserId,
        started_at: startedAtIso,
        ends_at: endsAtIso,
        duration_seconds: durationSeconds,
        pending_user_ids: pendingUserIds,
        finish_card: state.finishCard || session.metadata?.declaration?.finish_card || null,
      },
    };

    await gameSessionModel.updateSessionStatus(sessionId, session.status, {
      metadata: nextMetadata,
    });

    const declarationDealContext = buildDealContextFields({
      ...session,
      metadata: nextMetadata,
    });

    // Make the open-stage snapshot visible before notifying sockets on other
    // PM2/EC2 workers. Their responses may arrive immediately and must be able
    // to rebuild the declaration state from Redis.
    await persistDeclareState(state);

    io.to(sessionRoom(sessionId)).emit('game:declare:requested', {
      session_id: sessionId,
      server_time: new Date().toISOString(),
      event: 'game:declare:requested',
      sequence: state.sequence,
      declare_by_user_id: state.declareByUserId,
      started_at: startedAtIso,
      ends_at: endsAtIso,
      duration_seconds: durationSeconds,
      ...declarationDealContext,
      pending_user_ids: pendingUserIds,
      finish_card: state.finishCard || session.metadata?.declaration?.finish_card || null,
      visibility_stage: DECLARATION_VISIBILITY_OPEN_FOR_ALL,
      open_for_all: true,
    });

    emitDeclarationState(io, {
      ...session,
      metadata: nextMetadata,
    }, state, {
      distribution: nextDistribution,
    });

    if (state.timeoutHandle) {
      clearTimeout(state.timeoutHandle);
    }
    state.timeoutHandle = setTimeout(() => {
      logGame(sessionId, 'Declaration window timed out — auto-finalizing');
      finalizeDeclarationWindow(sessionId, 'timeout').catch((err) => {
        errorGame(sessionId, `Failed to finalize declaration on timeout: ${err.message}`);
      });
    }, durationSeconds * 1000);

    return {
      opened: true,
      sequence: state.sequence,
      started_at: startedAtIso,
      ends_at: endsAtIso,
      duration_seconds: durationSeconds,
      pending_user_ids: pendingUserIds,
      pending_count: pendingUserIds.length,
      finish_card: state.finishCard || session.metadata?.declaration?.finish_card || null,
      visibility_stage: DECLARATION_VISIBILITY_OPEN_FOR_ALL,
      open_for_all: true,
    };
  }

  function scheduleBotDeclarationResponses(sessionId) {
    const state = activeDeclareBySession.get(sessionId);
    if (!state) return;
    if (state.visibilityStage !== DECLARATION_VISIBILITY_OPEN_FOR_ALL) return;

    gameplayService.getSessionState(sessionId)
      .then((session) => {
        if (!session || session.status !== 'active') return;

        const distribution = session.metadata?.distribution;
        if (!distribution) return;

        const botPendingUsers = (session.players || [])
          .filter((player) => {
            if (player?.metadata?.is_bot !== true) return false;
            if (Array.isArray(state.participantUserIds)
              && !state.participantUserIds.includes(player.user_id)) {
              return false;
            }
            const playerDistribution = getPlayerDistribution(distribution, player.user_id);
            if (isPlayerDropped(player, playerDistribution)) return false;
            return !hasDeclareResponseEntry(state.responses, player.user_id);
          })
          .map((player) => Number(player.user_id))
          .filter((userId) => !Number.isNaN(userId));

        botPendingUsers.forEach((userId, idx) => {
          const delayMs = BOT_DECLARE_RESPONSE_DELAY_MS + (idx * 250);
          setTimeout(async () => {
            const current = activeDeclareBySession.get(sessionId);
            if (!current) return;
            if (current.visibilityStage !== DECLARATION_VISIBILITY_OPEN_FOR_ALL) return;
            if (hasDeclareResponseEntry(current.responses, userId)) return;

            try {
              const freshSession = await gameplayService.getSessionState(sessionId);
              if (!freshSession || freshSession.status !== 'active') return;

              const freshDistribution = freshSession.metadata?.distribution;
              const playerDistribution = getPlayerDistribution(freshDistribution, userId);
              if (!playerDistribution) return;

              const grouping = groupingService.buildBestGrouping(
                playerDistribution.cards || [],
                freshDistribution?.wild_joker || null
              );
              const submittedGroups = toSubmittedGroupsFromGrouping(grouping);

              current.responses.set(userId, {
                submitted_at: new Date().toISOString(),
                auto: true,
                groups: submittedGroups,
              });
              persistDeclareState(current);

              const totalPlayers = Array.isArray(current.participantUserIds)
                ? current.participantUserIds.length
                : (freshSession.players || []).length;
              const pendingCount = Math.max(0, totalPlayers - current.responses.size);

              io.to(sessionRoom(sessionId)).emit('game:declare:submitted', {
                session_id: sessionId,
                server_time: new Date().toISOString(),
                event: 'game:declare:submitted',
                user_id: userId,
                pending_count: pendingCount,
              });

              emitDeclarationState(io, freshSession, current, {
                distribution: freshDistribution,
              });

              if (pendingCount === 0) {
                await finalizeDeclarationWindow(sessionId, 'all_submitted');
              }
            } catch (err) {
              errorGame(sessionId, `Bot declare response failed uid=${userId}: ${err.message}`);
            }
          }, delayMs);
        });
      })
      .catch((err) => {
        errorGame(sessionId, `Bot declaration scheduling failed: ${err.message}`);
      });
  }

  declarationRuntime.startWindow = startDeclarationWindow;
  declarationRuntime.scheduleBotResponses = scheduleBotDeclarationResponses;

  io.on('connection', (socket) => {
    instrumentSocket(socket);
    // Socket.IO Redis adapter includes socket.data in cluster-wide
    // fetchSockets() results. Keep only the non-sensitive user identifier.
    socket.data = socket.data || {};
    socket.data.user_id = Number(socket.user.id);
    socketRegistry.addSocket(socket.user.id, socket.id);
    console.log(`[SOCKET] Connected uid=${socket.user.id} socketId=${socket.id}`);
    userModel.touchLastSocketAt(socket.user.id).catch((err) => {
      console.error(`[SOCKET] Failed to touch last_socket_at uid=${socket.user.id}:`, err.message);
    });
    socket.emit('connection:ready', {
      socket_id: socket.id,
      user: socket.user,
      server_time: new Date().toISOString(),
    });

    emitActiveNotices(socket).catch((err) => {
      console.error('[SOCKET] Failed to emit notices on connect:', err.message);
    });

    emitLiveGameCounts(socket).catch((err) => {
      console.error('[SOCKET] Failed to emit live game counts on connect:', err.message);
    });

    emitPendingRejoinGame(io, socket, 'connect').catch((err) => {
      console.error('[SOCKET] Failed to emit pending rejoin game on connect:', err.message);
    });

    if (typeof socket.use === 'function') {
      socket.use(async (packet, next) => {
        try {
          const eventName = Array.isArray(packet) ? String(packet[0] || '') : '';
          if (!eventName) return next();
          const sessionState = await validateSocketSessionState(socket);
          if (sessionState.valid) return next();

          const payload = {
            event: 'auth:session_expired',
            server_time: new Date().toISOString(),
            reason: sessionState.reason || 'session_replaced_or_expired',
            message: 'Your session has expired or was logged in on another device. Please login again.',
          };
          socket.emit('auth:session_expired', payload);
          return socket.disconnect(true);
        } catch (err) {
          console.error(`[SOCKET] Packet auth guard failed uid=${socket?.user?.id}:`, err.message);
          return next(err);
        }
      });
    }

    socket.on('client:telemetry:ack', async (payload = {}, callback = () => { }) => {
      try {
        const result = await handleClientTelemetryAck(socket, payload);
        callback(result);
      } catch (err) {
        callback({ success: false, message: err.message, server_time: new Date().toISOString() });
      }
    });

    // Lightweight RTT probe for client socket-health indicator (no DB, no session read).
    socket.on('socket:ping', (payload = {}, callback = () => { }) => {
      callback({
        success: true,
        server_time: new Date().toISOString(),
        socket_id: socket.id,
      });
    });

    socket.on('notice:get', async (payload = {}, callback = () => { }) => {
      try {
        const response = await emitActiveNotices(socket);
        callback({ success: true, ...response });
      } catch (err) {
        callback({ success: false, message: err.message });
      }
    });

    socket.on('rejoin_pending_game:get', async (payload = {}, callback = () => { }) => {
      try {
        const response = await emitPendingRejoinGame(io, socket, 'request');
        callback({ success: true, ...response });
      } catch (err) {
        callback({ success: false, message: err.message });
      }
    });

    socket.on('scoreboard:get', async (payload = {}, callback = () => { }) => {
      try {
        const sessionRef = payload.session_id || payload.session_code;
        if (!sessionRef) {
          throw new Error('session_id is required');
        }

        const numericSessionId = Number(sessionRef);
        const lookupSessionRef = Number.isNaN(numericSessionId) ? sessionRef : numericSessionId;
        const session = await gameplayService.getSessionState(lookupSessionRef);
        if (!session) {
          throw new Error('Session not found');
        }

        const isMember = (session.players || []).some(
          (player) => Number(player.user_id) === Number(socket.user.id)
        );
        if (!isMember) {
          throw new Error('Not a session member');
        }

        callback({
          success: true,
          scoreboard: buildScoreboardPayload(session),
        });
      } catch (err) {
        callback({ success: false, message: err.message });
      }
    });

    socket.on('session:join', async (payload = {}, callback = () => { }) => {
      try {
        const sessionRef = payload.session_id || payload.session_code;
        if (!sessionRef) {
          throw new Error('session_id or session_code is required');
        }

        const numericSessionId = Number(sessionRef);
        const lookupSessionRef = Number.isNaN(numericSessionId) ? sessionRef : numericSessionId;

        const session = await gameplayService.joinSession({
          sessionIdOrCode: lookupSessionRef,
          userId: socket.user.id,
        });

        const { liveSession } = await attachSocketToSession(io, socket, session, {
          presenceReason: 'session_join',
          startPregameIfReady: true,
        });
        const joinedPlayer = (liveSession?.players || []).find(
          (player) => Number(player.user_id) === Number(socket.user.id)
        );
        const canBroadcastActive = joinedPlayer
          && !['eliminated', 'left'].includes(String(joinedPlayer.status || '').toLowerCase())
          && joinedPlayer?.metadata?.is_dropped !== true
          && String(joinedPlayer?.metadata?.drop_status || '').toLowerCase() !== 'dropped';
        if (canBroadcastActive) {
          console.log('joinedPlayer broadcast', joinedPlayer);
          emitPlayerStatusOverride(io, liveSession, joinedPlayer, {
            status: 'joined',
            player_status: 'active',
            connection_status: 'connected',
            metadata: {
              connection_status: 'connected',
              is_connected: true,
              rejoined_via: 'session_join',
              rejoined_at: new Date().toISOString(),
            },
          }, 'player_rejoined_table');
        }
        console.log(`[SOCKET] uid=${socket.user.id} joined session=${session.id} status=${session.status}`);

        const joinAckBase = await gameplayService.getSessionState(liveSession.id);
        const joinAckSession = enrichSessionDistributionWithGroupingSnapshots(
          joinAckBase || liveSession
        );
        callback({ success: true, session: buildJoinAckSessionPayload(joinAckSession) });
      } catch (err) {
        console.warn(`[SOCKET] uid=${socket.user.id} session:join failed:`, err.message);
        callback({ success: false, message: err.message });
      }
    });

    socket.on('session:watch', async (payload = {}, callback = () => { }) => {
      try {
        const sessionRef = payload.session_id || payload.session_code;
        if (!sessionRef) {
          throw new Error('session_id or session_code is required');
        }

        const numericSessionId = Number(sessionRef);
        const session = await gameplayService.getSessionState(
          Number.isNaN(numericSessionId) ? sessionRef : numericSessionId
        );
        if (!session) {
          throw new Error('Session not found');
        }

        const { liveSession } = await attachSocketToSession(io, socket, session, {
          presenceReason: 'session_watch',
          startPregameIfReady: false,
        });
        callback({ success: true, session: liveSession });
      } catch (err) {
        callback({ success: false, message: err.message });
      }
    });

    socket.on('session:refresh', async (payload = {}, callback = () => { }) => {
      const cb = typeof callback === 'function' ? callback : () => {};
      const serverTime = () => new Date().toISOString();
      try {
        const userId = Number(socket?.user?.id);
        if (Number.isNaN(userId)) {
          return cb({
            success: false,
            message: 'Unauthorized',
            code: 'UNAUTHORIZED',
            server_time: serverTime(),
          });
        }

        const sessionRef = payload.session_id || payload.session_code;
        if (!sessionRef) {
          return cb({
            success: false,
            message: 'session_id or session_code is required',
            code: 'INVALID_PAYLOAD',
            server_time: serverTime(),
          });
        }

        const numericSessionId = Number(sessionRef);
        const lookupRef = Number.isNaN(numericSessionId) ? sessionRef : numericSessionId;

        const session = await gameplayService.getSessionState(lookupRef);
        if (!session) {
          return cb({
            success: false,
            message: 'Session not found',
            code: 'SESSION_NOT_FOUND',
            server_time: serverTime(),
          });
        }

        const player = (Array.isArray(session.players) ? session.players : []).find(
          (p) => Number(p.user_id) === userId
        );
        if (!player) {
          return cb({
            success: false,
            message: 'Player not in session',
            code: 'NOT_IN_SESSION',
            server_time: serverTime(),
          });
        }

        if (!gameplayService.userAllowedToAccessSessionMetadata(session.metadata, userId)) {
          return cb({
            success: false,
            message: 'Session is reserved for another table',
            code: 'SESSION_ACCESS_DENIED',
            server_time: serverTime(),
          });
        }

        const SESSION_REFRESH_RL_WINDOW_MS = 60_000;
        const SESSION_REFRESH_RL_MAX = 45;
        const now = Date.now();
        if (!Array.isArray(socket.data.sessionRefreshTimestamps)) {
          socket.data.sessionRefreshTimestamps = [];
        }
        socket.data.sessionRefreshTimestamps = socket.data.sessionRefreshTimestamps.filter(
          (t) => now - t < SESSION_REFRESH_RL_WINDOW_MS
        );
        if (socket.data.sessionRefreshTimestamps.length >= SESSION_REFRESH_RL_MAX) {
          return cb({
            success: false,
            message: 'Too many refresh requests. Try again shortly.',
            code: 'RATE_LIMITED',
            server_time: serverTime(),
          });
        }
        socket.data.sessionRefreshTimestamps.push(now);

        const status = String(session.status || '').toLowerCase();
        const joinable = ['waiting', 'ready', 'active'].includes(status);
        const ts = serverTime();

        if (!joinable) {
          return cb({
            success: true,
            session,
            server_time: ts,
            attached: false,
            phase: null,
            sync_event: null,
          });
        }

        // Multi-table: do not detach other live game-session rooms on refresh.
        const startPregameIfReady = status === 'ready';
        const { liveSession } = await attachSocketToSession(io, socket, session, {
          presenceReason: 'session_refresh',
          startPregameIfReady,
        });

        const phaseSync = syncSocketToSessionPhase(socket, liveSession, 'session_refresh');
        const refreshed = await gameplayService.getSessionState(liveSession.id);
        const ackSession = enrichSessionDistributionWithGroupingSnapshots(
          refreshed || liveSession
        );

        const joinedPlayer = (ackSession?.players || []).find(
          (p) => Number(p.user_id) === userId
        );
        const timeoutEliminatedSet = getTimeoutEliminatedUserIdSet(ackSession?.metadata || {});
        const turnEliminatedSet = getTurnEliminatedUserIdSet(ackSession?.metadata || {});
        const canBroadcastActive = joinedPlayer
          && !['eliminated', 'left'].includes(String(joinedPlayer.status || '').toLowerCase())
          && joinedPlayer?.metadata?.is_dropped !== true
          && String(joinedPlayer?.metadata?.drop_status || '').toLowerCase() !== 'dropped'
          && !timeoutEliminatedSet.has(userId)
          && !turnEliminatedSet.has(userId);
        if (canBroadcastActive) {
          emitPlayerStatusOverride(io, ackSession, joinedPlayer, {
            status: 'joined',
            player_status: 'active',
            connection_status: 'connected',
            metadata: {
              connection_status: 'connected',
              is_connected: true,
              rejoined_via: 'session_refresh',
              rejoined_at: new Date().toISOString(),
            },
          }, 'player_rejoined_table');
        }

        cb({
          success: true,
          session: ackSession,
          server_time: ts,
          attached: true,
          phase: phaseSync.phase,
          sync_event: phaseSync.event,
        });
      } catch (err) {
        console.warn(`[SOCKET] uid=${socket?.user?.id} session:refresh failed:`, err.message);
        cb({
          success: false,
          message: err.message,
          code: err.code || 'REFRESH_FAILED',
          server_time: serverTime(),
        });
      }
    });

    socket.on('player:ready', async (payload = {}, callback = () => { }) => {
      try {
        const sessionId = Number(payload.session_id);
        if (Number.isNaN(sessionId)) {
          throw new Error('Valid session_id is required');
        }

        const session = await gameplayService.markPlayerReady({
          sessionId,
          userId: socket.user.id,
          ready: typeof payload.ready === 'boolean' ? payload.ready : true,
        });

        await emitSessionState(io, session.id);
        callback({ success: true, session });
      } catch (err) {
        callback({ success: false, message: err.message });
      }
    });

    socket.on('player:autogroup', async (payload = {}, callback = () => { }) => {
      try {
        const sessionId = Number(payload.session_id);
        if (Number.isNaN(sessionId)) {
          throw new Error('Valid session_id is required');
        }

        const session = await gameplayService.getSessionState(sessionId);
        if (!session) {
          throw new Error('Session not found');
        }

        const player = session.players?.find((p) => p.user_id === socket.user.id);
        if (!player) {
          throw new Error('Player not found in session');
        }
        if (session.status !== 'active') {
          throw new Error('Session is not active');
        }

        const distribution = session.metadata?.distribution;
        if (!distribution) {
          throw new Error('Card distribution not found');
        }

        const playerDistribution = distribution.players?.find((pd) => pd.user_id === socket.user.id);
        if (!playerDistribution) {
          throw new Error('Player cards not found in distribution');
        }

        const freshSession = await gameplayService.getSessionState(sessionId);
        const freshDistribution = freshSession?.metadata?.distribution;
        const freshPlayerDistribution = freshDistribution?.players?.find(
          (pd) => pd.user_id === socket.user.id
        );
        const playerCards = freshPlayerDistribution?.cards || playerDistribution.cards || [];
        const wildJoker = freshDistribution?.wild_joker || distribution.wild_joker || null;
        const turnIdForSeed = Number(freshSession?.metadata?.turn?.turn_id) || 0;
        const decisionSeed = buildDecisionSeed(sessionId, turnIdForSeed, socket.user.id);
        const groupingOptions = buildGroupingTieBreakOptions(decisionSeed);
        const bestGrouping = groupingService.buildBestGrouping(playerCards, wildJoker, groupingOptions);
        const newSubmittedGroups = toSubmittedGroupsFromGrouping(bestGrouping);
        const evaluatedGrouping = groupingService.evaluateSubmittedGrouping(
          playerCards,
          wildJoker,
          newSubmittedGroups
        );
        const finishPlan = tryBuildFinishPlan(playerCards, wildJoker, {
          submittedGroups: newSubmittedGroups,
          groupingOptions,
          tieBreakSeed: decisionSeed,
          sessionId,
          userId: socket.user.id,
          turnId: turnIdForSeed,
        });

        const autoPdIndex = (freshDistribution?.players || distribution.players).findIndex(
          (pd) => pd.user_id === socket.user.id
        );
        const autoUpdatedPlayers = (freshDistribution?.players || distribution.players).map((pd, i) =>
          i === autoPdIndex
            ? { ...pd, submitted_groups: newSubmittedGroups, auto_best_group: true }
            : pd
        );

        await gameSessionModel.updateSessionStatus(sessionId, freshSession?.status || session.status, {
          currentTurnUserId: freshSession?.current_turn_user_id || session.current_turn_user_id,
          metadata: {
            ...(freshSession?.metadata || session.metadata),
            distribution: {
              ...(freshDistribution || distribution),
              players: autoUpdatedPlayers,
            },
            phase_updated_at: new Date().toISOString(),
          },
        });
        callback({
          success: true,
          data: {
            ...buildFinishPlanCallbackExtras(finishPlan),
            cards_count: playerCards.length,
            ...buildGroupingResponseData(evaluatedGrouping),
            finish_card_suggestion: finishPlan?.finishCard || null,
            finish_plan: finishPlan
              ? {
                finish_card: finishPlan.finishCard,
                submitted_groups: finishPlan.submittedGroups,
                valid_for_declare_after_finish: finishPlan?.preview?.summary?.valid_for_declare === true,
              }
              : null,
          },
        });
      } catch (err) {
        callback({ success: false, message: err.message });
      }
    });

    socket.on('player:group:update', async (payload = {}, callback = () => { }) => {
      try {
        const sessionId = Number(payload.session_id);
        if (Number.isNaN(sessionId)) {
          throw new Error('Valid session_id is required');
        }

        const session = await gameplayService.getSessionState(sessionId);
        if (!session) {
          throw new Error('Session not found');
        }
        if (session.status !== 'active') {
          throw new Error('Session is not active');
        }

        const distribution = session.metadata?.distribution;
        if (!distribution) {
          throw new Error('Card distribution not found');
        }

        const playerDistribution = getPlayerDistribution(distribution, socket.user.id);
        if (!playerDistribution) {
          throw new Error('Player cards not found in distribution');
        }

        const cardUid = String(payload.card_uid || '').trim();
        if (!cardUid) {
          throw new Error('card_uid is required');
        }

        const toGroupId = Number(payload.to_group_id);
        if (Number.isNaN(toGroupId) || toGroupId < 1) {
          throw new Error('Valid to_group_id is required');
        }

        const requestedPositionRaw = payload.position ?? payload.to_position ?? payload.card_position;
        const requestedPosition = normalizeCardPosition(requestedPositionRaw);

        const handCards = playerDistribution.cards || [];
        if (!handCards.some((c) => c.card_uid === cardUid)) {
          throw new Error('Card not found in your hand');
        }

        const wildJoker = distribution.wild_joker || null;
        const storedGroups = Array.isArray(playerDistribution.submitted_groups)
          ? playerDistribution.submitted_groups
          : [];

        // Remove card from its current group
        const groupsWithoutCard = storedGroups
          .map((g) => ({ ...g, cards: g.cards.filter((uid) => uid !== cardUid) }))
          .filter((g) => g.cards.length > 0);

        // Add card to the target group (create it if needed, then reindex)
        const targetExists = groupsWithoutCard.some((g) => g.group_id === toGroupId);
        let updatedMoveGroups;
        if (targetExists) {
          updatedMoveGroups = groupsWithoutCard.map((g) =>
            g.group_id === toGroupId
              ? { ...g, cards: insertCardIntoGroupCards(g.cards, cardUid, requestedPosition) }
              : g
          );
        } else {
          updatedMoveGroups = reindexSubmittedGroups([
            ...groupsWithoutCard,
            { group_id: toGroupId, cards: [cardUid] },
          ]);
        }

        const playerIndex = distribution.players.findIndex((pd) => pd.user_id === socket.user.id);
        const moveUpdatedPlayers = distribution.players.map((pd, i) =>
          i === playerIndex ? { ...pd, submitted_groups: updatedMoveGroups } : pd
        );

        await gameSessionModel.updateSessionStatus(sessionId, session.status, {
          currentTurnUserId: session.current_turn_user_id,
          metadata: {
            ...session.metadata,
            distribution: { ...distribution, players: moveUpdatedPlayers },
            phase_updated_at: new Date().toISOString(),
          },
        });

        const { grouping } = resolveGroupingSnapshot(handCards, wildJoker, updatedMoveGroups);
        const finishPlan = resolveFinishPlanForPlayerHand(
          handCards,
          wildJoker,
          updatedMoveGroups,
          sessionId,
          socket.user.id,
          session?.metadata?.turn?.turn_id
        );
        console.log("[SOCKET] player:group:update:", grouping.groups);
        callback({
          success: true,
          data: {
            ...buildGroupingResponseData(grouping),
            ...buildFinishPlanCallbackExtras(finishPlan),
          },
        });
      } catch (err) {
        callback({ success: false, message: err.message });
      }
    });

    socket.on('player:group:create', async (payload = {}, callback = () => { }) => {
      try {
        const sessionId = Number(payload.session_id);
        if (Number.isNaN(sessionId)) {
          throw new Error('Valid session_id is required');
        }

        const rawCardUids = Array.isArray(payload.card_uids) ? payload.card_uids : [];
        if (rawCardUids.length === 0) {
          throw new Error('card_uids must be a non-empty array');
        }

        const cardUids = rawCardUids
          .map((uid) => String(uid || '').trim())
          .filter(Boolean);
        if (cardUids.length === 0) {
          throw new Error('card_uids must contain at least one valid card UID');
        }

        const uniqueCardUids = [...new Set(cardUids)];
        if (uniqueCardUids.length !== cardUids.length) {
          throw new Error('Duplicate card_uids are not allowed');
        }

        const session = await gameplayService.getSessionState(sessionId);
        if (!session) {
          throw new Error('Session not found');
        }
        if (session.status !== 'active') {
          throw new Error('Session is not active');
        }

        const distribution = session.metadata?.distribution;
        if (!distribution) {
          throw new Error('Card distribution not found');
        }

        const playerDistribution = getPlayerDistribution(distribution, socket.user.id);
        if (!playerDistribution) {
          throw new Error('Player cards not found in distribution');
        }

        const handCards = playerDistribution.cards || [];
        const handCardIds = new Set(handCards.map((card) => card.card_uid));
        uniqueCardUids.forEach((cardUid) => {
          if (!handCardIds.has(cardUid)) {
            throw new Error(`Card ${cardUid} not found in your hand`);
          }
        });

        const wildJoker = distribution.wild_joker || null;
        const storedGroups = Array.isArray(playerDistribution.submitted_groups)
          ? playerDistribution.submitted_groups
          : [];

        const selectedCardSet = new Set(uniqueCardUids);
        const groupsWithoutSelectedCards = storedGroups
          .map((group) => ({
            ...group,
            cards: (Array.isArray(group?.cards) ? group.cards : []).filter((uid) => !selectedCardSet.has(uid)),
          }))
          .filter((group) => group.cards.length > 0);

        const updatedCreateGroups = reindexSubmittedGroups([
          ...groupsWithoutSelectedCards,
          {
            group_id: groupsWithoutSelectedCards.length + 1,
            cards: uniqueCardUids,
          },
        ]);

        const playerIndex = distribution.players.findIndex((pd) => pd.user_id === socket.user.id);
        const createUpdatedPlayers = distribution.players.map((pd, i) =>
          i === playerIndex ? { ...pd, submitted_groups: updatedCreateGroups } : pd
        );

        await gameSessionModel.updateSessionStatus(sessionId, session.status, {
          currentTurnUserId: session.current_turn_user_id,
          metadata: {
            ...session.metadata,
            distribution: { ...distribution, players: createUpdatedPlayers },
            phase_updated_at: new Date().toISOString(),
          },
        });

        const { grouping } = resolveGroupingSnapshot(handCards, wildJoker, updatedCreateGroups);
        const finishPlan = resolveFinishPlanForPlayerHand(
          handCards,
          wildJoker,
          updatedCreateGroups,
          sessionId,
          socket.user.id,
          session?.metadata?.turn?.turn_id
        );

        callback({
          success: true,
          data: {
            ...buildGroupingResponseData(grouping),
            ...buildFinishPlanCallbackExtras(finishPlan),
          },
        });
      } catch (err) {
        callback({ success: false, message: err.message });
      }
    });

    socket.on('player:pick', async (payload = {}, callback = () => { }) => {
      try {
        const sessionId = Number(payload.session_id);
        if (Number.isNaN(sessionId)) {
          throw new Error('Valid session_id is required');
        }
        const requestedGroupIdRaw = payload.group_id ?? payload.to_group_id;
        const requestedGroupId = requestedGroupIdRaw == null ? null : Number(requestedGroupIdRaw);
        if (requestedGroupIdRaw != null && (Number.isNaN(requestedGroupId) || requestedGroupId < 1)) {
          throw new Error('Valid group_id is required');
        }

        const requestedPositionRaw = payload.position ?? payload.card_position ?? payload.to_position;
        const requestedPosition = normalizeCardPosition(requestedPositionRaw);

        const source = resolvePickSource(payload.source);
        // Lean load: same validation fields; ACK payload built below unchanged.
        const session = await gameplayService.loadTurnActionSession(sessionId);
        if (!session) {
          throw new Error('Session not found');
        }
        if (session.status !== 'active') {
          throw new Error('Session is not active');
        }

        const player = session.players?.find((p) => p.user_id === socket.user.id);
        if (!player) {
          throw new Error('Player not found in session');
        }
        if (Number(session.current_turn_user_id) !== Number(socket.user.id)) {
          throw new Error('It is not your turn');
        }
        assertTurnStarted(session.metadata?.turn);

        const pickTurnId = turnActionIdempotency.resolveTurnId(session);
        const pickResultKey = turnActionIdempotency.pickResultKey(sessionId, pickTurnId, socket.user.id);
        const priorPickAck = await turnActionIdempotency.getStoredAck(pickResultKey);
        if (priorPickAck) {
          callback(priorPickAck);
          return;
        }

        // Guard: cannot pick twice in the same turn (idempotent replay handled above)
        if (session.metadata?.turn?.has_picked === true) {
          throw new Error('You have already picked a card this turn — discard first');
        }

        const pickLockOwner = `${socket.id}:pick:${Date.now()}`;
        const pickLockKey = turnActionIdempotency.pickLockKey(sessionId, pickTurnId, socket.user.id);
        const pickLockGot = await redisLockService.acquireLock(pickLockKey, pickLockOwner, 20);
        if (!pickLockGot) {
          for (let i = 0; i < 40; i += 1) {
            await new Promise((r) => setTimeout(r, 50));
            const waited = await turnActionIdempotency.getStoredAck(pickResultKey);
            if (waited) {
              callback(waited);
              return;
            }
          }
          throw new Error('Pick already in progress — retry shortly');
        }
        try {
        const lockedPickAck = await turnActionIdempotency.getStoredAck(pickResultKey);
        if (lockedPickAck) {
          callback(lockedPickAck);
          return;
        }
        // Lightweight race check — Redis live row only (no players/events/game join).
        const liveAfterLock = await gameSessionModel.findSessionById(sessionId);
        if (liveAfterLock?.metadata?.turn?.has_picked === true) {
          const raced = await turnActionIdempotency.getStoredAck(pickResultKey);
          if (raced) {
            callback(raced);
            return;
          }
          throw new Error('You have already picked a card this turn — discard first');
        }

        const distribution = session.metadata?.distribution;
        if (!distribution) {
          throw new Error('Card distribution not found');
        }

        const playersDistribution = Array.isArray(distribution.players) ? [...distribution.players] : [];
        const playerIndex = playersDistribution.findIndex((pd) => pd.user_id === socket.user.id);
        if (playerIndex < 0) {
          throw new Error('Player cards not found in distribution');
        }

        const playerDistribution = {
          ...playersDistribution[playerIndex],
          cards: [...(playersDistribution[playerIndex].cards || [])],
          has_picked: true, // Mark that this player has picked at least once
        };

        let pickedCard = null;
        let discardPile = [...(distribution.discard_pile || [])];
        let closedDeck = [...(distribution.closed_deck || [])];
        let reshufflePayload = null;

        if (source === 'discard') {
          if (discardPile.length === 0) {
            warnGame(sessionId, `Player pick failed — discard pile empty uid=${socket.user.id}`);
            throw new Error('Discard pile is empty');
          }
          const discardTop = discardPile[0] || null;
          const wildJoker = distribution.wild_joker || null;
          const topIsJoker = isJokerCard(discardTop, wildJoker);
          if (topIsJoker && !canPickDiscardJokerInCurrentTurn(session)) {
            throw new Error('Discard top joker can be picked only on the first turn');
          }
          pickedCard = discardPile.shift();
        } else {
          if (closedDeck.length === 0) {
            logGame(
              sessionId,
              `Player pick found closed deck empty — uid=${socket.user.id} discardCount=${discardPile.length}. Attempting reshuffle.`
            );

            const reshuffle = reshuffleClosedDeck(distribution);
            if (!reshuffle.changed) {
              warnGame(
                sessionId,
                `Player reshuffle unavailable — uid=${socket.user.id} discardCount=${discardPile.length}. No cards available to rebuild closed deck.`
              );
              throw new Error('Closed deck is empty and discard pile cannot be reshuffled');
            }

            discardPile = [...(reshuffle.distribution.discard_pile || [])];
            closedDeck = [...(reshuffle.distribution.closed_deck || [])];
            reshufflePayload = {
              triggered_by_user_id: socket.user.id,
              closed_deck_count: reshuffle.closedDeckCount,
              discard_top: reshuffle.discardTop,
              reshuffled_cards: reshuffle.reshuffledCards,
            };
            logGame(
              sessionId,
              `Player reshuffle successful — uid=${socket.user.id} reshuffledCards=${reshuffle.reshuffledCards} ` +
              `discardTop=${reshuffle.discardTop?.card_uid || 'none'}`
            );
          }
          pickedCard = closedDeck.shift();
        }

        playerDistribution.cards.push(pickedCard);

        const wildJoker = distribution.wild_joker || null;
        const turnIdForSeed = Number(session?.metadata?.turn?.turn_id) || 0;
        const decisionSeed = buildDecisionSeed(sessionId, turnIdForSeed, socket.user.id);
        const groupingOptions = buildGroupingTieBreakOptions(decisionSeed);
        const autoBestGroup = isAutoBestGroupEnabled(playerDistribution);

        let updatedPickGroups;
        let grouping;
        let finishPlan = null;

        if (autoBestGroup) {
          // Yield before the heavy buildBestGrouping DFS so queued ACKs/pings
          // from other sessions can run and avoid event-loop lag spikes.
          await yieldToEventLoop();
          // Auto-best already uses fastFinishPlan (no multi-card scan).
          const autoResult = buildAutoBestGroupingResult(playerDistribution.cards, wildJoker, {
            groupingOptions,
            tieBreakSeed: decisionSeed,
            sessionId,
            userId: socket.user.id,
            turnId: turnIdForSeed,
            fastFinishPlan: true,
          });
          updatedPickGroups = autoResult.submittedGroups;
          grouping = autoResult.grouping;
          finishPlan = autoResult.finishPlan;
        } else {
          const storedPickGroups = Array.isArray(playerDistribution.submitted_groups)
            ? playerDistribution.submitted_groups
            : [];
          updatedPickGroups = appendCardToSpecifiedGroupOrLast(
            storedPickGroups,
            pickedCard.card_uid,
            requestedGroupId,
            requestedPosition
          );
          ({ grouping } = resolveGroupingSnapshot(
            playerDistribution.cards,
            wildJoker,
            updatedPickGroups
          ));
        }

        playerDistribution.submitted_groups = updatedPickGroups;
        playersDistribution[playerIndex] = playerDistribution;

        const nextMetadata = {
          ...(session.metadata || {}),
          distribution: {
            ...distribution,
            players: playersDistribution,
            discard_pile: discardPile,
            closed_deck: closedDeck,
            closed_deck_count: closedDeck.length,
          },
          // Mark that we've picked this turn so discard handler can validate order
          turn: {
            ...(session.metadata?.turn || {}),
            has_picked: true,
            picked_card_uid: pickedCard.card_uid,
          },
          phase_updated_at: new Date().toISOString(),
        };

        // Persist move first so cluster peers see has_picked before finish-hint CPU.
        // discard_history picked markers are updated non-blocking after ACK below.
        await gameSessionModel.updateSessionStatus(sessionId, session.status, {
          currentTurnUserId: session.current_turn_user_id,
          metadata: nextMetadata,
        });

        // Non-blocking audit trail — must not delay pick ACK.
        gameSessionModel.insertEvent({
          sessionId,
          userId: socket.user.id,
          eventType: 'player_pick',
          payload: {
            source,
            card_uid: pickedCard.card_uid,
            card_id: pickedCard.card_id,
          },
        }).catch(() => {});

        // Human finish hint stays on ACK (Flutter finish suggestion). Keep scan budget small.
        if (!autoBestGroup) {
          finishPlan = tryBuildFinishPlanFromSubmittedGroups(playerDistribution.cards, wildJoker, {
            submittedGroups: updatedPickGroups,
            groupingOptions,
            tieBreakSeed: decisionSeed,
            sessionId,
            userId: socket.user.id,
            turnId: turnIdForSeed,
            earlyExit: true,
            maxCandidates: PICK_ACK_FINISH_PLAN_MAX_CANDIDATES,
          });
        }

        const pickAck = {
          success: true,
          data: {
            source,
            picked_card: pickedCard,
            cards_count: playerDistribution.cards.length,
            closed_deck_count: closedDeck.length,
            discard_top: discardPile[0] || null,
            deck_reshuffled: Boolean(reshufflePayload),
            ...buildFinishPlanCallbackExtras(finishPlan),
            ...buildGroupingResponseData(grouping),
          },
        };
        callback(pickAck);
        await turnActionIdempotency.storeAck(pickResultKey, { ...pickAck, idempotent_replay: true });

        if (reshufflePayload) {
          emitDeckReshuffled(io, sessionId, reshufflePayload);
        }

        logGame(sessionId, `Pick — uid=${socket.user.id} source=${source} card=${pickedCard.card_uid} closedLeft=${closedDeck.length}`);

        io.to(sessionRoom(sessionId)).emit('game:pick', {
          session_id: sessionId,
          server_time: new Date().toISOString(),
          event: 'game:pick',
          user_id: socket.user.id,
          source,
          picked_card: pickedCard,
          closed_deck_count: closedDeck.length,
          discard_top: discardPile[0] || null,
        });

        // Update discard_history picked marker non-blocking after ACK,
        // so the UI/audit timeline stays correct without delaying the pick response.
        if (source === 'discard') {
          setImmediate(() => {
            gameSessionModel.findSessionById(sessionId)
              .then((liveRow) => {
                if (!liveRow) return;
                const livePickedUpdate = markDiscardHistoryPicked(
                  liveRow.metadata || {},
                  liveRow.metadata?.distribution || null,
                  {
                    picked_card: pickedCard,
                    picked_by_user_id: socket.user.id,
                    picked_at: new Date().toISOString(),
                  }
                );
                if (!livePickedUpdate.changed) return;
                const patchedMetadata = {
                  ...(liveRow.metadata || {}),
                  discard_history: livePickedUpdate.discardHistory,
                };
                return gameSessionModel.updateSessionStatus(sessionId, liveRow.status, {
                  currentTurnUserId: liveRow.current_turn_user_id,
                  metadata: patchedMetadata,
                }).then(() => {
                  emitDiscardHistoryUpdate(io, { ...liveRow, metadata: patchedMetadata }, {
                    reason: 'player_pick_discard',
                    latest: livePickedUpdate.latestEntry,
                  });
                });
              })
              .catch(() => {});
          });
        }
        } finally {
          await redisLockService.releaseLock(pickLockKey, pickLockOwner);
        }
      } catch (err) {
        callback({ success: false, message: err.message });
      }
    });

    socket.on('player:discard', async (payload = {}, callback = () => { }) => {
      try {
        const sessionId = Number(payload.session_id);
        if (Number.isNaN(sessionId)) {
          throw new Error('Valid session_id is required');
        }

        const cardUid = String(payload.card_uid || '').trim();
        if (!cardUid) {
          throw new Error('card_uid is required');
        }

        const session = await gameplayService.loadTurnActionSession(sessionId);
        if (!session) {
          throw new Error('Session not found');
        }
        if (session.status !== 'active') {
          throw new Error('Session is not active');
        }

        const player = session.players?.find((p) => p.user_id === socket.user.id);
        if (!player) {
          throw new Error('Player not found in session');
        }
        if (Number(session.current_turn_user_id) !== Number(socket.user.id)) {
          throw new Error('It is not your turn');
        }
        assertTurnStarted(session.metadata?.turn);

        const discardTurnId = turnActionIdempotency.resolveTurnId(session);
        const discardResultKey = turnActionIdempotency.discardResultKey(sessionId, discardTurnId, socket.user.id);
        const priorDiscardAck = await turnActionIdempotency.getStoredAck(discardResultKey);
        if (priorDiscardAck) {
          callback(priorDiscardAck);
          return;
        }

        // Guard: must pick before discarding
        if (session.metadata?.turn?.has_picked !== true) {
          throw new Error('You must pick a card before discarding');
        }

        const discardLockOwner = `${socket.id}:discard:${Date.now()}`;
        const discardLockKey = turnActionIdempotency.discardLockKey(sessionId, discardTurnId, socket.user.id);
        const discardLockGot = await redisLockService.acquireLock(discardLockKey, discardLockOwner, 20);
        if (!discardLockGot) {
          for (let i = 0; i < 40; i += 1) {
            await new Promise((r) => setTimeout(r, 50));
            const waited = await turnActionIdempotency.getStoredAck(discardResultKey);
            if (waited) {
              callback(waited);
              return;
            }
          }
          throw new Error('Discard already in progress — retry shortly');
        }
        try {
        const lockedDiscardAck = await turnActionIdempotency.getStoredAck(discardResultKey);
        if (lockedDiscardAck) {
          callback(lockedDiscardAck);
          return;
        }

        const distribution = session.metadata?.distribution;
        if (!distribution) {
          throw new Error('Card distribution not found');
        }

        const playersDistribution = Array.isArray(distribution.players) ? [...distribution.players] : [];
        const playerIndex = playersDistribution.findIndex((pd) => pd.user_id === socket.user.id);
        if (playerIndex < 0) {
          throw new Error('Player cards not found in distribution');
        }

        const playerDistribution = {
          ...playersDistribution[playerIndex],
          cards: [...(playersDistribution[playerIndex].cards || [])],
        };

        const cardIndex = playerDistribution.cards.findIndex((c) => c.card_uid === cardUid);
        if (cardIndex < 0) {
          throw new Error('Card not found in your hand');
        }

        const [discardedCard] = playerDistribution.cards.splice(cardIndex, 1);
        const discardPile = [discardedCard, ...(distribution.discard_pile || [])];

        const wildJoker = distribution.wild_joker || null;
        const storedDiscardGroups = Array.isArray(playerDistribution.submitted_groups)
          ? playerDistribution.submitted_groups
          : [];
        const updatedDiscardGroups = removeCardFromGroups(storedDiscardGroups, cardUid);
        playerDistribution.submitted_groups = updatedDiscardGroups;
        playersDistribution[playerIndex] = playerDistribution;

        const { grouping } = resolveGroupingSnapshot(
          playerDistribution.cards,
          wildJoker,
          updatedDiscardGroups
        );

        const nextTurnUser = nextTurnUserId(getActivePlayers(session), socket.user.id);
        const turnTimerSeconds = resolveNormalTurnTimerSeconds(session, 30);
        const nextTurnWindow = buildTurnWindow(turnTimerSeconds);
        const previousTurnId = Number(session.metadata?.turn?.turn_id) || Date.now();
        const maxBonusAttempts = getMaxBonusAttempts(session);
        const attemptsUsedByUser = normalizeAttemptsUsedByUser(session.metadata || {});
        const nextTurn = buildTurnPayload({
          session,
          userId: nextTurnUser,
          turnId: previousTurnId + 1,
          type: 'normal',
          attemptNo: 0,
          attemptsUsedCount: Number(attemptsUsedByUser[String(nextTurnUser)]) || 0,
          startedAt: nextTurnWindow.startedAt,
          endsAt: nextTurnWindow.endsAt,
          turnTimerSeconds,
          hasPicked: false,
        });

        const playersAfterDepartingTurn = markDepartingPlayerFirstTurnCycleComplete(
          playersDistribution,
          socket.user.id
        );

        const nextMetadata = {
          ...(session.metadata || {}),
          distribution: {
            ...distribution,
            players: playersAfterDepartingTurn,
            discard_pile: discardPile,
          },
          turn: nextTurn,
          turn_bonus: {
            max_attempts_per_player: maxBonusAttempts,
            attempts_used_by_user: attemptsUsedByUser,
          },
          phase_updated_at: new Date().toISOString(),
        };

        const playerDiscardHistoryAppend = appendDiscardHistoryEntry(nextMetadata, nextMetadata.distribution, {
          discarded_card: discardedCard,
          discarded_by_user_id: socket.user.id,
          discarded_at: new Date().toISOString(),
          turn_id: previousTurnId,
        });
        nextMetadata.discard_history = playerDiscardHistoryAppend.discardHistory;

        await gameSessionModel.updateSessionStatus(sessionId, session.status, {
          currentTurnUserId: nextTurnUser,
          metadata: nextMetadata,
        });

        gameSessionModel.insertEvent({
          sessionId,
          userId: socket.user.id,
          eventType: 'player_discard',
          payload: {
            card_uid: discardedCard.card_uid,
            card_id: discardedCard.card_id,
            next_turn_user_id: nextTurnUser,
          },
        }).catch(() => {});

        const discardAck = {
          success: true,
          data: {
            discarded_card: discardedCard,
            cards_count: playerDistribution.cards.length,
            discard_top: discardPile[0],
            turn: nextTurn,
            ...buildGroupingResponseData(grouping),
          },
        };
        // ACK first with the exact client payload; persist idempotent copy before unlock.
        callback(discardAck);
        await turnActionIdempotency.storeAck(discardResultKey, { ...discardAck, idempotent_replay: true });

        logGame(sessionId, `Discard — uid=${socket.user.id} card=${discardedCard.card_uid} → next=uid:${nextTurnUser} timer=${turnTimerSeconds}s`);

        emitTurn(io, sessionId, nextTurn, {
          action: 'discard',
          previous_turn_user_id: socket.user.id,
          previous_turn_id: previousTurnId,
          discarded_card: discardedCard,
          discard_top: discardPile[0],
          player_deal_flags: buildPlayerDealFlags(playersAfterDepartingTurn),
          distribution: nextMetadata.distribution,
        });

        emitDiscardHistoryUpdate(io, {
          ...session,
          metadata: nextMetadata,
        }, {
          reason: 'player_discard',
          latest: playerDiscardHistoryAppend.latestEntry,
        });

        scheduleTurnTimeout(io, sessionId, nextTurn);
        } finally {
          await redisLockService.releaseLock(discardLockKey, discardLockOwner);
        }
      } catch (err) {
        callback({ success: false, message: err.message });
      }
    });

    socket.on('player:declare', async (payload = {}, callback = () => { }) => {
      try {
        const sessionId = Number(payload.session_id);
        if (Number.isNaN(sessionId)) {
          throw new Error('Valid session_id is required');
        }

        if (activeDeclareBySession.has(sessionId)) {
          throw new Error('Declaration window already active');
        }

        const session = await gameplayService.getSessionState(sessionId);
        if (!session) {
          throw new Error('Session not found');
        }
        if (session.status !== 'active') {
          throw new Error('Session is not active');
        }
        if (Number(session.current_turn_user_id) !== Number(socket.user.id)) {
          throw new Error('It is not your turn');
        }

        const distribution = session.metadata?.distribution;
        if (!distribution) {
          throw new Error('Card distribution not found');
        }

        const playerDistribution = getPlayerDistribution(distribution, socket.user.id);
        if (!playerDistribution) {
          throw new Error('Player cards not found in distribution');
        }

        const finishCardUid = String(payload.card_uid || payload.finish_card_uid || '').trim();
        if (finishCardUid) {
          if (session.metadata?.turn?.has_picked !== true) {
            throw new Error('Finish is allowed only after picking a card');
          }

          const playerCards = playerDistribution.cards || [];
          const finishCardIndex = playerCards.findIndex((card) => card.card_uid === finishCardUid);
          if (finishCardIndex < 0) {
            throw new Error('Finish card not found in your hand');
          }

          const finishCard = playerCards[finishCardIndex];
          const nextHandCards = [...playerCards];
          nextHandCards.splice(finishCardIndex, 1);

          const baseGroups = Array.isArray(payload.groups)
            ? payload.groups
            : (Array.isArray(playerDistribution.submitted_groups) ? playerDistribution.submitted_groups : []);
          const groupsWithoutFinishCard = removeCardFromGroups(baseGroups, finishCardUid);
          const submittedGroups = resolveSubmittedGroupsInput(
            groupsWithoutFinishCard,
            [],
            nextHandCards
          );

          const wildJoker = distribution.wild_joker || null;
          const preview = groupingService.evaluateSubmittedGrouping(
            nextHandCards,
            wildJoker,
            submittedGroups
          );

          const playerIndex = distribution.players.findIndex((pd) => pd.user_id === socket.user.id);
          const updatedPlayerDistribution = {
            ...playerDistribution,
            cards: nextHandCards,
            submitted_groups: submittedGroups,
          };
          const updatedPlayers = distribution.players.map((pd, index) =>
            index === playerIndex ? updatedPlayerDistribution : pd
          );
          const updatedDistribution = {
            ...distribution,
            players: updatedPlayers,
          };
          const updatedSession = {
            ...session,
            metadata: {
              ...(session.metadata || {}),
              distribution: updatedDistribution,
            },
          };

          logGame(
            sessionId,
            `Finish initiated — uid=${socket.user.id} finish=${finishCardUid} groups=${submittedGroups.length} ` +
            `preview_valid=${preview.summary?.valid_for_declare} ungrouped=${preview.summary?.ungrouped_points}pts`
          );

          const declaration = await startDeclarationWindow(
            updatedSession,
            socket.user.id,
            submittedGroups,
            {
              finishCard,
              distribution: updatedDistribution,
            }
          );
          scheduleBotDeclarationResponses(sessionId);

          callback({
            success: true,
            data: {
              declaration,
              preview,
              finish_card: finishCard,
              cards_count: nextHandCards.length,
              ...buildGroupingResponseData(preview),
            },
          });
          return;
        }

        const submittedGroups = resolveSubmittedGroupsInput(
          payload.groups,
          playerDistribution.submitted_groups,
          playerDistribution.cards || []
        );
        const wildJoker = distribution.wild_joker || null;
        const preview = groupingService.evaluateSubmittedGrouping(
          playerDistribution.cards || [],
          wildJoker,
          submittedGroups
        );

        logGame(
          sessionId,
          `Declare initiated — uid=${socket.user.id} groups=${submittedGroups.length} ` +
          `preview_valid=${preview.summary?.valid_for_declare} ` +
          `ungrouped=${preview.summary?.ungrouped_points}pts`
        );

        const declaration = await startDeclarationWindow(session, socket.user.id, submittedGroups, {
          prefillDeclarerResponse: true,
        });
        scheduleBotDeclarationResponses(sessionId);

        callback({
          success: true,
          data: {
            declaration,
            preview,
          },
        });
      } catch (err) {
        console.warn(`[GAME] player:declare failed uid=${socket.user.id}:`, err.message);
        callback({ success: false, message: err.message });
      }
    });

    socket.on('player:drop', async (payload = {}, callback = () => { }) => {
      try {
        const sessionId = Number(payload.session_id);
        if (Number.isNaN(sessionId)) {
          throw new Error('Valid session_id is required');
        }

        const outcome = await dropPlayerFromSession(io, sessionId, socket.user.id);
        callback({
          success: true,
          data: {
            dropped: true,
            session: outcome.session,
            turn: outcome.turn || null,
            result: outcome.result || null,
          },
        });
      } catch (err) {
        console.warn(`[GAME] player:drop failed uid=${socket.user.id}:`, err.message);
        callback({ success: false, message: err.message });
      }
    });

    socket.on('player:auto_drop:set', async (payload = {}, callback = () => { }) => {
      try {
        const sessionId = Number(payload.session_id);
        if (Number.isNaN(sessionId)) {
          throw new Error('Valid session_id is required');
        }
        const enabled = payload.enabled === true;
        const session = await gameplayService.getSessionState(sessionId);
        if (!session) {
          throw new Error('Session not found');
        }
        if (!isSessionEligibleForAutoDrop(session)) {
          const status = String(session.status || '').toLowerCase();
          if (status === 'completed') {
            throw new Error('Auto-drop cannot be changed after the game has ended');
          }
          throw new Error('Auto-drop can be changed only during active game');
        }
        const player = (session.players || []).find((item) => Number(item.user_id) === Number(socket.user.id));
        if (!player) {
          throw new Error('Player not found in session');
        }
        if (!isPlayerEligibleForAutoDrop(session, player)) {
          throw new Error('Player is no longer eligible for auto-drop');
        }
        const nextMetadata = {
          ...(player.metadata || {}),
          auto_drop_enabled: enabled,
          auto_drop_updated_at: new Date().toISOString(),
        };
        await gameSessionModel.updatePlayerMetadata(sessionId, socket.user.id, nextMetadata);
        await gameSessionModel.insertEvent({
          sessionId,
          userId: socket.user.id,
          eventType: enabled ? 'auto_drop_enabled' : 'auto_drop_disabled',
          payload: {
            enabled,
            user_id: socket.user.id,
          },
        });
        const statePayload = {
          session_id: sessionId,
          server_time: new Date().toISOString(),
          event: 'player:auto_drop:state',
          user_id: socket.user.id,
          enabled,
          updated_at: nextMetadata.auto_drop_updated_at,
        };
        io.to(sessionRoom(sessionId)).emit('player:auto_drop:state', statePayload);

        if (enabled === true && Number(session.current_turn_user_id) === Number(socket.user.id)) {
          const liveSession = await gameplayService.getSessionState(sessionId);
          const turn = liveSession?.metadata?.turn || null;
          if (turn && Number(turn.user_id) === Number(socket.user.id)) {
            maybeScheduleAutoDropAction(io, sessionId, turn).catch((err) => {
              errorGame(sessionId, `Immediate auto-drop execution failed: ${err.message}`);
            });
          }
        }

        callback({
          success: true,
          data: statePayload,
        });
      } catch (err) {
        console.warn(`[GAME] player:auto_drop:set failed uid=${socket.user.id}:`, err.message);
        callback({ success: false, message: err.message });
      }
    });

    socket.on('player:drop_and_switch', async (payload = {}, callback = () => { }) => {
      try {
        const sourceSession = await requireSourceSessionForTransition(payload, socket.user.id);
        const isActiveTwoPlayerExit = sourceSession.status === 'active'
          && Number(sourceSession.max_players) === 2;
        const sourcePlayer = (Array.isArray(sourceSession.players) ? sourceSession.players : [])
          .find((player) => Number(player.user_id) === Number(socket.user.id));
        const leaveFlags = buildTableLeaveSeatFlags(
          sourceSession,
          sourcePlayer || {},
          socket.user.id
        );
        // Switching permanently opts out of pending rejoin on the source table
        // (including 2P finalize, which would otherwise emit a pending-rejoin hint).
        if (typeof gameplayService.markPendingRejoinOptOut === 'function') {
          await gameplayService.markPendingRejoinOptOut({
            sessionId: sourceSession.id,
            userId: socket.user.id,
            reason: 'switched_table',
          });
        }

        let outcome;
        if (isActiveTwoPlayerExit) {
          // Detach from the source room before finalize so this socket does not
          // receive game:result (opponent still does). Client then boots into
          // the new matchmaking session instead of the result overlay.
          // Multi-table: leave only the source room — keep parallel tables.
          leaveSessionRoom(socket, sourceSession.id);
          outcome = await finalizeActiveTwoPlayerExit(
            io,
            sourceSession.id,
            socket.user.id,
            'player_switch_exit'
          );
        } else {
          outcome = leaveFlags.skipRedundantDrop
            ? { session: await gameplayService.getSessionState(sourceSession.id), result: null }
            : await dropPlayerFromSession(io, sourceSession.id, socket.user.id);
        }

        const config = resolveTransitionConfig(payload, sourceSession);
        const targetSession = await gameplayService.createSession({
          gameId: config.gameId,
          contestId: config.contestId,
          hostUserId: socket.user.id,
          maxPlayers: config.maxPlayers,
          metadata: {
            transition_action: 'drop_and_switch',
            transition_source_session_id: sourceSession.id,
          },
        });

        const { liveSession } = await attachSocketToSession(io, socket, targetSession, {
          presenceReason: 'drop_and_switch',
          startPregameIfReady: true,
        });
        leaveSessionRoom(socket, sourceSession.id);
        const phaseSync = syncSocketToSessionPhase(socket, liveSession, 'drop_and_switch');

        callback({
          success: true,
          data: {
            transition_type: 'matchmaking_only',
            source_session_id: sourceSession.id,
            source_session: outcome.session,
            target_session: liveSession,
            phase: phaseSync.phase,
            sync_event: phaseSync.event,
            result: outcome.result || null,
          },
        });
      } catch (err) {
        console.warn(`[GAME] player:drop_and_switch failed uid=${socket.user.id}:`, err.message);
        callback({ success: false, message: err.message });
      }
    });

    const handleTablePlayNow = async (payload = {}, callback = () => { }) => {
      try {
        const hasSource = payload.source_session_id != null || payload.session_id != null;
        const sourceSession = hasSource
          ? await requireSourceSessionForTransition(payload, socket.user.id)
          : null;
        const preferredFirstTurnUserId = Number(sourceSession?.metadata?.result?.winner_user_id);
        if (sourceSession?.id) {
          clearAutoRematchTimer(sourceSession.id);
          if (typeof gameplayService.markPendingRejoinOptOut === 'function') {
            await gameplayService.markPendingRejoinOptOut({
              sessionId: sourceSession.id,
              userId: socket.user.id,
              reason: 'switched_table_play_now',
            });
          }
        }
        const config = resolveTransitionConfig(payload, sourceSession);
        const targetSession = await gameplayService.createSession({
          gameId: config.gameId,
          contestId: config.contestId,
          hostUserId: socket.user.id,
          maxPlayers: config.maxPlayers,
          metadata: {
            transition_action: 'table_play_now',
            ...(sourceSession ? { transition_source_session_id: sourceSession.id } : {}),
          },
        });

        const { liveSession } = await attachSocketToSession(io, socket, targetSession, {
          presenceReason: 'table_play_now',
          // Manual transitions should start pregame whenever the room becomes ready,
          // regardless of auto-rematch mode gating.
          startPregameIfReady: true,
        });
        if (sourceSession?.id) {
          leaveSessionRoom(socket, sourceSession.id);
        }
        const phaseSync = syncSocketToSessionPhase(socket, liveSession, 'table_play_now');

        callback({
          success: true,
          data: {
            transition_type: 'matchmaking_only',
            source_session_id: sourceSession?.id || null,
            target_session: liveSession,
            phase: phaseSync.phase,
            sync_event: phaseSync.event,
          },
        });
        await emitSessionState(io, liveSession.id);
        if (
          sourceSession?.id
          && sourceSession.status === 'completed'
        ) {
          maybeStartRematchFastDeal(io, liveSession.id, {
            preferredFirstTurnUserId: Number.isNaN(preferredFirstTurnUserId) ? null : preferredFirstTurnUserId,
            enforceModeGate: false,
          }).catch((err) => {
            warnGame(liveSession.id, `table:play_again fast rematch start failed: ${err.message}`);
          });
        }
      } catch (err) {
        console.warn(`[GAME] table:play_now failed uid=${socket.user.id}:`, err.message);
        callback({ success: false, message: err.message });
      }
    };
    socket.on('table:play_now', handleTablePlayNow);
    socket.on('table:play_again', handleTablePlayNow);

    socket.on('table:back', async (payload = {}, callback = () => { }) => {
      try {
        const sourceSession = await requireSourceSessionForTransition(payload, socket.user.id);
        const preferredFirstTurnUserId = Number(sourceSession?.metadata?.result?.winner_user_id);
        clearAutoRematchTimer(sourceSession.id);

        // Pool still running + this seat is pool-eliminated: start a fresh table
        // (same contest). Do NOT create reserved rematch against the unfinished source.
        const openFreshMatchmaking = shouldOpenFreshMatchmakingOnTableBack(
          sourceSession,
          socket.user.id
        );

        let targetSession = null;
        let transitionType = 'same_table_continuation';
        let continuationReused = false;
        let fallbackToMatchmaking = false;
        let eligibleUserIds = null;

        if (openFreshMatchmaking) {
          if (typeof gameplayService.markPendingRejoinOptOut === 'function') {
            await gameplayService.markPendingRejoinOptOut({
              sessionId: sourceSession.id,
              userId: socket.user.id,
              reason: 'table_back_fresh_after_pool_elimination',
            });
          }
          // Hard-leave the unfinished pool seat so pending-rejoin / buyback UI
          // does not fight the new matchmaking table.
          if (typeof gameplayService.recordExplicitTableLeave === 'function') {
            try {
              await gameplayService.recordExplicitTableLeave({
                sourceSessionId: sourceSession.id,
                userId: socket.user.id,
                reason: 'table_back_fresh_after_pool_elimination',
                activeSessionExit: true,
              });
            } catch (leaveErr) {
              // Seat may already be left/opted-out; still open the fresh table.
              warnGame(
                sourceSession.id,
                `table:back pool-elim leave skipped uid=${socket.user.id}: ${leaveErr.message}`
              );
            }
          }

          const config = resolveTransitionConfig(payload, sourceSession);
          targetSession = await gameplayService.createSession({
            gameId: config.gameId,
            contestId: config.contestId,
            hostUserId: socket.user.id,
            maxPlayers: config.maxPlayers,
            metadata: {
              transition_action: 'table_back_fresh_after_pool_elimination',
              transition_source_session_id: sourceSession.id,
            },
          });
          transitionType = 'matchmaking_only';
          fallbackToMatchmaking = true;
        } else {
          const continuation = await gameplayService.createOrJoinContinuationSession({
            sourceSessionId: sourceSession.id,
            userId: socket.user.id,
          });

          targetSession = continuation.session;
          continuationReused = continuation.reused === true;
          fallbackToMatchmaking = continuation.fallbackToMatchmaking === true;
          eligibleUserIds = continuation.eligibleUserIds || null;

          if (!targetSession && continuation.fallbackToMatchmaking) {
            const config = resolveTransitionConfig(payload, sourceSession);
            targetSession = await gameplayService.createSession({
              gameId: config.gameId,
              contestId: config.contestId,
              hostUserId: socket.user.id,
              maxPlayers: config.maxPlayers,
              metadata: {
                transition_action: 'table_back_fallback',
                transition_source_session_id: sourceSession.id,
              },
            });
            transitionType = 'same_table_fallback_matchmaking';
          }
        }

        const { liveSession } = await attachSocketToSession(io, socket, targetSession, {
          presenceReason: openFreshMatchmaking
            ? 'table_back_fresh_after_pool_elimination'
            : 'table_back',
          // Manual back-to-table must trigger pregame once all seats are filled.
          startPregameIfReady: true,
        });
        leaveSessionRoom(socket, sourceSession.id);
        const phaseSync = syncSocketToSessionPhase(
          socket,
          liveSession,
          openFreshMatchmaking ? 'table_back_fresh' : 'table_back'
        );

        callback({
          success: true,
          data: {
            transition_type: transitionType,
            source_session_id: sourceSession.id,
            target_session: liveSession,
            phase: phaseSync.phase,
            sync_event: phaseSync.event,
            continuation_reused: continuationReused,
            fallback_to_matchmaking: fallbackToMatchmaking,
            eligible_user_ids: eligibleUserIds,
            fresh_after_pool_elimination: openFreshMatchmaking === true,
          },
        });
        await emitSessionState(io, liveSession.id);

        // Completed rematch: fill bots / start countdown on the target table.
        // Mid-pool eliminated fresh path: also fill — source is not completed, but
        // the new open table still needs seats for 6P contests.
        if (sourceSession.status === 'completed' || openFreshMatchmaking) {
          maybeStartRematchFastDeal(io, liveSession.id, {
            preferredFirstTurnUserId: Number.isNaN(preferredFirstTurnUserId) ? null : preferredFirstTurnUserId,
            enforceModeGate: false,
          }).catch((err) => {
            warnGame(liveSession.id, `table:back fast rematch start failed: ${err.message}`);
          });
        }
      } catch (err) {
        console.warn(`[GAME] table:back failed uid=${socket.user.id}:`, err.message);
        callback({ success: false, message: err.message });
      }
    });

    socket.on('table:leave', async (payload = {}, callback = () => { }) => {
      try {
        const sourceSession = await requireSourceSessionForTransition(payload, socket.user.id);
        const isActiveSession = sourceSession.status === 'active';
        const isReadySession = String(sourceSession.status || '').toLowerCase() === 'ready';
        const isActiveTwoPlayerExit = isActiveSession
          && Number(sourceSession.max_players) === 2;
        // Match-start countdown before entry lock must free-leave (no soft-away / rejoin banner).
        const isPregameFreeLeave = typeof gameplayService.isPregameFreeLeaveEligible === 'function'
          && gameplayService.isPregameFreeLeaveEligible(sourceSession);
        const isSixPlayerSoftExit = Number(sourceSession.max_players) === 6
          && (isActiveSession || isReadySession)
          && !isPregameFreeLeave;
        const sourcePlayer = (Array.isArray(sourceSession.players) ? sourceSession.players : [])
          .find((player) => Number(player.user_id) === Number(socket.user.id));
        const leaveFlags = buildTableLeaveSeatFlags(
          sourceSession,
          sourcePlayer || {},
          socket.user.id
        );
        let updatedSourceSession = null;
        let result = null;
        let softAway = false;
        if (isActiveTwoPlayerExit) {
          // Detach exiting player first so they do not receive game:result from
          // finalize — intentional leave should return to lobby, not the result UI.
          // Multi-table: leave only this table's room.
          leaveSessionRoom(socket, sourceSession.id);
          try {
            const outcome = await finalizeActiveTwoPlayerExit(
              io,
              sourceSession.id,
              socket.user.id,
              'player_left_table_exit'
            );
            updatedSourceSession = outcome.session;
            result = outcome.result || null;
          } catch (finalizeErr) {
            // Never trap a packed/stuck seat on leave — detach + hard-leave as fallback.
            warnGame(
              sourceSession.id,
              `table:leave 2P finalize failed uid=${socket.user.id}: ${finalizeErr.message}`
            );
            if (typeof gameplayService.recordExplicitTableLeave === 'function') {
              updatedSourceSession = await gameplayService.recordExplicitTableLeave({
                sourceSessionId: sourceSession.id,
                userId: socket.user.id,
                reason: 'table_left_after_2p_finalize_fallback',
                activeSessionExit: true,
              });
            } else {
              updatedSourceSession = sourceSession;
            }
          }
        } else if (isPregameFreeLeave) {
          // Lobby / countdown before entry lock: remove seat, cancel pregame timers.
          // Applies to 2P and 6P — never soft-away (that wrongly offered pending rejoin).
          const leftSessionId = sourceSession.id;
          updatedSourceSession = await gameplayService.leaveTableContinuation({
            sourceSessionId: leftSessionId,
            userId: socket.user.id,
          });
          try {
            await cancelPregame(leftSessionId);
          } catch (cancelErr) {
            warnGame(
              leftSessionId,
              `table:leave cancelPregame failed uid=${socket.user.id}: ${cancelErr.message}`
            );
          }
          if (updatedSourceSession) {
            emitSessionStatePayload(io, updatedSourceSession);
          }
        } else if (isSixPlayerSoftExit) {
          // 6P only: drop mid-hand if needed, then soft-away (disconnect-style pending rejoin).
          // Invalid-declare pack / turn_eliminated skip drop but still soft-away —
          // never hard-opt-out (that used to hide pending rejoin after pack+leave).
          // Never settles the table; never charges pool buyback.
          if (isActiveSession && !leaveFlags.skipRedundantDrop) {
            const outcome = await dropPlayerFromSession(io, sourceSession.id, socket.user.id);
            updatedSourceSession = outcome?.session || null;
            result = outcome?.result || null;
          }
          updatedSourceSession = await gameplayService.recordSoftTableAway({
            sourceSessionId: sourceSession.id,
            userId: socket.user.id,
            reason: leaveFlags.skipRedundantDrop
              ? (leaveFlags.isDealPacked
                ? 'soft_table_away_after_invalid_declare'
                : 'soft_table_away_after_drop')
              : 'soft_table_away_leave',
          });
          softAway = true;
        } else if (isActiveSession) {
          if (leaveFlags.forceHardLeave) {
            // Real drop / timeout / pool wipe / prior hard leave — hide pending.
            updatedSourceSession = await gameplayService.recordExplicitTableLeave({
              sourceSessionId: sourceSession.id,
              userId: socket.user.id,
              reason: leaveFlags.isPoolEliminated
                ? 'table_left_after_pool_elimination'
                : 'table_left_after_drop',
              activeSessionExit: true,
            });
          } else if (leaveFlags.skipRedundantDrop) {
            // Invalid-declare pack (or similar deal-out) on non-6: keep classic
            // disconnect pending rejoin — do not hard-opt-out.
            updatedSourceSession = await gameplayService.recordDisconnectAwayForPendingRejoin({
              sourceSessionId: sourceSession.id,
              userId: socket.user.id,
              reason: leaveFlags.isDealPacked
                ? 'disconnect_away_after_invalid_declare'
                : 'disconnect_away_after_deal_out',
            });
            softAway = true;
          } else {
            const outcome = await dropPlayerFromSession(io, sourceSession.id, socket.user.id);
            updatedSourceSession = outcome?.session || null;
            result = outcome?.result || null;
          }
        } else {
          updatedSourceSession = await gameplayService.leaveTableContinuation({
            sourceSessionId: sourceSession.id,
            userId: socket.user.id,
          });
          // // Detach leaver first so they do not receive the post-leave session:state
          // // (players list no longer includes them; clients historically crashed on that).
          // leaveOtherSessionRooms(socket, null);
          emitSessionStatePayload(io, updatedSourceSession);
        }
        // Detach from this table's room only — keep parallel multi-table rooms.
        leaveSessionRoom(socket, sourceSession.id);
        await emitPendingRejoinGameForUser(
          io,
          socket.user.id,
          softAway ? 'soft_table_away' : 'table_left'
        );

        callback({
          success: true,
          data: {
            left: true,
            soft_away: softAway === true,
            source_session_id: sourceSession.id,
            source_session: updatedSourceSession,
            result,
          },
        });
      } catch (err) {
        console.warn(`[GAME] table:leave failed uid=${socket.user.id}:`, err.message);
        callback({ success: false, message: err.message });
      }
    });

    socket.on('pool:rejoin_table', async (payload = {}, callback = () => { }) => {
      try {
        const sessionId = Number(payload.session_id);
        if (Number.isNaN(sessionId)) {
          throw new Error('Valid session_id is required');
        }
        if (activePoolSplitBySession.has(sessionId)) {
          throw new Error('Pool rejoin is unavailable while split flow is active');
        }
        if (pendingPoolSplitStartBySession.has(sessionId)) {
          // Rejoin should take priority over pre-split prompt. Close the pending
          // split-start window so eliminated users can buy back immediately.
          clearPoolSplitStartTimer(sessionId);
        }

        const rejoinResult = await processPoolRejoinRequest({
          sessionId,
          userId: socket.user.id,
        });
        const rejoinSession = await gameplayService.getSessionState(sessionId);
        if (rejoinSession) {
          await attachSocketToSession(io, socket, rejoinSession, {
            presenceReason: 'pool_rejoin',
            startPregameIfReady: false,
          });
        }
        const rejoinInfo = buildPoolRejoinInfoPayload({
          rejoinContext: {
            rejoin_start_points_by_user: {
              [String(socket.user.id)]: rejoinResult.rejoinScore,
            },
          },
          joiningFee: rejoinResult.joiningFee || 0,
          prizePoolSummary: rejoinResult.prizePoolSummary,
        });
        const refreshedSession = await emitSessionState(io, sessionId);
        io.to(sessionRoom(sessionId)).emit('pool:rejoin', {
          session_id: sessionId,
          server_time: new Date().toISOString(),
          event: 'pool:rejoin',
          user_id: socket.user.id,
          rejoin_score: rejoinResult.rejoinScore,
          rejoin_threshold: rejoinResult.rejoinThreshold,
          pool_scores_by_user: rejoinResult.poolScoresByUser,
          pool_eliminated_user_ids: rejoinResult.poolEliminatedUserIds,
          joining_fee: rejoinResult.joiningFee || 0,
          pool_rejoin_entry_count: rejoinResult.poolRejoinEntryCount || 0,
          rejoin_info: rejoinInfo,
        });
        callback({
          success: true,
          data: {
            session: refreshedSession,
            rejoin_score: rejoinResult.rejoinScore,
            rejoin_threshold: rejoinResult.rejoinThreshold,
            joining_fee: rejoinResult.joiningFee || 0,
            pool_rejoin_entry_count: rejoinResult.poolRejoinEntryCount || 0,
            rejoin_info: rejoinInfo,
          },
        });
      } catch (err) {
        console.warn(`[GAME] pool:rejoin_table failed uid=${socket.user.id}:`, err.message);
        callback({
          success: false,
          message: err.message,
          ...(err.code && { code: err.code }),
          ...(err.details && { details: err.details }),
        });
      }
    });

    socket.on('pool:split:start', async (payload = {}, callback = () => { }) => {
      try {
        const sessionId = Number(payload.session_id);
        if (Number.isNaN(sessionId)) {
          throw new Error('Valid session_id is required');
        }
        if (activePoolSplitBySession.has(sessionId)) {
          throw new Error('Split window already active');
        }
        const pending = pendingPoolSplitStartBySession.get(sessionId);
        if (!pending) {
          throw new Error('Split option is not available right now');
        }
        if (Date.parse(pending.split_start_ends_at) <= Date.now()) {
          clearPoolSplitStartTimer(sessionId);
          throw new Error('Split start window has expired');
        }
        await cancelPregame(sessionId);
        const splitPlan = pending.split_plan || {};
        const eligibleSet = new Set((splitPlan.active_user_ids || []).map((id) => Number(id)));
        if (!eligibleSet.has(Number(socket.user.id))) {
          throw new Error('You are not eligible to start split');
        }
        const session = await gameplayService.getSessionState(sessionId);
        // Never block the human from starting split. Bots accept/reject based on
        // admin profit protection after the offer is opened.
        if (session) {
          const startProtection = evaluateAdminProfitProtection(session, splitPlan.rows || [], {
            participantUserIds: splitPlan.active_user_ids || [],
          });
          logGame(sessionId, `[SPLIT_PROTECTION] start_offer ${JSON.stringify(startProtection)}`);
        }
        const offerId = `${sessionId}:split:${Date.now()}`;
        const startedAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + (POOL_SPLIT_WINDOW_SECONDS * 1000)).toISOString();
        const state = {
          offer_id: offerId,
          session_id: sessionId,
          status: 'pending',
          initiated_by_user_id: socket.user.id,
          started_at: startedAt,
          expires_at: expiresAt,
          eligible_user_ids: splitPlan.active_user_ids || [],
          accepted_user_ids: [Number(socket.user.id)],
          rejected_user_ids: [],
          rows: (splitPlan.rows || []).map((row) => ({
            ...row,
            decision: Number(row.user_id) === Number(socket.user.id) ? 'accepted' : 'pending',
          })),
          total_split_amount: splitPlan.total_split_amount || 0,
          preferred_first_turn_user_id: pending.preferred_first_turn_user_id || null,
          base_result_payload: pending.payload || null,
          timeoutHandle: null,
        };
        state.timeoutHandle = setTimeout(() => {
          const current = activePoolSplitBySession.get(sessionId);
          if (!current || current.offer_id !== offerId) return;
          terminatePoolSplitOffer(io, sessionId, current, 'timeout').catch((err) => {
            errorGame(sessionId, `Pool split timeout handling failed: ${err.message}`);
          });
        }, POOL_SPLIT_WINDOW_SECONDS * 1000);

        activePoolSplitBySession.set(sessionId, state);
        clearPoolSplitStartTimer(sessionId);
        scheduleBotSplitAutoResponses(io, sessionId, offerId);

        if (session) {
          await gameSessionModel.updateSessionStatus(sessionId, session.status, {
            metadata: {
              ...(session.metadata || {}),
              split_offer: {
                offer_id: offerId,
                status: 'pending',
                started_at: startedAt,
                expires_at: expiresAt,
                initiated_by_user_id: socket.user.id,
                eligible_user_ids: state.eligible_user_ids,
                accepted_user_ids: state.accepted_user_ids,
                rejected_user_ids: [],
              },
            },
          });
        }

        const splitStatePayload = emitPoolSplitState(io, sessionId, state, 'started');
        callback({
          success: true,
          data: splitStatePayload,
        });
      } catch (err) {
        console.warn(`[GAME] pool:split:start failed uid=${socket.user.id}:`, err.message);
        callback({ success: false, message: err.message });
      }
    });

    socket.on('pool:split:respond', async (payload = {}, callback = () => { }) => {
      try {
        const sessionId = Number(payload.session_id);
        if (Number.isNaN(sessionId)) {
          throw new Error('Valid session_id is required');
        }
        const offerId = String(payload.offer_id || '').trim();
        if (!offerId) {
          throw new Error('offer_id is required');
        }
        const statusRaw = String(payload.status || '').trim().toLowerCase();
        const accept = payload.accept === true || statusRaw === 'accept' || statusRaw === 'accepted';
        const reject = payload.accept === false || statusRaw === 'reject' || statusRaw === 'rejected';
        if (!accept && !reject) {
          throw new Error('Valid split response required (accept=true/false or status=accepted/rejected)');
        }
        const state = activePoolSplitBySession.get(sessionId);
        if (!state || state.offer_id !== offerId) {
          throw new Error('Split offer is not active');
        }
        const now = Date.now();
        if (Date.parse(state.expires_at) <= now) {
          await terminatePoolSplitOffer(io, sessionId, state, 'timeout');
          throw new Error('Split offer has expired');
        }
        const userId = Number(socket.user.id);
        const eligibleSet = new Set((state.eligible_user_ids || []).map((id) => Number(id)));
        if (!eligibleSet.has(userId)) {
          throw new Error('You are not eligible for this split offer');
        }
        const acceptedSet = new Set((state.accepted_user_ids || []).map((id) => Number(id)));
        const rejectedSet = new Set((state.rejected_user_ids || []).map((id) => Number(id)));
        if (accept) {
          // Humans may always accept. Bot auto-response enforces admin profit.
          const liveSession = await gameplayService.getSessionState(sessionId);
          if (liveSession) {
            const acceptProtection = evaluateAdminProfitProtection(
              liveSession,
              state?.rows || [],
              { participantUserIds: state?.eligible_user_ids || [] }
            );
            logGame(sessionId, `[SPLIT_PROTECTION] human_accept ${JSON.stringify(acceptProtection)}`);
          }
        }
        if (accept) {
          rejectedSet.delete(userId);
          acceptedSet.add(userId);
        } else {
          acceptedSet.delete(userId);
          rejectedSet.add(userId);
        }
        state.accepted_user_ids = Array.from(acceptedSet);
        state.rejected_user_ids = Array.from(rejectedSet);
        state.rows = (state.rows || []).map((row) => {
          const rowUserId = Number(row.user_id);
          let decision = 'pending';
          if (acceptedSet.has(rowUserId)) decision = 'accepted';
          if (rejectedSet.has(rowUserId)) decision = 'rejected';
          return {
            ...row,
            decision,
          };
        });
        await persistSplitOfferMetadata(sessionId, {
          offer_id: state.offer_id,
          status: state.status,
          started_at: state.started_at,
          expires_at: state.expires_at,
          initiated_by_user_id: state.initiated_by_user_id,
          eligible_user_ids: state.eligible_user_ids || [],
          accepted_user_ids: state.accepted_user_ids || [],
          rejected_user_ids: state.rejected_user_ids || [],
        });

        const splitStatePayload = emitPoolSplitState(io, sessionId, state, accept ? 'accepted' : 'rejected');
        if (!accept) {
          await terminatePoolSplitOffer(io, sessionId, state, 'rejected');
          callback({
            success: true,
            data: {
              ...splitStatePayload,
              terminated: true,
              termination_reason: 'rejected',
            },
          });
          return;
        }
        const everyoneAccepted = (state.eligible_user_ids || []).every((id) => acceptedSet.has(Number(id)));
        if (everyoneAccepted) {
          const finalized = await finalizePoolSplitOffer(io, sessionId, state);
          callback({
            success: true,
            data: {
              finalized: true,
              result: finalized,
            },
          });
          return;
        }
        callback({ success: true, data: splitStatePayload });
      } catch (err) {
        console.warn(`[GAME] pool:split:respond failed uid=${socket.user.id}:`, err.message);
        callback({ success: false, message: err.message });
      }
    });

    socket.on('player:finish', async (payload = {}, callback = () => { }) => {
      try {
        const finishPayload = {
          ...payload,
          card_uid: payload.card_uid || payload.finish_card_uid,
        };

        const sessionId = Number(finishPayload.session_id);
        if (Number.isNaN(sessionId)) {
          throw new Error('Valid session_id is required');
        }

        if (!finishPayload.card_uid) {
          throw new Error('card_uid is required for finish');
        }

        const session = await gameplayService.loadTurnActionSession(sessionId);
        if (!session) {
          throw new Error('Session not found');
        }
        if (session.status !== 'active') {
          throw new Error('Session is not active');
        }
        if (Number(session.current_turn_user_id) !== Number(socket.user.id)) {
          throw new Error('It is not your turn');
        }

        const distribution = session.metadata?.distribution;
        if (!distribution) {
          throw new Error('Card distribution not found');
        }

        const playerDistribution = getPlayerDistribution(distribution, socket.user.id);
        if (!playerDistribution) {
          throw new Error('Player cards not found in distribution');
        }

        if (activeDeclareBySession.has(sessionId)) {
          throw new Error('Declaration window already active');
        }

        if (session.metadata?.turn?.has_picked !== true) {
          throw new Error('Finish is allowed only after picking a card');
        }

        const playerCards = playerDistribution.cards || [];
        const finishCardUid = String(finishPayload.card_uid || '').trim();
        const finishCardIndex = playerCards.findIndex((card) => card.card_uid === finishCardUid);
        if (finishCardIndex < 0) {
          throw new Error('Finish card not found in your hand');
        }


        const finishCard = playerCards[finishCardIndex];
        const nextHandCards = [...playerCards];
        nextHandCards.splice(finishCardIndex, 1);

        // Match `player:discard`: strip finish uid from melds, then sanitize + evaluate via
        // `resolveGroupingSnapshot`. Empty `groups: []` is treated as absent (same pitfall as declare).
        const clientSentGroups = Array.isArray(finishPayload.groups) && finishPayload.groups.length > 0;
        const storedFinishGroups = Array.isArray(playerDistribution.submitted_groups)
          ? playerDistribution.submitted_groups
          : [];
        const baseGroups = clientSentGroups ? finishPayload.groups : storedFinishGroups;

        const updatedFinishGroups = removeCardFromGroups(baseGroups, finishCardUid);
        const submittedGroups = updatedFinishGroups;

        const wildJoker = distribution.wild_joker || null;
        const { grouping } = resolveGroupingSnapshot(
          nextHandCards,
          wildJoker,
          updatedFinishGroups
        );
        const preview = grouping;
        // Validity is evaluated when the finisher submits in the declarer-only
        // declare window (`player:declare:response`). Invalid hands must still
        // be allowed to finish so wrong-show / pack rules can apply.
        if (BOT_FINISH_DEBUG_LOG_ENABLED) {
          logGame(
            sessionId,
            'Finish grouping classification',
            (preview?.groups || []).map((group) => ({
              card_uids: (group?.cards || []).map((card) => card?.card_uid),
              card_ids: (group?.cards || []).map((card) => card?.card_id),
              type: group?.type,
              points: group?.group_points,
              is_valid_meld: group?.is_valid_meld,
            }))
          );
        }

        const playerIndex = distribution.players.findIndex((pd) => pd.user_id === socket.user.id);
        const updatedPlayerDistribution = {
          ...playerDistribution,
          cards: nextHandCards,
          submitted_groups: submittedGroups,
        };
        const updatedPlayers = distribution.players.map((pd, index) =>
          index === playerIndex ? updatedPlayerDistribution : pd
        );
        const updatedDistribution = {
          ...distribution,
          players: updatedPlayers,
        };
        const updatedSession = {
          ...session,
          metadata: {
            ...(session.metadata || {}),
            distribution: updatedDistribution,
          },
        };

        logGame(
          sessionId,
          `Finish initiated — uid=${socket.user.id} finish=${finishCardUid} groups=${submittedGroups.length} ` +
          `preview_valid=${preview.summary?.valid_for_declare} ungrouped=${preview.summary?.ungrouped_points}pts`
        );

        const declaration = await startDeclarationWindow(
          updatedSession,
          socket.user.id,
          submittedGroups,
          {
            finishCard,
            distribution: updatedDistribution,
            prefillDeclarerResponse: false,
            openForAll: false,
          }
        );

        callback({
          success: true,
          data: {
            declaration,
            preview,
            finish_card: finishCard,
            cards_count: nextHandCards.length,
            ...buildGroupingResponseData(preview),
          },
        });
      } catch (err) {
        console.warn(`[GAME] player:finish failed uid=${socket.user.id}:`, err.message);
        callback({ success: false, message: err.message });
      }
    });

    socket.on('player:declare:response', async (payload = {}, callback = () => { }) => {
      try {
        const sessionId = Number(payload.session_id);
        if (Number.isNaN(sessionId)) {
          throw new Error('Valid session_id is required');
        }

        // Declaration state is process-local, but the responding player's
        // socket may live on another PM2/EC2 worker. Recover the shared Redis
        // snapshot before treating this as a late/closed-window response.
        const state = activeDeclareBySession.get(sessionId)
          || await rebuildDeclareStateFromStore(sessionId);
        if (!state) {
          // Late / desynced submit: window already finalized (timeout or all players done).
          // Do not fail hard — return settled state so client can show result seamlessly.
          const settled = await gameplayService.loadTurnActionSession(sessionId);
          const settledResult = settled?.metadata?.result || null;
          const declarationMeta = settled?.metadata?.declaration || null;
          if (settledResult || declarationMeta?.finalized_at || settled?.status === 'completed' || settled?.status === 'ready') {
            warnGame(
              sessionId,
              `Declare response after window closed uid=${socket.user.id} — returning already_finalized`
            );
            callback({
              success: true,
              data: {
                already_finalized: true,
                pending_count: 0,
                result: settledResult,
                declaration: declarationMeta,
                session_status: settled?.status || null,
              },
            });
            return;
          }
          throw new Error('No active declaration window');
        }

        const session = await gameplayService.loadTurnActionSession(sessionId);
        if (!session) {
          throw new Error('Session not found');
        }

        const player = session.players?.find((p) => p.user_id === socket.user.id);
        if (!player) {
          throw new Error('Player not found in session');
        }

        const distribution = session.metadata?.distribution;
        const playerDistribution = getPlayerDistribution(distribution, socket.user.id);
        if (!playerDistribution) {
          throw new Error('Player cards not found in distribution');
        }

        const wildJoker = distribution?.wild_joker || null;
        const isAwaitingDeclarerOnly = state.visibilityStage === DECLARATION_VISIBILITY_AWAITING_DECLARER;
        const isDeclarer = Number(socket.user.id) === Number(state.declareByUserId);
        if (isAwaitingDeclarerOnly && !isDeclarer) {
          throw new Error('Declaration window will open for all players after finisher submits');
        }

        if (hasDeclareResponseEntry(state.responses, socket.user.id)) {
          const existingGroups = getDeclareResponseEntry(state.responses, socket.user.id)?.groups || [];
          const preview = groupingService.evaluateSubmittedGrouping(
            playerDistribution.cards || [],
            wildJoker,
            existingGroups
          );

          callback({
            success: true,
            data: {
              already_submitted: true,
              pending_count: (Array.isArray(state.participantUserIds)
                ? state.participantUserIds.length
                : (session.players || []).length) - state.responses.size,
              preview,
              ...buildGroupingResponseData(preview),
            },
          });
          return;
        }

        const submittedGroups = sanitizeSubmittedGroups(payload.groups, playerDistribution.cards || []);
        // Yield before grouping evaluation so concurrent declare:response
        // CPU bursts (all 6 players × N tables) don't block one another.
        await yieldToEventLoop();
        const preview = groupingService.evaluateSubmittedGrouping(
          playerDistribution.cards || [],
          wildJoker,
          submittedGroups
        );

        // Always lock manual DECLARE layout first (all modes). Invalid-pack
        // early-returns below used to skip responses.set → result showed best groups.
        recordManualDeclareResponse(state, socket.user.id, submittedGroups);
        playerDistribution.submitted_groups = submittedGroups;
        if (Array.isArray(distribution?.players)) {
          const pdIndex = distribution.players.findIndex(
            (pd) => Number(pd?.user_id) === Number(socket.user.id)
          );
          if (pdIndex >= 0) {
            distribution.players[pdIndex] = {
              ...distribution.players[pdIndex],
              submitted_groups: submittedGroups,
            };
          }
        }

        // Wrong-show / invalid DECLARE: pack declarer with 80 and continue when
        // other seats remain (pool, points, deals, spin). Only end the hand when
        // ≤1 active player is left — same product rule across all modes.
        if (isAwaitingDeclarerOnly && isDeclarer && preview?.summary?.valid_for_declare !== true) {
          const gameMode = resolveSessionGameMode(session);
          const isPoolMode = gameMode === 'pool';

          // Persist arrangement for later finalize / inactive prefills (6P continue).
          const persistedSession = await persistPlayerSubmittedGroups(
            sessionId,
            socket.user.id,
            submittedGroups
          );
          // Prefer DB-backed distribution (with submitted_groups) for any result build below.
          const sessionWithGroups = persistedSession || session;
          const distributionWithGroups = sessionWithGroups.metadata?.distribution || distribution;

          const poolLimit = isPoolMode ? resolvePoolLimit(sessionWithGroups) : null;
          const currentScores = isPoolMode
            ? normalizePoolScoresByUser(sessionWithGroups.metadata || {})
            : {};
          const declarerKey = String(socket.user.id);
          const nextScore = isPoolMode
            ? ((Number(currentScores[declarerKey]) || 0) + 80)
            : 80;
          const nextScores = isPoolMode
            ? { ...currentScores, [declarerKey]: nextScore }
            : currentScores;

          const poolEliminatedSet = new Set(
            (Array.isArray(sessionWithGroups.metadata?.pool_eliminated_user_ids)
              ? sessionWithGroups.metadata.pool_eliminated_user_ids
              : [])
              .map((id) => Number(id))
              .filter((id) => !Number.isNaN(id))
          );
          const wasPoolEliminated = poolEliminatedSet.has(Number(socket.user.id));
          const crossedPoolLimitNow = isPoolMode
            && Number.isFinite(poolLimit)
            && nextScore >= poolLimit;
          if (crossedPoolLimitNow) {
            poolEliminatedSet.add(Number(socket.user.id));
          }

          const turnEliminatedSet = new Set(
            (Array.isArray(sessionWithGroups.metadata?.turn_eliminated_user_ids)
              ? sessionWithGroups.metadata.turn_eliminated_user_ids
              : [])
              .map((id) => Number(id))
              .filter((id) => !Number.isNaN(id))
          );
          turnEliminatedSet.add(Number(socket.user.id));

          const activePlayersAfterPack = getActivePlayers({
            ...sessionWithGroups,
            metadata: {
              ...(sessionWithGroups.metadata || {}),
              turn_eliminated_user_ids: Array.from(turnEliminatedSet),
              pool_eliminated_user_ids: Array.from(poolEliminatedSet),
            },
          });

          if (activePlayersAfterPack.length <= 1) {
            const winnerUserId = activePlayersAfterPack[0]?.user_id || null;
            if (winnerUserId != null) {
              // Do NOT cleanup declare state before building result players —
              // responses must still hold the manual invalid groups for display.
              if (crossedPoolLimitNow) {
                const refreshedForStatus = await gameplayService.getSessionState(sessionId);
                if (refreshedForStatus) {
                  const statusPlayer = (refreshedForStatus.players || []).find(
                    (item) => Number(item.user_id) === Number(socket.user.id)
                  );
                  if (statusPlayer) {
                    await persistInvalidDeclarationPackMetadata(sessionId, socket.user.id, {
                      penaltyPoints: 80,
                      cumulativePoints: nextScore,
                      eliminated: true,
                    });
                    emitPlayerStatusOverride(io, refreshedForStatus, statusPlayer, {
                      status: 'eliminated',
                      player_status: 'eliminated',
                      metadata: {
                        elimination_reason: 'pool_limit',
                        invalid_declaration: true,
                        invalid_declaration_penalty_points: 80,
                        cumulative_points: nextScore,
                      },
                    }, 'pool_limit_eliminated');
                  }
                }
              } else {
                await persistInvalidDeclarationPackMetadata(sessionId, socket.user.id, {
                  penaltyPoints: 80,
                  cumulativePoints: isPoolMode ? nextScore : null,
                  eliminated: false,
                });
                emitPlayerStatusOverride(io, sessionWithGroups, player, {
                  player_status: 'invalid_declaration',
                  metadata: {
                    invalid_declaration: true,
                    packed_in_current_deal: true,
                    invalid_declaration_penalty_points: 80,
                    ...(isPoolMode ? { cumulative_points: nextScore } : {}),
                  },
                }, 'invalid_declaration_packed');
              }
              // In 2-player pool, invalid declaration should pack declarer for the current deal
              // and transition to the next deal/round (unless pool limit elimination happened).
              if (isPoolMode && !crossedPoolLimitNow && Number(sessionWithGroups?.max_players) === 2) {
                const perRoundResults = (sessionWithGroups.players || []).map((item) => {
                  const isDeclarerItem = Number(item.user_id) === Number(socket.user.id);
                  const isWinnerItem = Number(item.user_id) === Number(winnerUserId);
                  const points = isDeclarerItem ? 80 : 0;
                  const baseStatus = isDeclarerItem ? 'invalid_declaration' : (isWinnerItem ? 'won' : 'lost');
                  return {
                    user_id: item.user_id,
                    seat_no: item.seat_no,
                    points,
                    round_points: points,
                    grouped_points: null,
                    ungrouped_points: null,
                    valid_for_declare: isDeclarerItem ? false : null,
                    invalid_group_count: isDeclarerItem ? 1 : null,
                    all_cards_grouped: isDeclarerItem ? false : null,
                    submission_mode: isDeclarerItem ? 'manual' : 'auto',
                    submission_status: isDeclarerItem ? 'manual' : 'auto',
                    player_status: baseStatus,
                    status_color: resolveStatusColor(baseStatus),
                    dropped: false,
                    is_winner: isWinnerItem,
                  };
                });

                const poolProgress = buildPoolRoundProgress(sessionWithGroups, perRoundResults);
                const roundResultsWithPool = perRoundResults.map((item) => {
                  const uid = Number(item.user_id);
                  const cumulativePoints = Number(poolProgress.scoresByUser[String(uid)]) || 0;
                  const isEliminated = (poolProgress.eliminatedUserIds || []).some((id) => Number(id) === uid);
                  const nextPlayerStatus = isEliminated ? 'eliminated' : item.player_status;
                  return {
                    ...item,
                    cumulative_points: cumulativePoints,
                    total_score: cumulativePoints,
                    score_model: 'pool_loss_cumulative',
                    player_status: nextPlayerStatus,
                    status_color: resolveStatusColor(nextPlayerStatus),
                  };
                });

                const rejoinContext = buildPoolRejoinContext({
                  players: sessionWithGroups.players || [],
                  scoresByUser: poolProgress.scoresByUser,
                  eliminatedUserIds: poolProgress.eliminatedUserIds,
                  poolLimit: poolProgress.poolLimit,
                });
                const rejoinJoiningFee = roundCurrency(Number(sessionWithGroups?.contest?.entry) || 0);
                const prizePoolSummary = buildPoolPrizePoolSummary({
                  entryFee: rejoinJoiningFee,
                  baseEntryCount: resolvePoolBaseEntryCount(sessionWithGroups),
                  rejoinEntryCount: resolvePoolRejoinEntryCount(sessionWithGroups?.metadata || {}),
                  projectedExtraEntries: rejoinContext.can_rejoin_table ? 1 : 0,
                });
                const rejoinInfo = buildPoolRejoinInfoPayload({
                  rejoinContext,
                  joiningFee: rejoinJoiningFee,
                  prizePoolSummary,
                });
                const poolEliminationContext = buildPoolEliminationContextFields(
                  sessionWithGroups,
                  poolProgress
                );
                const intermediatePayload = {
                  session_id: sessionId,
                  server_time: new Date().toISOString(),
                  event: 'game:result',
                  status: 'round_completed',
                  is_final: false,
                  reason: 'invalid_declaration_packed',
                  declare_by_user_id: socket.user.id,
                  declare_valid: false,
                  winner_user_id: winnerUserId,
                  tie_break_policy: 'pool_limit_then_lowest_points',
                  finish_card: null,
                  auto_declared_user_ids: [],
                  pool_limit: poolProgress.poolLimit,
                  pool_round_no: poolProgress.currentRoundNo,
                  pool_scores_by_user: poolProgress.scoresByUser,
                  pool_eliminated_user_ids: poolProgress.eliminatedUserIds,
                  pool_previous_eliminated_user_ids: poolEliminationContext.pool_previous_eliminated_user_ids,
                  pool_newly_eliminated_user_ids: poolEliminationContext.pool_newly_eliminated_user_ids,
                  can_rejoin_table: rejoinContext.can_rejoin_table,
                  rejoin_threshold: rejoinContext.rejoin_threshold,
                  rejoin_candidate_user_ids: rejoinContext.rejoin_candidate_user_ids,
                  rejoin_start_points_by_user: rejoinContext.rejoin_start_points_by_user,
                  rejoin_at_points_by_user: rejoinContext.rejoin_start_points_by_user,
                  joining_fee: rejoinInfo.joining_fee, 
                  current_prize_pool: rejoinInfo.current_prize_pool,
                  updated_prize_pool_if_rejoin: rejoinInfo.updated_prize_pool_if_rejoin,
                  rejoin_info: rejoinInfo,
                  results: roundResultsWithPool,
                  settlement: null,
                  deal_no: null,
                  total_deals: null,
                  deal_scores: null,
                };
                const completeRoundResultsWithPool = appendAbsentEliminatedPoolPlayersToRoundResults(
                  sessionWithGroups,
                  roundResultsWithPool,
                  poolProgress,
                );
                intermediatePayload.results = completeRoundResultsWithPool;
                intermediatePayload.players = buildDeclarationTablePlayers({
                  session: sessionWithGroups,
                  distribution: distributionWithGroups,
                  state,
                  isFinal: true,
                  isGameFinal: false,
                  finalizedResults: completeRoundResultsWithPool,
                  settlement: null,
                  winnerUserId,
                  declarerValid: false,
                  previousPoolEliminatedUserIds: poolEliminationContext.previousPoolEliminatedUserIds,
                });

                cleanupDeclareState(sessionId);
                await transitionToNextPoolRound(io, sessionWithGroups, intermediatePayload, poolProgress);
                callback({
                  success: true,
                  data: {
                    submitted: true,
                    invalid_declaration: true,
                    packed: true,
                    eliminated: false,
                    next_turn_user_id: null,
                    penalty_points: 80,
                    total_score: nextScore,
                  },
                });
                return;
              }
              // Keep declare responses until after result players are built inside finalize.
              // Refresh + merge pack flags so points settlement uses fixed 80, not hand score.
              const packedPenalty = 80;
              let sessionForFinalize = applyInvalidDeclarationPackToSessionPlayers(
                {
                  ...sessionWithGroups,
                  metadata: {
                    ...(sessionWithGroups.metadata || {}),
                    distribution: distributionWithGroups,
                    turn_eliminated_user_ids: Array.from(turnEliminatedSet),
                    ...(isPoolMode
                      ? {
                        pool_scores_by_user: nextScores,
                        pool_eliminated_user_ids: Array.from(poolEliminatedSet),
                      }
                      : {}),
                  },
                },
                socket.user.id,
                {
                  penaltyPoints: packedPenalty,
                  cumulativePoints: isPoolMode ? nextScore : null,
                  eliminated: crossedPoolLimitNow,
                }
              );
              try {
                const refreshedForFinalize = await gameplayService.getSessionState(sessionId);
                if (refreshedForFinalize) {
                  sessionForFinalize = applyInvalidDeclarationPackToSessionPlayers(
                    {
                      ...refreshedForFinalize,
                      metadata: {
                        ...(refreshedForFinalize.metadata || {}),
                        distribution: distributionWithGroups
                          || refreshedForFinalize.metadata?.distribution,
                        turn_eliminated_user_ids: Array.from(turnEliminatedSet),
                        ...(isPoolMode
                          ? {
                            pool_scores_by_user: nextScores,
                            pool_eliminated_user_ids: Array.from(poolEliminatedSet),
                          }
                          : {}),
                      },
                    },
                    socket.user.id,
                    {
                      penaltyPoints: packedPenalty,
                      cumulativePoints: isPoolMode ? nextScore : null,
                      eliminated: crossedPoolLimitNow,
                    }
                  );
                }
              } catch (_) {
                // Keep in-memory packed sessionForFinalize.
              }

              await finalizeGameByElimination(
                io,
                sessionForFinalize,
                winnerUserId,
                isPoolMode ? Array.from(poolEliminatedSet) : Array.from(turnEliminatedSet),
                'invalid_declaration_last_player_standing'
              );
              cleanupDeclareState(sessionId);
              callback({
                success: true,
                data: {
                  submitted: true,
                  invalid_declaration: true,
                  packed: true,
                  eliminated: crossedPoolLimitNow,
                  next_turn_user_id: null,
                  penalty_points: 80,
                  total_score: nextScore,
                },
              });
              return;
            }
          }

          const turnTimerSeconds = Number(sessionWithGroups?.game?.turn_timer_seconds) || 30;
          const attemptsUsedByUser = normalizeAttemptsUsedByUser(sessionWithGroups.metadata || {});
          const nextTurnUser = nextTurnUserId(activePlayersAfterPack, socket.user.id, {
            currentSeatNo: player?.seat_no,
          });
          if (!nextTurnUser) {
            cleanupDeclareState(sessionId);
            callback({
              success: false,
              message: 'Unable to continue game after invalid declaration; no active player available',
            });
            return;
          }
          const nextTurnWindow = buildTurnWindow(turnTimerSeconds);
          const nextTurn = buildTurnPayload({
            session: sessionWithGroups,
            userId: nextTurnUser,
            turnId: Number(sessionWithGroups?.metadata?.turn?.turn_id || 0) + 1,
            type: 'normal',
            attemptNo: 0,
            attemptsUsedCount: Number(attemptsUsedByUser[String(nextTurnUser)]) || 0,
            startedAt: nextTurnWindow.startedAt,
            endsAt: nextTurnWindow.endsAt,
            turnTimerSeconds,
            hasPicked: false,
          });

          const nextMetadata = {
            ...(sessionWithGroups.metadata || {}),
            distribution: distributionWithGroups,
            phase: 'active',
            phase_updated_at: new Date().toISOString(),
            turn: nextTurn,
            turn_bonus: {
              max_attempts_per_player: getMaxBonusAttempts(sessionWithGroups),
              attempts_used_by_user: attemptsUsedByUser,
            },
            turn_eliminated_user_ids: Array.from(turnEliminatedSet),
            ...(isPoolMode
              ? {
                pool_scores_by_user: nextScores,
                pool_eliminated_user_ids: Array.from(poolEliminatedSet),
              }
              : {}),
          };
          delete nextMetadata.declaration;

          await gameSessionModel.updateSessionStatus(sessionId, sessionWithGroups.status, {
            currentTurnUserId: nextTurnUser,
            metadata: nextMetadata,
          });

          await gameSessionModel.insertEvent({
            sessionId,
            userId: socket.user.id,
            eventType: 'invalid_declaration_packed',
            payload: {
              user_id: socket.user.id,
              penalty_points: 80,
              total_score: nextScore,
              next_turn_user_id: nextTurnUser,
              game_mode: gameMode,
              pool_limit: isPoolMode ? poolLimit : null,
              eliminated: crossedPoolLimitNow,
            },
          });

          cleanupDeclareState(sessionId);

          await persistInvalidDeclarationPackMetadata(sessionId, socket.user.id, {
            penaltyPoints: 80,
            cumulativePoints: isPoolMode ? nextScore : null,
            eliminated: crossedPoolLimitNow,
          });

          const continueContent = crossedPoolLimitNow
            ? 'Invalid declaration and threshold reached. You are eliminated from this pool game.'
            : 'Invalid declaration. You are packed for this deck; play continues for others.';
          const continueAction = crossedPoolLimitNow
            ? 'Please wait for game completion or use rejoin option if available.'
            : 'Please wait for this deck to end.';

          emitPlayerStatusOverride(io, sessionWithGroups, player, {
            status: crossedPoolLimitNow ? 'eliminated' : player.status,
            player_status: crossedPoolLimitNow ? 'eliminated' : 'invalid_declaration',
            metadata: {
              invalid_declaration: true,
              packed_in_current_deal: true,
              invalid_declaration_penalty_points: 80,
              ...(isPoolMode ? { cumulative_points: nextScore } : {}),
            },
            content_message: continueContent,
            action_message: continueAction,
          }, crossedPoolLimitNow ? 'pool_limit_eliminated' : 'invalid_declaration_packed');

          if (crossedPoolLimitNow && !wasPoolEliminated) {
            schedulePoolEliminationDetachAfterNextDealStart(io, sessionId, socket.user.id, 'pool_limit_eliminated');
            await emitPendingRejoinGameForUser(io, socket.user.id, 'pool_limit_eliminated');
          }

          emitTurn(io, sessionId, nextTurn, {
            action: 'invalid_declaration_continue',
            previous_turn_id: sessionWithGroups?.metadata?.turn?.turn_id || null,
            invalid_declarer_user_id: socket.user.id,
            distribution: nextMetadata.distribution,
          });
          scheduleTurnTimeout(io, sessionId, nextTurn);
          await emitSessionState(io, sessionId, { includeEvents: false });

          callback({
            success: true,
            data: {
              submitted: true,
              invalid_declaration: true,
              packed: true,
              eliminated: crossedPoolLimitNow,
              next_turn_user_id: nextTurnUser,
              penalty_points: 80,
              total_score: nextScore,
            },
          });
          return;
        }

        const responderIdNum = Number(socket.user.id);
        const responderKey = Number.isNaN(responderIdNum) ? socket.user.id : responderIdNum;
        state.responses.set(responderKey, {
          submitted_at: new Date().toISOString(),
          auto: false,
          groups: submittedGroups,
        });
        persistDeclareState(state);

        const totalPlayers = Array.isArray(state.participantUserIds)
          ? state.participantUserIds.length
          : (session.players || []).length;
        const pendingCount = Math.max(0, totalPlayers - state.responses.size);

        if (isAwaitingDeclarerOnly && isDeclarer) {
          const openResult = await openDeclarationWindowForAll(session, state, {
            distribution,
          });
          io.to(sessionRoom(sessionId)).emit('game:declare:submitted', {
            session_id: sessionId,
            server_time: new Date().toISOString(),
            event: 'game:declare:submitted',
            user_id: socket.user.id,
            pending_count: openResult?.pending_count ?? pendingCount,
          });
          scheduleBotDeclarationResponses(sessionId);
          const shouldFinalizeNow = (openResult?.pending_count || 0) === 0;
          // ACK before settlement — finalize can take seconds under concurrent finishes.
          callback({
            success: true,
            data: {
              submitted: true,
              declaration_window_opened: true,
              pending_count: openResult?.pending_count ?? pendingCount,
              declaration: openResult || null,
              preview,
              ...buildGroupingResponseData(preview),
            },
          });
          if (shouldFinalizeNow) {
            logGame(sessionId, 'Declarer submitted and no pending players remain — finalizing declaration async');
            setImmediate(() => {
              finalizeDeclarationWindow(sessionId, 'all_submitted').catch((err) => {
                errorGame(sessionId, `Async declaration finalize failed: ${err.message}`);
              });
            });
          }
          return;
        }

        io.to(sessionRoom(sessionId)).emit('game:declare:submitted', {
          session_id: sessionId,
          server_time: new Date().toISOString(),
          event: 'game:declare:submitted',
          user_id: socket.user.id,
          pending_count: pendingCount,
        });

        emitDeclarationState(io, session, state, {
          distribution,
        });

        const shouldFinalize = pendingCount === 0;
        callback({
          success: true,
          data: {
            submitted: true,
            pending_count: pendingCount,
            preview,
            ...buildGroupingResponseData(preview),
          },
        });
        if (shouldFinalize) {
          logGame(sessionId, 'All players responded — finalizing declaration async');
          setImmediate(() => {
            finalizeDeclarationWindow(sessionId, 'all_submitted').catch((err) => {
              errorGame(sessionId, `Async declaration finalize failed: ${err.message}`);
            });
          });
        }
      } catch (err) {
        console.warn(`[GAME] player:declare:response failed uid=${socket.user.id}:`, err.message);
        callback({ success: false, message: err.message });
      }
    });

    socket.on('disconnecting', () => {
      socket.data.sessionRoomIds = getSessionIdsFromSocket(socket);
    });

    socket.on('disconnect', () => {
      const sessionIds = Array.isArray(socket.data.sessionRoomIds) ? socket.data.sessionRoomIds : [];
      const userId = socket.user.id;
      socketRegistry.removeSocket(userId, socket.id);

      const markDisconnectedForSession = (sessionId) => {
        const roomSocketIds = io.sockets.adapter.rooms.get(sessionRoom(sessionId)) || new Set();
        const remainingUserSocketIds = socketRegistry.getSocketIds(userId);
        const stillConnectedToSession = remainingUserSocketIds.some((socketId) => roomSocketIds.has(socketId));
        if (stillConnectedToSession) {
          return;
        }

        setPlayerConnectionState(io, sessionId, userId, false, 'socket_disconnect')
          .then((result) => {
            if (result?.changed) {
              emitPendingRejoinGameForUser(io, userId, 'socket_disconnect').catch((rejoinErr) => {
                console.error(`[SOCKET] Failed to emit pending rejoin after disconnect uid=${userId}:`, rejoinErr.message);
              });
            }
          })
          .catch((err) => {
            errorGame(sessionId, `Disconnect presence update failed: ${err.message}`);
          });
      };

      if (sessionIds.length > 0) {
        sessionIds.forEach(markDisconnectedForSession);
      } else if (typeof gameplayService.getPendingRejoinSession === 'function') {
        gameplayService.getPendingRejoinSession(userId)
          .then((session) => {
            if (session?.id) {
              markDisconnectedForSession(session.id);
            }
          })
          .catch((err) => {
            console.error(`[SOCKET] Failed to resolve active session on disconnect uid=${userId}:`, err.message);
          });
      }

      console.log(`[SOCKET] Disconnected uid=${userId} socketId=${socket.id}`);
    });
  });

  return io;
}

/** Process-local runtime snapshot for /health and metrics (safe / read-only). */
function getSocketRuntimeStats(io) {
  const registry = typeof socketRegistry.getRegistryStats === 'function'
    ? socketRegistry.getRegistryStats()
    : null;
  return {
    connected: io && io.engine ? io.engine.clientsCount : null,
    registry,
    timers: {
      turns: activeTurnBySession.size,
      declares: activeDeclareBySession.size,
      bot_actions: activeBotActionBySession.size,
      pool_splits: activePoolSplitBySession.size,
      rematch: pendingAutoRematchBySourceSession.size,
    },
  };
}

/**
 * Cluster-wide socket snapshot for the detailed diagnostics endpoint.
 * This queries every Socket.IO Redis-adapter worker, so do not use it as the
 * high-frequency ALB health check.
 */
async function getClusterSocketRuntimeStats(io) {
  const local = getSocketRuntimeStats(io);
  if (!io || typeof io.fetchSockets !== 'function') {
    return {
      scope: 'local',
      connected: local.connected,
      users: local.registry?.users ?? null,
      local,
    };
  }

  try {
    const sockets = await io.fetchSockets();
    const userIds = new Set();
    for (const socket of sockets) {
      const userId = Number(
        socket?.data?.user_id
        ?? socket?.handshake?.auth?.user_id
        ?? NaN,
      );
      if (!Number.isNaN(userId)) userIds.add(userId);
    }
    return {
      scope: 'cluster',
      connected: sockets.length,
      users: userIds.size,
      local,
    };
  } catch (err) {
    return {
      scope: 'local_fallback',
      connected: local.connected,
      users: local.registry?.users ?? null,
      error: err.message,
      local,
    };
  }
}

module.exports = {
  registerSocketServer,
  getSocketRuntimeStats,
  getClusterSocketRuntimeStats,
  tryBuildBotFinishPlan,
  tryBuildFinishPlan,
  __testHooks: {
    hasAnyValidMeld,
    shouldBotTakeEarlyDrop,
    shouldBotStrategicallyDrop,
    isBotPoolDropBlockedByScore,
    resolvePoolBotDropBlockScore,
    resolvePoolSplitDropsRemaining,
    buildPoolSplitPlan,
    evaluateAdminProfitProtection,
    shouldBotAcceptSplitOffer,
    canMeaningfullyImproveWithPickedCard,
    isHopelessHandForDrop,
    doesStructureBlockStrategicDrop,
    buildBotPlayContext,
    tryBuildBotFinishPlan,
    tryBuildFinishPlan,
    activeBotActionBySession,
    getActiveBotActionState,
    executeBotTurnAction,
    emitBotDiscardBroadcast,
  },
};
