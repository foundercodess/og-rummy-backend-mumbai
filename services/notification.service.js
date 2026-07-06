const notificationModel = require('../models/notification.model');
const userDeviceTokenModel = require('../models/userDeviceToken.model');
const pushService = require('./push.service');

const NOTIFICATION_EVENTS = {
  CASH_ADDED: 'cash_added',
  WITHDRAWAL_SUBMITTED: 'withdrawal_submitted',
  WITHDRAWAL_SUCCESS: 'withdrawal_success',
  WITHDRAWAL_FAILED: 'withdrawal_failed',
  WITHDRAWAL_REJECTED: 'withdrawal_rejected',
  TICKET_RESOLVED: 'ticket_resolved',
  TICKET_REJECTED: 'ticket_rejected',
  KYC_APPROVED: 'kyc_approved',
  KYC_REJECTED: 'kyc_rejected',
  WELCOME: 'welcome',
  LOGIN: 'login',
  REWARD_CLAIMED: 'reward_claimed',
};

function serializeMetadata(metadata) {
  if (metadata == null) return null;
  if (typeof metadata === 'string') return metadata;
  try {
    return JSON.stringify(metadata);
  } catch {
    return null;
  }
}

function parseMetadata(metadata) {
  if (!metadata) return {};
  if (typeof metadata === 'object') return metadata;
  try {
    return JSON.parse(metadata);
  } catch {
    return {};
  }
}

async function notifyUser(userId, {
  title,
  content,
  type = 'system',
  event = null,
  metadata = null,
  push = true,
}) {
  if (!userId || !title || !content) return null;

  const mergedMetadata = {
    ...parseMetadata(metadata),
    ...(event ? { event } : {}),
  };
  const metadataJson = serializeMetadata(mergedMetadata);

  const row = await notificationModel.create({
    userId,
    title,
    content,
    type,
    metadata: metadataJson,
  });

  if (push && pushService.isConfigured()) {
    try {
      await pushService.sendToUser(userId, {
        title,
        body: content,
        data: {
          event: event || type,
          type,
          notification_id: row?.id ? String(row.id) : '',
          ...mergedMetadata,
        },
      });
    } catch (error) {
      console.error('notifyUser push error:', error.message);
    }
  }

  return row;
}

async function createNotification(userId, payload) {
  return notifyUser(userId, {
    ...payload,
    event: payload?.metadata?.event || payload?.event || null,
    push: payload?.push !== false,
  });
}

async function registerDeviceToken(userId, {
  fcmToken,
  platform = null,
  deviceId = null,
  appVersion = null,
}) {
  const token = String(fcmToken || '').trim();
  if (!token) {
    const error = new Error('fcm_token is required');
    error.code = 'FCM_TOKEN_REQUIRED';
    throw error;
  }

  const row = await userDeviceTokenModel.upsertToken({
    userId,
    fcmToken: token,
    platform,
    deviceId,
    appVersion,
  });

  return {
    registered: true,
    push_enabled: pushService.isConfigured(),
    token_id: row?.id || null,
  };
}

async function unregisterDeviceToken(userId, { fcmToken }) {
  const token = String(fcmToken || '').trim();
  if (!token) {
    const error = new Error('fcm_token is required');
    error.code = 'FCM_TOKEN_REQUIRED';
    throw error;
  }

  const ok = await userDeviceTokenModel.deactivateToken({ userId, fcmToken: token });
  return { unregistered: ok };
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
  NOTIFICATION_EVENTS,
  notifyUser,
  createNotification,
  registerDeviceToken,
  unregisterDeviceToken,
  listUserNotifications,
  markRead,
  remove,
};
