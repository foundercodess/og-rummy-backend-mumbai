const express = require('express');
const gameController = require('../controllers/game.controller');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/', gameController.getGames);
router.get('/admin', requireAdmin, gameController.getGamesForAdmin);
router.post('/:gameId/contests', requireAdmin, gameController.createContest);
router.patch('/:gameId/contests/:contestId/active', requireAdmin, gameController.setContestActive);
router.patch('/:gameId/active', requireAdmin, gameController.setGameActive);

module.exports = router;
