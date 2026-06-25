const { io } = require('socket.io-client');

const baseUrl = 'http://127.0.0.1:3000';
const phones = ['6390404429', '9565922753'];

async function post(path, body, token) {
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json();
  if (!res.ok || json.success === false || json.status === false) {
    throw new Error(`${path} failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function get(path, token) {
  const res = await fetch(baseUrl + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const json = await res.json();
  if (!res.ok || json.success === false || json.status === false) {
    throw new Error(`${path} failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function auth(phone) {
  const sent = await post('/api/auth/send-otp', { phone });
  const verified = await post('/api/auth/verify-otp', {
    phone,
    otp: '1111',
    login_attempt_id: sent.login_attempt_id,
  });
  return { token: verified.token, user: verified.user };
}

function connectClient(token, label) {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, {
      auth: { token },
      transports: ['websocket'],
      timeout: 10000,
      reconnection: false,
    });

    const timer = setTimeout(() => reject(new Error(`${label} connect timeout`)), 10000);
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('connection:ready', (data) => {
      clearTimeout(timer);
      resolve({ socket, ready: data });
    });
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timeout`)), 12000);
    socket.emit(event, payload, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

function waitForEvent(socket, event, timeoutMs = 45000, predicate = null) {
  return new Promise((resolve, reject) => {
    const onEvent = (data) => {
      if (predicate && !predicate(data)) return;
      cleanup();
      resolve(data);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, onEvent);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${event} wait timeout`));
    }, timeoutMs);
    socket.on(event, onEvent);
  });
}

function summarizeGrouping(data) {
  return {
    groups: (data?.groups || []).map((g) => ({
      group_id: g.group_id,
      type: g.type,
      cards: (g.cards || []).map((c) => c.card_uid),
      is_valid_meld: g.is_valid_meld,
    })),
    summary: data?.summary || {},
  };
}

(async () => {
  const authA = await auth(phones[0]);
  const authB = await auth(phones[1]);

  const games = await get('/api/games');
  const game = games.games.find((g) => g.active && g.contests && g.contests['2'] && g.contests['2'].length > 0);
  if (!game) throw new Error('No active 2-player contest found');
  const contest = game.contests['2'][0];

  const created = await post('/api/gameplay/sessions', {
    game_id: game.id,
    contest_id: contest.id,
    max_players: 2,
    metadata: {},
  }, authA.token);
  const sessionId = created.session.id;

  const clientA = await connectClient(authA.token, 'A');
  const clientB = await connectClient(authB.token, 'B');

  const byUserId = {
    [clientA.ready.user.id]: { socket: clientA.socket, label: 'A' },
    [clientB.ready.user.id]: { socket: clientB.socket, label: 'B' },
  };

  const ackJoinA = await emitAck(clientA.socket, 'session:join', { session_id: sessionId });
  const ackJoinB = await emitAck(clientB.socket, 'session:join', { session_id: sessionId });
  const ackReadyA = await emitAck(clientA.socket, 'player:ready', { session_id: sessionId, ready: true });
  const ackReadyB = await emitAck(clientB.socket, 'player:ready', { session_id: sessionId, ready: true });

  const deal = await Promise.race([
    waitForEvent(clientA.socket, 'game:deal', 30000),
    waitForEvent(clientB.socket, 'game:deal', 30000),
  ]);

  const turnUserId = deal.turn?.user_id || deal.game_state?.current_turn_user_id;
  const actor = byUserId[turnUserId];
  if (!actor) throw new Error(`Turn user ${turnUserId} not among test clients`);

  const ackAutogroup = await emitAck(actor.socket, 'player:autogroup', { session_id: sessionId });

  const pickPayload = {
    session_id: sessionId,
    source: 'available',
    groups: (ackAutogroup.data.groups || []).map((g) => ({
      group_id: g.group_id,
      cards: (g.cards || []).map((c) => c.card_uid),
    })),
  };
  const ackPick = await emitAck(actor.socket, 'player:pick', pickPayload);

  let movedGrouping = null;
  const pickGroups = ackPick.data.groups || [];
  if (pickGroups.length >= 2) {
    const pickedUid = ackPick.data.picked_card?.card_uid;
    const cloned = pickGroups.map((g) => ({
      group_id: g.group_id,
      cards: (g.cards || []).map((c) => c.card_uid),
    }));
    const sourceIndex = cloned.findIndex((g) => g.cards.includes(pickedUid));
    const targetIndex = cloned.findIndex((g, idx) => idx !== sourceIndex);
    if (sourceIndex >= 0 && targetIndex >= 0) {
      cloned[sourceIndex].cards = cloned[sourceIndex].cards.filter((id) => id !== pickedUid);
      cloned[targetIndex].cards.push(pickedUid);
      const nonEmpty = cloned
        .filter((g) => g.cards.length > 0)
        .map((g, idx) => ({ group_id: idx + 1, cards: g.cards }));
      movedGrouping = await emitAck(actor.socket, 'player:group:update', {
        session_id: sessionId,
        groups: nonEmpty,
      });
    }
  }

  const discardBaseGroups = movedGrouping?.data?.groups || ackPick.data.groups || [];
  const discardSourceGroups = discardBaseGroups.map((g) => ({
    group_id: g.group_id,
    cards: (g.cards || []).map((c) => c.card_uid),
  }));
  const discardFromGroup = discardBaseGroups.find((g) =>
    (g.cards || []).some((c) => c.card_uid === ackPick.data.picked_card.card_uid)
  );

  const ackDiscard = await emitAck(actor.socket, 'player:discard', {
    session_id: sessionId,
    card_uid: ackPick.data.picked_card.card_uid,
    from_group_id: discardFromGroup?.group_id || null,
    groups: discardSourceGroups,
  });

  const result = {
    users: {
      A: { user_id: clientA.ready.user.id, phone: phones[0] },
      B: { user_id: clientB.ready.user.id, phone: phones[1] },
    },
    session_id: sessionId,
    acting_user_id: turnUserId,
    acks: {
      session_join: { A: ackJoinA, B: ackJoinB },
      ready: { A: ackReadyA, B: ackReadyB },
      autogroup: {
        success: ackAutogroup.success,
        data: summarizeGrouping(ackAutogroup.data),
      },
      pick: {
        success: ackPick.success,
        data: {
          source: ackPick.data.source,
          picked_card: ackPick.data.picked_card,
          cards_count: ackPick.data.cards_count,
          closed_deck_count: ackPick.data.closed_deck_count,
          discard_top: ackPick.data.discard_top,
          grouping: summarizeGrouping(ackPick.data.grouping || ackPick.data),
        },
      },
      group_update: movedGrouping ? {
        success: movedGrouping.success,
        data: summarizeGrouping(movedGrouping.data),
      } : null,
      discard: {
        success: ackDiscard.success,
        data: {
          discarded_card: ackDiscard.data.discarded_card,
          cards_count: ackDiscard.data.cards_count,
          discard_top: ackDiscard.data.discard_top,
          turn: ackDiscard.data.turn,
          grouping: summarizeGrouping(ackDiscard.data.grouping || ackDiscard.data),
        },
      },
    },
  };

  console.log(JSON.stringify(result, null, 2));
  clientA.socket.disconnect();
  clientB.socket.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
