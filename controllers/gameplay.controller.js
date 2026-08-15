const gameplayService = require('../services/gameplay.service');

function handleGameplayError(res, err) {
  if (err.code === 'CONTEST_NOT_FOUND' || err.code === 'SESSION_NOT_FOUND' || err.code === 'PLAYER_NOT_FOUND') {
    return res.status(404).json({
      success: false,
      message: err.message,
      ...(err.details && { details: err.details }),
    });
  }
  if (['CONTEST_INACTIVE', 'SESSION_NOT_JOINABLE', 'SESSION_FULL', 'SESSION_PHASE_LOCKED', 'SESSION_ACCESS_DENIED', 'PLAYER_LEFT_TABLE', 'INSUFFICIENT_BALANCE', 'MAX_CONCURRENT_TABLES', 'SESSION_JOIN_BUSY'].includes(err.code)) {
    return res.status(400).json({
      success: false,
      message: err.message,
      code: err.code,
      ...(err.details && { details: err.details }),
    });
  }

  console.error('gameplay error:', err);
  return res.status(500).json({ success: false, message: 'Gameplay request failed' });
}

async function createSession(req, res) {
  try {
    console.log('Received createSession request with body:', req.body);
    const {
      game_id: gameId,
      contest_id: contestId,
      max_players: maxPlayers,
      metadata,
    } = req.body || {};
    console.log('Parsed createSession parameters:', { gameId, contestId, maxPlayers, metadata });
    const session = await gameplayService.createSession({
      gameId: Number(gameId),
      contestId: Number(contestId),
      hostUserId: req.user.id,
      maxPlayers: Number(maxPlayers),
      metadata: metadata || {},
    });

    return res.status(201).json({
      success: true,
      message: 'Game session created successfully',
      session,
    });
  } catch (err) {
    return handleGameplayError(res, err);
  }
}

async function joinSession(req, res) {
  try {
    const sessionRef = req.params.sessionIdOrCode;
    const parsedId = Number(sessionRef);
    const session = await gameplayService.joinSession({
      sessionIdOrCode: Number.isInteger(parsedId) && !Number.isNaN(parsedId) ? parsedId : sessionRef,
      userId: req.user.id,
    });

    return res.json({
      success: true,
      message: 'Joined session successfully',
      session,
    });
  } catch (err) {
    return handleGameplayError(res, err);
  }
}

async function markReady(req, res) {
  try {
    const sessionId = Number(req.params.sessionId);
    const ready = req.body && typeof req.body.ready === 'boolean' ? req.body.ready : true;
    const session = await gameplayService.markPlayerReady({
      sessionId,
      userId: req.user.id,
      ready,
    });

    return res.json({
      success: true,
      message: ready ? 'Player marked ready' : 'Player marked not ready',
      session,
    });
  } catch (err) {
    return handleGameplayError(res, err);
  }
}

async function getSession(req, res) {
  try {
    const sessionRef = req.params.sessionIdOrCode;
    const parsedId = Number(sessionRef);
    const session = await gameplayService.getSessionState(
      Number.isInteger(parsedId) && !Number.isNaN(parsedId) ? parsedId : sessionRef
    );

    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    return res.json({
      success: true,
      message: 'Session fetched successfully',
      session,
    });
  } catch (err) {
    return handleGameplayError(res, err);
  }
}

async function listActiveSessions(req, res) {
  try {
    const result = await gameplayService.listActiveSessionsForUser(req.user.id);
    return res.json({
      success: true,
      message: 'Active sessions fetched successfully',
      ...result,
    });
  } catch (err) {
    return handleGameplayError(res, err);
  }
}

module.exports = {
  createSession,
  joinSession,
  markReady,
  getSession,
  listActiveSessions,
};
