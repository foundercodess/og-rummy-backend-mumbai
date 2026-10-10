'use strict';

/**
 * Teen Patti table watchdog.
 *
 * Every phase transition (toss → deal → betting → turn expiry → result → next
 * round) is driven by an in-process setTimeout. A deploy/restart, a crashed
 * worker or a callback that threw drops that timer and the table freezes with
 * no cards and no turn. Each phase stores its deadline in metadata; this sweep
 * re-fires the transition once the deadline is clearly overdue. Every
 * transition is phase-guarded and table-locked, so a late duplicate is a no-op.
 */

const { query } = require('../../db');
const gameplayService = require('../../services/gameplay.service');
const { isTeenPattiSession } = require('../../services/gameFamily');
const tableService = require('./table.service');

const SWEEP_MS = Math.max(2000, Number(process.env.TEENPATTI_WATCHDOG_MS) || 4000);
const GRACE_MS = Math.max(1500, Number(process.env.TEENPATTI_WATCHDOG_GRACE_MS) || 3000);
// Rows written before deadlines were stored: recover once a phase sits unchanged this long.
const LEGACY_STALL_MS = 30000;

let sweepHandle = null;
let sweeping = false;
const firstSeen = new Map();

function overdue(iso, now) {
  const at = Date.parse(iso || '');
  return Number.isFinite(at) && now - at > GRACE_MS;
}

function legacyStalled(sessionId, tp, now) {
  const key = `${tp.phase}:${tp.round_no || 0}:${tp.turn_id || ''}`;
  const seen = firstSeen.get(sessionId);
  if (!seen || seen.key !== key) {
    firstSeen.set(sessionId, { key, at: now });
    return false;
  }
  return now - seen.at > LEGACY_STALL_MS;
}

async function listLiveTableIds() {
  const result = await query(
    `SELECT id
     FROM game_sessions
     WHERE status IN ('ready', 'active')
       AND metadata->>'game_family' = 'teenpatti'
     ORDER BY id DESC
     LIMIT 300`
  );
  return result.rows.map((row) => Number(row.id));
}

async function recoverTable(io, sessionId, now) {
  const session = await gameplayService.getSessionState(sessionId);
  if (!session || !isTeenPattiSession(session)) return;
  if (['completed', 'cancelled'].includes(String(session.status || '').toLowerCase())) return;
  const tp = session.metadata?.teenpatti;
  if (!tp) return;

  switch (tp.phase) {
    case 'countdown':
      if (overdue(tp.countdown_ends_at, now)) {
        console.warn(`[TP][${sessionId}] watchdog: countdown overdue → toss`);
        await tableService.startToss(io, sessionId);
      }
      return;
    case 'toss':
      if (overdue(tp.toss_ends_at, now) || (!tp.toss_ends_at && legacyStalled(sessionId, tp, now))) {
        console.warn(`[TP][${sessionId}] watchdog: toss overdue → deal`);
        await tableService.dealNewRound(io, sessionId);
      }
      return;
    case 'dealing':
      if (overdue(tp.deal_ends_at, now) || (!tp.deal_ends_at && legacyStalled(sessionId, tp, now))) {
        console.warn(`[TP][${sessionId}] watchdog: deal overdue → betting`);
        await tableService.beginBetting(io, sessionId);
      }
      return;
    case 'betting': {
      if (tp.side_show_reveal) {
        if (overdue(tp.side_show_reveal.until, now)) {
          console.warn(`[TP][${sessionId}] watchdog: side show reveal overdue`);
          await tableService.finalizeSideShowReveal(io, sessionId, tp.side_show_reveal.request_id);
        }
        return;
      }
      if (tp.side_show) {
        if (overdue(tp.side_show.expires_at, now)) {
          console.warn(`[TP][${sessionId}] watchdog: side show reply overdue`);
          await tableService.applyAction(io, sessionId, 0, {
            type: 'side_show_reply',
            accept: false,
            timeout: true,
            request_id: tp.side_show.request_id,
          });
        }
        return;
      }
      const stuck = tp.turn_ends_at
        ? overdue(tp.turn_ends_at, now)
        : legacyStalled(sessionId, tp, now);
      if (stuck) {
        console.warn(`[TP][${sessionId}] watchdog: turn overdue uid=${tp.current_turn_user_id}`);
        await tableService.applyAction(io, sessionId, 0, { type: 'timeout', turn_id: tp.turn_id });
      }
      return;
    }
    case 'result':
      if (overdue(tp.next_round_at, now) || (!tp.next_round_at && legacyStalled(sessionId, tp, now))) {
        console.warn(`[TP][${sessionId}] watchdog: result overdue → next round`);
        await tableService.dealNewRound(io, sessionId);
      }
      return;
    default:
  }
}

async function sweep(io) {
  if (sweeping) return;
  sweeping = true;
  try {
    const ids = await listLiveTableIds();
    const now = Date.now();
    const live = new Set(ids);
    for (const id of firstSeen.keys()) {
      if (!live.has(id)) firstSeen.delete(id);
    }
    for (const id of ids) {
      try {
        await recoverTable(io, id, now);
      } catch (err) {
        if (err?.code !== 'TP_BUSY') {
          console.error(`[TP][${id}] watchdog recovery failed: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.error(`[TP] watchdog sweep failed: ${err.message}`);
  } finally {
    sweeping = false;
  }
}

function startTeenPattiWatchdog(io) {
  if (sweepHandle || !io) return;
  sweepHandle = setInterval(() => {
    sweep(io).catch(() => {});
  }, SWEEP_MS);
  if (typeof sweepHandle.unref === 'function') sweepHandle.unref();
}

module.exports = {
  startTeenPattiWatchdog,
};
