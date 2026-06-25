const noticeService = require('../services/notice.service');

let ioInstance = null;

function setSocketIO(io) {
  ioInstance = io;
}

function getSocketIO() {
  return ioInstance;
}

async function emitActiveNotices(targetSocket = null) {
  const notices = await noticeService.listActiveNotices();
  const payload = {
    items: notices,
    server_time: new Date().toISOString(),
  };

  if (targetSocket) {
    targetSocket.emit('notice:list', payload);
    return payload;
  }

  if (ioInstance) {
    ioInstance.emit('notice:list', payload);
  }

  return payload;
}

module.exports = {
  setSocketIO,
  getSocketIO,
  emitActiveNotices,
};