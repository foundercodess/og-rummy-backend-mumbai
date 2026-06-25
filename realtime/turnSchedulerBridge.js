let turnTimerStarter = null;

function setTurnTimerStarter(fn) {
  turnTimerStarter = typeof fn === 'function' ? fn : null;
}

function startTurnTimerFromDeal(payload = {}) {
  if (typeof turnTimerStarter !== 'function') return false;
  turnTimerStarter(payload);
  return true;
}

module.exports = {
  setTurnTimerStarter,
  startTurnTimerFromDeal,
};
