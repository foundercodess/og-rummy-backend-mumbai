'use strict';

const gameplayService = require('../../services/gameplay.service');
const { isTeenPattiSession } = require('../../services/gameFamily');
const tableService = require('./table.service');

function ack(callback, payload) {
  if (typeof callback === 'function') callback(payload);
}

function attachTeenPattiSocket(io, socket) {
  if (socket.user?.id) socket.join(`tp-user:${socket.user.id}`);

  const handleAction = (type) => async (payload = {}, callback = () => {}) => {
    try {
      const sessionId = Number(payload.session_id);
      if (Number.isNaN(sessionId)) throw new Error('session_id is required');
      const session = await gameplayService.getSessionState(sessionId);
      if (!session || !isTeenPattiSession(session)) {
        throw new Error('Not a Teen Patti table');
      }
      const member = (session.players || []).some(
        (player) => Number(player.user_id) === Number(socket.user.id)
      );
      if (!member) throw new Error('Not a session member');

      await tableService.applyAction(io, sessionId, socket.user.id, {
        type,
        amount: payload.amount,
        accept: payload.accept === true,
      });
      ack(callback, { success: true, server_time: new Date().toISOString() });
    } catch (err) {
      ack(callback, {
        success: false,
        message: err.message,
        code: err.code || 'TP_ACTION_FAILED',
        server_time: new Date().toISOString(),
      });
    }
  };

  socket.on('tp:see', handleAction('see'));
  socket.on('tp:pack', handleAction('pack'));
  socket.on('tp:chaal', handleAction('chaal'));
  socket.on('tp:blind', handleAction('blind'));
  socket.on('tp:show', handleAction('show'));
  socket.on('tp:side_show', handleAction('side_show'));
  socket.on('tp:side_show_reply', handleAction('side_show_reply'));

  socket.on('tp:sync', async (payload = {}, callback = () => {}) => {
    try {
      const sessionId = Number(payload.session_id);
      const session = await gameplayService.getSessionState(sessionId);
      if (!session || !isTeenPattiSession(session)) throw new Error('Not a Teen Patti table');
      ack(callback, {
        success: true,
        state: tableService.buildPublicState(session, socket.user.id),
        server_time: new Date().toISOString(),
      });
    } catch (err) {
      ack(callback, { success: false, message: err.message });
    }
  });
}

function syncSocket(socket, session) {
  if (!session || !isTeenPattiSession(session)) return { phase: session?.status || 'waiting', event: 'tp:state' };
  socket.emit('tp:state', {
    success: true,
    server_time: new Date().toISOString(),
    state: tableService.buildPublicState(session, socket.user.id),
  });
  return { phase: session.metadata?.teenpatti?.phase || session.status, event: 'tp:state' };
}

async function handleLeave(io, socket, session) {
  await tableService.leaveTable(io, session, socket.user.id);
  socket.leave(tableService.sessionRoom(session.id));
  return { success: true };
}

/** Kill-app / socket drop: pack + hard leave so the table is not pending-rejoin. */
async function handleDisconnectLeave(io, session, userId) {
  if (!session || !userId) return null;
  const seated = (session.players || []).find(
    (player) => Number(player.user_id) === Number(userId)
  );
  if (!seated) return session;
  const status = String(seated.status || '').toLowerCase();
  if (status === 'left' || seated.metadata?.table_left === true) return session;
  return tableService.leaveTable(io, session, userId);
}

module.exports = {
  attachTeenPattiSocket,
  syncSocket,
  handleLeave,
  handleDisconnectLeave,
};
