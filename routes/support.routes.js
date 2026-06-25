const express = require('express');
const supportController = require('../controllers/support.controller');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Add-cash complaint
router.post('/add-cash-complaint', requireAuth, supportController.createAddCashComplaint);
router.get('/cash-complaint', requireAuth, supportController.listAddCashComplaints);

// Reports/feedback
router.post('/feedback', requireAuth, supportController.createReportFeedback);
router.get('/feedback', requireAuth, supportController.listReportFeedback);

module.exports = router;

