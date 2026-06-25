const express = require('express');
const rewardsController = require('../controllers/rewards.controller');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Get 7-day daily rewards status
router.get('/daily', requireAuth, rewardsController.getDailyStatus);

// Claim today's daily reward
router.post('/daily/claim', requireAuth, rewardsController.claimDaily);

module.exports = router;

