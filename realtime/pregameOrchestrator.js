'use strict';

const crypto = require('crypto');
const { computeWalletDebitSplit } = require('../services/walletDebitSplit');
const gameplayService = require('../services/gameplay.service');
const {
  buildPoolSessionPrizePoolFields,
  countPoolJoinedPlayers,
} = require('../services/poolPrizePool.service');
const gameSessionModel = require('../models/gameSession.model');
const groupingService = require('../services/grouping.service');
const { resolveWildRank } = require('../services/wildJokerRules');
const redisLockService = require('../services/redisLock.service');
const durableTimer = require('../services/durableTimer.service');
const sessionCache = require('../services/sessionCache.service');
const liveSessionState = require('../services/liveSessionState.service');
const socketRegistry = require('./socketRegistry');
const { pool } = require('../db');
const { startTurnTimerFromDeal } = require('./turnSchedulerBridge');
const {
  filterTurnEligibleAtDealStart,
  resolveLastTurnUserId,
} = require('./turnRotation');
const {
  emitClosedDeckPreviewToTurnPlayer,
} = require('./closedDeckPreview');

const COUNTDOWN_SECONDS = Math.max(3, Number(process.env.MATCH_COUNTDOWN_SECONDS) || 10);
/** Free leave while seconds_left is above this; entry lock + back disabled at this value. */
const COUNTDOWN_ENTRY_LOCK_AT_SECONDS = Math.max(
  1,
  Math.min(COUNTDOWN_SECONDS - 1, Number(process.env.MATCH_COUNTDOWN_LOCK_AT_SECONDS) || 3)
);
const INTER_DEAL_COUNTDOWN_SECONDS = 5;
const TOSS_ANIMATION_SECONDS_DEFAULT = 5;
const TOSS_ANIMATION_SECONDS_TWO_PLAYER = 2;
const POST_DEAL_TURN_DELAY_SECONDS = 6;
const TURN_START_GRACE_MS = 1000;
const CARDS_PER_PLAYER = 13;
const PREGAME_LOCK_TTL_SECONDS = 45;
const PREGAME_LOCK_RENEW_EVERY_MS = 8000;
const BONUS_ATTEMPTS_PER_PLAYER = 1;
const ENTRY_DEBIT_COMMISSION_PERCENT = 12;
const HAND_PATTERN_HISTORY_LIMIT = Math.max(3, Number(process.env.HAND_PATTERN_HISTORY_LIMIT) || 8);
const DEAL_SHUFFLE_CANDIDATE_COUNT = Math.max(1, Math.min(7, Number(process.env.DEAL_SHUFFLE_CANDIDATE_COUNT) || 5));
const DEAL_RANDOM_PICK_PROBABILITY = Math.max(0, Math.min(0.6, Number(process.env.DEAL_RANDOM_PICK_PROBABILITY) || 0.05));
const DEAL_TOP_CANDIDATE_WINDOW = Math.max(
  1,
  Math.min(5, Number(process.env.DEAL_TOP_CANDIDATE_WINDOW) || 2),
);
const DEAL_FAIRNESS_PLAYABILITY_WEIGHT = Math.max(
  0.1,
  Math.min(0.45, Number(process.env.DEAL_FAIRNESS_PLAYABILITY_WEIGHT) || 0.27),
);



const activePregameBySession = new Map();

// ─── Utilities ────────────────────────────────────────────────────────────────

function sessionRoom(sessionId) {
  return `game-session:${sessionId}`;
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

function detachPoolEliminatedPlayers(io, session = {}) {
  const eliminated = resolvePoolEliminatedSet(session?.metadata || {});
  eliminated.forEach((userId) => detachUserFromSessionRoom(io, session.id, userId));
}

function getNowIso() {
  return new Date().toISOString();
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

// ─── Session mode helpers ─────────────────────────────────────────────────────

function normalizeSessionModeValue(value) {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
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

function resolveTossAnimationSeconds(players = []) {
  return Array.isArray(players) && players.length === 2
    ? TOSS_ANIMATION_SECONDS_TWO_PLAYER
    : TOSS_ANIMATION_SECONDS_DEFAULT;
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
      return { ...entry, deal_no: Math.floor(dealNo), results };
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

function normalizePoolScoresByUser(metadata = {}) {
  const raw = metadata?.pool_scores_by_user || {};
  const normalized = {};
  Object.entries(raw || {}).forEach(([userId, points]) => {
    const numericUserId = Number(userId);
    if (Number.isNaN(numericUserId)) return;
    normalized[String(numericUserId)] = Math.max(0, Number(points) || 0);
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

function getEliminatedUserIdSet(metadata = {}) {
  const eliminated = [
    ...(Array.isArray(metadata?.turn_eliminated_user_ids) ? metadata.turn_eliminated_user_ids : []),
    ...(Array.isArray(metadata?.pool_eliminated_user_ids) ? metadata.pool_eliminated_user_ids : []),
  ];
  return new Set(eliminated.map((id) => Number(id)).filter((id) => !Number.isNaN(id)));
}

function getTimeoutEliminatedUserIdSet(metadata = {}) {
  const eliminated = Array.isArray(metadata?.turn_timeout_eliminated_user_ids)
    ? metadata.turn_timeout_eliminated_user_ids
    : [];
  return new Set(eliminated.map((id) => Number(id)).filter((id) => !Number.isNaN(id)));
}

function resolveDealPlayerStatus(session, player = {}) {
  const userId = Number(player.user_id);
  const metadata = player.metadata || {};
  const sessionMeta = session?.metadata || {};

  if (!Number.isNaN(userId) && getTimeoutEliminatedUserIdSet(sessionMeta).has(userId)) {
    return 'timeout';
  }

  if (
    metadata.is_dropped === true
    || metadata.drop_status === 'dropped'
    || metadata.status === 'dropped'
    || metadata.elimination_reason === 'dropped'
  ) {
    return 'dropped';
  }

  if (
    (!Number.isNaN(userId) && getEliminatedUserIdSet(sessionMeta).has(userId))
    || player.status === 'eliminated'
    || metadata.elimination_reason === 'pool_limit'
  ) {
    return 'eliminated';
  }

  if (player.player_status
    && player.player_status !== 'disconnected'
    && player.player_status !== 'connected'
    && player.player_status !== 'joined') {
    return player.player_status;
  }

  const connectionStatus = player.connection_status
    || metadata.connection_status
    || (metadata.is_connected === false ? 'disconnected' : 'connected');
  if (connectionStatus === 'disconnected' || player.status === 'disconnected') {
    return 'disconnected';
  }

  return 'active';
}

function mapPlayersForDealEmit(scoreSession, participants = []) {
  const rows = Array.isArray(scoreSession?.players) && scoreSession.players.length > 0
    ? scoreSession.players
    : participants;
  const distributionPlayers = Array.isArray(scoreSession?.metadata?.distribution?.players)
    ? scoreSession.metadata.distribution.players
    : [];

  return rows.map((player) => {
    const metadata = player.metadata || {};
    const playerStatus = resolveDealPlayerStatus(scoreSession, player);
    const connectionStatus = player.connection_status
      || metadata.connection_status
      || (metadata.is_connected === false ? 'disconnected' : 'connected');
    const distributionPlayer = distributionPlayers.find(
      (row) => Number(row?.user_id) === Number(player.user_id)
    );

    return {
      user_id: player.user_id,
      seat_no: player.seat_no,
      name: player.name,
      avatar: player.avatar,
      total_score: resolvePlayerTotalScore(scoreSession, player.user_id),
      metadata,
      player_status: playerStatus,
      connection_status: connectionStatus,
      has_picked: distributionPlayer?.has_picked === true,
      first_turn_cycle_complete: distributionPlayer?.first_turn_cycle_complete === true,
    };
  });
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
  return session.players.filter((p) => ['joined', 'disconnected'].includes(p?.status)).length;
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

function resolvePoolEliminatedSet(metadata = {}) {
  return new Set(
    (Array.isArray(metadata?.pool_eliminated_user_ids) ? metadata.pool_eliminated_user_ids : [])
      .map((id) => Number(id))
      .filter((id) => !Number.isNaN(id)),
  );
}

function resolvePregameParticipants(session = {}) {
  const players = Array.isArray(session?.players) ? session.players : [];
  if (resolveSessionGameMode(session) !== 'pool') return players;
  const eliminated = resolvePoolEliminatedSet(session?.metadata || {});
  return players.filter((player) => !eliminated.has(Number(player.user_id)));
}

// ─── Crypto / shuffle helpers ─────────────────────────────────────────────────

function secureRandomInt(maxExclusive) {
  const max = Number(maxExclusive);
  if (!Number.isFinite(max) || max <= 1) return 0;
  const upperBound = 0x100000000;
  const cutoff = upperBound - (upperBound % max);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const value = crypto.randomBytes(4).readUInt32BE(0);
    if (value < cutoff) return value % max;
  }
}

function secureShuffle(items = []) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = secureRandomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── Deck builder ─────────────────────────────────────────────────────────────

function buildRummyDeck(deckCount = 2) {
  const suits = ['spades', 'hearts', 'diamonds', 'clubs'];
  const ranks = [
    { rank: 'A', value: 10 },
    { rank: '2', value: 2 },
    { rank: '3', value: 3 },
    { rank: '4', value: 4 },
    { rank: '5', value: 5 },
    { rank: '6', value: 6 },
    { rank: '7', value: 7 },
    { rank: '8', value: 8 },
    { rank: '9', value: 9 },
    { rank: '10', value: 10 },
    { rank: 'J', value: 10 },
    { rank: 'Q', value: 10 },
    { rank: 'K', value: 10 },
  ];

  const deck = [];
  let serial = 1;
  for (let d = 1; d <= deckCount; d += 1) {
    suits.forEach((suit) => {
      ranks.forEach((item) => {
        deck.push({
          card_id: `D${d}_${suit}_${item.rank}_${serial}`,
          suit,
          rank: item.rank,
          value: item.value,
          display: `${suit[0].toUpperCase()}${item.rank}`,
          is_joker: false,
        });
        serial += 1;
      });
    });
    deck.push({
      card_id: `D${d}_joker_${serial}`,
      suit: null,
      rank: null,
      value: 0,
      display: 'JKR',
      is_joker: true,
    });
    serial += 1;
  }
  return deck;
}

function normalizeCard(card) {
  if (!card) return null;
  return {
    card_uid: card.card_id,
    card_id: card.display,
    suit: card.suit,
    rank: card.rank,
    value: card.value,
    is_joker: card.is_joker,
  };
}

// ─── Hand analysis helpers ────────────────────────────────────────────────────

function buildHandFingerprint(cards = []) {
  const suitCounts = { spades: 0, hearts: 0, diamonds: 0, clubs: 0, joker: 0 };
  const rankCounts = {};
  const totalCards = Array.isArray(cards) ? cards.length : 0;
  let lowCount = 0;
  let highCount = 0;
  let totalValue = 0;
  let jokerCount = 0;

  (cards || []).forEach((card) => {
    if (card?.is_joker) {
      suitCounts.joker += 1;
      jokerCount += 1;
      return;
    }
    if (suitCounts[card?.suit] != null) suitCounts[card.suit] += 1;
    const rank = String(card?.rank || 'unknown');
    rankCounts[rank] = (rankCounts[rank] || 0) + 1;
    const value = Number(card?.value) || 0;
    totalValue += value;
    if (value > 0 && value <= 5) lowCount += 1;
    if (value >= 10) highCount += 1;
  });

  return {
    suit_counts: suitCounts,
    rank_counts: rankCounts,
    low_ratio: totalCards > 0 ? lowCount / totalCards : 0,
    high_ratio: totalCards > 0 ? highCount / totalCards : 0,
    total_value: totalValue,
    joker_count: jokerCount,
  };
}

function normalizedEntropy(values = []) {
  const total = values.reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  if (total <= 0) return 0;
  const nonZero = values.filter((value) => (Number(value) || 0) > 0).length;
  if (nonZero <= 1) return 0;
  let entropy = 0;
  values.forEach((value) => {
    const p = (Number(value) || 0) / total;
    if (p > 0) entropy -= p * Math.log2(p);
  });
  const maxEntropy = Math.log2(nonZero);
  if (maxEntropy <= 0) return 0;
  return Math.max(0, Math.min(1, entropy / maxEntropy));
}

function computePatternSimilarity(current = {}, previous = {}) {
  const suitKeys = ['spades', 'hearts', 'diamonds', 'clubs', 'joker'];
  const suitDistance = suitKeys.reduce((sum, key) => (
    sum + Math.abs((current?.suit_counts?.[key] || 0) - (previous?.suit_counts?.[key] || 0))
  ), 0);
  const suitSimilarity = Math.max(0, 1 - (suitDistance / 26));

  const rankKeys = new Set([
    ...Object.keys(current?.rank_counts || {}),
    ...Object.keys(previous?.rank_counts || {}),
  ]);
  const rankDistance = Array.from(rankKeys).reduce((sum, key) => (
    sum + Math.abs((current?.rank_counts?.[key] || 0) - (previous?.rank_counts?.[key] || 0))
  ), 0);
  const rankSimilarity = Math.max(0, 1 - (rankDistance / 26));
  const lowSimilarity = Math.max(0, 1 - Math.abs((current?.low_ratio || 0) - (previous?.low_ratio || 0)));
  const highSimilarity = Math.max(0, 1 - Math.abs((current?.high_ratio || 0) - (previous?.high_ratio || 0)));
  return (suitSimilarity * 0.45) + (rankSimilarity * 0.35) + (lowSimilarity * 0.1) + (highSimilarity * 0.1);
}

function computeDistributionVariance(handsByUser = {}) {
  const strengths = Object.values(handsByUser).map((cards) => {
    const fp = buildHandFingerprint(cards);
    const maxSuitCount = Math.max(
      ...Object.values(fp.suit_counts || { spades: 0, hearts: 0, diamonds: 0, clubs: 0, joker: 0 }),
    );
    return fp.total_value + (maxSuitCount * 1.8) - (fp.joker_count * 3);
  });
  if (strengths.length <= 1) return 0;
  const mean = strengths.reduce((sum, value) => sum + value, 0) / strengths.length;
  return strengths.reduce((sum, value) => {
    const d = value - mean;
    return sum + (d * d);
  }, 0) / strengths.length;
}

function computeShuffleEntropyScore(handsByUser = {}) {
  const handScores = Object.values(handsByUser).map((cards) => {
    const fp = buildHandFingerprint(cards);
    const suitEntropy = normalizedEntropy(Object.values(fp.suit_counts || {}));
    const rankEntropy = normalizedEntropy(Object.values(fp.rank_counts || {}));
    return (suitEntropy * 0.5) + (rankEntropy * 0.5);
  });
  if (handScores.length === 0) return 0;
  return handScores.reduce((sum, value) => sum + value, 0) / handScores.length;
}

function countHighCards(cards = []) {
  return (cards || []).reduce((count, card) => {
    if (card?.is_joker) return count;
    return (card?.rank === 'A' || card?.rank === 'K' || card?.rank === 'Q') ? count + 1 : count;
  }, 0);
}

function computeHighCardGap(handsByUser = {}) {
  const highs = Object.values(handsByUser).map((cards) => countHighCards(cards));
  if (highs.length <= 1) return 0;
  return Math.max(...highs) - Math.min(...highs);
}

// ─── Meld-aware playability scoring ──────────────────────────────────────────
//
//  Counts real near-sequence windows (consecutive rank runs of length 3-5 per
//  suit, with joker gap-bridging) instead of just unique-rank counts.
//  A hand with zero windows and zero jokers is flagged as unplayable.

const RANK_ORDER_MAP = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13,
};

function estimateSequencePotential(cards = [], wildRank = null) {
  const bySuit = new Map();
  let jokerCount = 0;

  (cards || []).forEach((card) => {
    if (!card) return;
    if (card.is_joker === true || (wildRank != null && card.rank === wildRank)) {
      jokerCount += 1;
      return;
    }
    if (!card.suit || !card.rank) return;
    // Ace stored as 1; ace-high variant handled below as 14
    const order = card.rank === 'A' ? 1 : (RANK_ORDER_MAP[card.rank] || 0);
    if (order === 0) return;
    if (!bySuit.has(card.suit)) bySuit.set(card.suit, new Set());
    bySuit.get(card.suit).add(order);
  });

  let score = 0;

  bySuit.forEach((rankSet) => {
    const ranks = [...rankSet].sort((a, b) => a - b);
    // Evaluate both ace-low and ace-high variants
    const ranksHigh = ranks.map((r) => (r === 1 ? 14 : r)).sort((a, b) => a - b);

    for (const seq of [ranks, ranksHigh]) {
      for (let wSize = 3; wSize <= 5; wSize += 1) {
        for (let start = 0; start < seq.length; start += 1) {
          const lo = seq[start];
          const hi = lo + wSize - 1;
          const window = seq.filter((r) => r >= lo && r <= hi);
          const gaps = (hi - lo + 1) - window.length;
          if (window.length >= 2 && gaps <= jokerCount) {
            score += 1;
          }
        }
      }
    }
  });

  // Set potential: 3+ distinct suits for the same rank
  const byRank = new Map();
  (cards || []).forEach((card) => {
    if (!card || card.is_joker === true || (wildRank != null && card.rank === wildRank)) return;
    if (!card.rank || !card.suit) return;
    if (!byRank.has(card.rank)) byRank.set(card.rank, new Set());
    byRank.get(card.rank).add(card.suit);
  });
  byRank.forEach((suits) => {
    if (suits.size >= 3) score += 1;
    else if (suits.size >= 2 && jokerCount >= 1) score += 0.5;
  });

  return score;
}

function computeHandPlayabilityScore(cards = [], wildRank = null) {
  // Normalise to [0,1]; divisor 2.5 rewards "almost there" hands more than 3.0
  return clamp01(estimateSequencePotential(cards, wildRank) / 2.5);
}

function computeDurationRiskScore(handsByUser = {}, wildRank = null) {
  const entries = Object.values(handsByUser);
  if (entries.length === 0) return 1;
  const potentials = entries.map((cards) => estimateSequencePotential(cards, wildRank));
  const avgPotential = potentials.reduce((sum, v) => sum + v, 0) / potentials.length;
  // Raised normalisation divisor (2.2 → 4.0) to match the higher score range
  return clamp01(1 - (avgPotential / 4.0));
}

// ─── Candidate selection ──────────────────────────────────────────────────────

function computeDealDelightScore(metrics = {}) {
  const fairness = clamp01(Number(metrics?.fairness_score) || 0);
  const playability = clamp01(Number(metrics?.playability_score) || 0);
  return clamp01((fairness * 0.42) + (playability * 0.58));
}

function selectBestDealCandidate(candidates = []) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  // Prefer candidates where every player has at least one viable meld window
  const playable = candidates.filter((c) => !c.isUnplayable);
  const pool = playable.length > 0 ? playable : candidates; // last-resort fallback

  const delightful = pool.filter((c) => (Number(c?.metrics?.playability_score) || 0) >= 0.22);
  const delightPool = delightful.length > 0 ? delightful : pool;

  const sorted = [...delightPool].sort((a, b) => {
    const delightDelta = computeDealDelightScore(b?.metrics) - computeDealDelightScore(a?.metrics);
    if (delightDelta !== 0) return delightDelta;
    if ((b?.metrics?.playability_score || 0) !== (a?.metrics?.playability_score || 0)) {
      return (b?.metrics?.playability_score || 0) - (a?.metrics?.playability_score || 0);
    }
    if ((b?.metrics?.fairness_score || 0) !== (a?.metrics?.fairness_score || 0)) {
      return (b?.metrics?.fairness_score || 0) - (a?.metrics?.fairness_score || 0);
    }
    return (a?.metrics?.pattern_repetition_score || 0) - (b?.metrics?.pattern_repetition_score || 0);
  });

  const topWindow = sorted.slice(0, Math.max(1, Math.min(sorted.length, DEAL_TOP_CANDIDATE_WINDOW)));
  if (topWindow.length === 1) return topWindow[0];

  // Weighted random within top window — bias toward higher delight/playability
  const weighted = topWindow.map((candidate, idx) => {
    const delight = computeDealDelightScore(candidate?.metrics || {});
    const base = Math.max(0.0001, delight + 0.001);
    return base * (1 / (idx + 1));
  });
  const totalWeight = weighted.reduce((sum, v) => sum + v, 0);
  if (totalWeight > 0) {
    let roll = (secureRandomInt(10000) / 10000) * totalWeight;
    for (let i = 0; i < topWindow.length; i += 1) {
      roll -= weighted[i];
      if (roll <= 0) return topWindow[i];
    }
    return topWindow[0];
  }

  const randomRoll = secureRandomInt(10000) / 10000;
  if (randomRoll < DEAL_RANDOM_PICK_PROBABILITY) {
    return sorted[secureRandomInt(sorted.length)];
  }
  return sorted[0];
}

// ─── Deal payload builder ─────────────────────────────────────────────────────

function buildDealPayload({ session, players, tossWinnerUserId, seed }) {
  const seats = [...players].sort((a, b) => a.seat_no - b.seat_no);
  const metadata = session?.metadata || {};
  const recentPatternsByUser = metadata?.recent_hand_patterns_by_user || {};
  const totalCards = buildRummyDeck(2).length;
  const seedHint = crypto.createHash('sha256').update(String(seed || '')).digest('hex').slice(0, 10);

  // ── Inner: build one candidate from a pre-shuffled deck ───────────────────
  function buildCandidate(deck) {
    const handsByUser = {};
    let cursor = 0;
    seats.forEach((player) => {
      const hand = deck.slice(cursor, cursor + CARDS_PER_PLAYER);
      cursor += CARDS_PER_PLAYER;
      handsByUser[player.user_id] = hand.map(normalizeCard);
    });

    const wildJoker = deck[cursor] || null;
    cursor += 1;
    const discardTop = deck[cursor] || null;
    cursor += 1;
    const closedDeck = deck.slice(cursor);
    const normalizedWildJoker = normalizeCard(wildJoker);
    const resolvedWildRank = resolveWildRank(normalizedWildJoker);

    // Repetition score (unchanged)
    const repetitionScores = seats.map((player) => {
      const currentFingerprint = buildHandFingerprint(handsByUser[player.user_id] || []);
      const history = Array.isArray(recentPatternsByUser?.[String(player.user_id)])
        ? recentPatternsByUser[String(player.user_id)]
        : [];
      if (history.length === 0) return 0;
      const recent = history.slice(-HAND_PATTERN_HISTORY_LIMIT);
      const avgSimilarity = recent.reduce((sum, fp) => (
        sum + computePatternSimilarity(currentFingerprint, fp)
      ), 0) / recent.length;
      return avgSimilarity * Math.min(1, recent.length / 3);
    });

    const patternRepetitionScore = repetitionScores.length
      ? repetitionScores.reduce((sum, v) => sum + v, 0) / repetitionScores.length
      : 0;

    // Distribution metrics
    const distributionVariance = computeDistributionVariance(handsByUser);
    const shuffleEntropyScore = computeShuffleEntropyScore(handsByUser);
    const highCardGap = computeHighCardGap(handsByUser);

    // Meld-aware duration risk
    const durationRiskScore = computeDurationRiskScore(handsByUser, resolvedWildRank);

    // Per-player playability → averaged
    const playabilityScores = seats.map((player) => (
      computeHandPlayabilityScore(handsByUser[player.user_id] || [], resolvedWildRank)
    ));
    const playabilityScore = playabilityScores.reduce((s, v) => s + v, 0) / playabilityScores.length;

    // Flag candidate as unplayable if any player has zero meld potential AND no jokers
    const isUnplayable = seats.some((player) => {
      const cards = handsByUser[player.user_id] || [];
      const jokersInHand = cards.filter((c) => (
        c.is_joker === true || (resolvedWildRank != null && c.rank === resolvedWildRank)
      )).length;
      return jokersInHand === 0 && estimateSequencePotential(cards, resolvedWildRank) === 0;
    });

    // Fairness score — playability weighted for user delight (server-only selection)
    const normalizedVariance = Math.min(1, distributionVariance / 220);
    const normalizedHighCardGap = Math.min(1, highCardGap / 4);
    const playabilityWeight = DEAL_FAIRNESS_PLAYABILITY_WEIGHT;
    const penaltyBudget = clamp01(1 - playabilityWeight);
    const fairnessScore = clamp01(
      1
      - (normalizedVariance * penaltyBudget * 0.34)
      - (patternRepetitionScore * penaltyBudget * 0.30)
      - ((1 - shuffleEntropyScore) * penaltyBudget * 0.19)
      - (normalizedHighCardGap * penaltyBudget * 0.14)
      - (durationRiskScore * penaltyBudget * 0.03)
      + (playabilityScore * playabilityWeight),
    );

    return {
      handsByUser,
      wildJoker,
      discardTop,
      closedDeck,
      normalizedWildJoker,
      isUnplayable,
      metrics: {
        distribution_variance: Number(distributionVariance.toFixed(4)),
        pattern_repetition_score: Number(patternRepetitionScore.toFixed(4)),
        shuffle_entropy_score: Number(shuffleEntropyScore.toFixed(4)),
        playability_score: Number(playabilityScore.toFixed(4)),
        fairness_score: Number(fairnessScore.toFixed(4)),
        delight_score: Number(computeDealDelightScore({
          fairness_score: fairnessScore,
          playability_score: playabilityScore,
        }).toFixed(4)),
        seed_hint: seedHint,
      },
    };
  }

  // ── Generate candidates and pick the best ─────────────────────────────────
  const candidates = [];
  for (let i = 0; i < DEAL_SHUFFLE_CANDIDATE_COUNT; i += 1) {
    candidates.push(buildCandidate(secureShuffle(buildRummyDeck(2))));
  }
  const chosen = selectBestDealCandidate(candidates)
    || buildCandidate(secureShuffle(buildRummyDeck(2)));

  const {
    handsByUser,
    discardTop,
    closedDeck,
    normalizedWildJoker,
    metrics,
  } = chosen;

  // Update recent hand pattern history
  const nextRecentPatternsByUser = { ...(recentPatternsByUser || {}) };
  seats.forEach((player) => {
    const key = String(player.user_id);
    const currentFingerprint = buildHandFingerprint(handsByUser[player.user_id] || []);
    const prev = Array.isArray(nextRecentPatternsByUser[key]) ? nextRecentPatternsByUser[key] : [];
    nextRecentPatternsByUser[key] = [...prev.slice(-(HAND_PATTERN_HISTORY_LIMIT - 1)), currentFingerprint];
  });

  return {
    session_id: session.id,
    session_code: session.session_code,
    phase: 'dealing',
    server_time: getNowIso(),
    game_state: {
      status: 'active',
      current_turn_user_id: tossWinnerUserId,
      cards_per_player: CARDS_PER_PLAYER,
    },
    toss: {
      toss_winner_user_id: tossWinnerUserId,
      winner_user_id: tossWinnerUserId,
    },
    distribution: {
      players: seats.map((player) => {
        const playerCards = handsByUser[player.user_id];
        const bestGrouping = groupingService.buildBestGrouping(playerCards, normalizedWildJoker);
        const submittedGroups = groupingService.toSubmittedGroupsFromGrouping(bestGrouping);
        return {
          user_id: player.user_id,
          seat_no: player.seat_no,
          cards: playerCards,
          auto_groups: bestGrouping,
          submitted_groups: submittedGroups,
          auto_best_group: true,
          has_picked: false,
          first_turn_cycle_complete: false,
        };
      }),
      wild_joker: normalizedWildJoker,
      wild_rank: resolveWildRank(normalizedWildJoker),
      discard_pile: discardTop ? [normalizeCard(discardTop)] : [],
      closed_deck_count: closedDeck.length,
      closed_deck: closedDeck.map(normalizeCard),
      total_cards: totalCards,
    },
    distribution_quality: metrics,
    recent_hand_patterns_by_user: nextRecentPatternsByUser,
  };
}

// ─── Toss ─────────────────────────────────────────────────────────────────────

function getTossCardStrength(card) {
  if (!card) return 0;
  if (card.rank === 'A') return 14;
  if (card.rank === 'K') return 13;
  if (card.rank === 'Q') return 12;
  if (card.rank === 'J') return 11;
  return card.value;
}

const TOSS_DECK_COUNT = 1;
// Highest priority first — lower index wins on equal rank.
const TOSS_SUIT_ORDER = ['spades', 'hearts', 'diamonds', 'clubs'];

function getTossSuitRank(card) {
  if (!card || !card.suit) return TOSS_SUIT_ORDER.length + 1;
  const idx = TOSS_SUIT_ORDER.indexOf(card.suit);
  if (idx < 0) return TOSS_SUIT_ORDER.length + 1;
  return idx + 1;
}

function buildTossResult(players) {
  const seats = [...players].sort((a, b) => a.seat_no - b.seat_no);
  const tossDeck = secureShuffle(buildRummyDeck(TOSS_DECK_COUNT));

  const tossEntries = seats.map((player, idx) => {
    const card = tossDeck[idx];
    return {
      user_id: player.user_id,
      seat_no: player.seat_no,
      toss_card: normalizeCard(card),
      toss_value: getTossCardStrength(card),
      toss_suit_rank: getTossSuitRank(card),
    };
  });

  const maxValue = Math.max(...tossEntries.map((e) => e.toss_value));
  const topEntries = tossEntries.filter((e) => e.toss_value === maxValue);
  topEntries.sort((a, b) => {
    if (a.toss_suit_rank !== b.toss_suit_rank) {
      return a.toss_suit_rank - b.toss_suit_rank;
    }
    return a.seat_no - b.seat_no;
  });
  const tossWinner = topEntries[0];

  return {
    tossWinnerUserId: tossWinner.user_id,
    players: tossEntries.map((entry) => ({
      user_id: entry.user_id,
      seat_no: entry.seat_no,
      toss_card: entry.toss_card,
      toss_value: entry.toss_value,
      is_toss_winner: entry.user_id === tossWinner.user_id,
    })),
  };
}

// ─── Session state helpers ────────────────────────────────────────────────────

async function emitSessionState(io, sessionId) {
  const session = await gameplayService.getSessionState(sessionId);
  if (!session) return null;
  io.to(sessionRoom(session.id)).emit('session:state', session);
  return session;
}

async function setSessionPhaseMetadata(sessionId, phase, extra = {}) {
  const session = await gameSessionModel.findSessionById(sessionId);
  if (!session) return null;
  const nextMetadata = {
    ...(session.metadata || {}),
    phase,
    phase_updated_at: getNowIso(),
    ...extra,
  };
  return gameSessionModel.updateSessionStatus(sessionId, session.status, { metadata: nextMetadata });
}

function buildPregameLockOwner(sessionId, sequence) {
  return `${process.pid}:${sessionId}:${sequence}`;
}

async function cleanupPregameSequence(sessionId) {
  const state = activePregameBySession.get(sessionId);
  if (!state) {
    durableTimer.cancel({ kind: 'pregame_deadline', sessionId, token: 'countdown' }).catch(() => {});
    durableTimer.cancel({ kind: 'post_deal', sessionId, token: 'turn_start' }).catch(() => {});
    return;
  }

  if (state.countdownInterval) { clearInterval(state.countdownInterval); state.countdownInterval = null; }
  if (state.tossTimeout) { clearTimeout(state.tossTimeout); state.tossTimeout = null; }
  if (state.lockRenewInterval) { clearInterval(state.lockRenewInterval); state.lockRenewInterval = null; }

  activePregameBySession.delete(sessionId);

  durableTimer.cancel({
    kind: 'pregame_deadline',
    sessionId,
    token: state.sequence || 'countdown',
  }).catch(() => {});

  if (state.lockKey && state.lockOwner) {
    await redisLockService.releaseLock(state.lockKey, state.lockOwner);
  }
}

async function autoReadyAllPlayers(sessionId, players) {
  await Promise.all(players.map((player) => gameSessionModel.updatePlayerMetadata(
    sessionId,
    player.user_id,
    { ...(player.metadata || {}), ready: true, auto_ready: true },
  )));
}

function shouldDebitEntryAtMatchFilled(session = {}) {
  const mode = resolveSessionGameMode(session);
  if (!['deals_2', 'pool', 'spin_go'].includes(mode)) return false;
  const entryFee = Number(session?.contest?.entry);
  return Number.isFinite(entryFee) && entryFee > 0;
}

function resolveDebitablePlayers(players = []) {
  return (Array.isArray(players) ? players : []).filter((player) => (
    ['joined', 'disconnected'].includes(player?.status)
    && player?.metadata?.is_bot !== true
  ));
}

// ─── Wallet debit ─────────────────────────────────────────────────────────────

async function debitEntriesOnMatchFilled({ sessionId, sequence }) {
  if (!pool) {
    const err = new Error('Wallet debit unavailable — DATABASE_URL not configured');
    err.code = 'WALLET_UNAVAILABLE';
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '15s'");

    const sessionRes = await client.query(
      'SELECT * FROM game_sessions WHERE id = $1 FOR UPDATE',
      [sessionId],
    );
    const sessionRow = sessionRes.rows[0] || null;
    if (!sessionRow) {
      const err = new Error('Session not found');
      err.code = 'SESSION_NOT_FOUND';
      throw err;
    }

    const gameRes = await client.query('SELECT name FROM games WHERE id = $1', [sessionRow.game_id]);
    const contestRes = sessionRow.contest_id
      ? await client.query('SELECT entry FROM contests WHERE id = $1', [sessionRow.contest_id])
      : { rows: [] };

    const mode = resolveSessionGameMode({
      metadata: sessionRow.metadata || {},
      game: { name: gameRes.rows[0]?.name || null },
    });
    const entryFee = roundCurrency(Number(contestRes.rows[0]?.entry) || 0);
    if (!['deals_2', 'pool', 'spin_go'].includes(mode) || entryFee <= 0) {
      await client.query('COMMIT');
      return { debited_user_ids: [], skipped: true };
    }

    const metadata = sessionRow.metadata || {};
    const alreadyDebited = new Set(
      (Array.isArray(metadata?.entry_debited_user_ids) ? metadata.entry_debited_user_ids : [])
        .map((id) => Number(id)).filter((id) => !Number.isNaN(id)),
    );

    const playersRes = await client.query(
      `SELECT * FROM game_session_players
       WHERE game_session_id = $1 AND status IN ('joined', 'disconnected')
       ORDER BY seat_no ASC FOR UPDATE`,
      [sessionId],
    );

    const debitablePlayers = resolveDebitablePlayers(playersRes.rows || []);
    const debitedUserIds = [];

    for (const player of debitablePlayers) {
      const userId = Number(player.user_id);
      if (Number.isNaN(userId) || alreadyDebited.has(userId)) continue;

      let walletRes = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
      if (!walletRes.rows[0]) {
        await client.query(
          'INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id',
          [userId],
        );
        walletRes = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
      }

      const wallet = walletRes.rows[0];
      const debitSplit = computeWalletDebitSplit(wallet, entryFee);
      if (debitSplit.available < entryFee) {
        const err = new Error(
          `Insufficient balance for lock. uid=${userId} required ₹${entryFee}, available ₹${debitSplit.available.toFixed(2)}`,
        );
        err.code = 'INSUFFICIENT_BALANCE_AT_LOCK';
        err.details = { user_id: userId, required: entryFee, available: debitSplit.available };
        throw err;
      }

      const nextTotal = roundCurrency(Number(wallet?.total_balance || 0) - entryFee);
      await client.query(
        `UPDATE wallets SET deposit=$2, released_bonus=$3, withdrawable=$4, total_balance=$5, updated_at=NOW()
         WHERE id = $1`,
        [wallet.id, debitSplit.nextDeposit, debitSplit.nextReleasedBonus, debitSplit.nextWithdrawable, nextTotal],
      );
      await client.query(
        `INSERT INTO wallet_transactions
           (user_id, wallet_id, transaction_type, amount, source, reference_type, reference_id, metadata)
         VALUES ($1, $2, 'game_entry_debit', $3, 'game', 'game_session', $4, $5::jsonb)`,
        [userId, wallet.id, -entryFee, sessionId, JSON.stringify({
          reason: `${mode}_entry_debit_match_filled`,
          mode,
          session_id: sessionId,
          contest_id: sessionRow.contest_id,
          entry_fee: entryFee,
          lock_sequence: sequence,
          admin_commission_percent: mode === 'spin_go' ? null : ENTRY_DEBIT_COMMISSION_PERCENT,
        })],
      );
      debitedUserIds.push(userId);
      alreadyDebited.add(userId);
    }

    const nextMetadata = {
      ...metadata,
      entry_debited_user_ids: Array.from(alreadyDebited),
      entry_debited_at: getNowIso(),
      entry_debit_lock_sequence: sequence,
    };
    await client.query(
      'UPDATE game_sessions SET metadata=$2::jsonb, updated_at=NOW() WHERE id=$1',
      [sessionId, JSON.stringify(nextMetadata)],
    );

    await client.query('COMMIT');
    if (sessionCache.isEnabled()) await sessionCache.invalidate(sessionId);
    if (liveSessionState.isEnabled()) await liveSessionState.drop(sessionId);
    return { debited_user_ids: debitedUserIds, skipped: false, entry_fee: entryFee };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Deal emit ────────────────────────────────────────────────────────────────

function resolveFirstTurnPlayer(players = [], preferredUserId = null) {
  const seats = [...players].sort((a, b) => a.seat_no - b.seat_no);
  if (!seats.length) return null;
  const preferred = seats.find((p) => Number(p.user_id) === Number(preferredUserId));
  if (preferred && preferred.status !== 'disconnected' && preferred?.metadata?.connection_status !== 'disconnected') {
    return preferred;
  }
  const connected = seats.find((p) => (
    p.status !== 'disconnected' && p?.metadata?.connection_status !== 'disconnected'
  ));
  if (connected) return connected;
  if (preferred) return preferred;
  return seats[0] || null;
}

async function emitDealFromPregame({
  io,
  sessionId,
  sequence,
  sessionForDeal,
  participants = [],
  baseSession,
  firstTurnPlayer,
  dealSeed,
  includeTossMetadata = true,
  tossPayload = null,
  postDealDelaySeconds = POST_DEAL_TURN_DELAY_SECONDS,
}) {
  const dealEventKey = redisLockService.dealEmitKey(sessionId, sequence);
  const dealEventClaimed = await redisLockService.claimEventIdempotency(dealEventKey, 180);
  if (!dealEventClaimed) {
    console.warn(`[PREGAME][${sessionId}] Duplicate game:deal prevented — sequence=${sequence} already claimed`);
    return false;
  }

  console.log(`[PREGAME][${sessionId}] Building deal — sequence=${sequence} firstTurn=uid:${firstTurnPlayer.user_id}`);

  const dealPayload = buildDealPayload({
    session: sessionForDeal,
    players: participants,
    tossWinnerUserId: firstTurnPlayer.user_id,
    seed: dealSeed,
  });

  const wildJoker = dealPayload.distribution?.wild_joker;
  const jokerDisplay = wildJoker?.is_joker
    ? `Printed JKR (wild rank=A)`
    : `${wildJoker?.rank || '?'}(${wildJoker?.suit || '?'})`;
  console.log(`[PREGAME][${sessionId}] Deal built — cardsPerPlayer=${CARDS_PER_PLAYER} wildJoker=${jokerDisplay} closedDeck=${dealPayload.distribution?.closed_deck?.length}`);
  console.log(`[DEAL_QUALITY][${sessionId}] ${JSON.stringify(dealPayload.distribution_quality || {})}`);

  const safePostDealDelaySeconds = Math.max(0, Number(postDealDelaySeconds) || 0);
  const turnStartedAt = new Date(
    Date.now() + (safePostDealDelaySeconds * 1000) + TURN_START_GRACE_MS,
  ).toISOString();
  const turnTimerSeconds = Number(sessionForDeal?.game?.turn_timer_seconds) || 30;
  const turnId = Date.now();
  const turnEndsAt = new Date(Date.parse(turnStartedAt) + (turnTimerSeconds * 1000)).toISOString();

  const poolEliminatedForTurn = Array.from(
    resolvePoolEliminatedSet(sessionForDeal?.metadata || {}),
  );
  const turnEligibleAtDealStart = filterTurnEligibleAtDealStart(participants, {
    poolEliminatedUserIds: poolEliminatedForTurn,
  });
  const lastTurnUserId = resolveLastTurnUserId(
    turnEligibleAtDealStart,
    firstTurnPlayer.user_id,
  );

  const nextMetadata = {
    ...(sessionForDeal.metadata || {}),
    phase: 'active',
    phase_updated_at: getNowIso(),
    first_turn_user_id: firstTurnPlayer.user_id,
    last_turn_user_id: lastTurnUserId,
    toss: includeTossMetadata ? (tossPayload || dealPayload.toss) : null,
    distribution: dealPayload.distribution,
    deal_quality: dealPayload.distribution_quality || null,
    recent_hand_patterns_by_user: dealPayload.recent_hand_patterns_by_user || {},
    discard_history: {
      seq: 0,
      initial_discard_card: Array.isArray(dealPayload.distribution?.discard_pile)
        ? (dealPayload.distribution.discard_pile[0] || null)
        : null,
      timeline: [],
    },
    game_state: {
      ...(dealPayload.game_state || {}),
      initial_turn_id: turnId,
      first_turn_user_id: firstTurnPlayer.user_id,
      last_turn_user_id: lastTurnUserId,
    },
    turn: {
      turn_id: turnId,
      user_id: firstTurnPlayer.user_id,
      started_at: turnStartedAt,
      ends_at: turnEndsAt,
      turn_timer_seconds: turnTimerSeconds,
      type: 'normal',
      attempt_no: 0,
      max_bonus_attempts: BONUS_ATTEMPTS_PER_PLAYER,
      attempts_left: BONUS_ATTEMPTS_PER_PLAYER,
      has_picked: false,
    },
    turn_bonus: {
      max_attempts_per_player: BONUS_ATTEMPTS_PER_PLAYER,
      attempts_used_by_user: {},
    },
  };
  // Pregame countdown must not survive into the live hand — clients re-apply
  // metadata.countdown on refresh and were looping back to countdown:0.
  delete nextMetadata.countdown;

  const dealMode = resolveSessionGameMode(sessionForDeal);
  if (
    dealMode === 'pool'
    && !Number.isFinite(Number(nextMetadata.pool_base_entry_count))
  ) {
    const lockedBase = countPoolJoinedPlayers(
      participants.length ? participants : (sessionForDeal.players || []),
    );
    if (lockedBase > 0) {
      nextMetadata.pool_base_entry_count = lockedBase;
    }
  }

  await gameSessionModel.updateSessionStatus(sessionId, 'active', {
    startedAt: new Date(),
    currentTurnUserId: firstTurnPlayer.user_id,
    metadata: nextMetadata,
  });

  await gameSessionModel.insertEvent({
    sessionId,
    eventType: 'cards_distributed',
    payload: {
      sequence,
      cards_per_player: CARDS_PER_PLAYER,
      toss_winner_user_id: includeTossMetadata ? firstTurnPlayer.user_id : null,
      winner_user_id: firstTurnPlayer.user_id,
      first_turn_user_id: firstTurnPlayer.user_id,
      last_turn_user_id: lastTurnUserId,
      distribution_quality: dealPayload.distribution_quality || null,
    },
  });

  const updatedSession = await gameplayService.getSessionState(sessionId);
  const dealContext = buildDealContextFields(updatedSession || sessionForDeal || baseSession);
  const prizePoolFields = buildSessionPrizePoolFields(updatedSession || sessionForDeal || baseSession);
  const poolEliminatedUserIds = Array.from(
    resolvePoolEliminatedSet((updatedSession || sessionForDeal || baseSession)?.metadata || {}),
  );
  const dealPlayers = mapPlayersForDealEmit(
    updatedSession || sessionForDeal || baseSession,
    participants,
  );

  detachPoolEliminatedPlayers(io, updatedSession || sessionForDeal || baseSession);

  console.log(`[PREGAME][${sessionId}] Emitting game:deal — session is now ACTIVE, turn=uid:${firstTurnPlayer.user_id} timer=${turnTimerSeconds}s, entire data: ${JSON.stringify({
    session_id: dealPayload.session_id,
    session_code: dealPayload.session_code,
    phase: 'active',
    status: 'active',
    server_time: getNowIso(),
    event: 'game:deal',
    ...dealContext,
    ...prizePoolFields,
    game_state: {
      ...dealPayload.game_state,
      turn_started_at: turnStartedAt,
      turn_ends_at: turnEndsAt,
      turn_timer_seconds: turnTimerSeconds,
    },
    toss: includeTossMetadata ? (tossPayload || dealPayload.toss) : null,
    turn: {
      turn_id: turnId,
      user_id: firstTurnPlayer.user_id,
      started_at: turnStartedAt,
      ends_at: turnEndsAt,
      turn_timer_seconds: turnTimerSeconds,
      type: 'normal',
      attempt_no: 0,
      max_bonus_attempts: BONUS_ATTEMPTS_PER_PLAYER,
      attempts_left: BONUS_ATTEMPTS_PER_PLAYER,
    },
    distribution: dealPayload.distribution,
    distribution_quality: dealPayload.distribution_quality || null,
    pool_eliminated_user_ids: poolEliminatedUserIds,
    players: dealPlayers,
  })}`);

  io.to(sessionRoom(sessionId)).emit('game:deal', {
    session_id: dealPayload.session_id,
    session_code: dealPayload.session_code,
    phase: 'active',
    status: 'active',
    server_time: getNowIso(),
    event: 'game:deal',
    ...dealContext,
    ...prizePoolFields,
    game_state: {
      ...dealPayload.game_state,
      turn_started_at: turnStartedAt,
      turn_ends_at: turnEndsAt,
      turn_timer_seconds: turnTimerSeconds,
      first_turn_user_id: firstTurnPlayer.user_id,
      last_turn_user_id: lastTurnUserId,
    },
    first_turn_user_id: firstTurnPlayer.user_id,
    last_turn_user_id: lastTurnUserId,
    toss: includeTossMetadata ? (tossPayload || dealPayload.toss) : null,
    turn: {
      turn_id: turnId,
      user_id: firstTurnPlayer.user_id,
      started_at: turnStartedAt,
      ends_at: turnEndsAt,
      turn_timer_seconds: turnTimerSeconds,
      type: 'normal',
      attempt_no: 0,
      max_bonus_attempts: BONUS_ATTEMPTS_PER_PLAYER,
      attempts_left: BONUS_ATTEMPTS_PER_PLAYER,
    },
    distribution: dealPayload.distribution,
    distribution_quality: dealPayload.distribution_quality || null,
    pool_eliminated_user_ids: poolEliminatedUserIds,
    players: dealPlayers,
  });

  // Private closed-top for first turn player — deal_start used to skip emitTurn().
  emitClosedDeckPreviewToTurnPlayer(
    io,
    sessionId,
    {
      turn_id: turnId,
      user_id: firstTurnPlayer.user_id,
      has_picked: false,
    },
    dealPayload.distribution
  );

  setTimeout(() => {
    const dealStartTurn = {
      turn_id: turnId,
      user_id: firstTurnPlayer.user_id,
      started_at: turnStartedAt,
      ends_at: turnEndsAt,
      turn_timer_seconds: turnTimerSeconds,
      type: 'normal',
      attempt_no: 0,
      max_bonus_attempts: BONUS_ATTEMPTS_PER_PLAYER,
      attempts_left: BONUS_ATTEMPTS_PER_PLAYER,
      has_picked: false,
    };
    io.to(sessionRoom(sessionId)).emit('game:turn', {
      session_id: dealPayload.session_id,
      server_time: getNowIso(),
      event: 'game:turn',
      action: 'deal_start',
      turn: dealStartTurn,
    });
    // Re-send after deal animation window so late joiners / missed emits still get it.
    emitClosedDeckPreviewToTurnPlayer(
      io,
      sessionId,
      dealStartTurn,
      dealPayload.distribution
    );

    durableTimer.cancel({ kind: 'post_deal', sessionId, token: 'turn_start' }).catch(() => {});

    startTurnTimerFromDeal({
      session_id: sessionId,
      turn: {
        turn_id: turnId,
        type: 'normal',
        started_at: turnStartedAt,
        ends_at: turnEndsAt,
      },
    });
  }, safePostDealDelaySeconds * 1000);

  durableTimer.arm({
    kind: 'post_deal',
    sessionId,
    token: 'turn_start',
    fireAtMs: Date.now() + (safePostDealDelaySeconds * 1000),
    graceMs: 1500,
    payload: {
      turn_id: turnId,
      started_at: turnStartedAt,
      ends_at: turnEndsAt,
      user_id: firstTurnPlayer.user_id,
    },
  }).catch(() => {});

  return true;
}

// ─── Pregame orchestration ────────────────────────────────────────────────────

async function startPregame(io, sessionId, options = {}) {
  if (activePregameBySession.has(sessionId)) {
    console.log(`[PREGAME][${sessionId}] startPregame skipped — already active`);
    return;
  }

  const session = await gameplayService.getSessionState(sessionId);
  if (!session) {
    console.warn(`[PREGAME][${sessionId}] startPregame aborted — session not found`);
    return;
  }
  if (session.status !== 'ready') {
    console.log(`[PREGAME][${sessionId}] startPregame aborted — status=${session.status} (expected: ready)`);
    return;
  }
  const mode = resolveSessionGameMode(session);
  const isDealsInterDeal = mode === 'deals_2' && resolveCurrentDeal(session) > 1;
  const poolRoundNo = Number(session?.metadata?.pool_round_no);
  const isPoolInterRound = mode === 'pool'
    && ((Number.isFinite(poolRoundNo) && poolRoundNo > 1) || session?.metadata?.phase === 'inter_deal');
  const useInterDealFastStart = options.interDealFastStart === true && (isDealsInterDeal || isPoolInterRound);

  // Fresh matchmaking requires a full table. Inter-deal / next pool round only needs
  // enough active participants (left / eliminated seats must not block continuation).
  if (!useInterDealFastStart) {
    if (!Array.isArray(session.players) || session.players.length !== session.max_players) {
      console.log(`[PREGAME][${sessionId}] startPregame aborted — players=${session.players?.length}/${session.max_players} not filled`);
      return;
    }
  } else if (!Array.isArray(session.players) || session.players.length < 2) {
    console.log(`[PREGAME][${sessionId}] startPregame aborted — inter-deal players=${session.players?.length} (<2)`);
    return;
  }
  const initialParticipants = resolvePregameParticipants(session);
  if (initialParticipants.length < 2) {
    console.log(`[PREGAME][${sessionId}] startPregame aborted — active participants=${initialParticipants.length} (<2)`);
    return;
  }

  const configuredCountdown = useInterDealFastStart
    ? Number(options.countdownSeconds) || INTER_DEAL_COUNTDOWN_SECONDS
    : COUNTDOWN_SECONDS;
  const countdownSeconds = Math.max(1, Math.floor(configuredCountdown));

  const sequence = `${session.id}:${Date.now()}`;
  const lockKey = redisLockService.pregameLockKey(sessionId);
  const lockOwner = buildPregameLockOwner(sessionId, sequence);
  const lockAcquired = await redisLockService.acquireLock(lockKey, lockOwner, PREGAME_LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    console.log(`[PREGAME][${sessionId}] Lock not acquired — another instance owns this pregame`);
    return;
  }
  console.log(
    `[PREGAME][${sessionId}] Lock acquired — starting countdown sequence=${sequence} players=${session.players.length} ` +
    `mode=${useInterDealFastStart ? 'inter_deal_fast' : 'default'}`,
  );

  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + (countdownSeconds * 1000));

  activePregameBySession.set(sessionId, {
    sequence, lockKey, lockOwner,
    lockRenewInterval: null, countdownInterval: null, tossTimeout: null,
  });

  const ownedState = activePregameBySession.get(sessionId);
  ownedState.lockRenewInterval = setInterval(async () => {
    const currentState = activePregameBySession.get(sessionId);
    if (!currentState) return;
    const renewed = await redisLockService.renewLock(
      currentState.lockKey, currentState.lockOwner, PREGAME_LOCK_TTL_SECONDS,
    );
    if (!renewed) {
      console.warn(`[PREGAME][${sessionId}] Lock renew FAILED — another instance took over. Cleaning up.`);
      await cleanupPregameSequence(sessionId);
    } else {
      console.log(`[PREGAME][${sessionId}] Lock renewed successfully`);
    }
  }, PREGAME_LOCK_RENEW_EVERY_MS);

  try {
    let liveSession = session;
    // Entry fee locks when countdown reaches COUNTDOWN_ENTRY_LOCK_AT_SECONDS,
    // so players can leave for free from MATCH_COUNTDOWN…(lock+1).

    await gameSessionModel.insertEvent({
      sessionId,
      eventType: 'countdown_started',
      payload: {
        sequence,
        started_at: startedAt.toISOString(),
        ends_at: endsAt.toISOString(),
        seconds: countdownSeconds,
        lock_at_seconds: COUNTDOWN_ENTRY_LOCK_AT_SECONDS,
      },
    });

    await setSessionPhaseMetadata(sessionId, 'countdown', {
      countdown: {
        sequence,
        started_at: startedAt.toISOString(),
        ends_at: endsAt.toISOString(),
        seconds: countdownSeconds,
        lock_at_seconds: COUNTDOWN_ENTRY_LOCK_AT_SECONDS,
      },
      entry_locked: false,
    });

    durableTimer.arm({
      kind: 'pregame_deadline',
      sessionId,
      token: sequence,
      fireAtMs: endsAt.getTime(),
      graceMs: 2500,
      payload: { sequence, stage: 'countdown_end', inter_deal: useInterDealFastStart === true },
    }).catch(() => {});

    if (!useInterDealFastStart) {
      io.to(sessionRoom(sessionId)).emit('match:filled', {
        session_id: sessionId,
        session_code: liveSession.session_code,
        phase: 'countdown',
        status: 'ready',
        server_time: getNowIso(),
        event: 'match:filled',
        entry_locked: false,
        countdown: {
          sequence,
          started_at: startedAt.toISOString(),
          ends_at: endsAt.toISOString(),
          seconds: countdownSeconds,
          lock_at_seconds: COUNTDOWN_ENTRY_LOCK_AT_SECONDS,
        },
        players: liveSession.players.map((p) => ({
          user_id: p.user_id,
          seat_no: p.seat_no,
          name: p.name,
          avatar: p.avatar,
          metadata: p.metadata,
        })),
      });
    }

    const tick = async () => {
      const now = new Date();
      const secondsLeft = Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / 1000));
      let latestSession = await gameplayService.getSessionState(sessionId);

      if (
        !useInterDealFastStart
        && shouldDebitEntryAtMatchFilled(latestSession || session)
        && secondsLeft <= COUNTDOWN_ENTRY_LOCK_AT_SECONDS
        && latestSession?.metadata?.entry_locked !== true
      ) {
        try {
          const debitResult = await debitEntriesOnMatchFilled({ sessionId, sequence });
          await gameSessionModel.insertEvent({
            sessionId,
            eventType: 'entry_debit_locked',
            payload: {
              sequence,
              locked_at_seconds_left: secondsLeft,
              debited_user_ids: debitResult.debited_user_ids || [],
              entry_fee: debitResult.entry_fee || null,
              skipped: debitResult.skipped === true,
            },
          });
          await setSessionPhaseMetadata(sessionId, 'countdown', {
            countdown: {
              sequence,
              started_at: startedAt.toISOString(),
              ends_at: endsAt.toISOString(),
              seconds: countdownSeconds,
            },
            entry_locked: true,
            entry_locked_at: getNowIso(),
            entry_locked_at_seconds_left: secondsLeft,
          });
          latestSession = await gameplayService.getSessionState(sessionId);
          if (latestSession) liveSession = latestSession;
        } catch (err) {
          if (err?.code === 'INSUFFICIENT_BALANCE_AT_LOCK') throw err;
          console.error(`[PREGAME][${sessionId}] Entry lock debit failed:`, err.message);
          throw err;
        }
      }

      io.to(sessionRoom(sessionId)).emit('game:countdown', {
        session_id: sessionId,
        session_code: latestSession?.session_code || session.session_code,
        phase: 'countdown',
        status: latestSession?.status || 'ready',
        server_time: now.toISOString(),
        event: 'game:countdown',
        entry_locked: latestSession?.metadata?.entry_locked === true,
        countdown: {
          sequence,
          started_at: startedAt.toISOString(),
          ends_at: endsAt.toISOString(),
          seconds_left: secondsLeft,
          lock_at_seconds: COUNTDOWN_ENTRY_LOCK_AT_SECONDS,
        },
        players: latestSession?.players?.map((p) => ({
          user_id: p.user_id, seat_no: p.seat_no, name: p.name, metadata: p.metadata,
        })) || [],
      });

      if (secondsLeft > 0) return;

      console.log(`[PREGAME][${sessionId}] Countdown complete — proceeding to ${useInterDealFastStart ? 'direct_deal' : 'toss'}`);
      const state = activePregameBySession.get(sessionId);
      if (state?.countdownInterval) { clearInterval(state.countdownInterval); state.countdownInterval = null; }

      const refreshed = await gameplayService.getSessionState(sessionId);
      if (!refreshed || !Array.isArray(refreshed.players) || refreshed.players.length < 2) {
        console.warn(`[PREGAME][${sessionId}] Countdown end check failed — missing session/players. Aborting.`);
        await cleanupPregameSequence(sessionId);
        return;
      }
      if (!useInterDealFastStart && refreshed.players.length !== refreshed.max_players) {
        console.warn(`[PREGAME][${sessionId}] Countdown end check failed — players dropped. Aborting.`);
        await cleanupPregameSequence(sessionId);
        return;
      }
      const refreshedParticipants = resolvePregameParticipants(refreshed);
      if (refreshedParticipants.length < 2) {
        console.warn(`[PREGAME][${sessionId}] Countdown end check failed — active participants=${refreshedParticipants.length} (<2). Aborting.`);
        await cleanupPregameSequence(sessionId);
        return;
      }

      await autoReadyAllPlayers(sessionId, refreshedParticipants);

      if (useInterDealFastStart) {
        const firstTurnPlayer = resolveFirstTurnPlayer(
          refreshedParticipants,
          options.preferredFirstTurnUserId || null,
        );
        if (!firstTurnPlayer) {
          console.warn(`[PREGAME][${sessionId}] Inter-deal fast start aborted — no eligible first-turn player`);
          await cleanupPregameSequence(sessionId);
          return;
        }
        try {
          await emitDealFromPregame({
            io, sessionId, sequence,
            sessionForDeal: refreshed,
            participants: refreshedParticipants,
            baseSession: liveSession,
            firstTurnPlayer,
            dealSeed: `${sessionId}:${sequence}:inter-deal:${firstTurnPlayer.user_id}`,
            includeTossMetadata: false,
            tossPayload: null,
            postDealDelaySeconds: POST_DEAL_TURN_DELAY_SECONDS,
          });
        } catch (err) {
          console.error(`[PREGAME][${sessionId}] Inter-deal direct deal FAILED:`, err.message, err.stack);
        } finally {
          await cleanupPregameSequence(sessionId);
        }
        return;
      }

      const tossSeed = `${sessionId}:${sequence}:${refreshedParticipants.map((p) => p.user_id).join(',')}`;
      const tossResult = buildTossResult(refreshedParticipants, tossSeed);
      const tossWinner = refreshedParticipants.find((p) => p.user_id === tossResult.tossWinnerUserId);
      if (!tossWinner) {
        console.warn(`[PREGAME][${sessionId}] Toss winner uid=${tossResult.tossWinnerUserId} not found. Aborting.`);
        await cleanupPregameSequence(sessionId);
        return;
      }
      const tossAnimationSeconds = resolveTossAnimationSeconds(refreshedParticipants);
      console.log(`[PREGAME][${sessionId}] Toss won by uid=${tossWinner.user_id} seat=${tossWinner.seat_no} — deals in ${tossAnimationSeconds}s`);

      const tossTime = new Date();
      const dealStartsAt = new Date(tossTime.getTime() + (tossAnimationSeconds * 1000));

      await gameSessionModel.insertEvent({
        sessionId,
        userId: tossWinner.user_id,
        eventType: 'toss_completed',
        payload: {
          toss_winner_user_id: tossWinner.user_id,
          winner_user_id: tossWinner.user_id,
          sequence,
          deal_starts_at: dealStartsAt.toISOString(),
        },
      });

      await setSessionPhaseMetadata(sessionId, 'toss', {
        toss: {
          sequence,
          toss_winner_user_id: tossWinner.user_id,
          winner_user_id: tossWinner.user_id,
          started_at: tossTime.toISOString(),
          deal_starts_at: dealStartsAt.toISOString(),
        },
      });

      io.to(sessionRoom(sessionId)).emit('game:toss', {
        session_id: sessionId,
        session_code: refreshed.session_code,
        phase: 'toss',
        status: 'ready',
        server_time: tossTime.toISOString(),
        event: 'game:toss',
        toss: {
          rule: 'highest_card_wins',
          ace_high: true,
          sequence,
          started_at: tossTime.toISOString(),
          deal_starts_at: dealStartsAt.toISOString(),
        },
        players: tossResult.players.map((p) => ({
          user_id: p.user_id,
          seat_no: p.seat_no,
          toss_card: p.toss_card,
          toss_value: p.toss_value,
          is_toss_winner: p.is_toss_winner,
        })),
        toss_winner_user_id: tossWinner.user_id,
        toss_seed_hash: crypto.createHash('sha256').update(tossSeed).digest('hex'),
      });

      const latestState = activePregameBySession.get(sessionId);
      if (!latestState) return;
      latestState.tossTimeout = setTimeout(async () => {
        try {
          await emitDealFromPregame({
            io, sessionId, sequence,
            sessionForDeal: refreshed,
            participants: refreshedParticipants,
            baseSession: liveSession,
            firstTurnPlayer: tossWinner,
            dealSeed: `${tossSeed}:deal`,
            includeTossMetadata: true,
            tossPayload: {
              sequence,
              toss_winner_user_id: tossWinner.user_id,
              winner_user_id: tossWinner.user_id,
              started_at: tossTime.toISOString(),
              deal_starts_at: dealStartsAt.toISOString(),
            },
            postDealDelaySeconds: POST_DEAL_TURN_DELAY_SECONDS,
          });
        } catch (err) {
          console.error(`[PREGAME][${sessionId}] Deal sequence FAILED:`, err.message, err.stack);
        } finally {
          await cleanupPregameSequence(sessionId);
        }
      }, tossAnimationSeconds * 1000);
    };

    const state = activePregameBySession.get(sessionId);
    state.countdownInterval = setInterval(tick, 1000);
    await tick();
  } catch (err) {
    if (err?.code === 'INSUFFICIENT_BALANCE_AT_LOCK') {
      await gameSessionModel.updateSessionStatus(sessionId, 'waiting', {
        metadata: {
          ...(session.metadata || {}),
          phase: 'waiting',
          phase_updated_at: getNowIso(),
          pregame_lock_failed: {
            reason: err.code,
            details: err.details || null,
            sequence,
            at: getNowIso(),
          },
        },
      });
      await gameSessionModel.insertEvent({
        sessionId,
        eventType: 'pregame_lock_failed',
        payload: { reason: err.code, details: err.details || null, sequence },
      });
      await emitSessionState(io, sessionId);
    }
    await cleanupPregameSequence(sessionId);
    throw err;
  }
}

async function cancelPregame(sessionId) {
  await cleanupPregameSequence(sessionId);
}

/**
 * Recover orphaned pregame / post-deal deadlines when the owning process died.
 * Idempotent via existing deal emit claim + turn-timeout scheduling.
 */
async function recoverPregameDeadline(io, sessionId, entry = {}) {
  const sid = Number(sessionId);
  if (Number.isNaN(sid)) return false;

  const kind = String(entry.kind || '');
  if (kind === 'post_deal') {
    const turn = entry.payload || {};
    if (!turn.ends_at || turn.turn_id == null) return false;
    const claimed = await redisLockService.claimEventIdempotency(
      `idem:post-deal-turn:session:${sid}:turn:${turn.turn_id}`,
      180,
    );
    if (!claimed) return false;
    startTurnTimerFromDeal({
      session_id: sid,
      turn: {
        turn_id: Number(turn.turn_id),
        type: 'normal',
        started_at: turn.started_at,
        ends_at: turn.ends_at,
      },
    });
    return true;
  }

  // If this process already owns pregame, local timers will finish it.
  if (activePregameBySession.has(sid)) return false;

  const session = await gameplayService.getSessionState(sid);
  if (!session) return false;

  const phase = String(session.metadata?.phase || '').toLowerCase();
  const status = String(session.status || '').toLowerCase();

  if (status === 'active' && phase === 'active' && session.metadata?.turn) {
    // Deal already landed — ensure turn timer exists.
    startTurnTimerFromDeal({
      session_id: sid,
      turn: session.metadata.turn,
    });
    return true;
  }

  if (status === 'ready' && (phase === 'countdown' || phase === 'toss' || !phase)) {
    console.warn(`[PREGAME][${sid}] Durable recovery restarting pregame (phase=${phase || 'none'})`);
    await startPregame(io, sid, {
      preferredFirstTurnUserId: entry.payload?.preferred_first_turn_user_id || null,
    });
    return true;
  }

  return false;
}

module.exports = {
  startPregame,
  cancelPregame,
  recoverPregameDeadline,
  __testHooks: {
    buildTossResult,
    getTossCardStrength,
    getTossSuitRank,
    TOSS_SUIT_ORDER,
    buildDealPayload,
    selectBestDealCandidate,
    computeDealDelightScore,
    DEAL_SHUFFLE_CANDIDATE_COUNT,
    DEAL_RANDOM_PICK_PROBABILITY,
    DEAL_TOP_CANDIDATE_WINDOW,
  },
};