const express = require('express');
const userController = require('../controllers/user.controller');
const kycController = require('../controllers/kyc.controller');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/profile', requireAuth, userController.getProfile);
router.patch('/profile', requireAuth, userController.updateProfile);

// Admin: list all users
router.get('/admin', requireAdmin, userController.listUsers);

router.post('/kyc', requireAuth, kycController.upsertKyc);
router.put('/kyc', requireAuth, kycController.upsertKyc);

module.exports = router;
