const express = require('express');
const notificationController = require('../controllers/notification.controller');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// List notifications + unread count
router.get('/', requireAuth, notificationController.list);

// Mark notifications as read (scope: 'one' | 'all')
router.post('/read', requireAuth, notificationController.markRead);

// Delete notifications (scope: 'one' | 'all')
router.post('/delete', requireAuth, notificationController.remove);

module.exports = router;



