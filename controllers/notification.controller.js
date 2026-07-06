const notificationService = require('../services/notification.service');

/** List notifications for the authenticated user, including unread count. */
async function list(req, res) {
  try {
    const userId = req.user.id;
    const { limit, offset } = req.query || {};

    const { items, unreadCount } = await notificationService.listUserNotifications({
      userId,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });

    return res.json({
      success: true,
      message: 'Notifications retrieved successfully',
      notifications: items,
      unread_count: unreadCount,
    });
  } catch (err) {
    console.error('notifications.list error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve notifications' });
  }
}

/** Mark notifications as read (single or all). */
async function markRead(req, res) {
  try {
    const userId = req.user.id;
    const { scope, notification_id: notificationId } = req.body || {};

    if (!scope) {
      return res.status(400).json({ success: false, message: 'scope is required' });
    }

    let result;
    try {
      result = await notificationService.markRead({
        userId,
        scope,
        notificationId,
      });
    } catch (e) {
      if (e.message === 'INVALID_SCOPE' || e.message === 'NOTIFICATION_ID_REQUIRED') {
        return res.status(400).json({ success: false, message: e.message });
      }
      throw e;
    }

    return res.json({
      success: true,
      message: 'Notification(s) marked as read',
      result,
    });
  } catch (err) {
    console.error('notifications.markRead error:', err);
    return res.status(500).json({ success: false, message: 'Failed to mark notifications as read' });
  }
}

/** Delete notifications (single or all). */
async function remove(req, res) {
  try {
    const userId = req.user.id;
    const { scope, notification_id: notificationId } = req.body || {};

    if (!scope) {
      return res.status(400).json({ success: false, message: 'scope is required' });
    }

    let result;
    try {
      result = await notificationService.remove({
        userId,
        scope,
        notificationId,
      });
    } catch (e) {
      if (e.message === 'INVALID_SCOPE' || e.message === 'NOTIFICATION_ID_REQUIRED') {
        return res.status(400).json({ success: false, message: e.message });
      }
      throw e;
    }

    return res.json({
      success: true,
      message: 'Notification(s) deleted',
      result,
    });
  } catch (err) {
    console.error('notifications.remove error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete notifications' });
  }
}

async function registerDeviceToken(req, res) {
  try {
    const {
      fcm_token: fcmToken,
      platform,
      device_id: deviceId,
      app_version: appVersion,
    } = req.body || {};

    const result = await notificationService.registerDeviceToken(req.user.id, {
      fcmToken,
      platform,
      deviceId,
      appVersion,
    });

    return res.json({
      success: true,
      message: 'Device token registered successfully',
      ...result,
    });
  } catch (err) {
    if (err.code === 'FCM_TOKEN_REQUIRED') {
      return res.status(400).json({ success: false, message: 'fcm_token is required' });
    }
    console.error('notifications.registerDeviceToken error:', err);
    return res.status(500).json({ success: false, message: 'Failed to register device token' });
  }
}

async function unregisterDeviceToken(req, res) {
  try {
    const { fcm_token: fcmToken } = req.body || {};
    const result = await notificationService.unregisterDeviceToken(req.user.id, { fcmToken });

    return res.json({
      success: true,
      message: 'Device token unregistered successfully',
      ...result,
    });
  } catch (err) {
    if (err.code === 'FCM_TOKEN_REQUIRED') {
      return res.status(400).json({ success: false, message: 'fcm_token is required' });
    }
    console.error('notifications.unregisterDeviceToken error:', err);
    return res.status(500).json({ success: false, message: 'Failed to unregister device token' });
  }
}

module.exports = {
  list,
  markRead,
  remove,
  registerDeviceToken,
  unregisterDeviceToken,
};

