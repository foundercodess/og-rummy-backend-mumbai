const notificationModel = require('../models/notification.model');

async function createNotification(userId, { title, content, type = 'system', metadata = null }) {
  if (!userId || !title || !content) return null;
  return notificationModel.create({ userId, title, content, type, metadata });
}

async function listUserNotifications({ userId, limit = 50, offset = 0 }) {
  const safeLimit = Number.isNaN(Number(limit)) ? 50 : Math.min(Number(limit), 100);
  const safeOffset = Number.isNaN(Number(offset)) ? 0 : Math.max(Number(offset), 0);

  const [items, unreadCount] = await Promise.all([
    notificationModel.listByUserId({ userId, limit: safeLimit, offset: safeOffset }),
    notificationModel.countUnreadByUserId(userId),
  ]);

  return { items, unreadCount };
}

async function markRead({ userId, scope, notificationId }) {
  if (!['one', 'all'].includes(scope)) {
    throw new Error('INVALID_SCOPE');
  }
  if (scope === 'one') {
    if (!notificationId) throw new Error('NOTIFICATION_ID_REQUIRED');
    const item = await notificationModel.markReadById({ userId, id: notificationId });
    return { updated: item ? 1 : 0 };
  }
  const updatedItems = await notificationModel.markAllReadByUserId(userId);
  return { updated: updatedItems.length };
}

async function remove({ userId, scope, notificationId }) {
  if (!['one', 'all'].includes(scope)) {
    throw new Error('INVALID_SCOPE');
  }
  if (scope === 'one') {
    if (!notificationId) throw new Error('NOTIFICATION_ID_REQUIRED');
    const ok = await notificationModel.deleteById({ userId, id: notificationId });
    return { deleted: ok ? 1 : 0 };
  }
  const deletedCount = await notificationModel.deleteAllByUserId(userId);
  return { deleted: deletedCount };
}

module.exports = {
  createNotification,
  listUserNotifications,
  markRead,
  remove,
};

