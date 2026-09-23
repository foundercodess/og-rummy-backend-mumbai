'use strict';

const gameplayService = require('../../services/gameplay.service');
const gameSessionModel = require('../../models/gameSession.model');
const redisLockService = require('../../services/redisLock.service');
const { isTeenPattiSession } = require('../../services/gameFamily');
const tableService = require('./table.service');

const COUNTDOWN_SECONDS = Math.max(3, Number(process.env.TEENPATTI_COUNTDOWN_SECONDS) || 8);
const activeBySession = new Map();

function sessionRoom(sessionId) {
  return `game-session:${sessionId}`;
}

async function startPregame(io, sessionId) {
  if (activeBySession.has(Number(sessionId))) return;

  const session = await gameplayService.getSessionState(sessionId);
  if (!session || !isTeenPattiSession(session)) return;
  if (session.status !== 'ready') return;
  if (!Array.isArray(session.players) || session.players.length < 2) return;
  if (session.players.length !== session.max_players) return;

  const lockKey = `lock:tp:pregame:${sessionId}`;
  const lockOwner = `tp-pregame:${process.pid}:${Date.now()}`;
  const acquired = await redisLockService.acquireLock(lockKey, lockOwner, 40);
  if (!acquired) return;

  const endsAt = Date.now() + COUNTDOWN_SECONDS * 1000;
  const boot = Number(session.metadata?.teenpatti?.boot)
    || Number(String(session.contest?.entry || '10').replace(/[₹,]/g, ''))
    || 10;

  session.metadata = {
    ...(session.metadata || {}),
    game_family: 'teenpatti',
    phase: 'countdown',
    teenpatti: {
      ...(session.metadata?.teenpatti || {}),
      phase: 'countdown',
      boot,
      countdown_ends_at: new Date(endsAt).toISOString(),
    },
  };

  await gameSessionModel.updateSessionStatus(sessionId, 'ready', {
    metadata: session.metadata,
  });

  activeBySession.set(Number(sessionId), { lockKey, lockOwner, timer: null });

  const emitTick = (secondsLeft) => {
    io.to(sessionRoom(sessionId)).emit('tp:countdown', {
      session_id: sessionId,
      seconds_left: secondsLeft,
      ends_at: new Date(endsAt).toISOString(),
      server_time: new Date().toISOString(),
    });
  };

  const fresh = await gameplayService.getSessionState(sessionId);
  emitTick(COUNTDOWN_SECONDS);
  tableService.emitState(io, fresh);

  let left = COUNTDOWN_SECONDS;
  const timer = setInterval(async () => {
    left -= 1;
    if (left > 0) {
      emitTick(left);
      return;
    }
    clearInterval(timer);
    activeBySession.delete(Number(sessionId));
    await redisLockService.releaseLock(lockKey, lockOwner);
    try {
      await tableService.startToss(io, sessionId);
    } catch (err) {
      console.error(`[TP][${sessionId}] toss after countdown failed: ${err.message}`);
    }
  }, 1000);

  const owned = activeBySession.get(Number(sessionId));
  if (owned) owned.timer = timer;
}

module.exports = {
  startPregame,
};
