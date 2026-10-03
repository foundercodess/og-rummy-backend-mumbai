'use strict';

const settingsService = require('../../services/dragontiger/dtSettings.service');
const repo = require('../../services/dragontiger/dtRound.repository');
const { emptyTotals } = require('../../services/dragontiger/dtRules.service');
const { toMs, derivePhase } = require('./phase');

const HISTORY_ON_JOIN = 60;

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

async function buildTableState(userId) {
  const settings = await settingsService.getSettings();
  const enabled = settingsService.isEngineEnabled() && settings.enabled === true;
  const [round, history, wallet] = await Promise.all([
    repo.findLatestRound(),
    repo.getHistory(HISTORY_ON_JOIN),
    repo.getWalletBalance(userId),
  ]);

  const derived = derivePhase(round);
  let phase = derived.phase;
  if (!enabled && ['waiting', 'result', 'intermission'].includes(phase)) phase = 'paused';

  const roundId = round ? Number(round.id) : null;
  const [myBets, settlement] = await Promise.all([
    roundId ? repo.getUserRoundStakes(roundId, userId) : emptyTotals(),
    roundId && derived.phase === 'result' ? repo.getUserSettlement(roundId, userId) : null,
  ]);

  return {
    enabled,
    phase,
    round_id: roundId,
    phase_ends_at: iso(derived.phaseEndsAt),
    betting_ends_at: round ? iso(toMs(round.betting_ends_at)) : null,
    totals: round ? repo.totalsFromRow(round) : emptyTotals(),
    totals_version: round ? Number(round.totals_version || 0) : 0,
    my_bets: myBets,
    dragon_card: derived.revealed ? round.dragon_card : null,
    tiger_card: derived.revealed ? round.tiger_card : null,
    result: derived.revealed ? round.result : null,
    my_result: settlement
      ? {
        staked: Number(settlement.staked),
        returned: Number(settlement.returned),
        commission: Number(settlement.commission),
        credited: Number(settlement.credited),
        net: Number(settlement.net),
      }
      : null,
    history,
    seats: Array.isArray(round?.meta?.seats) ? round.meta.seats : [],
    settings: settingsService.publicSettings(settings),
    wallet,
  };
}

module.exports = {
  buildTableState,
};
