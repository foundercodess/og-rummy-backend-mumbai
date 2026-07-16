const groupingService = require('../grouping.service');

const RANK_TO_ORDER = {
  A: 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  '10': 10,
  J: 11,
  Q: 12,
  K: 13,
};

const RANK_TO_VALUE = {
  A: 10,
  J: 10,
  Q: 10,
  K: 10,
};

function hashSeed(value = '') {
  const input = String(value || '');
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}

function seededFloat(seed, salt = '') {
  if (!seed) return Math.random();
  const mixed = hashSeed(`${seed}:${salt}`);
  return mixed / 4294967295;
}

function isWildcard(card, wildRank = null) {
  return Boolean(card?.is_joker) || (wildRank != null && card?.rank === wildRank);
}

function getCardValue(card, wildRank = null) {
  if (isWildcard(card, wildRank)) return 0;
  return Number(card?.value) || RANK_TO_VALUE[card?.rank] || 0;
}

function getRankOrder(card) {
  return RANK_TO_ORDER[card?.rank] || null;
}

function getSameSuitNeighbors(card, cards = [], wildRank = null) {
  const rank = getRankOrder(card);
  if (!rank) return { immediate: 0, gap: 0, bridge: 0 };

  let immediate = 0;
  let gap = 0;
  let lowerNear = false;
  let upperNear = false;

  cards.forEach((other) => {
    if (!other || other.card_uid === card.card_uid || isWildcard(other, wildRank)) return;
    if (other.suit !== card.suit) return;

    const otherRank = getRankOrder(other);
    if (!otherRank) return;

    const diff = Math.abs(rank - otherRank);
    if (diff === 1) immediate += 1;
    if (diff === 2) gap += 1;

    if (otherRank < rank && rank - otherRank <= 2) lowerNear = true;
    if (otherRank > rank && otherRank - rank <= 2) upperNear = true;
  });

  return {
    immediate,
    gap,
    bridge: lowerNear && upperNear ? 1 : 0,
  };
}

function getSetLinks(card, cards = [], wildRank = null) {
  if (isWildcard(card, wildRank)) return 0;

  return cards.reduce((count, other) => {
    if (!other || other.card_uid === card.card_uid || isWildcard(other, wildRank)) return count;
    if (other.rank !== card.rank) return count;
    if (other.suit === card.suit) return count;
    return count + 1;
  }, 0);
}

function isCardIsolated(card, cards = [], wildRank = null) {
  if (isWildcard(card, wildRank)) return false;
  const seq = getSameSuitNeighbors(card, cards, wildRank);
  const sets = getSetLinks(card, cards, wildRank);
  return seq.immediate === 0 && seq.gap === 0 && seq.bridge === 0 && sets === 0;
}

function getCardImportance(card, cards = [], wildRank = null) {
  if (!card) return -Infinity;
  if (isWildcard(card, wildRank)) return 500;

  const seq = getSameSuitNeighbors(card, cards, wildRank);
  const setLinks = getSetLinks(card, cards, wildRank);
  const value = getCardValue(card, wildRank);

  let importance = 0;
  importance += seq.immediate * 26;
  importance += seq.gap * 12;
  importance += seq.bridge * 20;
  importance += setLinks * 18;

  if (seq.immediate >= 2) importance += 16;
  if (setLinks >= 2) importance += 20;
  if (value <= 5 && (seq.immediate > 0 || setLinks > 0)) importance += 6;
  if (isCardIsolated(card, cards, wildRank)) importance -= Math.min(10, value + 2);

  return importance;
}

function evaluateHandStrength(cards = [], wildJoker = null, options = {}) {
  const wildRank = wildJoker?.rank || null;
  const grouping = groupingService.buildBestGrouping(cards, wildJoker, options?.groupingOptions || {});
  const summary = grouping?.summary || {};
  const groupedCount = Array.isArray(cards)
    ? cards.length - (Array.isArray(grouping?.ungrouped_cards) ? grouping.ungrouped_cards.length : 0)
    : 0;

  const validGroups = Array.isArray(grouping?.groups)
    ? grouping.groups.filter((group) => group?.is_valid_meld === true)
    : [];

  const pureCount = Number(summary.pure_sequence_count) || validGroups.filter((group) => group.type === 'pure_sequence').length;
  const impureCount = validGroups.filter((group) => group.type === 'impure_sequence').length;
  const sequenceCount = Number(summary.sequence_count) || (pureCount + impureCount);
  const setCount = validGroups.filter((group) => group.type === 'set').length;
  const ungroupedPoints = Number(summary.ungrouped_points) || 0;
  const validForDeclare = summary.valid_for_declare === true;

  const structureScore = cards.reduce((acc, card) => acc + Math.min(90, getCardImportance(card, cards, wildRank)), 0);

  let score = 0;
  if (validForDeclare) score += 10000;
  score += pureCount * 320;
  score += sequenceCount * 180;
  score += setCount * 70;
  score += groupedCount * 16;
  score += structureScore;
  score -= ungroupedPoints * 6;

  return {
    score,
    grouping,
    summary,
    groupedCount,
    wildRank,
    pureCount,
    impureCount,
    sequenceCount,
    setCount,
  };
}

function canFinishAfterOneDiscard(cards = [], wildJoker = null, options = {}) {
  if (!Array.isArray(cards) || cards.length < 2) return false;
  const groupingOptions = options?.groupingOptions || {};

  // 14-card hands: buildBestGrouping already runs finish-ready detection.
  if (cards.length === 14) {
    if (options?.precomputedGrouping?.summary) {
      return options.precomputedGrouping.summary.can_finish_after_one_discard === true;
    }
    const grouping = groupingService.buildBestGrouping(cards, wildJoker, groupingOptions);
    return grouping?.summary?.can_finish_after_one_discard === true;
  }

  // 13-card (pre-pick) "finish after one discard" is rarely meaningful for declare;
  // skip the O(n) scan unless explicitly requested.
  if (options?.allowExpensiveFinishScan !== true) {
    return false;
  }

  const budgetMs = Number.isFinite(Number(options?.evalBudgetMs))
    ? Math.max(5, Number(options.evalBudgetMs))
    : Math.max(5, Number(process.env.BOT_FINISH_EVAL_BUDGET_MS) || 40);
  const startedAtMs = Date.now();
  for (const card of cards) {
    if ((Date.now() - startedAtMs) >= budgetMs) break;
    if (!card?.card_uid) continue;
    const remainingCards = cards.filter((entry) => entry?.card_uid !== card.card_uid);
    const grouping = groupingService.buildBestGrouping(remainingCards, wildJoker, groupingOptions);
    if (grouping?.summary?.valid_for_declare === true) {
      return true;
    }
  }
  return false;
}

function urgencyScaledThreshold(baseThreshold, urgency = 0.5) {
  const clamped = Math.max(0, Math.min(1, Number(urgency) || 0.5));
  return baseThreshold * (1.2 - (clamped * 0.55));
}

function chooseBotPickSource(distribution, playerCards = [], wildJoker = null, options = {}) {
  const softRiggingEnabled = options?.softRiggingEnabled === true;
  const conservativeMode = options?.conservativeMode === true;
  const playToWin = options?.playToWin === true;
  const urgency = Math.max(0, Math.min(1, Number(options?.playUrgency) || 0.55));
  const tieBreakSeed = options?.tieBreakSeed ? String(options.tieBreakSeed) : '';
  const discardTop = Array.isArray(distribution?.discard_pile) ? distribution.discard_pile[0] : null;
  if (!discardTop) return 'closed';

  const before = options.precomputedBefore || evaluateHandStrength(playerCards, wildJoker, options);
  const after = options.precomputedAfter
    || evaluateHandStrength([...playerCards, discardTop], wildJoker, options);
  const pickImportance = getCardImportance(discardTop, [...playerCards, discardTop], before.wildRank);
  const improvement = after.score - before.score;

  const beforeSummary = before.summary || {};
  const afterSummary = after.summary || {};
  // Prefer finish flags already computed inside evaluateHandStrength / buildBestGrouping.
  const canFinishBefore = playerCards.length === 14
    ? beforeSummary.can_finish_after_one_discard === true
    : false;
  const canFinishAfterPick = ([...playerCards, discardTop].length === 14)
    ? afterSummary.can_finish_after_one_discard === true
    : canFinishAfterOneDiscard([...playerCards, discardTop], wildJoker, {
      ...options,
      precomputedGrouping: after.grouping,
    });
  const needsPure = before.pureCount === 0;
  const proactive = playToWin || urgency >= 0.7;

  const conservativeOpenGate = urgencyScaledThreshold(12, urgency);
  const minFinishImprovement = urgencyScaledThreshold(18, urgency);
  const minGroupedImprovement = urgencyScaledThreshold(10, urgency);
  const minUngroupedImprovement = urgencyScaledThreshold(4, urgency);
  const minImportancePick = urgencyScaledThreshold(44, urgency);
  const minImportanceDelta = urgencyScaledThreshold(4, urgency);

  if (conservativeMode && improvement < conservativeOpenGate && pickImportance < urgencyScaledThreshold(48, urgency)) {
    return 'closed';
  }

  if (isWildcard(discardTop, before.wildRank)) return 'discard';
  if (canFinishAfterPick && !canFinishBefore) return 'discard';
  if (afterSummary.valid_for_declare === true && beforeSummary.valid_for_declare !== true) return 'discard';
  if (needsPure && after.pureCount > before.pureCount) return 'discard';
  if (proactive && needsPure && after.sequenceCount > before.sequenceCount && improvement >= 2) return 'discard';
  if (after.pureCount > before.pureCount) return 'discard';
  if (after.impureCount > before.impureCount) return 'discard';
  if (after.sequenceCount > before.sequenceCount) return 'discard';
  if (after.groupedCount > before.groupedCount && improvement >= minGroupedImprovement) return 'discard';
  if ((Number(afterSummary.ungrouped_points) || 0) < (Number(beforeSummary.ungrouped_points) || 0)
    && improvement >= minUngroupedImprovement) {
    if (!softRiggingEnabled || seededFloat(tieBreakSeed, 'pick-ungrouped') >= (proactive ? 0.2 : 0.35)) return 'discard';
    return 'closed';
  }
  if (pickImportance >= minImportancePick && improvement >= minImportanceDelta) {
    if (!softRiggingEnabled || seededFloat(tieBreakSeed, 'pick-importance') >= (proactive ? 0.15 : 0.30)) return 'discard';
    return 'closed';
  }

  if (improvement >= minFinishImprovement) {
    if (!softRiggingEnabled || seededFloat(tieBreakSeed, 'pick-improvement') >= (proactive ? 0.12 : 0.25)) return 'discard';
    return 'closed';
  }

  if (proactive && needsPure && pickImportance >= 30 && improvement >= 8) {
    return 'discard';
  }

  return 'closed';
}

function buildDiscardCandidateRanking(cards = [], wildJoker = null, options = {}) {
  if (!Array.isArray(cards) || cards.length === 0) return [];

  const tieBreakSeed = options?.tieBreakSeed ? String(options.tieBreakSeed) : '';
  const conservativeMode = options?.conservativeMode === true;
  const playToWin = options?.playToWin === true;
  const urgency = Math.max(0, Math.min(1, Number(options?.playUrgency) || 0.55));
  const nearEqualMargin = Math.max(0.5, Number(options?.nearEqualMargin) || 8);
  const proactive = playToWin || urgency >= 0.7;
  const fullEvalTop = Math.max(
    2,
    Math.min(
      8,
      Number.isFinite(Number(options?.fullEvalTop))
        ? Number(options.fullEvalTop)
        : (Number(process.env.BOT_DISCARD_FULL_EVAL_TOP) || 4)
    )
  );

  const currentGrouping = options?.precomputedGrouping
    || groupingService.buildBestGrouping(cards, wildJoker, options?.groupingOptions || {});
  const groupedIds = new Set(
    (Array.isArray(currentGrouping?.groups) ? currentGrouping.groups : [])
      .filter((group) => group?.is_valid_meld)
      .flatMap((group) => (Array.isArray(group?.cards) ? group.cards : []))
      .map((card) => card?.card_uid)
      .filter(Boolean)
  );

  const wildRank = wildJoker?.rank || null;
  const excludeUids = new Set(
    (Array.isArray(options?.excludeCardUids) ? options.excludeCardUids : [])
      .map((uid) => String(uid || '').trim())
      .filter(Boolean)
  );
  const nonWildCandidates = cards.filter((card) => !isWildcard(card, wildRank));
  let candidates = (nonWildCandidates.length > 0 ? nonWildCandidates : cards)
    .filter((card) => !excludeUids.has(String(card?.card_uid || '')));
  if (candidates.length === 0) {
    candidates = nonWildCandidates.length > 0 ? nonWildCandidates : cards;
  }

  // Cheap pre-rank (no per-card buildBestGrouping) — was the main event-loop blocker.
  const cheapRanked = candidates.map((candidate) => {
    const importance = getCardImportance(candidate, cards, wildRank);
    const value = getCardValue(candidate, wildRank);
    const isolatedBonus = isCardIsolated(candidate, cards, wildRank) ? (proactive ? 18 : 14) : 0;
    const groupedPenalty = groupedIds.has(candidate.card_uid) ? (proactive ? 42 : 35) : 0;
    const highValueIsolatedPenalty = proactive && isolatedBonus > 0 && value >= 10 ? (value * 0.35) : 0;
    const cheapScore = (value * 2)
      + isolatedBonus
      + highValueIsolatedPenalty
      - (importance * 2)
      - groupedPenalty;
    return {
      candidate,
      importance,
      value,
      groupedPenalty,
      isolatedBonus,
      cheapScore,
      seededNoise: seededFloat(tieBreakSeed, `discard:${candidate.card_uid || 'unknown'}`),
    };
  });

  cheapRanked.sort((a, b) => {
    if (b.cheapScore !== a.cheapScore) return b.cheapScore - a.cheapScore;
    if (conservativeMode && a.value !== b.value) return a.value - b.value;
    return b.seededNoise - a.seededNoise;
  });

  const shortlist = cheapRanked.slice(0, Math.min(fullEvalTop, cheapRanked.length));
  const ranked = shortlist.map((row) => {
    const remainingCards = cards.filter((card) => card?.card_uid !== row.candidate.card_uid);
    const remainingState = evaluateHandStrength(remainingCards, wildJoker, options);
    const discardScore = remainingState.score
      + (row.value * 2)
      + row.isolatedBonus
      + (proactive && row.isolatedBonus > 0 && row.value >= 10 ? (row.value * 0.35) : 0)
      - (row.importance * 2)
      - row.groupedPenalty;

    return {
      candidate: row.candidate,
      discardScore,
      importance: row.importance,
      value: row.value,
      groupedPenalty: row.groupedPenalty,
      seededNoise: row.seededNoise,
    };
  });

  ranked.sort((a, b) => {
    const scoreDelta = b.discardScore - a.discardScore;
    if (Math.abs(scoreDelta) > nearEqualMargin) return scoreDelta;
    if (conservativeMode && a.value !== b.value) return a.value - b.value;
    if (a.seededNoise !== b.seededNoise) return b.seededNoise - a.seededNoise;
    if (a.groupedPenalty !== b.groupedPenalty) return a.groupedPenalty - b.groupedPenalty;
    if (a.importance !== b.importance) return a.importance - b.importance;
    if (b.value !== a.value) return b.value - a.value;
    return String(a.candidate?.card_uid || '').localeCompare(String(b.candidate?.card_uid || ''));
  });

  return ranked;
}

function chooseBotDiscardCard(cards = [], wildJoker = null, options = {}) {
  const ranked = buildDiscardCandidateRanking(cards, wildJoker, options);
  return ranked[0]?.candidate || null;
}

function compactGroupingSummary(summary = {}) {
  return {
    valid_for_declare: summary.valid_for_declare === true,
    display_point: Number(summary.display_point) || 0,
    ungrouped_points: Number(summary.ungrouped_points) || 0,
    pure_sequence_count: Number(summary.pure_sequence_count) || 0,
    sequence_count: Number(summary.sequence_count) || 0,
    grouped_cards_count: Number(summary.grouped_cards_count) || 0,
    grouping_confidence: Number(summary.grouping_confidence),
    decision_margin: Number(summary.decision_margin),
    alternative_count: Number(summary.alternative_count),
  };
}

function explainPickSourceDecision(distribution, playerCards = [], wildJoker = null, options = {}) {
  const softRiggingEnabled = options?.softRiggingEnabled === true;
  const discardTop = Array.isArray(distribution?.discard_pile) ? distribution.discard_pile[0] : null;
  const before = options.precomputedBefore || evaluateHandStrength(playerCards, wildJoker, options);

  if (!discardTop) {
    const chosen = chooseBotPickSource(distribution, playerCards, wildJoker, {
      ...options,
      precomputedBefore: before,
    });
    return {
      chosen,
      soft_rigging_enabled: softRiggingEnabled,
      wild_rank: before.wildRank,
      open_top: null,
      closed_deck_count: Array.isArray(distribution?.closed_deck)
        ? distribution.closed_deck.length
        : 0,
      before_hand: compactGroupingSummary(before.summary),
      score_delta_vs_open: null,
      can_finish_before: before.summary?.can_finish_after_one_discard === true,
    };
  }

  const after = options.precomputedAfter
    || evaluateHandStrength([...playerCards, discardTop], wildJoker, options);
  const chosen = chooseBotPickSource(distribution, playerCards, wildJoker, {
    ...options,
    precomputedBefore: before,
    precomputedAfter: after,
  });
  const pickImportance = getCardImportance(discardTop, [...playerCards, discardTop], before.wildRank);

  return {
    chosen,
    soft_rigging_enabled: softRiggingEnabled,
    wild_rank: before.wildRank,
    open_top: {
      card_uid: discardTop.card_uid,
      rank: discardTop.rank,
      suit: discardTop.suit,
    },
    closed_deck_count: Array.isArray(distribution?.closed_deck)
      ? distribution.closed_deck.length
      : 0,
    before_hand: compactGroupingSummary(before.summary),
    hypothetical_with_open: compactGroupingSummary(after.summary),
    strength_score_delta: after.score - before.score,
    pick_importance: pickImportance,
    can_finish_before: before.summary?.can_finish_after_one_discard === true,
    can_finish_after_open_pick: after.summary?.can_finish_after_one_discard === true,
  };
}

function getTopDiscardCandidatesForLog(cards = [], wildJoker = null, limit = 5, options = {}) {
  const ranked = buildDiscardCandidateRanking(cards, wildJoker, options);
  const n = Math.max(1, Number(limit) || 5);
  return ranked.slice(0, n).map((row) => ({
    card_uid: row.candidate?.card_uid,
    rank: row.candidate?.rank,
    suit: row.candidate?.suit,
    discardScore: row.discardScore,
    importance: row.importance,
    value: row.value,
    groupedPenalty: row.groupedPenalty,
  }));
}

module.exports = {
  chooseBotPickSource,
  chooseBotDiscardCard,
  buildDiscardCandidateRanking,
  getCardValue,
  isCardIsolated,
  evaluateHandStrength,
  canFinishAfterOneDiscard,
  explainPickSourceDecision,
  getTopDiscardCandidatesForLog,
  compactGroupingSummary,
};
