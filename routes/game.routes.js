const express = require('express');
const gameController = require('../controllers/game.controller');
const { requireAdmin, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.get('/', gameController.getGames);
router.get('/admin', requireAdmin, requirePermission('games.read'), gameController.getGamesForAdmin);
router.post('/:gameId/contests', requireAdmin, requirePermission('games.write'), gameController.createContest);
router.patch('/:gameId/contests/:contestId/active', requireAdmin, requirePermission('games.write'), gameController.setContestActive);
router.patch('/:gameId/active', requireAdmin, requirePermission('games.write'), gameController.setGameActive);

module.exports = router;
