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

module.exports = {
  list,
  markRead,
  remove,
};

