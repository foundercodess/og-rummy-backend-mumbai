const rewardsService = require('../services/rewards.service');
const notificationService = require('../services/notification.service');

/** Get 7-day daily reward status for the authenticated user. */
async function getDailyStatus(req, res) {
  try {
    const userId = req.user.id;
    const status = await rewardsService.getDailyStatus(userId);
    return res.json({
      success: true,
      message: 'Daily rewards status',
      ...status,
    });
  } catch (err) {
    console.error('getDailyStatus error:', err);
    return res.status(500).json({ success: false, message: 'Failed to get daily rewards status' });
  }
}

/** Claim today''s daily reward for the authenticated user. */
async function claimDaily(req, res) {
  try {
    const userId = req.user.id;
    const result = await rewardsService.claimDailyReward(userId);

    if (!result.claimed) {
      return res.status(400).json({
        success: false,
        message: 'No reward available to claim today',
        status: result.status,
      });
    }

    // Fire-and-forget notification
    notificationService
      .notifyUser(userId, {
        title: `Day ${result.claimed.day} reward claimed`,
        content: `You received ₹${result.claimed.amount} as your daily reward.`,
        type: 'wallet',
        event: notificationService.NOTIFICATION_EVENTS.REWARD_CLAIMED,
        metadata: { day: result.claimed.day, amount: result.claimed.amount, screen: 'rewards' },
      })
      .catch((e) => console.error('daily reward notification error:', e));

    return res.json({
      success: true,
      message: `Day ${result.claimed.day} reward claimed`,
      claimed: result.claimed,
      status: result.status,
    });
  } catch (err) {
    console.error('claimDaily error:', err);
    return res.status(500).json({ success: false, message: 'Failed to claim daily reward' });
  }
}

module.exports = {
  getDailyStatus,
  claimDaily,
};

