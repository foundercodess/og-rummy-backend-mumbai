'use strict';

/**
 * Dragon Tiger round loop. Runs on exactly one process (Redis leader lock);
 * every other worker only serves sockets. Postgres is the source of truth, so a
 * new leader resumes whatever round is open.
 *
 *   betting (N s) -> lock + draw -> reveal (cards flip) -> result
 *     -> intermission (dt:new_game, 3 s) -> next round
 */

const { startProcessLeader } = require('../../services/processLeader.service');
const settingsService = require('../../services/dragontiger/dtSettings.service');
const repo = require('../../services/dragontiger/dtRound.repository');
const { settleUserForRound } = require('../../services/dragontiger/dtWallet.service');
const { decideOutcome } = require('../../services/dragontiger/dtRules.service');
const { DragonTigerShoe } = require('../../services/dragontiger/dtShoe.service');
const { buildSeats, rotateSeats } = require('../../services/dragontiger/dtBots.service');
const { TABLE_ROOM, userRoom } = require('./rooms');
const { INTERMISSION_MS } = require('./phase');
const { decideTarget } = require('../../services/dragontiger/dtBias.service');
const PAUSE_POLL_MS = 3000;
const ERROR_BACKOFF_MS = 2000;
const SEAT_ROTATE_EVERY_ROUNDS = 6;
const SETTLE_CONCURRENCY = 8;
const HISTORY_IN_RESULT = 20;

let ioRef = null;
let leaderHandle = null;
let runToken = 0;
let shoe = null;
let seats = null;
let roundsSinceRotate = 0;
let pausedAnnounced = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function toMs(value) {
  return new Date(value).getTime();
}

function emitTable(event, payload) {
  if (!ioRef) return;
  ioRef.to(TABLE_ROOM).emit(event, { ...payload, server_time: new Date().toISOString() });
}

function emitUser(userId, event, payload) {
  if (!ioRef) return;
  ioRef.to(userRoom(userId)).emit(event, { ...payload, server_time: new Date().toISOString() });
}

async function nextSeats() {
  if (!seats) {
    seats = await buildSeats();
    roundsSinceRotate = 0;
  } else if (++roundsSinceRotate >= SEAT_ROTATE_EVERY_ROUNDS) {
    seats = await rotateSeats(seats);
    roundsSinceRotate = 0;
  }
  return seats;
}

async function openNewRound(settings) {
  const roundSeats = await nextSeats();
  const bettingEndsAt = new Date(Date.now() + settings.betting_seconds * 1000);
  const round = await repo.createRound({
    bettingEndsAt,
    commissionPercent: settings.commission_percent,
    revealSeconds: settings.reveal_seconds,
    resultSeconds: settings.result_seconds,
    meta: { seats: roundSeats },
  });
  if (!round) return null;
  emitTable('dt:round', {
    round_id: Number(round.id),
    phase: 'betting',
    betting_ends_at: new Date(round.betting_ends_at).toISOString(),
    seats: roundSeats,
  });
  return round;
}

// async function lockRound(round) {
//   if (!shoe) shoe = new DragonTigerShoe();
//   const pair = shoe.drawPair();
//   const locked = await repo.lockAndReveal(round.id, {
//     dragonCard: pair.dragon,
//     tigerCard: pair.tiger,
//     result: decideOutcome(pair.dragon, pair.tiger),
//     shoeId: pair.shoe_id,
//     shoePosition: pair.shoe_position,
//   });
//   const revealEndsAt = toMs(locked.locked_at) + Number(locked.reveal_seconds) * 1000;
//   emitTable('dt:reveal', {
//     round_id: Number(locked.id),
//     phase: 'reveal',
//     dragon_card: locked.dragon_card,
//     tiger_card: locked.tiger_card,
//     result: locked.result,
//     reveal_ends_at: new Date(revealEndsAt).toISOString(),
//   });
//   return locked;
// }

async function lockRound(round, settings) {
  if (!shoe) shoe = new DragonTigerShoe();

  // Fresh totals from DB (previous fix).
  const totals = await repo.getRoundTotals(round.id);

  const { targetOutcome, difficulty, source } = decideTarget({
    totals,
    difficulty: settings.difficulty,
    overrideResult: settings.override_result || null,
  });

  const pair = shoe.drawPair({ targetOutcome });

  const locked = await repo.lockAndReveal(round.id, {
    dragonCard: pair.dragon,
    tigerCard: pair.tiger,
    result: pair.outcome,
    shoeId: pair.shoe_id,
    shoePosition: pair.shoe_position,
  });

  console.log(
    `[DT] round=${round.id} difficulty=${difficulty} ` +
    `override=${settings.override_result || 'none'} source=${source} ` +
    `totals=[D:${totals.dragon} T:${totals.tiger} Tie:${totals.tie}] ` +
    `target=${targetOutcome || 'random'} got=${pair.outcome} biased=${pair.biased}`
  );

  // Clear override AFTER the round is locked so a mid-round crash doesn't
  // reapply it to the next round.
  if (settings.override_result) {
    try {
      await repo.clearOverride();
      console.log(`[DT] override cleared (${settings.override_result} applied to round=${round.id})`);
    } catch (err) {
      console.error(`[DT] failed to clear override after round=${round.id}:`, err.message);
      // Non-fatal — next round's `getSettings({ fresh: true })` will retry.
    }
  }

  const revealEndsAt = toMs(locked.locked_at) + Number(locked.reveal_seconds) * 1000;
  emitTable('dt:reveal', {
    round_id: Number(locked.id),
    phase: 'reveal',
    dragon_card: locked.dragon_card,
    tiger_card: locked.tiger_card,
    result: locked.result,
    reveal_ends_at: new Date(revealEndsAt).toISOString(),
  });
  return locked;
}

// async function lockRound(round, settings) {
//   if (!shoe) shoe = new DragonTigerShoe();

//   // THIS round's totals — already maintained by placeBet / clearBets.
//   // const totals = {
//   //   dragon: Number(round.dragon_total) || 0,
//   //   tiger:  Number(round.tiger_total)  || 0,
//   //   tie:    Number(round.tie_total)    || 0,
//   // };

//   const fresh = await repo.findRoundById(round.id);
//   const totals = {
//     dragon: Number(fresh?.dragon_total) || 0,
//     tiger:  Number(fresh?.tiger_total)  || 0,
//     tie:    Number(fresh?.tie_total)    || 0,
//   };

//   const { targetOutcome, difficulty } = decideTarget({
//     totals,
//     difficulty: settings.difficulty,
//   });

//   const pair = shoe.drawPair({ targetOutcome });

//   const locked = await repo.lockAndReveal(round.id, {
//     dragonCard: pair.dragon,
//     tigerCard: pair.tiger,
//     result: pair.outcome,                 // authoritative — same rules fn as settlement
//     shoeId: pair.shoe_id,
//     shoePosition: pair.shoe_position,
//   });

//   // Audit trail — one line per round.
//   console.log(
//     `[DT] round=${round.id} difficulty=${difficulty} ` +
//     `totals=[D:${totals.dragon} T:${totals.tiger} Tie:${totals.tie}] ` +
//     `target=${targetOutcome || 'random'} got=${pair.outcome} biased=${pair.biased}`
//   );

//   const revealEndsAt = toMs(locked.locked_at) + Number(locked.reveal_seconds) * 1000;
//   emitTable('dt:reveal', {
//     round_id: Number(locked.id),
//     phase: 'reveal',
//     dragon_card: locked.dragon_card,
//     tiger_card: locked.tiger_card,
//     result: locked.result,
//     reveal_ends_at: new Date(revealEndsAt).toISOString(),
//   });
//   return locked;
// }

/** Credits every bettor. Throws if any user failed so the next pass retries (idempotent). */
async function settleRound(round) {
  await repo.markSettling(round.id);
  const entries = await repo.aggregateOpenStakes(round.id);
  const results = [];
  let failures = 0;
  for (let i = 0; i < entries.length; i += SETTLE_CONCURRENCY) {
    const batch = entries.slice(i, i + SETTLE_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((entry) => settleUserForRound({ round, entry }))
    );
    settled.forEach((outcome, idx) => {
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        failures += 1;
        console.error(
          `[DT] settle failed round=${round.id} uid=${batch[idx].user_id}: ${outcome.reason?.message}`
        );
      }
    });
  }
  if (failures > 0) {
    throw new Error(`settlement incomplete for round ${round.id} (${failures} failed)`);
  }
  await repo.finalizeRound(round.id);
  return results;
}

async function announceResult(round, settlements) {
  const history = await repo.getHistory(HISTORY_IN_RESULT);
  const resultEndsAt = Date.now() + Number(round.result_seconds) * 1000;
  emitTable('dt:result', {
    round_id: Number(round.id),
    phase: 'result',
    result: round.result,
    dragon_card: round.dragon_card,
    tiger_card: round.tiger_card,
    history,
    next_round_at: new Date(resultEndsAt).toISOString(),
  });
  for (const s of settlements) {
    if (s.already_settled) continue;
    emitUser(s.user_id, 'dt:settled', {
      round_id: Number(round.id),
      result: round.result,
      staked: s.staked,
      returned: s.returned,
      commission: s.commission,
      credited: s.credited,
      net: s.net,
      wallet: s.wallet,
    });
  }
  return resultEndsAt;
}

async function runOneRound(token) {
  const settings = await settingsService.getSettings({ fresh: true });
  let round = await repo.findOpenRound();

  if (!round) {
    if (!settingsService.isEngineEnabled() || !settings.enabled) {
      if (!pausedAnnounced) {
        emitTable('dt:paused', { phase: 'paused' });
        pausedAnnounced = true;
      }
      await sleep(PAUSE_POLL_MS);
      return;
    }
    pausedAnnounced = false;
    round = await openNewRound(settings);
    if (!round) {
      await sleep(1000);
      return;
    }
  } else if (Array.isArray(round.meta?.seats)) {
    seats = round.meta.seats;
  }

  if (round.status === 'betting') {
    await sleep(toMs(round.betting_ends_at) - Date.now());
    if (token !== runToken) return;
    // round = await lockRound(round);
    round = await lockRound(round, settings);
  }

  const revealEndsAt = toMs(round.locked_at) + Number(round.reveal_seconds) * 1000;
  const settlements = await settleRound(round);
  await sleep(revealEndsAt - Date.now());
  const resultEndsAt = await announceResult(round, settlements);
  await sleep(resultEndsAt - Date.now());
  await runIntermission(token);
}

async function runIntermission(token) {
  if (token !== runToken || INTERMISSION_MS <= 0) return;
  const settings = await settingsService.getSettings({ fresh: true });
  if (!settingsService.isEngineEnabled() || !settings.enabled) return;
  emitTable('dt:new_game', {
    phase: 'intermission',
    next_round_at: new Date(Date.now() + INTERMISSION_MS).toISOString(),
  });
  await sleep(INTERMISSION_MS);
}

async function runLoop(token) {
  while (token === runToken) {
    try {
      await runOneRound(token);
    } catch (err) {
      console.error('[DT] round loop error:', err.message);
      await sleep(ERROR_BACKOFF_MS);
    }
  }
}

function startDragonTigerEngine(io) {
  ioRef = io;
  if (leaderHandle) return leaderHandle;
  if (!settingsService.isEngineEnabled()) {
    console.log('[DT] Engine disabled (DRAGONTIGER_ENGINE_ENABLED != true)');
    return null;
  }
  leaderHandle = startProcessLeader('dragontiger-engine', {
    ttlSeconds: 15,
    onBecomeLeader: () => {
      console.log('[DT] Acquired round-loop leadership');
      runToken += 1;
      shoe = new DragonTigerShoe();
      runLoop(runToken);
    },
    onLoseLeadership: () => {
      console.log('[DT] Lost round-loop leadership — stopping loop');
      runToken += 1;
    },
  });
  return leaderHandle;
}

module.exports = {
  startDragonTigerEngine,
};
