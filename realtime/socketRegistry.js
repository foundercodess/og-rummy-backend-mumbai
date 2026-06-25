const socketsByUserId = new Map();

function addSocket(userId, socketId) {
  if (!socketsByUserId.has(userId)) {
    socketsByUserId.set(userId, new Set());
  }
  socketsByUserId.get(userId).add(socketId);
}

function removeSocket(userId, socketId) {
  const sockets = socketsByUserId.get(userId);
  if (!sockets) return;
  sockets.delete(socketId);
  if (sockets.size === 0) {
    socketsByUserId.delete(userId);
  }
}

function getSocketIds(userId) {
  return Array.from(socketsByUserId.get(userId) || []);
}

function getUserSocket(userId, io) {
  const socketIds = getSocketIds(userId);
  for (const socketId of socketIds) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) return socket;
  }
  return null;
}

module.exports = {
  addSocket,
  removeSocket,
  getSocketIds,
  getUserSocket,
};
