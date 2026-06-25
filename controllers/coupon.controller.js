const promoCodeModel = require('../models/promoCode.model');

/** Get all promos with user context (used flag). */
async function getCoupons(req, res) {
  try {
    const userId = req.user.id;
    const promos = await promoCodeModel.getActiveWithUserUsage(userId);

    return res.json({
      success: true,
      message: 'Coupons retrieved successfully',
      promos,
    });
  } catch (err) {
    console.error('getCoupons error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve coupons' });
  }
}

module.exports = {
  getCoupons,
};
