const express = require('express');
const couponController = require('../controllers/coupon.controller');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, couponController.getCoupons);

module.exports = router;
