const express = require('express');
const authController = require('../controllers/auth.controller');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.post('/send-otp', authController.sendOtp);
router.post('/verify-otp', authController.verifyOtp);
router.post('/admin/login', authController.adminLogin);
router.get('/admin/me', requireAdmin, authController.adminMe);
router.post('/logout', requireAuth, authController.logout);

module.exports = router;
