const crypto = require('crypto');

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS = [
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

const PLAYERS = [101, 102, 103, 104];
const CARDS_PER_PLAYER = 13;
const HISTORY_LIMIT = 8;
const CANDIDATES = 5;
const RANDOM_PICK_PROBABILITY = 0.05;

function secureRandomInt(maxExclusive) {
  const max = Number(maxExclusive);
  if (!Number.isFinite(max) || max <= 1) return 0;
  const upperBound = 0x100000000;
  const cutoff = upperBound - (upperBound % max);
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

function buildDeck(deckCount = 2) {
  const deck = [];
  let serial = 1;
  for (let d = 1; d <= deckCount; d += 1) {
    SUITS.forEach((suit) => {
      RANKS.forEach((item) => {
        deck.push({
          card_id: `D${d}_${suit}_${item.rank}_${serial}`,
          suit,
          rank: item.rank,
          value: item.value,
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
      is_joker: true,
    });
    serial += 1;
  }
  return deck;
}

function buildHandFingerprint(cards = []) {
  const suitCounts = { spades: 0, hearts: 0, diamonds: 0, clubs: 0, joker: 0 };
  const rankCounts = {};
  const totalCards = cards.length;
  let lowCount = 0;
  let highCount = 0;
  let totalValue = 0;
  let jokerCount = 0;

  cards.forEach((card) => {
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
  return maxEntropy <= 0 ? 0 : Math.max(0, Math.min(1, entropy / maxEntropy));
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
    const maxSuitCount = Math.max(...Object.values(fp.suit_counts));
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
    const suitEntropy = normalizedEntropy(Object.values(fp.suit_counts));
    const rankEntropy = normalizedEntropy(Object.values(fp.rank_counts));
    return (suitEntropy * 0.5) + (rankEntropy * 0.5);
  });
  if (handScores.length === 0) return 0;
  return handScores.reduce((sum, value) => sum + value, 0) / handScores.length;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function buildCandidate(historyByUser = {}) {
  const deck = secureShuffle(buildDeck(2));
  const handsByUser = {};
  let cursor = 0;
  PLAYERS.forEach((userId) => {
    handsByUser[userId] = deck.slice(cursor, cursor + CARDS_PER_PLAYER);
    cursor += CARDS_PER_PLAYER;
  });

  const repetitionScores = PLAYERS.map((userId) => {
    const currentFp = buildHandFingerprint(handsByUser[userId] || []);
    const history = Array.isArray(historyByUser[userId]) ? historyByUser[userId] : [];
    if (history.length === 0) return 0;
    const recent = history.slice(-HISTORY_LIMIT);
    const avgSimilarity = recent.reduce((sum, fp) => sum + computePatternSimilarity(currentFp, fp), 0) / recent.length;
    return avgSimilarity * Math.min(1, recent.length / 3);
  });

  const patternRepetitionScore = repetitionScores.reduce((sum, value) => sum + value, 0) / repetitionScores.length;
  const distributionVariance = computeDistributionVariance(handsByUser);
  const shuffleEntropyScore = computeShuffleEntropyScore(handsByUser);
  const normalizedVariance = Math.min(1, distributionVariance / 220);
  const fairnessScore = clamp01(
    1 - ((normalizedVariance * 0.45) + (patternRepetitionScore * 0.35) + ((1 - shuffleEntropyScore) * 0.2))
  );

  return {
    handsByUser,
    metrics: {
      distribution_variance: distributionVariance,
      pattern_repetition_score: patternRepetitionScore,
      shuffle_entropy_score: shuffleEntropyScore,
      fairness_score: fairnessScore,
    },
  };
}

function pickCandidate(candidates = [], options = {}) {
  const randomPickProbability = Number.isFinite(Number(options?.randomPickProbability))
    ? Number(options.randomPickProbability)
    : RANDOM_PICK_PROBABILITY;
  const sorted = [...candidates].sort((a, b) => b.metrics.fairness_score - a.metrics.fairness_score);
  if (Math.random() < randomPickProbability) return sorted[secureRandomInt(sorted.length)];
  return sorted[0];
}

function run(simulations = 1000, options = {}) {
  const candidatesPerDeal = Math.max(1, Number(options?.candidatesPerDeal) || CANDIDATES);
  const randomPickProbability = Number.isFinite(Number(options?.randomPickProbability))
    ? Number(options.randomPickProbability)
    : RANDOM_PICK_PROBABILITY;
  const historyByUser = {};
  PLAYERS.forEach((userId) => { historyByUser[userId] = []; });
  const aggregate = {
    distribution_variance: 0,
    pattern_repetition_score: 0,
    shuffle_entropy_score: 0,
    fairness_score: 0,
  };

  for (let i = 0; i < simulations; i += 1) {
    const candidates = [];
    for (let j = 0; j < candidatesPerDeal; j += 1) {
      candidates.push(buildCandidate(historyByUser));
    }
    const chosen = pickCandidate(candidates, { randomPickProbability });
    Object.keys(aggregate).forEach((key) => {
      aggregate[key] += chosen.metrics[key];
    });

    PLAYERS.forEach((userId) => {
      const fp = buildHandFingerprint(chosen.handsByUser[userId] || []);
      historyByUser[userId] = [...historyByUser[userId].slice(-(HISTORY_LIMIT - 1)), fp];
    });
  }

  const avg = {};
  Object.keys(aggregate).forEach((key) => {
    avg[key] = Number((aggregate[key] / simulations).toFixed(4));
  });

  console.log(JSON.stringify({
    simulations,
    players: PLAYERS.length,
    cards_per_player: CARDS_PER_PLAYER,
    candidates_per_deal: candidatesPerDeal,
    random_pick_probability: randomPickProbability,
    average_metrics: avg,
  }, null, 2));
  return avg;
}

function runComparison(simulations = 1000) {
  const baseline = run(simulations, {
    candidatesPerDeal: 1,
    randomPickProbability: 1,
  });
  const improved = run(simulations, {
    candidatesPerDeal: CANDIDATES,
    randomPickProbability: RANDOM_PICK_PROBABILITY,
  });

  const delta = {
    distribution_variance: Number((improved.distribution_variance - baseline.distribution_variance).toFixed(4)),
    pattern_repetition_score: Number((improved.pattern_repetition_score - baseline.pattern_repetition_score).toFixed(4)),
    shuffle_entropy_score: Number((improved.shuffle_entropy_score - baseline.shuffle_entropy_score).toFixed(4)),
    fairness_score: Number((improved.fairness_score - baseline.fairness_score).toFixed(4)),
  };

  console.log(JSON.stringify({
    mode: 'comparison',
    simulations,
    baseline: {
      strategy: 'raw_random_single_candidate',
      average_metrics: baseline,
    },
    improved: {
      strategy: 'soft_balanced_multi_candidate',
      average_metrics: improved,
    },
    delta_improved_minus_baseline: delta,
  }, null, 2));
}

const simulations = Math.max(100, Number(process.argv[2]) || 1000);
const mode = String(process.argv[3] || 'single').trim().toLowerCase();
if (mode === 'compare' || mode === 'comparison') {
  runComparison(simulations);
} else {
  run(simulations);
}

