'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  groupingService.js
//  Exported API (unchanged):
//    buildBestGrouping(cards, wildJoker, options)
//    buildSuitGroups(cards, wildJoker)
//    evaluateSubmittedGrouping(cards, wildJoker, submittedGroups)
// ─────────────────────────────────────────────────────────────────────────────

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];

const RANK_TO_VALUE = {
  A: 10, '2': 2, '3': 3, '4': 4, '5': 5,
  '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  J: 10, Q: 10, K: 10,
};

const RANK_TO_ORDER = {
  A: 1, '2': 2, '3': 3, '4': 4, '5': 5,
  '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  J: 11, Q: 12, K: 13,
};

const MIN_MELD_SIZE = 3;
const MAX_SET_SIZE = 4;
const MAX_SEQ_SIZE = 5;
const MAX_TOTAL_GROUPS = 6;

const GROUP_TYPE_PRIORITY = {
  pure_sequence: 0, impure_sequence: 1, set: 2,
  invalid_set_candidate: 3, invalid_sequence_candidate: 4,
  invalid_single: 5, invalid_mixed: 6,
};

// ─── Joker detection ──────────────────────────────────────────────────────────

// function isJoker(card, wildRank) {
//   if (!card) return false;
//   if (card.is_joker === true) return true;
//   if (wildRank != null && card.rank === wildRank) return true;
//   return false;
// }

function isPrintedJoker(card) {
  return !!card?.is_joker;
}

function isWildRankCard(card, wildRank) {
  return !!card && wildRank != null && card.rank === wildRank;
}

function isJoker(card, wildRank) {
  if (!card) return false;
  return isPrintedJoker(card) || isWildRankCard(card, wildRank);
}

// ─── Point helpers ────────────────────────────────────────────────────────────

function cardPoints(card, wildRank) {
  if (isJoker(card, wildRank)) return 0;
  return RANK_TO_VALUE[card.rank] || 0;
}

function sumPoints(cards, wildRank) {
  return cards.reduce((s, c) => s + cardPoints(c, wildRank), 0);
}

// ─── Rank helpers ─────────────────────────────────────────────────────────────

function rankOrderValue(rank, aceHigh) {
  if (rank === 'A' && aceHigh) return 14;
  return RANK_TO_ORDER[rank] || 0;
}

// ─── Meld validators ─────────────────────────────────────────────────────────

// function isPureSequence(cards, wildRank) {
//   if (cards.length < MIN_MELD_SIZE || cards.length > MAX_SEQ_SIZE) return false;
//   if (cards.some(c => isJoker(c, wildRank))) return false;
//   const suit = cards[0] && cards[0].suit;
//   if (!suit || !cards.every(c => c.suit === suit)) return false;
//   return _consecutiveRanks(cards, false) || _consecutiveRanks(cards, true);
// }

function isPureSequence(cards, wildRank) {
  if (cards.length < MIN_MELD_SIZE || cards.length > MAX_SEQ_SIZE) {
    return false;
  }

  // Printed jokers are NEVER allowed in pure sequence
  if (cards.some(c => isPrintedJoker(c))) {
    return false;
  }

  const suit = cards[0]?.suit;

  if (!suit || !cards.every(c => c.suit === suit)) {
    return false;
  }

  // IMPORTANT:
  // Wild-rank cards behave as NORMAL cards in pure sequence
  return (
    _consecutiveRanks(cards, false) ||
    _consecutiveRanks(cards, true)
  );
}

function _consecutiveRanks(cards, aceHigh) {
  const orders = cards.map(c => rankOrderValue(c.rank, aceHigh)).sort((a, b) => a - b);
  if (new Set(orders).size !== orders.length) return false;
  for (let i = 1; i < orders.length; i++) {
    if (orders[i] !== orders[i - 1] + 1) return false;
  }
  return true;
}

// function isImpureSequence(cards, wildRank) {
//   if (cards.length < MIN_MELD_SIZE || cards.length > MAX_SEQ_SIZE) return false;
//   const nonJokers  = cards.filter(c => !isJoker(c, wildRank));
//   const jokerCount = cards.length - nonJokers.length;
//   if (jokerCount === 0 || nonJokers.length === 0) return false;

//   const suit = nonJokers[0].suit;
//   if (!nonJokers.every(c => c.suit === suit)) return false;

//   for (const aceHigh of [false, true]) {
//     const orders = nonJokers.map(c => rankOrderValue(c.rank, aceHigh)).sort((a, b) => a - b);
//     if (new Set(orders).size !== orders.length) continue;

//     const totalLen = cards.length;
//     const maxStart = 15 - totalLen;
//     for (let start = 1; start <= maxStart; start++) {
//       const end = start + totalLen - 1;
//       if (
//         orders.every(r => r >= start && r <= end) &&
//         (totalLen - orders.length) <= jokerCount
//       ) return true;
//     }
//   }
//   return false;
// }

function isImpureSequence(cards, wildRank) {

  if (cards.length < MIN_MELD_SIZE || cards.length > MAX_SEQ_SIZE) {
    return false;
  }

  // already pure => not impure
  if (isPureSequence(cards, wildRank)) {
    return false;
  }

  const jokerCards = cards.filter(c =>
    isPrintedJoker(c) || isWildRankCard(c, wildRank)
  );

  const naturalCards = cards.filter(c =>
    !isPrintedJoker(c) &&
    !isWildRankCard(c, wildRank)
  );

  // at least 1 natural card needed
  if (naturalCards.length === 0) {
    return false;
  }

  // all natural cards must be same suit
  const suit = naturalCards[0].suit;

  if (!naturalCards.every(c => c.suit === suit)) {
    return false;
  }

  for (const aceHigh of [false, true]) {

    const orders = naturalCards
      .map(c => rankOrderValue(c.rank, aceHigh))
      .sort((a, b) => a - b);

    // duplicate natural ranks invalid
    if (new Set(orders).size !== orders.length) {
      continue;
    }

    const minOrder = Math.min(...orders);
    const maxOrder = Math.max(...orders);

    // total gaps inside current natural spread
    let requiredJokers = 0;

    for (let i = 1; i < orders.length; i++) {
      requiredJokers += (orders[i] - orders[i - 1] - 1);
    }

    // too many gaps
    if (requiredJokers > jokerCards.length) {
      continue;
    }

    // remaining jokers can extend left/right
    const remaining = jokerCards.length - requiredJokers;

    const totalLen = maxOrder - minOrder + 1 + remaining;

    if (totalLen === cards.length) {
      return true;
    }
  }

  return false;
}

function isSet(cards, wildRank) {
  if (cards.length < MIN_MELD_SIZE || cards.length > MAX_SET_SIZE) return false;
  const nonJokers = cards.filter(c => !isJoker(c, wildRank));
  if (nonJokers.length === 0) return false;
  const rank = nonJokers[0].rank;
  if (!nonJokers.every(c => c.rank === rank)) return false;
  if (nonJokers.length >= 2) {
    const suits = nonJokers.map(c => c.suit);
    if (new Set(suits).size !== suits.length) return false;
  }
  return true;
}

// ─── Meld enumeration ─────────────────────────────────────────────────────────

function _combinations(n, r, cb) {
  const idxs = [];
  (function pick(start) {
    if (idxs.length === r) { cb(idxs); return; }
    for (let i = start; i < n; i++) {
      idxs.push(i);
      pick(i + 1);
      idxs.pop();
    }
  })(0);
}

function _enumerateMelds(hand, wildRank) {
  const n = hand.length;
  const melds = [];

  for (let size = MIN_MELD_SIZE; size <= MAX_SEQ_SIZE; size++) {
    _combinations(n, size, (idxs) => {
      const cards = idxs.map(i => hand[i]);
      const mask = idxs.reduce((m, i) => m | (1 << i), 0);

      if (isPureSequence(cards, wildRank)) {
        melds.push({ mask, type: 'pure_sequence' });
      } else if (isImpureSequence(cards, wildRank)) {
        melds.push({ mask, type: 'impure_sequence' });
      } else if (size <= MAX_SET_SIZE && isSet(cards, wildRank)) {
        melds.push({ mask, type: 'set' });
      }
    });
  }
  return melds;
}

// ─── Sequence-priority bitmask DP ────────────────────────────────────────────
//
//  ROOT CAUSE OF THE SCREENSHOT BUG (summarised):
//
//  The old DP minimised raw "ungrouped card points" with no awareness of
//  whether the grouping satisfied the sequence declaration requirement.
//
//  For img-4 (7x4, 6x3, 3x3 available as sets; 6♥7♥8♥ available as pure seq):
//    Sets path:     ungrouped = {8♥,4♦,4♦,2♥} = 8+4+4+2 = 18 pts  ← DP chose this
//    Pure-seq path: breaking set 6♠6♥6♦ frees only 6♠6♦ as ungrouped,
//                   but 6♠6♦ (2 cards, invalid) + existing ungrouped
//                   → total ungrouped pts = 22 pts
//
//  18 < 22 so the old DP was arithmetically correct but game-rule wrong:
//  neither path satisfies ≥1 pure + ≥2 seq, so BOTH pay totalPoints (~73).
//  The DP needed to know that "any path reaching seqState==3 beats any path
//  that never reaches it, regardless of raw ungrouped pts."
//
//  FIX: encode sequence progress as a 4-value seqState dimension in the DP.
//
//  seqState transitions when adding a meld:
//    pure_sequence:   0→1, 1→3, 2→3, 3→3
//    impure_sequence: 0→2, 1→3, 2→2, 3→3
//    set:             s→s  (sets never advance seqState)
//
//  Composite DP score:
//    seqState == 3  →  ungroupedPts              (satisfied: only bad cards cost)
//    seqState  < 3  →  BIG_OFFSET + ungroupedPts (unsatisfied: heavy penalty)
//
//  BIG_OFFSET (200) > max possible hand points (130), so any satisfied path
//  always beats any unsatisfied path.  Within each tier, tiebreak is raw
//  ungrouped points (favour fewer/cheaper ungrouped cards).

// const BIG_OFFSET = 200; // must be > max hand total points (≤ 130 for 13 cards)

const STATE_PENALTY = {
  0: 4000, // no seq
  2: 3000, // impure only
  1: 2000, // pure only
  3: 0     // fully satisfied
};

function _nextSeqState(seqState, meldType) {
  if (meldType === 'pure_sequence') {
    // 0: no seqs yet → 1: have ≥1 pure, need 2nd seq
    // 1: have pure, need 2nd → 3: satisfied (2nd seq is this pure)
    // 2: have impure, no pure → 3: now have pure + impure = satisfied
    // 3: already satisfied
    return seqState === 0 ? 1 : 3;
  }
  if (meldType === 'impure_sequence') {
    // 0 → 2: have 1 impure, no pure yet
    // 1 → 3: had pure, this is 2nd seq → satisfied
    // 2 → 2: still no pure seq
    // 3 → 3: already satisfied
    if (seqState === 0) return 2;
    if (seqState === 1) return 3;
    return seqState; // 2 stays 2, 3 stays 3
  }
  return seqState; // set: no change
}

function _runDP(hand, wildRank, melds) {
  const n = hand.length;
  const fullMask = (1 << n) - 1;
  const INF = 999999;
  const SEQ_STATES = 4; // 0,1,2,3

  // Pre-compute ungrouped-point cost of every card subset
  const subsetPts = new Int32Array(1 << n);
  for (let mask = 1; mask <= fullMask; mask++) {
    let pts = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) pts += cardPoints(hand[i], wildRank);
    }
    subsetPts[mask] = pts;
  }

  // Flat arrays indexed by (mask * SEQ_STATES + seqState)
  const stateCount = (fullMask + 1) * SEQ_STATES;
  const dp = new Int32Array(stateCount).fill(INF);
  const par = new Array(stateCount).fill(null);

  // idx(mask, s) = flat array index
  const idx = (mask, s) => (mask * SEQ_STATES) + s;

  // Base cases: 0 cards remaining → 0 ungrouped cost regardless of seqState
  for (let s = 0; s < SEQ_STATES; s++) dp[idx(0, s)] = 0;

  // Fill DP in ascending mask order so sub-problems are always ready
  for (let mask = 1; mask <= fullMask; mask++) {
    const ungroupedPts = subsetPts[mask];
    for (let s = 0; s < SEQ_STATES; s++) {
      dp[idx(mask, s)] = STATE_PENALTY[s] + ungroupedPts;
      par[idx(mask, s)] = null;

      for (const meld of melds) {
        if ((mask & meld.mask) !== meld.mask) continue; // meld cards not all in mask
        const sub = mask ^ meld.mask;             // remaining cards after meld
        const nextS = _nextSeqState(s, meld.type);
        const subDP = dp[idx(sub, nextS)];
        if (subDP === INF) continue;

        // Using this meld costs 0 pts (valid meld); sub-problem handles the rest
        // if (subDP < dp[idx(mask, s)]) {
        //   dp[idx(mask, s)]  = subDP;
        //   par[idx(mask, s)] = { sub, meldMask: meld.mask, type: meld.type, nextS };
        // }
        const current = par[idx(mask, s)];

        let shouldTake = false;

        if (subDP < dp[idx(mask, s)]) {
          shouldTake = true;
        }
        else if (subDP === dp[idx(mask, s)]) {

          // tie-break priority

          const curType = current?.type;

          const score = type => {
            switch (type) {
              case 'pure_sequence': return 3;
              case 'impure_sequence': return 2;
              case 'set': return 1;
              default: return 0;
            }
          };

          // if (score(meld.type) > score(curType)) {
          //   shouldTake = true;
          // }

          // const currentNextState = current?.nextS ?? -1;

          // if (nextS > currentNextState) {
          //   shouldTake = true;
          // }
          // else if (nextS === currentNextState) {
          //   if (score(meld.type) > score(curType)) {
          //     shouldTake = true;
          //   }
          // }

          const currentNextState = current?.nextS ?? -1;

          if (nextS > currentNextState) {
            shouldTake = true;
          }
          else if (nextS === currentNextState) {

            const curType = current?.type;

            const score = type => {
              switch (type) {
                case 'pure_sequence': return 3;
                case 'impure_sequence': return 2;
                case 'set': return 1;
                default: return 0;
              }
            };

            if (score(meld.type) > score(curType)) {
              shouldTake = true;
            }
          }
        }

        if (shouldTake) {
          const meldPenalty = _meldDisplayPenalty(meld, nextS, subsetPts);
          dp[idx(mask, s)] = subDP + meldPenalty;
          par[idx(mask, s)] = {
            sub,
            meldMask: meld.mask,
            type: meld.type,
            nextS
          };
        }
      }
    }
  }

  return { dp, par, subsetPts, idx };
}

function _displayPointForDpTrace(hand, wildRank, groups, ungrouped) {
  const grouped = groups.map((meld, i) => ({
    group_id: i + 1,
    type: meld.type,
    cards: meld.cards,
    group_points: 0,
    is_valid_meld: true,
  }));
  const ungroupedGroups = buildUngroupedGroups(ungrouped, wildRank, grouped.length + 1, true);
  const allGroups = capGroupsToMax([...grouped, ...ungroupedGroups], true);
  const pureCount = groups.filter((m) => m.type === 'pure_sequence').length;
  const impureCount = groups.filter((m) => m.type === 'impure_sequence').length;
  const seqCount = pureCount + impureCount;
  const allGrouped =
    ungrouped.length === 0 ||
    hasOnlyZeroPointUngrouped(ungrouped, wildRank);
  const validForDeclare = allGrouped && pureCount >= 1 && seqCount >= 2;
  const groupsWithPts = applyGroupDisplayPoints(allGroups, {
    pure_sequence_count: pureCount,
    sequence_count: seqCount,
    valid_for_declare: validForDeclare,
  }, wildRank);
  return computeDisplayPoint({
    validForDeclare,
    handCards: hand,
    groups: groupsWithPts,
    ungrouped,
    wildRank,
    pureCount,
    seqCount,
  });
}

function _pickBestDpTrace(hand, wildRank, dp, par, idx) {
  const fullMask = (1 << hand.length) - 1;
  let bestTrace = null;
  let bestDisplay = Infinity;
  let bestCost = Infinity;

  for (let s = 0; s < 4; s++) {
    if (s > 0 && par[idx(fullMask, s)] == null) continue;
    const traced = _traceGrouping(hand, par, idx, fullMask, s);
    const displayPoint = _displayPointForDpTrace(hand, wildRank, traced.groups, traced.ungrouped);
    const cost = dp[idx(fullMask, s)];
    const better =
      displayPoint < bestDisplay ||
      (displayPoint === bestDisplay && cost < bestCost) ||
      (displayPoint === bestDisplay && cost === bestCost && s > (bestTrace?.endS ?? -1));
    if (better) {
      bestDisplay = displayPoint;
      bestCost = cost;
      bestTrace = { ...traced, endS: s };
    }
  }

  return bestTrace || _traceGrouping(hand, par, idx, fullMask, 0);
}

function _traceGrouping(hand, par, idx, startMask, startS) {
  const fullMask = (1 << hand.length) - 1;
  const groups = [];
  let cur = startMask != null ? startMask : fullMask;
  let s = startS != null ? startS : 0;

  while (cur > 0 && par[idx(cur, s)] !== null) {
    const { sub, meldMask, type, nextS } = par[idx(cur, s)];
    const cards = [];
    for (let i = 0; i < hand.length; i++) {
      if (meldMask & (1 << i)) cards.push(hand[i]);
    }
    groups.push({ type, cards });
    cur = sub;
    s = nextS;
  }

  // Remaining bits in cur = ungrouped cards
  const ungrouped = [];
  for (let i = 0; i < hand.length; i++) {
    if (cur & (1 << i)) ungrouped.push(hand[i]);
  }
  return { groups, ungrouped };
}

// ─── Sort helpers ─────────────────────────────────────────────────────────────

function sortGroupCards(cards, wildRank, groupType, forceSort) {
  if (!forceSort) return [...cards];

  const jokers = cards.filter(c => isJoker(c, wildRank));
  const nonJokers = cards.filter(c => !isJoker(c, wildRank));

  if (groupType === 'set') {
    const suitIdx = s => SUITS.indexOf(s);
    return [
      ...nonJokers.sort((a, b) => suitIdx(a.suit) - suitIdx(b.suit)),
      ...jokers,
    ];
  }

  if (groupType === 'pure_sequence' || groupType === 'impure_sequence') {
    const hasAce = nonJokers.some(c => c.rank === 'A');
    const hasKing = nonJokers.some(c => c.rank === 'K');
    const hasTwo = nonJokers.some(c => c.rank === '2');
    const aceHigh = hasAce && hasKing && !hasTwo;
    const rankOf = c => (c.rank === 'A' && aceHigh ? 14 : RANK_TO_ORDER[c.rank] || 0);

    const sorted = [...nonJokers].sort((a, b) => rankOf(a) - rankOf(b));
    if (jokers.length === 0) return sorted;

    // Interleave jokers into rank gaps
    const result = [];
    let jokerPool = [...jokers];
    const minR = rankOf(sorted[0]);
    const maxR = rankOf(sorted[sorted.length - 1]);
    let nIdx = 0;
    for (let r = minR; r <= maxR; r++) {
      if (nIdx < sorted.length && rankOf(sorted[nIdx]) === r) result.push(sorted[nIdx++]);
      else if (jokerPool.length) result.push(jokerPool.shift());
    }
    result.push(...jokerPool);
    return result;
  }

  return sortCardsForDisplay(cards, forceSort);
}

function sortCardsForDisplay(cards, forceSort) {
  if (!forceSort) return [...cards];
  return [...cards].sort((a, b) => {
    const aRank = a.rank === 'A' ? 14 : (RANK_TO_ORDER[a.rank] || 0);
    const bRank = b.rank === 'A' ? 14 : (RANK_TO_ORDER[b.rank] || 0);
    if (aRank !== bRank) return aRank - bRank;
    return String(a.card_uid || '').localeCompare(String(b.card_uid || ''));
  });
}

// ─── Ungrouped-card output helpers ────────────────────────────────────────────

function getInvalidGroupType(cards) {
  return cards.length >= 2 ? 'invalid_sequence_candidate' : 'invalid_single';
}

function isInvalidSetCandidate(cards, wildRank) {
  if (!Array.isArray(cards) || cards.length < 2) return false;
  const natural = cards.filter((c) => !isJoker(c, wildRank));
  if (natural.length < 2) return false;
  const ranks = new Set(natural.map((c) => c.rank));
  return ranks.size === 1;
}

function getInvalidClusterType(cards, wildRank) {
  if (!Array.isArray(cards) || cards.length <= 1) return 'invalid_single';
  if (isInvalidSetCandidate(cards, wildRank)) return 'invalid_set_candidate';
  return 'invalid_sequence_candidate';
}

function clusterSequenceIndices(sortedIdxs, cards, wildRank) {
  if (sortedIdxs.length < 2) return [];

  const chains = [];
  let chain = [sortedIdxs[0]];

  for (let i = 1; i < sortedIdxs.length; i++) {
    const idx = sortedIdxs[i];
    const prevIdx = chain[chain.length - 1];
    const prev = cards[prevIdx];
    const cur = cards[idx];
    const prevOrder = rankOrderValue(prev.rank, false);
    const curOrder = rankOrderValue(cur.rank, false);

    if (curOrder <= prevOrder) {
      if (chain.length >= 2) chains.push([...chain]);
      chain = [idx];
      continue;
    }

    const gap = curOrder - prevOrder;
    const jokersInChain = chain.filter((ci) => isJoker(cards[ci], wildRank)).length;
    const missingBetween = Math.max(0, gap - 1);
    // One missing rank or wild fill keeps cards in the same potential-sequence bucket.
    if (missingBetween <= 1 + jokersInChain) {
      chain.push(idx);
      continue;
    }

    if (chain.length >= 2) chains.push([...chain]);
    chain = [idx];
  }

  if (chain.length >= 2) chains.push(chain);
  return chains;
}

function clusterInvalidCards(cards, wildRank) {
  const n = cards.length;
  if (n === 0) return [];

  const used = new Set();
  const clusters = [];

  const takeCluster = (indices) => {
    const picked = indices.filter((i) => !used.has(i));
    if (picked.length === 0) return;
    picked.forEach((i) => used.add(i));
    clusters.push(picked.map((i) => cards[i]));
  };

  // 1) Set candidates — same rank, 2+ natural cards.
  const byRank = new Map();
  for (let i = 0; i < n; i++) {
    const card = cards[i];
    if (isJoker(card, wildRank)) continue;
    const rank = card.rank || 'unknown';
    if (!byRank.has(rank)) byRank.set(rank, []);
    byRank.get(rank).push(i);
  }

  [...byRank.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([, idxs]) => {
      const available = idxs.filter((i) => !used.has(i));
      if (available.length >= 2) {
        takeCluster(available.slice(0, MAX_SET_SIZE));
      }
    });

  // 2) Sequence candidates — same suit, proximate ranks (one card away from valid seq).
  const bySuit = new Map();
  for (let i = 0; i < n; i++) {
    if (used.has(i)) continue;
    const card = cards[i];
    if (isJoker(card, wildRank) || !card.suit) continue;
    if (!bySuit.has(card.suit)) bySuit.set(card.suit, []);
    bySuit.get(card.suit).push(i);
  }

  for (const [, idxs] of bySuit) {
    const available = idxs.filter((i) => !used.has(i));
    if (available.length < 2) continue;
    const sorted = [...available].sort(
      (a, b) => rankOrderValue(cards[a].rank, false) - rankOrderValue(cards[b].rank, false)
    );
    clusterSequenceIndices(sorted, cards, wildRank).forEach((chain) => takeCluster(chain));
  }

  // 3) Jokers — attach to the best nearby sequence bucket, else keep together.
  const jokerIdxs = [];
  for (let i = 0; i < n; i++) {
    if (!used.has(i) && isJoker(cards[i], wildRank)) jokerIdxs.push(i);
  }
  if (jokerIdxs.length > 0) {
    let attached = false;
    for (let ci = clusters.length - 1; ci >= 0; ci--) {
      const cluster = clusters[ci];
      if (getInvalidClusterType(cluster, wildRank) !== 'invalid_sequence_candidate') continue;
      jokerIdxs.forEach((ji) => {
        used.add(ji);
        cluster.push(cards[ji]);
      });
      attached = true;
      break;
    }
    if (!attached) takeCluster(jokerIdxs);
  }

  // 4) Remaining rank pairs and singles.
  const remainingByRank = new Map();
  for (let i = 0; i < n; i++) {
    if (used.has(i)) continue;
    const card = cards[i];
    if (isJoker(card, wildRank)) continue;
    const rank = card.rank || 'unknown';
    if (!remainingByRank.has(rank)) remainingByRank.set(rank, []);
    remainingByRank.get(rank).push(i);
  }
  [...remainingByRank.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([, idxs]) => {
      const available = idxs.filter((i) => !used.has(i));
      if (available.length >= 2) takeCluster(available);
    });

  for (let i = 0; i < n; i++) {
    if (!used.has(i)) takeCluster([i]);
  }

  return clusters;
}

function buildUngroupedGroups(cards, wildRank, startGroupId, forceSort) {
  const suitOrder = new Map(SUITS.map((s, i) => [s, i]));

  return clusterInvalidCards(cards, wildRank)
    .sort((a, b) => {
      const typeA = getInvalidClusterType(a, wildRank);
      const typeB = getInvalidClusterType(b, wildRank);
      const pa = GROUP_TYPE_PRIORITY[typeA] ?? 99;
      const pb = GROUP_TYPE_PRIORITY[typeB] ?? 99;
      if (pa !== pb) return pa - pb;
      if (b.length !== a.length) return b.length - a.length;
      const aOrd = RANK_TO_ORDER[a[0]?.rank] || 99;
      const bOrd = RANK_TO_ORDER[b[0]?.rank] || 99;
      if (aOrd !== bOrd) return aOrd - bOrd;
      const aSOrd = suitOrder.get(a[0]?.suit) ?? 99;
      const bSOrd = suitOrder.get(b[0]?.suit) ?? 99;
      if (aSOrd !== bSOrd) return aSOrd - bSOrd;
      return String(a[0]?.card_uid || '').localeCompare(String(b[0]?.card_uid || ''));
    })
    .map((bucketCards, i) => ({
      group_id: startGroupId + i,
      type: getInvalidClusterType(bucketCards, wildRank),
      cards: sortCardsForDisplay(bucketCards, forceSort),
      group_points: sumPoints(bucketCards, wildRank),
      is_valid_meld: false,
    }));
}

function capGroupsToMax(allGroups, forceSort) {
  const sorted = forceSort
    ? [...allGroups].sort((a, b) => {
      const pa = GROUP_TYPE_PRIORITY[a.type] ?? 99;
      const pb = GROUP_TYPE_PRIORITY[b.type] ?? 99;
      if (pa !== pb) return pa - pb;
      return (b.cards?.length || 0) - (a.cards?.length || 0);
    })
    : [...allGroups];

  if (sorted.length <= MAX_TOTAL_GROUPS) {
    return sorted.map((g, i) => ({ ...g, group_id: i + 1 }));
  }

  const valid = sorted.filter(g => g.is_valid_meld);
  const invalid = sorted.filter(g => !g.is_valid_meld);
  const maxInvalidSlots = Math.max(0, MAX_TOTAL_GROUPS - valid.length);

  let finalInvalid;
  if (maxInvalidSlots === 0) {
    finalInvalid = [];
  } else if (invalid.length <= maxInvalidSlots) {
    finalInvalid = invalid;
  } else {
    const kept = invalid.slice(0, maxInvalidSlots - 1);
    const overflow = invalid.slice(maxInvalidSlots - 1);
    finalInvalid = [
      ...kept,
      {
        group_id: 0,
        type: 'invalid_mixed',
        cards: overflow.flatMap(g => g.cards),
        group_points: overflow.reduce((s, g) => s + g.group_points, 0),
        is_valid_meld: false,
      },
    ];
  }

  return [...valid, ...finalInvalid].map((g, i) => ({ ...g, group_id: i + 1 }));
}

function assertNoDuplicateCardUsage(handCards, groups, ungrouped, context) {
  const seen = new Set();
  const handSet = new Set(handCards.map(c => c.card_uid));

  const record = (card, src) => {
    const uid = card.card_uid;
    if (!handSet.has(uid)) throw new Error(`${context}: card ${uid} not in hand (${src})`);
    if (seen.has(uid)) throw new Error(`${context}: duplicate card ${uid} (${src})`);
    seen.add(uid);
  };

  groups.forEach((g, i) => g.cards.forEach(c => record(c, `group ${i + 1}`)));
  ungrouped.forEach(c => record(c, 'ungrouped'));

  if (seen.size !== handSet.size) {
    throw new Error(`${context}: card count mismatch (seen ${seen.size}, hand ${handSet.size})`);
  }
}

function computeDisplayPoint({
  validForDeclare = false,
  handCards = [],
  groups = [],
  ungrouped = [],
  wildRank = null,
  pureCount = 0,
  seqCount = 0,
}) {
  const totalPoints = sumPoints(handCards, wildRank);
  if (validForDeclare) return 0;
  if (pureCount < 1) return totalPoints;

  const seqRequirementMet = pureCount >= 1 && seqCount >= 2;
  if (!seqRequirementMet) {
    const pureUids = new Set();
    groups.forEach((group) => {
      if (group?.is_valid_meld === true && group.type === 'pure_sequence') {
        (group.cards || []).forEach((card) => pureUids.add(card.card_uid));
      }
    });
    let pts = 0;
    handCards.forEach((card) => {
      if (pureUids.has(card.card_uid)) return;
      pts += cardPoints(card, wildRank);
    });
    return pts;
  }

  const invalidUids = new Set();
  let invalidGroupPoints = 0;
  groups.forEach((group) => {
    if (group?.is_valid_meld === true) return;
    (group.cards || []).forEach((card) => {
      const uid = typeof card === 'string' ? card : card.card_uid;
      if (uid) invalidUids.add(uid);
    });
    invalidGroupPoints += Number(group.group_points) || 0;
  });
  const extraUngroupedPoints = sumPoints(
    ungrouped.filter(
      (card) =>
        !invalidUids.has(card.card_uid) && !isZeroPointUngrouped(card, wildRank)
    ),
    wildRank
  );
  return invalidGroupPoints + extraUngroupedPoints;
}

function applyGroupDisplayPoints(groups = [], summary = {}, wildRank = null) {
  const pureCount = Number(summary.pure_sequence_count) || 0;
  const seqCount = Number(summary.sequence_count) || 0;
  const validForDeclare = summary.valid_for_declare === true;
  const seqRequirementMet = pureCount >= 1 && seqCount >= 2;

  return groups.map((group) => {
    const cards = Array.isArray(group?.cards) ? group.cards : [];
    if (validForDeclare) {
      return { ...group, group_points: group.is_valid_meld ? 0 : group.group_points };
    }
    if (pureCount < 1) {
      return {
        ...group,
        group_points: group.is_valid_meld ? sumPoints(cards, wildRank) : group.group_points,
      };
    }
    if (!seqRequirementMet) {
      if (group.is_valid_meld && group.type === 'pure_sequence') {
        return { ...group, group_points: 0 };
      }
      if (group.is_valid_meld) {
        return { ...group, group_points: sumPoints(cards, wildRank) };
      }
      return group;
    }
    return { ...group, group_points: group.is_valid_meld ? 0 : group.group_points };
  });
}

function _meldDisplayPenalty(meld, nextSeqState, subsetPts) {
  if (meld.type === 'pure_sequence') return 0;
  if (nextSeqState === 3) return 0;
  return subsetPts[meld.mask];
}

// ─── buildBestGrouping ────────────────────────────────────────────────────────

function buildBestGrouping(cards, wildJoker, options) {
  const hand = Array.isArray(cards) ? cards.slice() : [];
  const wildRank = wildJoker != null ? (wildJoker.rank || null) : null;
  const n = hand.length;

  if (n === 0) return _emptyResult();

  const melds = _enumerateMelds(hand, wildRank);
  const { dp, par, idx } = _runDP(hand, wildRank, melds);
  const { groups, ungrouped } = _pickBestDpTrace(hand, wildRank, dp, par, idx);

  const grouped = groups.map((meld, i) => ({
    group_id: i + 1,
    type: meld.type,
    cards: sortGroupCards(meld.cards, wildRank, meld.type, true),
    group_points: 0,
    is_valid_meld: true,
  }));

  const ungroupedGroups = buildUngroupedGroups(ungrouped, wildRank, grouped.length + 1, true);
  const allGroups = capGroupsToMax([...grouped, ...ungroupedGroups], true);
  assertNoDuplicateCardUsage(hand, allGroups, [], 'best_grouping');

  const pureCount = groups.filter(m => m.type === 'pure_sequence').length;
  const impureCount = groups.filter(m => m.type === 'impure_sequence').length;
  const seqCount = pureCount + impureCount;
  // const allGrouped = ungrouped.length === 0;
  const allGrouped =
    ungrouped.length === 0 ||
    hasOnlyZeroPointUngrouped(ungrouped, wildRank);
  const validForDeclare = allGrouped && pureCount >= 1 && seqCount >= 2;
  const totalPoints = sumPoints(hand, wildRank);
  const ungroupedCardPoints = ungroupedGroups.reduce((s, g) => s + g.group_points, 0);

  const summaryBase = {
    valid_for_declare: validForDeclare,
    all_cards_grouped: allGrouped,
    invalid_group_count:
      ungroupedGroups.filter(
        g => g.group_points > 0
      ).length,
    pure_sequence_count: pureCount,
    sequence_count: seqCount,
    grouped_cards_count:
      hand.length -
      ungrouped.filter(c => !isZeroPointUngrouped(c, wildRank)).length,
    ungrouped_cards_count:
      ungrouped.filter(c => !isZeroPointUngrouped(c, wildRank)).length,
    grouped_points: grouped.reduce((s, g) => s + g.group_points, 0),
    ungrouped_points: sumPoints(ungrouped, wildRank),
    hand_points: totalPoints,
    grouping_confidence: null,
    decision_margin: null,
    alternative_count: null,
  };
  const displayPoint = computeDisplayPoint({
    validForDeclare,
    handCards: hand,
    groups: allGroups,
    ungrouped,
    wildRank,
    pureCount,
    seqCount,
  });
  const groupsWithDisplayPoints = applyGroupDisplayPoints(allGroups, {
    ...summaryBase,
    display_point: displayPoint,
  }, wildRank);

  return {
    groups: groupsWithDisplayPoints,
    ungrouped_cards: ungrouped,
    summary: {
      ...summaryBase,
      display_point: displayPoint,
    },
  };
}

function _emptyResult() {
  return {
    groups: [],
    ungrouped_cards: [],
    summary: {
      valid_for_declare: false,
      all_cards_grouped: true,
      invalid_group_count: 0,
      pure_sequence_count: 0,
      sequence_count: 0,
      grouped_cards_count: 0,
      ungrouped_cards_count: 0,
      grouped_points: 0,
      ungrouped_points: 0,
      display_point: 0,
      hand_points: 0,
      grouping_confidence: null,
      decision_margin: null,
      alternative_count: null,
    },
  };
}

// ─── evaluateSubmittedGrouping ────────────────────────────────────────────────

function evaluateSubmittedGrouping(cards, wildJoker, submittedGroups) {
  const handCards = Array.isArray(cards) ? cards : [];
  const wildRank = wildJoker != null ? (wildJoker.rank || null) : null;
  const cardMap = new Map(handCards.map(c => [c.card_uid, c]));
  const used = new Set();

  const groups = (submittedGroups || []).map((group, idx) => {
    const resolved = (group.cards || []).map(cid => {
      const c = cardMap.get(cid);
      if (!c) throw new Error(`Card ${cid} not found in hand`);
      if (used.has(cid)) throw new Error(`Duplicate card ${cid} in submitted grouping`);
      used.add(cid);
      return c;
    });

    let type = getInvalidGroupType(resolved);
    let valid = false;

    if (isPureSequence(resolved, wildRank)) { type = 'pure_sequence'; valid = true; }
    else if (isImpureSequence(resolved, wildRank)) { type = 'impure_sequence'; valid = true; }
    else if (isSet(resolved, wildRank)) { type = 'set'; valid = true; }

    return {
      group_id: group.group_id || idx + 1,
      type,
      cards: resolved,          // never reorder submitted groups
      group_points: valid ? 0 : sumPoints(resolved, wildRank),
      is_valid_meld: valid,
    };
  });

  const ungrouped = handCards.filter(c => !used.has(c.card_uid));
  const pureCount = groups.filter(g => g.type === 'pure_sequence').length;
  const seqCount = groups.filter(g => g.type === 'pure_sequence' || g.type === 'impure_sequence').length;
  // const invalidCount = groups.filter(g => !g.is_valid_meld).length;
  const invalidCount =
    groups.filter(
      g => !g.is_valid_meld && g.group_points > 0
    ).length;
  // const allGrouped = used.size === handCards.length;
  const remainingUngrouped =
    handCards.filter(c => !used.has(c.card_uid));

  const allGrouped =
    remainingUngrouped.length === 0 ||
    hasOnlyZeroPointUngrouped(remainingUngrouped, wildRank);
  const validForDeclare = allGrouped && invalidCount === 0 && pureCount >= 1 && seqCount >= 2;
  const totalPoints = sumPoints(handCards, wildRank);

  const ungroupedGroups = buildUngroupedGroups(ungrouped, wildRank, groups.length + 1, false);
  const allGroups = capGroupsToMax([...groups, ...ungroupedGroups], false);
  assertNoDuplicateCardUsage(handCards, allGroups, [], 'submitted_grouping');

  const summaryBase = {
    valid_for_declare: validForDeclare,
    all_cards_grouped: allGrouped,
    invalid_group_count: invalidCount,
    pure_sequence_count: pureCount,
    sequence_count: seqCount,
    grouped_cards_count: used.size,
    ungrouped_cards_count: ungrouped.length,
    grouped_points: groups.reduce((s, g) => s + g.group_points, 0),
    ungrouped_points: sumPoints(ungrouped, wildRank),
    hand_points: totalPoints,
    grouping_confidence: null,
    decision_margin: null,
    alternative_count: null,
  };
  const displayPoint = computeDisplayPoint({
    validForDeclare,
    handCards,
    groups: allGroups,
    ungrouped,
    wildRank,
    pureCount,
    seqCount,
  });

  const groupsWithDisplayPoints = applyGroupDisplayPoints(allGroups, {
    ...summaryBase,
    display_point: displayPoint,
  }, wildRank);

  return {
    groups: groupsWithDisplayPoints,
    ungrouped_cards: ungrouped,
    summary: {
      ...summaryBase,
      display_point: displayPoint,
    },
  };
}

// ─── buildSuitGroups ──────────────────────────────────────────────────────────

function buildSuitGroups(cards, wildJoker) {
  const handCards = Array.isArray(cards) ? cards : [];
  const wildRank = wildJoker != null ? (wildJoker.rank || null) : null;

  const suitBuckets = { spades: [], hearts: [], diamonds: [], clubs: [] };
  const jokers = [];

  handCards.forEach(card => {
    if (isJoker(card, wildRank)) jokers.push(card);
    else if (card.suit && suitBuckets[card.suit]) suitBuckets[card.suit].push(card);
    else jokers.push(card);
  });

  const groups = [];
  let gid = 1;

  for (const suit of SUITS) {
    const bucket = suitBuckets[suit];
    if (bucket.length === 0) continue;
    const sorted = [...bucket].sort(
      (a, b) => (RANK_TO_ORDER[a.rank] || 0) - (RANK_TO_ORDER[b.rank] || 0),
    );
    groups.push({
      group_id: gid++,
      type: getInvalidGroupType(sorted),
      cards: sorted,
      group_points: sumPoints(sorted, wildRank),
      is_valid_meld: false,
    });
  }

  if (jokers.length) {
    groups.push({
      group_id: gid,
      type: getInvalidGroupType(jokers),
      cards: jokers,
      group_points: 0,
      is_valid_meld: false,
    });
  }

  const totalPoints = sumPoints(handCards, wildRank);
  const groupedPoints = groups.reduce((s, g) => s + g.group_points, 0);

  return {
    groups,
    ungrouped_cards: [],
    summary: {
      valid_for_declare: false,
      all_cards_grouped: true,
      invalid_group_count: groups.length,
      pure_sequence_count: 0,
      sequence_count: 0,
      grouped_cards_count: handCards.length,
      ungrouped_cards_count: 0,
      grouped_points: groupedPoints,
      ungrouped_points: 0,
      display_point: groupedPoints,
      hand_points: totalPoints,
      grouping_confidence: null,
      decision_margin: null,
      alternative_count: null,
    },
  };
}

function isZeroPointUngrouped(card, wildRank) {
  return isJoker(card, wildRank);
}
function hasOnlyZeroPointUngrouped(cards, wildRank) {
  return cards.every(c => isZeroPointUngrouped(c, wildRank));
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  buildBestGrouping,
  buildSuitGroups,
  evaluateSubmittedGrouping,
  computeDisplayPoint,
  applyGroupDisplayPoints,
};