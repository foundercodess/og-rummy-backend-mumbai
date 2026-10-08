'use strict';

/**
 * Per-round outcome bias. Uses THIS round's area totals only.
 *
 *   min    → highest-staked side wins   (users win)
 *   medium → no bias                    (pure random, unchanged)
 *   high   → lowest-staked side wins    (house wins)
 *
 * Ties in stake size resolve deterministically in the order: dragon, tiger, tie.
 */

const SIDES = Object.freeze(['dragon', 'tiger', 'tie']);
const DIFFICULTIES = Object.freeze(['min', 'medium', 'high']);

function isDifficulty(value) {
    return DIFFICULTIES.includes(String(value || '').toLowerCase());
}

function normalizeDifficulty(value) {
    const d = String(value || '').toLowerCase();
    return isDifficulty(d) ? d : 'medium';
}

function pickHighest(totals) {
    let best = SIDES[0];
    for (const side of SIDES) {
        if (Number(totals[side] || 0) > Number(totals[best] || 0)) best = side;
    }
    return best;
}

function pickLowest(totals) {
    let worst = SIDES[0];
    for (const side of SIDES) {
        if (Number(totals[side] || 0) < Number(totals[worst] || 0)) worst = side;
    }
    return worst;
}

// /**
//  * @param {object} args
//  * @param {{dragon:number,tiger:number,tie:number}} args.totals  this round's area totals
//  * @param {'min'|'medium'|'high'} args.difficulty
//  * @returns {{ targetOutcome: 'dragon'|'tiger'|'tie'|null, difficulty: string }}
//  */
// function decideTarget({ totals, difficulty }) {
//     const tier = normalizeDifficulty(difficulty);

//     // 1. Manual override wins unconditionally.
//     if (overrideResult && SIDES.includes(overrideResult)) {
//         return { targetOutcome: overrideResult, difficulty: tier, source: 'override' };
//     }

//     // 2. Difficulty-based bias.
//     const safe = {
//         dragon: Number(totals?.dragon || 0),
//         tiger: Number(totals?.tiger || 0),
//         tie: Number(totals?.tie || 0),
//     };

//     //   const dragon = Number(totals?.dragon || 0);
//     //   const tiger = Number(totals?.tiger || 0);
//     //   const tie = Number(totals?.tie || 0);
//     //   const total = dragon + tiger + tie;

//     // No money in play → nothing to bias; let the shoe draw naturally.
//     if (total <= 0) return { targetOutcome: null, difficulty: tier };

//     if (tier === 'min') {
//         return { targetOutcome: pickHighest({ dragon, tiger, tie }), difficulty: tier };
//     }
//     if (tier === 'high') {
//         return { targetOutcome: pickLowest({ dragon, tiger, tie }), difficulty: tier };
//     }
//     return { targetOutcome: null, difficulty: tier };
// }

/**
 * Decide which side should win.
 *
 * Precedence:
 *   1. Manual override (admin picks exact winner)
 *   2. difficulty tier (min/medium/high)
 *   3. natural random
 */

/** Sides that have at least one real bet. */
function activeSides(totals) {
    return SIDES.filter((s) => Number(totals[s] || 0) > 0);
}

/** Highest staked among active sides. */
function pickHighestActive(totals) {
    const active = activeSides(totals);
    if (active.length === 0) return null;
    let best = active[0];
    for (const side of active) {
        if (Number(totals[side]) > Number(totals[best])) best = side;
    }
    return best;
}

/** Lowest staked among active sides. */
function pickLowestActive(totals) {
    const active = activeSides(totals);
    if (active.length === 0) return null;
    let worst = active[0];
    for (const side of active) {
        if (Number(totals[side]) < Number(totals[worst])) worst = side;
    }
    return worst;
}

function decideTarget({ totals, difficulty, overrideResult }) {
    const tier = normalizeDifficulty(difficulty);

    // 1. Manual override wins unconditionally.
    if (overrideResult && SIDES.includes(overrideResult)) {
        return { targetOutcome: overrideResult, difficulty: tier, source: 'override' };
    }

    // 2. Difficulty-based bias.
    const safe = {
        dragon: Number(totals?.dragon || 0),
        tiger: Number(totals?.tiger || 0),
        tie: Number(totals?.tie || 0),
    };

    const active = activeSides(safe);
    if (active.length === 0) {
        return { targetOutcome: null, difficulty: tier, source: 'random' };
    }

    if (tier === 'min') {
        return { targetOutcome: pickHighestActive(safe), difficulty: tier, source: 'difficulty' };
    }
    if (tier === 'high') {
        return { targetOutcome: pickLowestActive(safe), difficulty: tier, source: 'difficulty' };
    }
    return { targetOutcome: null, difficulty: tier, source: 'random' };
}

module.exports = {
    SIDES,
    DIFFICULTIES,
    isDifficulty,
    normalizeDifficulty,
    decideTarget,
};