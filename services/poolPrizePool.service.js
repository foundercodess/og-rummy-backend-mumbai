function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function countPoolJoinedPlayers(players = []) {
  return (Array.isArray(players) ? players : [])
    .filter((player) => ['joined', 'disconnected', 'eliminated', 'left'].includes(player?.status))
    .length;
}

function resolvePoolBaseEntryCount(session = {}) {
  const metadata = session?.metadata || {};
  const locked = Number(metadata.pool_base_entry_count);
  if (Number.isFinite(locked) && locked > 0) {
    return Math.floor(locked);
  }
  return countPoolJoinedPlayers(session?.players);
}

function resolvePoolRejoinEntryCount(metadata = {}) {
  const raw = Number(metadata?.pool_rejoin_entry_count);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

function buildPoolPrizePoolSummary({
  entryFee = 0,
  baseEntryCount = 0,
  rejoinEntryCount = 0,
  projectedExtraEntries = 0,
} = {}) {
  const numericEntryFee = Number(entryFee);
  const safeEntryFee = Number.isFinite(numericEntryFee) && numericEntryFee > 0
    ? roundCurrency(numericEntryFee)
    : 0;
  const safeBaseEntries = Math.max(
    0,
    Number.isFinite(Number(baseEntryCount)) ? Math.floor(Number(baseEntryCount)) : 0,
  );
  const safeRejoinEntries = Math.max(
    0,
    Number.isFinite(Number(rejoinEntryCount)) ? Math.floor(Number(rejoinEntryCount)) : 0,
  );
  const safeProjectedExtraEntries = Math.max(
    0,
    Number.isFinite(Number(projectedExtraEntries)) ? Math.floor(Number(projectedExtraEntries)) : 0,
  );

  const currentTotalEntries = safeBaseEntries + safeRejoinEntries;
  const updatedTotalEntries = currentTotalEntries + safeProjectedExtraEntries;
  const currentGrossPool = roundCurrency(safeEntryFee * currentTotalEntries);
  const updatedGrossPool = roundCurrency(safeEntryFee * updatedTotalEntries);
  const currentCommissionAmount = roundCurrency(currentGrossPool * 0.12);
  const updatedCommissionAmount = roundCurrency(updatedGrossPool * 0.12);
  const currentNetPool = roundCurrency(currentGrossPool - currentCommissionAmount);
  const updatedNetPool = roundCurrency(updatedGrossPool - updatedCommissionAmount);

  return {
    entry_fee: safeEntryFee,
    base_entry_count: safeBaseEntries,
    rejoin_entry_count: safeRejoinEntries,
    current_total_entries: currentTotalEntries,
    current_prize_pool: currentNetPool,
    current_prize_pool_gross: currentGrossPool,
    current_commission_amount: currentCommissionAmount,
    updated_total_entries: updatedTotalEntries,
    updated_prize_pool: updatedNetPool,
    updated_prize_pool_gross: updatedGrossPool,
    updated_commission_amount: updatedCommissionAmount,
  };
}

function buildPoolRejoinInfoPayload({
  rejoinContext = {},
  joiningFee = 0,
  prizePoolSummary = null,
} = {}) {
  const safeJoiningFee = Number.isFinite(Number(joiningFee))
    ? roundCurrency(Number(joiningFee))
    : 0;
  return {
    rejoin_at_points_by_user: rejoinContext?.rejoin_start_points_by_user || {},
    joining_fee: safeJoiningFee,
    current_prize_pool: prizePoolSummary?.current_prize_pool ?? 0,
    updated_prize_pool_if_rejoin: prizePoolSummary?.updated_prize_pool ?? 0,
    current_prize_pool_gross: prizePoolSummary?.current_prize_pool_gross ?? 0,
    updated_prize_pool_gross_if_rejoin: prizePoolSummary?.updated_prize_pool_gross ?? 0,
    current_total_entries: prizePoolSummary?.current_total_entries ?? 0,
    updated_total_entries_if_rejoin: prizePoolSummary?.updated_total_entries ?? 0,
    current_commission_amount: prizePoolSummary?.current_commission_amount ?? 0,
    updated_commission_amount_if_rejoin: prizePoolSummary?.updated_commission_amount ?? 0,
  };
}

function buildPoolSessionPrizePoolFields(session = null) {
  const entryFee = Number(session?.contest?.entry);
  const summary = buildPoolPrizePoolSummary({
    entryFee,
    baseEntryCount: resolvePoolBaseEntryCount(session),
    rejoinEntryCount: resolvePoolRejoinEntryCount(session?.metadata || {}),
  });

  return {
    winning_balance: summary.current_prize_pool,
    prize_pool: {
      player_count: summary.current_total_entries,
      base_entry_count: summary.base_entry_count,
      rejoin_entry_count: summary.rejoin_entry_count,
      entry_fee: summary.entry_fee > 0 ? summary.entry_fee : null,
      total_entry: summary.current_prize_pool_gross,
      admin_commission_percent: 12,
      admin_commission_amount: summary.current_commission_amount,
      winning_balance: summary.current_prize_pool,
      current_prize_pool: summary.current_prize_pool,
    },
  };
}

function resolveLockedPoolBaseEntryCount(session = {}, players = null) {
  const metadata = session?.metadata || {};
  const existing = Number(metadata.pool_base_entry_count);
  if (Number.isFinite(existing) && existing > 0) {
    return Math.floor(existing);
  }
  const playerList = Array.isArray(players) ? players : (session?.players || []);
  return countPoolJoinedPlayers(playerList);
}

module.exports = {
  roundCurrency,
  countPoolJoinedPlayers,
  resolvePoolBaseEntryCount,
  resolvePoolRejoinEntryCount,
  buildPoolPrizePoolSummary,
  buildPoolRejoinInfoPayload,
  buildPoolSessionPrizePoolFields,
  resolveLockedPoolBaseEntryCount,
};
