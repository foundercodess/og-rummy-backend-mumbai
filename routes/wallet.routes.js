const express = require('express');
const walletController = require('../controllers/wallet.controller');
const withdrawalController = require('../controllers/withdrawal.controller');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Create an Add Cash (recharge) transaction
router.post('/add-cash', requireAuth, walletController.createAddCash);

// GiftAura PG redirect callback (no auth)
router.get('/payment-callback', walletController.paymentCallback);

// Poll recharge status after payment redirect
router.get('/recharge-status', requireAuth, walletController.getRechargeStatus);

// List recharge transactions for the authenticated user
router.get('/recharge-transactions', requireAuth, walletController.listUserTransactions);

// Pending bonus transactions (any source: rewards, promos, etc.)
router.get('/pending-bonus-transactions', requireAuth, walletController.listPendingBonusTransactions);

// Unified wallet transaction details (game/deposit/bonus) with date filters
router.get('/transactions', requireAuth, walletController.listTransactionDetails);

// Update payment status for a recharge transaction (authenticated; ownership enforced)
router.post('/payment-status', requireAuth, walletController.updatePaymentStatus);

// Bank accounts for withdrawals
router.get('/bank-accounts', requireAuth, withdrawalController.listBankAccounts);
router.post('/bank-accounts', requireAuth, withdrawalController.addBankAccount);
router.delete('/bank-accounts/:id', requireAuth, withdrawalController.deleteBankAccount);

// Withdrawals / payouts
router.post('/withdraw', requireAuth, withdrawalController.createWithdrawal);
router.get('/withdrawals', requireAuth, withdrawalController.listWithdrawals);
router.get('/withdrawals/:id', requireAuth, withdrawalController.getWithdrawalDetail);
router.get('/payout-callback', withdrawalController.payoutCallback);

module.exports = router;

 