'use strict';

const INTERMISSION_MS = Math.max(0, Number(process.env.DT_INTERMISSION_MS) || 3000);

function toMs(value) {
  return value ? new Date(value).getTime() : null;
}

/** Phase is derived from the latest round row, so any worker can answer. */
function derivePhase(round, now = Date.now()) {
  if (!round || round.status === 'cancelled') {
    return { phase: 'waiting', phaseEndsAt: null, revealed: false };
  }
  if (round.status === 'betting') {
    return { phase: 'betting', phaseEndsAt: toMs(round.betting_ends_at), revealed: false };
  }
  const revealEnd = toMs(round.locked_at) + Number(round.reveal_seconds || 5) * 1000;
  if (round.status !== 'settled' || now < revealEnd) {
    return { phase: 'reveal', phaseEndsAt: revealEnd, revealed: true };
  }
  const resultEnd = revealEnd + Number(round.result_seconds || 3) * 1000;
  if (now < resultEnd) {
    return { phase: 'result', phaseEndsAt: resultEnd, revealed: true };
  }
  if (now < resultEnd + INTERMISSION_MS) {
    return { phase: 'intermission', phaseEndsAt: resultEnd + INTERMISSION_MS, revealed: true };
  }
  return { phase: 'result', phaseEndsAt: resultEnd, revealed: true };
}

module.exports = {
  INTERMISSION_MS,
  toMs,
  derivePhase,
};
