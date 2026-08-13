const express = require('express');
const adminController = require('../controllers/admin.controller');
const noticeController = require('../controllers/notice.controller');
const adminRbacController = require('../controllers/adminRbac.controller');
const { requireAdmin, requirePermission, requireAnyPermission } = require('../middleware/auth');

const router = express.Router();

const P = (code) => [requireAdmin, requirePermission(code)];
const anyP = (...codes) => [requireAdmin, requireAnyPermission(...codes)];

// Admin dashboard (revenue ledger sums + playing-now count)
router.get('/dashboard', ...P('dashboard.read'), adminController.getDashboard);

// Charts / analytics with date-range series (sections redacted by metrics perms)
router.get('/analytics', ...anyP('analytics.read', 'dashboard.read'), adminController.getAnalytics);

// Admin platform ledger history (commission / bot win credits / bot loss debits)
router.get('/ledger', ...P('ledger.read'), adminController.listAdminLedger);

// Admin: fetch paginated KYC list with filters
router.get('/kyc', ...P('kyc.read'), adminController.listKyc);

// Admin: fetch game sessions history with filters (all/live/completed)
router.get('/games/history', ...P('games.history.read'), adminController.listGamesHistory);

// Admin: per-game + contest session stats (completed / today / live)
router.get('/games/session-stats', ...P('games.read'), adminController.getGameSessionStats);

// Admin: fetch a single game session history details
router.get('/games/history/:sessionId', ...P('games.history.read'), adminController.getGameHistoryDetails);

// Admin: game telemetry (latency, errors, delivery)
router.get('/telemetry/summary', ...P('telemetry.read'), adminController.getGameTelemetrySummary);
router.get('/telemetry/events', ...P('telemetry.read'), adminController.listGameTelemetry);
router.get('/telemetry/traces/:traceId', ...P('telemetry.read'), adminController.getGameTelemetryTrace);
router.get('/telemetry/sessions/:sessionId/report', ...P('telemetry.read'), adminController.getGameTelemetrySessionReport);

// Admin: cancel stale waiting/ready sessions (same logic as scheduled job); optional body/query stale_after_hours, max_batch
router.post('/games/cleanup-stale-sessions', ...P('games.write'), adminController.triggerStaleSessionCleanup);

// Admin: fetch wallet transactions with filters and summary
router.get('/wallet/transactions', ...anyP('recharges.read', 'cashflow.read'), adminController.listWalletTransactions);

// Admin: fetch recharge/add-cash transactions with payment-status filters
router.get('/wallet/recharges', ...P('recharges.read'), adminController.listRecharges);

// Admin: fetch one recharge/add-cash transaction with linked wallet ledger rows
router.get('/wallet/recharges/:rechargeId', ...P('recharges.read'), adminController.getRechargeDetails);

// Admin: withdrawal payout queue (list, detail, settle via PG, reject + refund)
router.get('/wallet/withdrawals', ...P('withdrawals.read'), adminController.listWithdrawals);
router.get('/wallet/withdrawals/:withdrawalId', ...P('withdrawals.read'), adminController.getWithdrawalDetails);
router.post('/wallet/withdrawals/:withdrawalId/settle', ...P('withdrawals.write'), adminController.settleWithdrawal);
router.post('/wallet/withdrawals/:withdrawalId/reject', ...P('withdrawals.write'), adminController.rejectWithdrawal);
router.post('/wallet/withdrawals/:withdrawalId/sync-status', ...P('withdrawals.write'), adminController.syncWithdrawalStatus);
router.post('/wallet/credit', ...P('users.write'), adminController.creditWalletByViewId);

// Admin: support queues
router.get('/support/feedback/withdrawal', ...P('support.read'), adminController.listWithdrawalFeedback);
router.get('/support/feedback/withdrawal/:feedbackId', ...P('support.read'), adminController.getWithdrawalFeedbackDetails);
router.patch('/support/feedback/withdrawal/:feedbackId/status', ...P('support.write'), adminController.updateWithdrawalFeedbackStatus);
router.get('/support/feedback/bug-report', ...P('support.read'), adminController.listBugReportFeedback);
router.get('/support/feedback/bug-report/:feedbackId', ...P('support.read'), adminController.getBugReportDetails);
router.patch('/support/feedback/bug-report/:feedbackId/status', ...P('support.write'), adminController.updateBugReportStatus);
router.get('/support/add-cash-complaint', ...P('support.read'), adminController.listAddCashComplaints);
router.get('/support/add-cash-complaint/:complaintId', ...P('support.read'), adminController.getAddCashComplaintDetails);
router.patch('/support/add-cash-complaint/:complaintId/status', ...P('support.write'), adminController.updateAddCashComplaintStatus);

// Admin: get/update maintenance mode for frontend app-wide behavior
router.get('/maintenance-mode', ...P('app_settings.read'), adminController.getMaintenanceMode);
router.patch('/maintenance-mode', ...P('app_settings.write'), adminController.updateMaintenanceMode);

router.get('/bot-injection', ...P('app_settings.read'), adminController.getBotInjectionSettings);
router.patch('/bot-injection', ...P('app_settings.write'), adminController.updateBotInjectionSettings);

// Admin: unified app settings (includes disabled records)
router.get('/app-settings', ...P('app_settings.read'), adminController.getAppSettings);
router.get('/app-update', ...P('app_settings.read'), adminController.getAppUpdateConfig);
router.get('/app-update/:platform/versions', ...P('app_settings.read'), adminController.listAppUpdateVersions);
router.post('/app-update/:platform/delete-old', ...P('app_settings.write'), adminController.deleteOldAppUpdateVersions);
router.patch('/app-update/:platform', ...P('app_settings.write'), adminController.updateAppUpdateConfig);
router.post('/app-update/upload-apk', ...P('app_settings.write'), adminController.singleApkUpload, adminController.uploadAppUpdateApk);

// Admin: app settings toggles/updates
router.post('/app-settings/avatars', ...P('app_settings.write'), adminController.createAvatar);
router.patch('/app-settings/avatars/:avatarId/active', ...P('app_settings.write'), adminController.updateAvatarActive);
router.post('/app-settings/add-cash-options', ...P('app_settings.write'), adminController.createAddCashOption);
router.patch('/app-settings/add-cash-options/:optionId/active', ...P('app_settings.write'), adminController.updateAddCashOptionActive);
router.post('/app-settings/withdraw-options', ...P('app_settings.write'), adminController.createWithdrawOption);
router.patch('/app-settings/withdraw-options/:optionId/active', ...P('app_settings.write'), adminController.updateWithdrawOptionActive);
router.post('/app-settings/faqs', ...P('app_settings.write'), adminController.createFaq);
router.patch('/app-settings/faqs/:faqId/active', ...P('app_settings.write'), adminController.updateFaqActive);
router.post('/app-settings/supports', ...P('app_settings.write'), adminController.createSupport);
router.patch('/app-settings/supports/:supportId', ...P('app_settings.write'), adminController.updateSupport);

// Admin: inactive gameplay reminder (BullMQ + FCM multicast)
router.post(
  '/users/inactive-reminder',
  ...P('users.write'),
  adminController.enqueueInactiveGameplayReminder
);
router.get('/push-campaigns/:campaignId', ...P('users.write'), adminController.getPushCampaign);

// Admin: fetch user details by id (user + wallet + kyc)
router.get('/users/:userId', ...P('users.read'), adminController.getUserDetails);

// Admin: activate/deactivate user account
router.patch('/users/:userId/active', ...P('users.write'), adminController.updateUserActiveStatus);

// Admin: update user KYC status and rejection note
router.patch('/users/:userId/kyc-status', ...P('kyc.write'), adminController.updateUserKycStatus);

// Admin: manage global notices
router.get('/notices', ...P('app_settings.read'), noticeController.listAll);
router.post('/notices', ...P('app_settings.write'), noticeController.create);
router.patch('/notices/:noticeId', ...P('app_settings.write'), noticeController.update);
router.delete('/notices/:noticeId', ...P('app_settings.write'), noticeController.remove);

// RBAC: permissions, roles (sub-roles), admins
router.get('/permissions', ...anyP('roles.read', 'roles.write'), adminRbacController.listPermissions);
router.get('/roles', ...anyP('roles.read', 'admins.write'), adminRbacController.listRoles);
router.post('/roles', ...P('roles.write'), adminRbacController.createRole);
router.patch('/roles/:roleId', ...P('roles.write'), adminRbacController.updateRole);
router.get('/admins', ...P('admins.read'), adminRbacController.listAdmins);
router.post('/admins', ...P('admins.write'), adminRbacController.createAdmin);
router.patch('/admins/:adminId', ...P('admins.write'), adminRbacController.updateAdmin);

module.exports = router;
