const express = require('express');
const walletController = require('../controllers/wallet.controller');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Create an Add Cash (recharge) transaction
router.post('/add-cash', requireAuth, walletController.createAddCash);

// List recharge transactions for the authenticated user
router.get('/recharge-transactions', requireAuth, walletController.listUserTransactions);

// Pending bonus transactions (any source: rewards, promos, etc.)
router.get('/pending-bonus-transactions', requireAuth, walletController.listPendingBonusTransactions);

// Unified wallet transaction details (game/deposit/bonus) with date filters
router.get('/transactions', requireAuth, walletController.listTransactionDetails);

// Update payment status for a recharge transaction (e.g. from gateway callback/admin)
router.post('/payment-status', walletController.updatePaymentStatus);

module.exports = router;

 