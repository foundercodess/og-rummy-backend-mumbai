'use strict';

const crypto = require('crypto');
const gameplayService = require('../../services/gameplay.service');
const gameSessionModel = require('../../models/gameSession.model');
const redisLockService = require('../../services/redisLock.service');
const {
  RANK_VALUE,
  evaluateHand,
  compareHands,
  legalActions,
} = require('../../services/teenpatti/teenpattiRules.service');
const { isTeenPattiSession } = require('../../services/gameFamily');
const tpWallet = require('../../services/teenpatti/wallet.service');

const SUITS = ['H', 'D', 'C', 'S'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const TURN_SECONDS = Math.max(8, Number(process.env.TEENPATTI_TURN_SECONDS) || 15);
const MAX_BLINDS = Math.max(1, Number(process.env.TEENPATTI_MAX_BLINDS) || 4);
const TOSS_MS = Math.max(1600, Number(process.env.TEENPATTI_TOSS_MS) || 2000);
const DEAL_MS = Math.max(1600, Number(process.env.TEENPATTI_DEAL_MS) || 2200);
const SIDESHOW_SECONDS = Math.max(5, Number(process.env.TEENPATTI_SIDESHOW_SECONDS) || 8);
const SIDESHOW_REVEAL_MS = Math.max(5000, Number(process.env.TEENPATTI_SIDESHOW_REVEAL_MS) || 5000);
const SIDESHOW_BOT_MIN_MS = Math.max(2500, Number(process.env.TEENPATTI_SIDESHOW_BOT_MIN_MS) || 3200);
const SIDESHOW_BOT_JITTER_MS = Math.max(800, Number(process.env.TEENPATTI_SIDESHOW_BOT_JITTER_MS) || 2200);
const HOLE_PHASES = new Set(['dealing', 'betting', 'result', 'showdown']);

const turnTimers = new Map();
const tossTimers = new Map();
const dealTimers = new Map();
const sideShowTimers = new Map();
const sideShowRevealTimers = new Map();

function sessionRoom(sessionId) {
  return `game-session:${sessionId}`;
}

function shuffle(list) {
  const next = [...list];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({
        card_id: `${suit}${rank}`,
        rank,
        suit,
        card_uid: `${suit}${rank}-${crypto.randomUUID()}`,
      });
    }
  }
  return shuffle(deck);
}

function bootAmount(session) {
  const fromState = Number(session?.metadata?.teenpatti?.boot);
  if (Number.isFinite(fromState) && fromState > 0) return fromState;
  const entry = Number(String(session?.contest?.entry || '0').replace(/[₹,]/g, ''));
  return Number.isFinite(entry) && entry > 0 ? entry : 10;
}

function potLimit(session) {
  const winUpto = Number(String(session?.contest?.win_upto || '').replace(/[₹,]/g, ''));
  if (Number.isFinite(winUpto) && winUpto > 0) return winUpto;
  return bootAmount(session) * 128;
}

function seatedPlayers(session) {
  return (session.players || []).filter((player) => {
    const status = String(player.status || 'joined').toLowerCase();
    return ['joined', 'disconnected'].includes(status);
  }).sort((a, b) => Number(a.seat_no) - Number(b.seat_no));
}

function aliveTpPlayers(tp) {
  return (tp.players || []).filter((p) => p.state !== 'packed' && p.state !== 'show_lost');
}

function nextAliveUserId(tp, fromUserId) {
  const alive = aliveTpPlayers(tp);
  if (alive.length === 0) return null;
  const ids = alive.map((p) => Number(p.user_id));
  const from = Number(fromUserId);
  const start = ids.indexOf(from);
  if (start < 0) return ids[0];
  return ids[(start + 1) % ids.length];
}

function previousAlivePlayer(tp, fromUserId) {
  const alive = aliveTpPlayers(tp);
  if (alive.length < 2) return null;
  const from = Number(fromUserId);
  const start = alive.findIndex((p) => Number(p.user_id) === from);
  if (start < 0) return null;
  return alive[(start - 1 + alive.length) % alive.length];
}

function noteOrbitAction(tp, userId) {
  const acted = new Set((tp.orbit_acted || []).map((id) => Number(id)));
  acted.add(Number(userId));
  const aliveIds = aliveTpPlayers(tp).map((p) => Number(p.user_id));
  if (aliveIds.length > 0 && aliveIds.every((id) => acted.has(id))) {
    tp.betting_round = (tp.betting_round || 1) + 1;
    tp.orbit_acted = [];
  } else {
    tp.orbit_acted = [...acted];
  }
}

function findTpPlayer(tp, userId) {
  return (tp.players || []).find((p) => Number(p.user_id) === Number(userId)) || null;
}

function isBotSeat(session, userId) {
  const row = (session.players || []).find((p) => Number(p.user_id) === Number(userId));
  return row?.metadata?.is_bot === true;
}

function humanSeated(session) {
  return (session.players || []).filter((player) => {
    const status = String(player.status || 'joined').toLowerCase();
    if (!['joined', 'disconnected'].includes(status)) return false;
    if (player.metadata?.table_left === true) return false;
    if (player.metadata?.is_bot === true) return false;
    return true;
  });
}

function tossRank(card) {
  return RANK_VALUE[String(card?.rank || '').toUpperCase()] || 0;
}

function seatIndex(seats, userId) {
  return seats.findIndex((seat) => Number(seat.user_id) === Number(userId));
}

function playerAfter(seats, userId) {
  if (!seats.length) return null;
  const idx = seatIndex(seats, userId);
  const start = idx >= 0 ? idx : 0;
  return seats[(start + 1) % seats.length];
}

function dealOrderFromDealer(seats, dealerUserId) {
  if (!seats.length) return [];
  const idx = seatIndex(seats, dealerUserId);
  const start = idx >= 0 ? idx : 0;
  const order = [];
  for (let i = 1; i <= seats.length; i += 1) {
    order.push(Number(seats[(start + i) % seats.length].user_id));
  }
  return order;
}

async function completeSession(io, session, reason) {
  clearTurnTimer(session.id);
  clearTossTimer(session.id);
  clearDealTimer(session.id);
  clearSideShowTimer(session.id);
  const tp = session.metadata?.teenpatti || {};
  tp.phase = 'completed';
  tp.ended_reason = reason;
  tp.current_turn_user_id = null;
  session.metadata = {
    ...(session.metadata || {}),
    game_family: 'teenpatti',
    phase: 'completed',
    teenpatti: tp,
  };
  await persist(session, { status: 'completed', endedAt: new Date(), currentTurnUserId: null });
  const fresh = await gameplayService.getSessionState(session.id);
  emitState(io, fresh);
  return fresh;
}

async function persist(session, extra = {}) {
  const status = extra.status || session.status;
  return gameSessionModel.updateSessionStatus(session.id, status, {
    metadata: session.metadata,
    currentTurnUserId: extra.currentTurnUserId ?? session.current_turn_user_id,
    startedAt: extra.startedAt,
    endedAt: extra.endedAt,
  });
}

function clearTurnTimer(sessionId) {
  const handle = turnTimers.get(Number(sessionId));
  if (handle) clearTimeout(handle);
  turnTimers.delete(Number(sessionId));
}

function clearTossTimer(sessionId) {
  const handle = tossTimers.get(Number(sessionId));
  if (handle) clearTimeout(handle);
  tossTimers.delete(Number(sessionId));
}

function clearDealTimer(sessionId) {
  const handle = dealTimers.get(Number(sessionId));
  if (handle) clearTimeout(handle);
  dealTimers.delete(Number(sessionId));
}

function clearSideShowTimer(sessionId) {
  const handle = sideShowTimers.get(Number(sessionId));
  if (handle) clearTimeout(handle);
  sideShowTimers.delete(Number(sessionId));
}

function clearSideShowRevealTimer(sessionId) {
  const handle = sideShowRevealTimers.get(Number(sessionId));
  if (handle) clearTimeout(handle);
  sideShowRevealTimers.delete(Number(sessionId));
}

function normalizeCard(card) {
  if (!card) return null;
  if (typeof card === 'string') {
    const id = card.trim();
    if (!id) return null;
    return { card_id: id, rank: id.slice(1), suit: id.slice(0, 1) };
  }
  const suit = String(card.suit || '').toUpperCase().slice(0, 1);
  const rank = String(card.rank || card.value || '').toUpperCase();
  const cardId = String(card.card_id || (suit && rank ? `${suit}${rank}` : '')).trim();
  if (!cardId) return null;
  return {
    ...card,
    suit: suit || card.suit,
    rank: rank || card.rank,
    card_id: cardId,
  };
}

function publicCardList(cards) {
  if (!Array.isArray(cards)) return [];
  return cards.map(normalizeCard).filter(Boolean);
}

function publicCards(tpPlayer, viewerId, revealAll, tp) {
  const isSelf = Number(tpPlayer.user_id) === Number(viewerId);
  const seen = tpPlayer.state === 'seen';
  const revealHands = tp?.side_show_reveal?.hands;
  if (revealHands) {
    const shown = revealHands[String(tpPlayer.user_id)]
      || revealHands[tpPlayer.user_id]
      || revealHands[Number(tpPlayer.user_id)];
    if (Array.isArray(shown) && shown.length) return publicCardList(shown);
  }
  if (revealAll) return publicCardList(tpPlayer.cards || []);
  if (isSelf && seen) return publicCardList(tpPlayer.cards || []);
  return [];
}

function waitingPlayers(session) {
  return seatedPlayers(session).map((p) => ({
    user_id: Number(p.user_id),
    state: 'waiting',
    current_stake: 0,
    total_invested: 0,
    cards: [],
  }));
}

function buildPublicState(session, viewerId) {
  const tp = session.metadata?.teenpatti || {};
  const phase = tp.phase || 'waiting';
  const revealAll = phase === 'showdown' || phase === 'result';
  const viewer = findTpPlayer(tp, viewerId);
  const opponentsAlive = aliveTpPlayers(tp).filter((p) => Number(p.user_id) !== Number(viewerId));
  const isTurn = Number(tp.current_turn_user_id) === Number(viewerId)
    && phase === 'betting'
    && !tp.side_show
    && !tp.side_show_reveal;
  const previousOpponent = viewer ? previousAlivePlayer(tp, viewer.user_id) : null;
  const actions = viewer && phase === 'betting'
    ? legalActions({
      player: viewer,
      opponentsAlive,
      lastBet: tp.last_bet,
      boot: tp.boot,
      pot: tp.pot,
      potLimit: tp.pot_limit,
      isTurn,
      bettingRound: tp.betting_round || 1,
      previousOpponent,
      sideShowPending: Boolean(tp.side_show || tp.side_show_reveal),
    })
    : {};
  const myHand = viewer && viewer.state === 'seen' && viewer.cards?.length === 3
    ? (() => {
      const ev = evaluateHand(viewer.cards);
      return { category_key: ev.category_key, category_label: ev.category_label };
    })()
    : null;

  const playersById = new Map((session.players || []).map((p) => [Number(p.user_id), p]));
  const holeDealt = HOLE_PHASES.has(phase);
  const turnPaused = Boolean(tp.side_show || tp.side_show_reveal);

  return {
    session_id: session.id,
    session_code: session.session_code,
    game_family: 'teenpatti',
    phase,
    pot: tp.pot || 0,
    boot: tp.boot || 0,
    last_bet: tp.last_bet || 0,
    current_turn_user_id: tp.current_turn_user_id || null,
    turn_id: tp.turn_id || null,
    turn_ends_at: turnPaused ? null : (tp.turn_ends_at || null),
    turn_seconds: TURN_SECONDS,
    turn_paused: turnPaused,
    turn_paused_remaining_ms: turnPaused
      ? Math.max(0, Number(tp.turn_paused_remaining_ms) || 0)
      : null,
    dealer_user_id: tp.dealer_user_id || null,
    round_no: tp.round_no || 0,
    betting_round: tp.betting_round || 1,
    max_players: Number(session.max_players) || 0,
    deal_order: tp.deal_order || [],
    legal_actions: actions,
    my_hand: myHand,
    side_show: tp.side_show || null,
    side_show_reveal: tp.side_show_reveal
      ? {
        request_id: tp.side_show_reveal.request_id || null,
        from_user_id: Number(tp.side_show_reveal.from_user_id),
        to_user_id: Number(tp.side_show_reveal.to_user_id),
        loser_user_id: tp.side_show_reveal.loser_user_id == null
          ? null
          : Number(tp.side_show_reveal.loser_user_id),
        until: tp.side_show_reveal.until || null,
        reveal_ms: SIDESHOW_REVEAL_MS,
        hands: Object.fromEntries(
          Object.entries(tp.side_show_reveal.hands || {}).map(([uid, cards]) => [
            String(uid),
            publicCardList(cards),
          ]),
        ),
      }
      : null,
    result: tp.result || null,
    wallet_balance: viewer?.wallet_balance == null ? null : Number(viewer.wallet_balance),
    toss: phase === 'toss' ? (tp.toss || null) : null,
    players: ((Array.isArray(tp.players) && tp.players.length)
      ? tp.players
      : waitingPlayers(session)).map((tpPlayer) => {
      const row = playersById.get(Number(tpPlayer.user_id)) || {};
      const cards = publicCards(tpPlayer, viewerId, revealAll, tp);
      const packed = tpPlayer.state === 'packed' || tpPlayer.state === 'show_lost';
      return {
        user_id: Number(tpPlayer.user_id),
        name: row.name || row.user_name || null,
        avatar: row.avatar || row.metadata?.avatar || null,
        seat_no: row.seat_no || null,
        state: tpPlayer.state || 'waiting',
        is_bot: row.metadata?.is_bot === true,
        is_seen: tpPlayer.state === 'seen',
        is_connected: row.metadata?.is_connected !== false
          && String(row.status || '').toLowerCase() !== 'disconnected',
        current_stake: tpPlayer.current_stake || 0,
        total_invested: tpPlayer.total_invested || 0,
        card_count: holeDealt && !packed ? 3 : (holeDealt ? 3 : 0),
        cards,
      };
    }),
  };
}

function statePayload(session, viewerId) {
  return {
    success: true,
    server_time: new Date().toISOString(),
    state: buildPublicState(session, viewerId),
  };
}

function emitStateLocal(io, session) {
  const socketRegistry = require('../socketRegistry');
  (session.players || []).forEach((player) => {
    const payload = statePayload(session, player.user_id);
    io.to(`tp-user:${player.user_id}`).emit('tp:state', payload);
    const ids = socketRegistry.getSocketIds(player.user_id);
    ids.forEach((socketId) => {
      const sock = io.sockets?.sockets?.get(socketId);
      if (sock) sock.emit('tp:state', payload);
      else io.to(socketId).emit('tp:state', payload);
    });
  });
}

function emitState(io, session) {
  const room = sessionRoom(session.id);
  if (typeof io.in !== 'function') {
    emitStateLocal(io, session);
    return;
  }
  io.in(room).fetchSockets().then((sockets) => {
    sockets.forEach((sock) => {
      const viewerId = Number(sock.data?.user_id);
      if (!viewerId) return;
      sock.emit('tp:state', statePayload(session, viewerId));
    });
    if (!sockets.length) emitStateLocal(io, session);
  }).catch((err) => {
    console.warn(`[TP][${session.id}] emitState fetchSockets failed: ${err.message}`);
    emitStateLocal(io, session);
  });
}

async function startToss(io, sessionId) {
  const session = await gameplayService.getSessionState(sessionId);
  if (!session || !isTeenPattiSession(session)) return null;
  const seats = seatedPlayers(session);
  if (seats.length < 2) return session;

  clearTossTimer(sessionId);
  clearDealTimer(sessionId);
  clearTurnTimer(sessionId);
  clearSideShowTimer(sessionId);

  const deck = buildDeck();
  const tossCards = seats.map((seat) => ({
    user_id: Number(seat.user_id),
    card: deck.pop(),
  }));
  let winner = tossCards[0];
  for (const entry of tossCards) {
    if (tossRank(entry.card) > tossRank(winner.card)) winner = entry;
  }

  const toss = {
    winner_user_id: Number(winner.user_id),
    cards: tossCards.map((entry) => ({
      user_id: Number(entry.user_id),
      card_id: entry.card.card_id,
      rank: entry.card.rank,
      suit: entry.card.suit,
    })),
  };

  const tp = {
    ...(session.metadata?.teenpatti || {}),
    phase: 'toss',
    boot: bootAmount(session),
    pot: 0,
    last_bet: 0,
    dealer_user_id: Number(winner.user_id),
    current_turn_user_id: null,
    turn_id: null,
    turn_ends_at: null,
    toss,
    deal_order: [],
    players: waitingPlayers(session),
    result: null,
  };

  session.metadata = {
    ...(session.metadata || {}),
    game_family: 'teenpatti',
    phase: 'toss',
    teenpatti: tp,
  };

  await persist(session, { status: 'ready', currentTurnUserId: null });
  const fresh = await gameplayService.getSessionState(sessionId);
  emitState(io, fresh);
  io.to(sessionRoom(sessionId)).emit('tp:toss', {
    session_id: sessionId,
    server_time: new Date().toISOString(),
    toss,
    dealer_user_id: tp.dealer_user_id,
  });

  const handle = setTimeout(() => {
    dealNewRound(io, sessionId).catch((err) => {
      console.error(`[TP][${sessionId}] deal after toss failed: ${err.message}`);
    });
  }, TOSS_MS);
  tossTimers.set(Number(sessionId), handle);
  return fresh;
}

async function dealNewRound(io, sessionId) {
  const session = await gameplayService.getSessionState(sessionId);
  if (!session || !isTeenPattiSession(session)) return null;
  if (['completed', 'cancelled'].includes(String(session.status || '').toLowerCase())) {
    return session;
  }
  if (humanSeated(session).length === 0) {
    return completeSession(io, session, 'no_human_seated');
  }
  const seats = seatedPlayers(session);
  if (seats.length < 2) return session;

  clearTossTimer(sessionId);
  clearDealTimer(sessionId);
  clearTurnTimer(sessionId);
  clearSideShowTimer(sessionId);
  clearSideShowRevealTimer(sessionId);

  const prev = session.metadata?.teenpatti || {};
  let dealer = seats.find((seat) => Number(seat.user_id) === Number(prev.dealer_user_id)) || seats[0];
  if (prev.phase === 'result') {
    dealer = playerAfter(seats, dealer.user_id) || seats[0];
  }

  const boot = bootAmount(session);
  const deck = buildDeck();
  const order = dealOrderFromDealer(seats, dealer.user_id);
  const settleCash = tpWallet.shouldSettle(session);
  const tpPlayers = [];
  let pot = 0;
  for (const player of seats) {
    const userId = Number(player.user_id);
    const bot = isBotSeat(session, userId);
    let invested = boot;
    let settled = 0;
    let walletBalance;
    if (settleCash && !bot) {
      try {
        const paid = await tpWallet.debitStake({
          sessionId,
          userId,
          amount: boot,
          reason: 'teenpatti_boot',
        });
        settled = Number(paid.actualDebit || 0);
        walletBalance = paid.total_balance;
      } catch (err) {
        if (err.code !== 'TP_INSUFFICIENT_BALANCE') throw err;
        invested = 0;
      }
    }
    pot += invested;
    tpPlayers.push({
      user_id: userId,
      cards: [deck.pop(), deck.pop(), deck.pop()],
      state: invested > 0 ? 'blind' : 'packed',
      current_stake: invested,
      total_invested: invested,
      blind_count: 0,
      wallet_settled: settled,
      wallet_balance: walletBalance,
    });
  }

  const aliveIds = tpPlayers
    .filter((player) => player.state !== 'packed')
    .map((player) => Number(player.user_id));
  const firstTurn = order.find((id) => aliveIds.includes(Number(id)))
    || aliveIds[0]
    || Number(seats[0].user_id);

  const tp = {
    phase: 'dealing',
    boot,
    pot,
    pot_limit: potLimit(session),
    last_bet: boot,
    last_better_user_id: Number(dealer.user_id),
    dealer_user_id: Number(dealer.user_id),
    pending_first_turn_user_id: firstTurn,
    current_turn_user_id: null,
    turn_id: null,
    turn_ends_at: null,
    betting_round: 1,
    orbit_acted: [],
    side_show: null,
    side_show_reveal: null,
    round_no: Number(prev.round_no || 0) + 1,
    deal_order: order,
    toss: null,
    players: tpPlayers,
    result: null,
  };

  session.metadata = {
    ...(session.metadata || {}),
    game_family: 'teenpatti',
    game_mode: 'classic',
    phase: 'dealing',
    teenpatti: tp,
  };

  await persist(session, {
    status: 'active',
    currentTurnUserId: null,
    startedAt: session.started_at || new Date(),
  });

  const fresh = await gameplayService.getSessionState(sessionId);
  emitState(io, fresh);
  io.to(sessionRoom(sessionId)).emit('tp:deal', {
    session_id: sessionId,
    server_time: new Date().toISOString(),
    round_no: tp.round_no,
    dealer_user_id: tp.dealer_user_id,
    deal_order: order,
    cards_per_player: 3,
    duration_ms: DEAL_MS,
  });

  const handle = setTimeout(() => {
    beginBetting(io, sessionId).catch((err) => {
      console.error(`[TP][${sessionId}] begin betting failed: ${err.message}`);
    });
  }, DEAL_MS);
  dealTimers.set(Number(sessionId), handle);
  return fresh;
}

async function beginBetting(io, sessionId) {
  const session = await gameplayService.getSessionState(sessionId);
  if (!session || !isTeenPattiSession(session)) return null;
  const tp = session.metadata?.teenpatti;
  if (!tp || tp.phase !== 'dealing') return session;

  const firstTurn = Number(tp.pending_first_turn_user_id)
    || Number((tp.deal_order || [])[0])
    || Number(tp.players?.[0]?.user_id);
  tp.phase = 'betting';
  tp.current_turn_user_id = firstTurn;
  tp.round_start_user_id = firstTurn;
  tp.orbit_acted = [];
  tp.side_show = null;
  tp.side_show_reveal = null;
  delete tp.turn_paused_remaining_ms;
  tp.turn_id = crypto.randomUUID();
  tp.turn_ends_at = new Date(Date.now() + TURN_SECONDS * 1000).toISOString();
  session.metadata.phase = 'betting';
  session.metadata.teenpatti = tp;

  await persist(session, { currentTurnUserId: tp.current_turn_user_id });
  const fresh = await gameplayService.getSessionState(sessionId);
  emitState(io, fresh);
  scheduleTurnTimeout(io, sessionId, tp.turn_id, tp.current_turn_user_id);
  scheduleBotIfNeeded(io, fresh);
  return fresh;
}

function scheduleTurnTimeout(io, sessionId, turnId, userId, durationMs) {
  clearTurnTimer(sessionId);
  const wait = Math.max(800, Number(durationMs) || TURN_SECONDS * 1000);
  const handle = setTimeout(() => {
    applyAction(io, sessionId, userId, { type: 'pack', reason: 'timeout' }).catch((err) => {
      console.error(`[TP][${sessionId}] turn timeout pack failed: ${err.message}`);
    });
  }, wait + 400);
  turnTimers.set(Number(sessionId), handle);
}

function pauseTurnForSideShow(tp) {
  const endsAt = tp.turn_ends_at ? Date.parse(tp.turn_ends_at) : NaN;
  const remaining = Number.isFinite(endsAt)
    ? Math.max(1500, endsAt - Date.now())
    : Math.max(1500, Number(tp.turn_paused_remaining_ms) || TURN_SECONDS * 1000);
  tp.turn_paused_remaining_ms = remaining;
  tp.turn_ends_at = null;
  return remaining;
}

function resumePausedTurn(tp, userId) {
  const remaining = Math.max(
    1500,
    Number(tp.turn_paused_remaining_ms) || TURN_SECONDS * 1000,
  );
  delete tp.turn_paused_remaining_ms;
  tp.current_turn_user_id = Number(userId);
  tp.turn_id = crypto.randomUUID();
  tp.turn_ends_at = new Date(Date.now() + remaining).toISOString();
  return remaining;
}

function scheduleBotIfNeeded(io, session, delayMs) {
  const tp = session?.metadata?.teenpatti;
  if (!tp || tp.phase !== 'betting' || tp.side_show || tp.side_show_reveal) return;
  const userId = Number(tp.current_turn_user_id);
  if (!isBotSeat(session, userId)) return;
  const delay = Math.max(
    1200,
    Number(delayMs) || (1600 + crypto.randomInt(0, 1800)),
  );
  setTimeout(async () => {
    try {
      const latest = await gameplayService.getSessionState(session.id);
      const live = latest?.metadata?.teenpatti;
      if (!live || live.side_show || live.side_show_reveal) return;
      if (Number(live.current_turn_user_id) !== userId) return;
      if (live.phase !== 'betting') return;
      const action = await chooseBotAction(latest, userId);
      await applyAction(io, latest.id, userId, action);
    } catch (err) {
      console.error(`[TP][${session.id}] bot action failed uid=${userId}: ${err.message}`);
    }
  }, delay);
}

async function chooseBotAction(session, userId) {
  const tp = session.metadata.teenpatti;
  const player = findTpPlayer(tp, userId);
  const opponents = aliveTpPlayers(tp).filter((p) => Number(p.user_id) !== Number(userId));
  const actions = legalActions({
    player,
    opponentsAlive: opponents,
    lastBet: tp.last_bet,
    boot: tp.boot,
    pot: tp.pot,
    potLimit: tp.pot_limit,
    isTurn: true,
    bettingRound: tp.betting_round || 1,
    previousOpponent: previousAlivePlayer(tp, userId),
    sideShowPending: Boolean(tp.side_show),
  });
  const rank = evaluateHand(player.cards);
  if (actions.can_show && rank.category >= 2) return { type: 'show' };
  if (player.state === 'blind' && rank.category_key === 'high' && rank.primary < 11) {
    return { type: 'pack' };
  }
  if (actions.can_see && rank.category >= 3) return { type: 'see' };
  if (actions.can_side_show && rank.category === 1) {
    const targetId = actions.side_show_target_user_id;
    const vsHuman = targetId && !isBotSeat(session, targetId);
    if (vsHuman && crypto.randomInt(0, 100) < 28) return { type: 'side_show' };
  }
  if (actions.can_blind) return { type: 'blind', amount: actions.min_chaal };
  if (actions.can_chaal) return { type: 'chaal', amount: actions.min_chaal };
  if (actions.can_show) return { type: 'show' };
  return { type: 'pack' };
}

async function finishRound(io, session, winnerUserIds, reason) {
  const tp = session.metadata.teenpatti;
  const evaluated = winnerUserIds.map((userId) => {
    const player = findTpPlayer(tp, userId);
    return { user_id: Number(userId), ...evaluateHand(player.cards) };
  });
  tp.phase = 'result';
  tp.current_turn_user_id = null;
  tp.side_show = null;
  tp.result = {
    reason,
    pot: tp.pot,
    winners: evaluated,
    hands: Object.fromEntries(
      (tp.players || []).map((p) => [p.user_id, {
        state: p.state,
        cards: p.cards,
        evaluation: p.cards?.length === 3 ? evaluateHand(p.cards) : null,
      }]),
    ),
  };
  session.metadata.phase = 'result';
  session.metadata.teenpatti = tp;
  clearTurnTimer(session.id);
  clearDealTimer(session.id);
  clearSideShowTimer(session.id);
  clearSideShowRevealTimer(session.id);
  tp.side_show_reveal = null;
  delete tp.turn_paused_remaining_ms;
  if (tpWallet.shouldSettle(session) && !tp.wallet_credited) {
    const collected = (tp.players || []).reduce(
      (sum, player) => sum + Number(player.wallet_settled || 0),
      0
    );
    const humanWinners = (winnerUserIds || []).filter((id) => !isBotSeat(session, id));
    if (collected > 0 && humanWinners.length > 0) {
      const share = tpWallet.roundCurrency(collected / humanWinners.length);
      for (const winnerId of humanWinners) {
        try {
          const paid = await tpWallet.creditWin({
            sessionId: session.id,
            userId: winnerId,
            amount: share,
            reason: 'teenpatti_win',
          });
          const winner = findTpPlayer(tp, winnerId);
          if (winner && paid.total_balance != null) winner.wallet_balance = paid.total_balance;
        } catch (err) {
          console.error(`[TP][${session.id}] win credit failed uid=${winnerId}: ${err.message}`);
        }
      }
    }
    tp.wallet_credited = true;
    session.metadata.teenpatti = tp;
  }
  await persist(session, { status: 'active' });
  const fresh = await gameplayService.getSessionState(session.id);
  emitState(io, fresh);
  io.to(sessionRoom(session.id)).emit('tp:result', {
    session_id: session.id,
    server_time: new Date().toISOString(),
    result: tp.result,
  });
  setTimeout(async () => {
    try {
      const latest = await gameplayService.getSessionState(session.id);
      if (!latest || ['completed', 'cancelled'].includes(String(latest.status || '').toLowerCase())) {
        return;
      }
      if (humanSeated(latest).length === 0) {
        await completeSession(io, latest, 'no_human_seated');
        return;
      }
      await dealNewRound(io, session.id);
    } catch (err) {
      console.error(`[TP][${session.id}] next round failed: ${err.message}`);
    }
  }, 5000);
  return fresh;
}

function publicSideShow(pending) {
  if (!pending) return null;
  return {
    request_id: pending.request_id,
    from_user_id: Number(pending.from_user_id),
    to_user_id: Number(pending.to_user_id),
    expires_at: pending.expires_at,
    seconds: SIDESHOW_SECONDS,
  };
}

async function requestSideShow(io, session, fromUserId, targetUserId) {
  const tp = session.metadata.teenpatti;
  const target = findTpPlayer(tp, targetUserId);
  if (!target || target.state !== 'seen') {
    throw Object.assign(new Error('Side show target invalid'), { code: 'TP_ILLEGAL' });
  }
  clearTurnTimer(session.id);
  pauseTurnForSideShow(tp);
  const pending = {
    request_id: crypto.randomUUID(),
    from_user_id: Number(fromUserId),
    to_user_id: Number(targetUserId),
    expires_at: new Date(Date.now() + SIDESHOW_SECONDS * 1000).toISOString(),
  };
  tp.side_show = pending;
  tp.side_show_reveal = null;
  session.metadata.teenpatti = tp;
  await persist(session, { currentTurnUserId: tp.current_turn_user_id });
  const fresh = await gameplayService.getSessionState(session.id);
  emitState(io, fresh);
  io.to(sessionRoom(session.id)).emit('tp:side_show', {
    session_id: session.id,
    server_time: new Date().toISOString(),
    side_show: publicSideShow(pending),
  });
  scheduleSideShowTimeout(io, session.id, pending.request_id);
  scheduleSideShowBot(io, fresh);
  return fresh;
}

function scheduleSideShowTimeout(io, sessionId, requestId) {
  clearSideShowTimer(sessionId);
  const handle = setTimeout(() => {
    applyAction(io, sessionId, 0, {
      type: 'side_show_reply',
      accept: false,
      timeout: true,
      request_id: requestId,
    }).catch((err) => {
      console.error(`[TP][${sessionId}] side show timeout failed: ${err.message}`);
    });
  }, SIDESHOW_SECONDS * 1000 + 250);
  sideShowTimers.set(Number(sessionId), handle);
}

function scheduleSideShowBot(io, session) {
  const pending = session?.metadata?.teenpatti?.side_show;
  if (!pending) return;
  if (!isBotSeat(session, pending.to_user_id)) return;
  const delay = SIDESHOW_BOT_MIN_MS + crypto.randomInt(0, SIDESHOW_BOT_JITTER_MS + 1);
  setTimeout(async () => {
    try {
      const latest = await gameplayService.getSessionState(session.id);
      const live = latest?.metadata?.teenpatti?.side_show;
      if (!live || live.request_id !== pending.request_id) return;
      const bot = findTpPlayer(latest.metadata.teenpatti, live.to_user_id);
      if (!bot || bot.cards?.length !== 3) return;
      const rank = evaluateHand(bot.cards);
      const accept = rank.category >= 3 || (rank.category === 2 && rank.primary >= 10);
      await applyAction(io, latest.id, live.to_user_id, {
        type: 'side_show_reply',
        accept,
      });
    } catch (err) {
      console.error(`[TP][${session.id}] side show bot reply failed: ${err.message}`);
    }
  }, delay);
}

async function resolveSideShow(io, session, userId, accept) {
  const tp = session.metadata.teenpatti;
  const pending = tp.side_show;
  if (!pending) {
    throw Object.assign(new Error('No side show pending'), { code: 'TP_NO_SIDESHOW' });
  }
  const timeout = Number(userId) === 0;
  if (!timeout && Number(userId) !== Number(pending.to_user_id)) {
    throw Object.assign(new Error('Not the side show target'), { code: 'TP_NOT_TURN' });
  }

  clearSideShowTimer(session.id);
  tp.side_show = null;

  const from = findTpPlayer(tp, pending.from_user_id);
  const to = findTpPlayer(tp, pending.to_user_id);

  // Deny / timeout: requester keeps the turn; clock resumes from the pause point.
  if (!accept) {
    const remaining = resumePausedTurn(tp, pending.from_user_id);
    session.metadata.teenpatti = tp;
    session.metadata.phase = 'betting';
    await persist(session, { currentTurnUserId: tp.current_turn_user_id });
    const payload = {
      session_id: session.id,
      server_time: new Date().toISOString(),
      request_id: pending.request_id,
      accepted: false,
      timeout,
      from_user_id: Number(pending.from_user_id),
      to_user_id: Number(pending.to_user_id),
      loser_user_id: null,
      turn_resumed: true,
      turn_remaining_ms: remaining,
    };
    emitState(io, session);
    io.to(sessionRoom(session.id)).emit('tp:side_show_result', payload);
    scheduleTurnTimeout(io, session.id, tp.turn_id, tp.current_turn_user_id, remaining);
    // Give humans time to see the deny FX before a bot acts again.
    scheduleBotIfNeeded(io, session, 2200 + crypto.randomInt(0, 1200));
    return session;
  }

  // Accept: show both hands for SIDESHOW_REVEAL_MS, then pack loser and continue.
  noteOrbitAction(tp, pending.from_user_id);
  delete tp.turn_paused_remaining_ms;
  tp.turn_ends_at = null;
  clearTurnTimer(session.id);

  let loserUserId = null;
  const fromCards = publicCardList(from?.cards || []);
  const toCards = publicCardList(to?.cards || []);
  if (fromCards.length === 3 && toCards.length === 3) {
    const cmp = compareHands(fromCards, toCards);
    if (cmp < 0) loserUserId = Number(from.user_id);
    else if (cmp > 0) loserUserId = Number(to.user_id);
  }

  const hands = {};
  if (from) hands[String(from.user_id)] = fromCards;
  if (to) hands[String(to.user_id)] = toCards;

  tp.side_show_reveal = {
    request_id: pending.request_id,
    from_user_id: Number(pending.from_user_id),
    to_user_id: Number(pending.to_user_id),
    loser_user_id: loserUserId,
    hands,
    until: new Date(Date.now() + SIDESHOW_REVEAL_MS).toISOString(),
  };
  // Keep challenger as current turn owner while reveal plays (timer paused).
  tp.current_turn_user_id = Number(pending.from_user_id);
  session.metadata.teenpatti = tp;
  session.metadata.phase = 'betting';
  await persist(session, { currentTurnUserId: tp.current_turn_user_id });
  const payload = {
    session_id: session.id,
    server_time: new Date().toISOString(),
    request_id: pending.request_id,
    accepted: true,
    timeout: false,
    from_user_id: Number(pending.from_user_id),
    to_user_id: Number(pending.to_user_id),
    loser_user_id: loserUserId,
    hands,
    reveal_ms: SIDESHOW_REVEAL_MS,
  };
  emitState(io, session);
  io.to(sessionRoom(session.id)).emit('tp:side_show_result', payload);
  scheduleSideShowReveal(io, session.id, pending.request_id);
  return session;
}

function scheduleSideShowReveal(io, sessionId, requestId) {
  clearSideShowRevealTimer(sessionId);
  const handle = setTimeout(() => {
    finalizeSideShowReveal(io, sessionId, requestId).catch((err) => {
      console.error(`[TP][${sessionId}] side show reveal finalize failed: ${err.message}`);
    });
  }, SIDESHOW_REVEAL_MS + 80);
  sideShowRevealTimers.set(Number(sessionId), handle);
}

async function finalizeSideShowReveal(io, sessionId, requestId) {
  const lockKey = `lock:tp:action:${sessionId}`;
  const lockOwner = `tp:reveal:${process.pid}:${Date.now()}`;
  const acquired = await redisLockService.acquireLock(lockKey, lockOwner, 8);
  if (!acquired) {
    setTimeout(() => {
      finalizeSideShowReveal(io, sessionId, requestId).catch(() => {});
    }, 400);
    return null;
  }
  try {
    const session = await gameplayService.getSessionState(sessionId);
    const tp = session?.metadata?.teenpatti;
    if (!session || !tp || !tp.side_show_reveal) return session;
    if (requestId && tp.side_show_reveal.request_id !== requestId) return session;

    const reveal = tp.side_show_reveal;
    tp.side_show_reveal = null;
    const loserId = reveal.loser_user_id == null ? null : Number(reveal.loser_user_id);
    if (loserId) {
      const loser = findTpPlayer(tp, loserId);
      if (loser && loser.state !== 'packed' && loser.state !== 'show_lost') {
        loser.state = 'packed';
      }
    }

    const stillAlive = aliveTpPlayers(tp);
    if (stillAlive.length <= 1) {
      session.metadata.teenpatti = tp;
      return finishRound(
        io,
        session,
        [stillAlive[0]?.user_id || reveal.from_user_id],
        'side_show',
      );
    }

    tp.current_turn_user_id = nextAliveUserId(tp, reveal.from_user_id);
    tp.turn_id = crypto.randomUUID();
    tp.turn_ends_at = new Date(Date.now() + TURN_SECONDS * 1000).toISOString();
    delete tp.turn_paused_remaining_ms;
    session.metadata.teenpatti = tp;
    session.metadata.phase = 'betting';
    await persist(session, { currentTurnUserId: tp.current_turn_user_id });
    const fresh = await gameplayService.getSessionState(sessionId);
    emitState(io, fresh);
    scheduleTurnTimeout(io, sessionId, tp.turn_id, tp.current_turn_user_id);
    scheduleBotIfNeeded(io, fresh);
    return fresh;
  } finally {
    await redisLockService.releaseLock(lockKey, lockOwner);
  }
}

async function applyAction(io, sessionId, userId, action = {}) {
  const lockKey = `lock:tp:action:${sessionId}`;
  const lockOwner = `tp:${userId}:${process.pid}:${Date.now()}`;
  const acquired = await redisLockService.acquireLock(lockKey, lockOwner, 8);
  if (!acquired) {
    const err = new Error('Action in progress');
    err.code = 'TP_BUSY';
    throw err;
  }

  try {
    const session = await gameplayService.getSessionState(sessionId);
    if (!session || !isTeenPattiSession(session)) {
      const err = new Error('Teen Patti session not found');
      err.code = 'SESSION_NOT_FOUND';
      throw err;
    }
    const tp = session.metadata?.teenpatti;
    if (!tp || tp.phase !== 'betting') {
      const err = new Error('Betting is not active');
      err.code = 'TP_NOT_BETTING';
      throw err;
    }

    const type = String(action.type || '').toLowerCase();
    const isTurnPlayer = Number(tp.current_turn_user_id) === Number(userId);
    const pendingShow = tp.side_show || null;
    const pendingExpired = pendingShow && Number.isFinite(Date.parse(pendingShow.expires_at))
      && Date.parse(pendingShow.expires_at) < Date.now() - 200;

    if (pendingExpired && type !== 'side_show_reply') {
      return resolveSideShow(io, session, 0, false);
    }

    if (type === 'side_show_reply') {
      if (action.request_id && tp.side_show && action.request_id !== tp.side_show.request_id) {
        return session;
      }
      return resolveSideShow(io, session, userId, action.accept === true);
    }

    if (tp.side_show_reveal) {
      throw Object.assign(new Error('Side show reveal in progress'), { code: 'TP_SIDESHOW_PENDING' });
    }

    if (pendingShow && type !== 'see') {
      throw Object.assign(new Error('Side show pending'), { code: 'TP_SIDESHOW_PENDING' });
    }

    if (type !== 'see' && !isTurnPlayer) {
      const err = new Error('Not your turn');
      err.code = 'TP_NOT_TURN';
      throw err;
    }

    const player = findTpPlayer(tp, userId);
    if (!player || player.state === 'packed' || player.state === 'show_lost') {
      const err = new Error('Player is packed');
      err.code = 'TP_PACKED';
      throw err;
    }

    const opponents = aliveTpPlayers(tp).filter((p) => Number(p.user_id) !== Number(userId));
    const actions = legalActions({
      player,
      opponentsAlive: opponents,
      lastBet: tp.last_bet,
      boot: tp.boot,
      pot: tp.pot,
      potLimit: tp.pot_limit,
      isTurn: isTurnPlayer,
      bettingRound: tp.betting_round || 1,
      previousOpponent: previousAlivePlayer(tp, userId),
      sideShowPending: Boolean(tp.side_show),
    });

    if (type === 'see') {
      if (!actions.can_see) throw Object.assign(new Error('Cannot see'), { code: 'TP_ILLEGAL' });
      player.state = 'seen';
      session.metadata.teenpatti = tp;
      await persist(session, { currentTurnUserId: tp.current_turn_user_id });
      const fresh = await gameplayService.getSessionState(sessionId);
      emitState(io, fresh);
      if (isTurnPlayer) scheduleBotIfNeeded(io, fresh);
      return fresh;
    }

    if (type === 'side_show') {
      if (!actions.can_side_show) {
        throw Object.assign(new Error('Cannot request side show'), { code: 'TP_ILLEGAL' });
      }
      return requestSideShow(io, session, userId, actions.side_show_target_user_id);
    }

    if (type === 'pack') {
      if (!actions.can_pack) throw Object.assign(new Error('Cannot pack'), { code: 'TP_ILLEGAL' });
      player.state = 'packed';
      noteOrbitAction(tp, userId);
    } else if (type === 'chaal' || type === 'blind') {
      const allowed = type === 'blind' ? actions.can_blind : actions.can_chaal;
      if (!allowed) throw Object.assign(new Error(`Cannot ${type}`), { code: 'TP_ILLEGAL' });
      const min = actions.min_chaal;
      const max = actions.max_chaal;
      const amount = Number(action.amount);
      const stake = Number.isFinite(amount) ? amount : min;
      if (stake < min) throw Object.assign(new Error('Chaal too low'), { code: 'TP_CHAAL_LOW' });
      if (stake > max) throw Object.assign(new Error('Chaal too high'), { code: 'TP_CHAAL_HIGH' });
      if (tp.pot + stake > tp.pot_limit) {
        throw Object.assign(new Error('Pot limit reached'), { code: 'TP_POT_LIMIT' });
      }
      if (!isBotSeat(session, userId) && tpWallet.shouldSettle(session)) {
        const paid = await tpWallet.debitStake({
          sessionId,
          userId,
          amount: stake,
          reason: type === 'blind' ? 'teenpatti_blind' : 'teenpatti_chaal',
        });
        player.wallet_settled = Number(player.wallet_settled || 0) + Number(paid.actualDebit || 0);
        if (paid.total_balance != null) player.wallet_balance = paid.total_balance;
      }
      player.current_stake = stake;
      player.total_invested += stake;
      tp.pot += stake;
      tp.last_bet = player.state === 'seen' ? Math.ceil(stake / 2) : stake;
      tp.last_better_user_id = Number(userId);
      if (player.state === 'blind') player.blind_count = (player.blind_count || 0) + 1;
      if (player.state === 'blind' && player.blind_count >= MAX_BLINDS) {
        player.state = 'seen';
      }
      noteOrbitAction(tp, userId);
    } else if (type === 'show') {
      if (!actions.can_show) throw Object.assign(new Error('Show only with 2 players'), { code: 'TP_ILLEGAL' });
      const other = opponents[0];
      const cmp = compareHands(player.cards, other.cards);
      const winnerId = cmp >= 0 ? player.user_id : other.user_id;
      const loser = cmp >= 0 ? other : player;
      loser.state = 'show_lost';
      session.metadata.teenpatti = tp;
      return finishRound(io, session, [winnerId], 'show');
    } else {
      throw Object.assign(new Error('Unknown action'), { code: 'TP_UNKNOWN_ACTION' });
    }

    const stillAlive = aliveTpPlayers(tp);
    if (stillAlive.length === 1) {
      session.metadata.teenpatti = tp;
      return finishRound(io, session, [stillAlive[0].user_id], type === 'pack' ? 'pack' : 'last_player');
    }

    tp.current_turn_user_id = nextAliveUserId(tp, userId);
    tp.turn_id = crypto.randomUUID();
    tp.turn_ends_at = new Date(Date.now() + TURN_SECONDS * 1000).toISOString();
    session.metadata.teenpatti = tp;
    session.metadata.phase = 'betting';
    await persist(session, { currentTurnUserId: tp.current_turn_user_id });
    const fresh = await gameplayService.getSessionState(sessionId);
    emitState(io, fresh);
    scheduleTurnTimeout(io, sessionId, tp.turn_id, tp.current_turn_user_id);
    scheduleBotIfNeeded(io, fresh);
    return fresh;
  } finally {
    await redisLockService.releaseLock(lockKey, lockOwner);
  }
}

async function leaveTable(io, session, userId) {
  const tp = session.metadata?.teenpatti;
  if (tp?.side_show && (
    Number(tp.side_show.from_user_id) === Number(userId)
    || Number(tp.side_show.to_user_id) === Number(userId)
  )) {
    try {
      await applyAction(io, session.id, tp.side_show.to_user_id, {
        type: 'side_show_reply',
        accept: false,
      });
    } catch (err) {
      console.warn(`[TP][${session.id}] clear sideshow on leave failed: ${err.message}`);
      tp.side_show = null;
    }
  }
  try {
    if (tp && tp.phase === 'betting' && Number(tp.current_turn_user_id) === Number(userId)) {
      await applyAction(io, session.id, userId, { type: 'pack', reason: 'leave' });
    } else if (tp && tp.phase === 'betting') {
      const player = findTpPlayer(tp, userId);
      if (player && player.state !== 'packed') {
        player.state = 'packed';
        session.metadata.teenpatti = tp;
        const alive = aliveTpPlayers(tp);
        if (alive.length === 1) {
          await finishRound(io, session, [alive[0].user_id], 'leave');
        } else {
          await persist(session);
        }
      }
    }
  } catch (err) {
    console.warn(`[TP][${session.id}] pack-on-leave failed uid=${userId}: ${err.message}`);
  }

  let fresh = session;
  try {
    fresh = await gameplayService.recordExplicitTableLeave({
      sourceSessionId: session.id,
      userId,
      reason: 'teenpatti_leave',
      activeSessionExit: true,
    });
  } catch (err) {
    console.warn(`[TP][${session.id}] record leave failed uid=${userId}: ${err.message}`);
    fresh = await gameplayService.getSessionState(session.id);
  }

  if (fresh && humanSeated(fresh).length === 0
    && !['completed', 'cancelled'].includes(String(fresh.status || '').toLowerCase())) {
    return completeSession(io, fresh, 'human_left');
  }
  if (fresh) emitState(io, fresh);
  return fresh;
}

module.exports = {
  buildPublicState,
  emitState,
  startToss,
  dealNewRound,
  beginBetting,
  applyAction,
  leaveTable,
  sessionRoom,
};
