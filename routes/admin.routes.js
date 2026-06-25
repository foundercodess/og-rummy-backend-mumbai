const express = require('express');
const adminController = require('../controllers/admin.controller');
const noticeController = require('../controllers/notice.controller');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Admin dashboard (revenue ledger sums + playing-now count)
router.get('/dashboard', requireAdmin, adminController.getDashboard);

// Admin platform ledger history (commission / bot win credits)
router.get('/ledger', requireAdmin, adminController.listAdminLedger);

// Admin: fetch paginated KYC list with filters
router.get('/kyc', requireAdmin, adminController.listKyc);

// Admin: fetch game sessions history with filters (all/live/completed)
router.get('/games/history', requireAdmin, adminController.listGamesHistory);

// Admin: fetch a single game session history details
router.get('/games/history/:sessionId', requireAdmin, adminController.getGameHistoryDetails);

// Admin: game telemetry (latency, errors, delivery)
router.get('/telemetry/summary', requireAdmin, adminController.getGameTelemetrySummary);
router.get('/telemetry/events', requireAdmin, adminController.listGameTelemetry);
router.get('/telemetry/traces/:traceId', requireAdmin, adminController.getGameTelemetryTrace);
router.get('/telemetry/sessions/:sessionId/report', requireAdmin, adminController.getGameTelemetrySessionReport);

// Admin: cancel stale waiting/ready sessions (same logic as scheduled job); optional body/query stale_after_hours, max_batch
router.post('/games/cleanup-stale-sessions', requireAdmin, adminController.triggerStaleSessionCleanup);

// Admin: fetch wallet transactions with filters and summary
router.get('/wallet/transactions', requireAdmin, adminController.listWalletTransactions);

// Admin: fetch recharge/add-cash transactions with payment-status filters
router.get('/wallet/recharges', requireAdmin, adminController.listRecharges);

// Admin: fetch one recharge/add-cash transaction with linked wallet ledger rows
router.get('/wallet/recharges/:rechargeId', requireAdmin, adminController.getRechargeDetails);

// Admin: support queues
router.get('/support/feedback/withdrawal', requireAdmin, adminController.listWithdrawalFeedback);
router.get('/support/feedback/withdrawal/:feedbackId', requireAdmin, adminController.getWithdrawalFeedbackDetails);
router.patch('/support/feedback/withdrawal/:feedbackId/status', requireAdmin, adminController.updateWithdrawalFeedbackStatus);
router.get('/support/feedback/bug-report', requireAdmin, adminController.listBugReportFeedback);
router.get('/support/feedback/bug-report/:feedbackId', requireAdmin, adminController.getBugReportDetails);
router.patch('/support/feedback/bug-report/:feedbackId/status', requireAdmin, adminController.updateBugReportStatus);
router.get('/support/add-cash-complaint', requireAdmin, adminController.listAddCashComplaints);
router.get('/support/add-cash-complaint/:complaintId', requireAdmin, adminController.getAddCashComplaintDetails);
router.patch('/support/add-cash-complaint/:complaintId/status', requireAdmin, adminController.updateAddCashComplaintStatus);

// Admin: get/update maintenance mode for frontend app-wide behavior
router.get('/maintenance-mode', requireAdmin, adminController.getMaintenanceMode);
router.patch('/maintenance-mode', requireAdmin, adminController.updateMaintenanceMode);

// Admin: unified app settings (includes disabled records)
router.get('/app-settings', requireAdmin, adminController.getAppSettings);
router.get('/app-update', requireAdmin, adminController.getAppUpdateConfig);
router.get('/app-update/:platform/versions', requireAdmin, adminController.listAppUpdateVersions);
router.post('/app-update/:platform/delete-old', requireAdmin, adminController.deleteOldAppUpdateVersions);
router.patch('/app-update/:platform', requireAdmin, adminController.updateAppUpdateConfig);
router.post('/app-update/upload-apk', requireAdmin, adminController.singleApkUpload, adminController.uploadAppUpdateApk);

// Admin: app settings toggles/updates
router.post('/app-settings/avatars', requireAdmin, adminController.createAvatar);
router.patch('/app-settings/avatars/:avatarId/active', requireAdmin, adminController.updateAvatarActive);
router.post('/app-settings/add-cash-options', requireAdmin, adminController.createAddCashOption);
router.patch('/app-settings/add-cash-options/:optionId/active', requireAdmin, adminController.updateAddCashOptionActive);
router.post('/app-settings/withdraw-options', requireAdmin, adminController.createWithdrawOption);
router.patch('/app-settings/withdraw-options/:optionId/active', requireAdmin, adminController.updateWithdrawOptionActive);
router.post('/app-settings/faqs', requireAdmin, adminController.createFaq);
router.patch('/app-settings/faqs/:faqId/active', requireAdmin, adminController.updateFaqActive);
router.post('/app-settings/supports', requireAdmin, adminController.createSupport);
router.patch('/app-settings/supports/:supportId', requireAdmin, adminController.updateSupport);

// Admin: fetch user details by id (user + wallet + kyc)
router.get('/users/:userId', requireAdmin, adminController.getUserDetails);

// Admin: activate/deactivate user account
router.patch('/users/:userId/active', requireAdmin, adminController.updateUserActiveStatus);

// Admin: update user KYC status and rejection note
router.patch('/users/:userId/kyc-status', requireAdmin, adminController.updateUserKycStatus);

// Admin: manage global notices
router.get('/notices', requireAdmin, noticeController.listAll);
router.post('/notices', requireAdmin, noticeController.create);
router.patch('/notices/:noticeId', requireAdmin, noticeController.update);
router.delete('/notices/:noticeId', requireAdmin, noticeController.remove);

module.exports = router;
