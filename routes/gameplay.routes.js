const express = require('express');
const gameplayController = require('../controllers/gameplay.controller');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/sessions', requireAuth, gameplayController.createSession);
router.get('/sessions/active', requireAuth, gameplayController.listActiveSessions);
router.get('/sessions/:sessionIdOrCode', requireAuth, gameplayController.getSession);
router.post('/sessions/:sessionIdOrCode/join', requireAuth, gameplayController.joinSession);
router.post('/sessions/:sessionId/ready', requireAuth, gameplayController.markReady);

module.exports = router;
