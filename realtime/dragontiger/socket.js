'use strict';

const settingsService = require('../../services/dragontiger/dtSettings.service');
const repo = require('../../services/dragontiger/dtRound.repository');
const { placeBet, clearBets } = require('../../services/dragontiger/dtWallet.service');
const { isArea } = require('../../services/dragontiger/dtRules.service');
const { buildTableState } = require('./state');
const { TABLE_ROOM, userRoom } = require('./rooms');

const BET_RATE_WINDOW_MS = 1000;
const BET_RATE_MAX = 12;
const BROADCAST_FLUSH_MS = 120;
const MAX_BETS_PER_FLUSH = 60;
const CLIENT_BET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Coalesces bet broadcasts per round on this worker (clients keep the highest totals_version). */
const pendingBroadcasts = new Map();

function nowIso() {
  return new Date().toISOString();
}

function ack(callback, payload) {
  if (typeof callback === 'function') callback({ ...payload, server_time: nowIso() });
}

function fail(callback, err, fallbackCode) {
  ack(callback, {
    success: false,
    code: err.code || fallbackCode,
    message: err.message || 'Request failed',
    ...(err.details ? { details: err.details } : {}),
  });
}

function dtError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function queueTotalsBroadcast(io, roundId, totals, version, bet) {
  let entry = pendingBroadcasts.get(roundId);
  if (!entry) {
    entry = { totals, version, bets: [] };
    pendingBroadcasts.set(roundId, entry);
    setTimeout(() => {
      const flushed = pendingBroadcasts.get(roundId);
      pendingBroadcasts.delete(roundId);
      if (!flushed) return;
      io.to(TABLE_ROOM).emit('dt:bets', {
        round_id: roundId,
        totals: flushed.totals,
        totals_version: flushed.version,
        bets: flushed.bets,
        server_time: nowIso(),
      });
    }, BROADCAST_FLUSH_MS);
  }
  if (version >= entry.version) {
    entry.totals = totals;
    entry.version = version;
  }
  if (bet && entry.bets.length < MAX_BETS_PER_FLUSH) entry.bets.push(bet);
}

function assertEngineOn() {
  if (!settingsService.isEngineEnabled()) {
    throw dtError('DT_DISABLED', 'Dragon Tiger is currently unavailable');
  }
}

function attachDragonTigerSocket(io, socket) {
  const userId = Number(socket.user?.id);
  if (!Number.isFinite(userId)) return;

  const rate = { windowStart: 0, count: 0 };
  function allowBetRequest() {
    const now = Date.now();
    if (now - rate.windowStart > BET_RATE_WINDOW_MS) {
      rate.windowStart = now;
      rate.count = 0;
    }
    rate.count += 1;
    return rate.count <= BET_RATE_MAX;
  }

  socket.on('dt:join', async (_payload = {}, callback) => {
    try {
      assertEngineOn();
      const state = await buildTableState(userId);
      if (!state.enabled && state.phase === 'paused') {
        throw dtError('DT_DISABLED', 'Dragon Tiger is currently unavailable');
      }
      socket.join(TABLE_ROOM);
      socket.join(userRoom(userId));
      ack(callback, { success: true, state });
    } catch (err) {
      fail(callback, err, 'DT_JOIN_FAILED');
    }
  });

  socket.on('dt:leave', (_payload = {}, callback) => {
    socket.leave(TABLE_ROOM);
    socket.leave(userRoom(userId));
    ack(callback, { success: true });
  });

  socket.on('dt:sync', async (_payload = {}, callback) => {
    try {
      assertEngineOn();
      ack(callback, { success: true, state: await buildTableState(userId) });
    } catch (err) {
      fail(callback, err, 'DT_SYNC_FAILED');
    }
  });

  socket.on('dt:bet', async (payload = {}, callback) => {
    try {
      assertEngineOn();
      if (!allowBetRequest()) throw dtError('DT_RATE_LIMITED', 'Too many bets, slow down');

      const settings = await settingsService.getSettings();
      const roundId = Number(payload.round_id);
      const area = String(payload.area || '').toLowerCase();
      const amount = Number(payload.amount);
      const clientBetId = payload.client_bet_id != null ? String(payload.client_bet_id) : null;

      if (!Number.isInteger(roundId) || roundId <= 0) throw dtError('DT_INVALID_ROUND', 'round_id is required');
      if (!isArea(area)) throw dtError('DT_INVALID_AREA', 'Invalid betting area');
      if (!Number.isInteger(amount) || amount < settings.min_bet) {
        throw dtError('DT_INVALID_AMOUNT', `Minimum bet is ₹${settings.min_bet}`);
      }
      if (clientBetId && !CLIENT_BET_ID_RE.test(clientBetId)) {
        throw dtError('DT_INVALID_CLIENT_BET_ID', 'Invalid client_bet_id');
      }

      const result = await placeBet({ roundId, userId, area, amount, clientBetId, settings });
      if (result.duplicate) {
        const [myBets, wallet] = await Promise.all([
          repo.getUserRoundStakes(roundId, userId),
          repo.getWalletBalance(userId),
        ]);
        ack(callback, { success: true, duplicate: true, round_id: roundId, my_bets: myBets, wallet });
        return;
      }

      queueTotalsBroadcast(io, roundId, result.totals, result.totals_version, {
        user_id: userId,
        area,
        amount,
      });
      ack(callback, {
        success: true,
        round_id: roundId,
        area,
        amount,
        totals: result.totals,
        totals_version: result.totals_version,
        my_bets: result.my_bets,
        wallet: result.wallet,
      });
    } catch (err) {
      fail(callback, err, 'DT_BET_FAILED');
    }
  });

  socket.on('dt:clear', async (payload = {}, callback) => {
    try {
      assertEngineOn();
      const roundId = Number(payload.round_id);
      if (!Number.isInteger(roundId) || roundId <= 0) throw dtError('DT_INVALID_ROUND', 'round_id is required');
      const result = await clearBets({ roundId, userId });
      if (result.totals) {
        queueTotalsBroadcast(io, roundId, result.totals, result.totals_version, null);
      }
      const wallet = result.wallet || (await repo.getWalletBalance(userId));
      ack(callback, {
        success: true,
        round_id: roundId,
        refunded: result.refunded,
        my_bets: { dragon: 0, tiger: 0, tie: 0 },
        totals: result.totals,
        totals_version: result.totals_version,
        wallet,
      });
    } catch (err) {
      fail(callback, err, 'DT_CLEAR_FAILED');
    }
  });

  socket.on('dt:history', async (payload = {}, callback) => {
    try {
      const history = await repo.getHistory(Number(payload.limit) || 120);
      ack(callback, { success: true, history });
    } catch (err) {
      fail(callback, err, 'DT_HISTORY_FAILED');
    }
  });
}

module.exports = {
  attachDragonTigerSocket,
};
