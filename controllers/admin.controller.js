const multer = require('multer');
const adminService = require('../services/admin.service');
const adminTelemetryService = require('../services/adminTelemetry.service');
const adminLedgerService = require('../services/adminLedger.service');
const staleSessionCleanupScheduler = require('../services/staleSessionCleanup.scheduler');

// APK upload gate: multipart field `upload_pin` must match one of these 4-digit PINs (change on deploy as needed).
const APK_UPLOAD_ALLOWED_PINS = new Set(['8842', '7196', '4429']);

const apkUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 200 * 1024 * 1024,
  },
});

const singleApkUpload = apkUpload.single('file');

async function listKyc(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const { status, search, state, active, date_from: dateFrom, date_to: dateTo } = req.query || {};

    const result = await adminService.listKycApplications({
      page,
      limit,
      status,
      search,
      state,
      active,
      dateFrom,
      dateTo,
    });

    return res.json({
      success: true,
      message: 'KYC list fetched successfully',
      ...result,
    });
  } catch (err) {
    console.error('listKyc error:', err);
    if (err.code === 'INVALID_KYC_STATUS_FILTER') {
      return res.status(400).json({ success: false, message: 'status must be all, pending, submitted, approved, or rejected' });
    }
    if (err.code === 'INVALID_ACTIVE_FLAG') {
      return res.status(400).json({ success: false, message: 'active must be true or false' });
    }
    if (err.code === 'INVALID_DATE_FROM') {
      return res.status(400).json({ success: false, message: 'date_from must be a valid date' });
    }
    if (err.code === 'INVALID_DATE_TO') {
      return res.status(400).json({ success: false, message: 'date_to must be a valid date' });
    }
    return res.status(500).json({ success: false, message: 'Failed to fetch KYC list' });
  }
}

async function getUserDetails(req, res) {
  try {
    const userId = Number(req.params.userId);
    if (!userId || Number.isNaN(userId) || userId <= 0) {
      return res.status(400).json({ success: false, message: 'Valid userId is required' });
    }

    const details = await adminService.getUserDetailsById(userId);

    return res.json({
      success: true,
      message: 'User details fetched successfully',
      ...details,
    });
  } catch (err) {
    console.error('getUserDetails error:', err);
    if (err.code === 'USER_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    return res.status(500).json({ success: false, message: 'Failed to fetch user details' });
  }
}

async function updateUserActiveStatus(req, res) {
  try {
    const userId = Number(req.params.userId);
    const { active } = req.body || {};

    if (!userId || Number.isNaN(userId) || userId <= 0) {
      return res.status(400).json({ success: false, message: 'Valid userId is required' });
    }

    const user = await adminService.updateUserActiveStatus({ userId, active });

    return res.json({
      success: true,
      message: `User ${user.active ? 'activated' : 'deactivated'} successfully`,
      user,
    });
  } catch (err) {
    console.error('updateUserActiveStatus error:', err);
    if (err.code === 'INVALID_ACTIVE_FLAG') {
      return res.status(400).json({ success: false, message: 'active must be true or false' });
    }
    if (err.code === 'USER_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    return res.status(500).json({ success: false, message: 'Failed to update user status' });
  }
}

async function updateUserKycStatus(req, res) {
  try {
    const userId = Number(req.params.userId);
    const { status, rejection_note: rejectionNote } = req.body || {};

    if (!userId || Number.isNaN(userId) || userId <= 0) {
      return res.status(400).json({ success: false, message: 'Valid userId is required' });
    }

    const kyc = await adminService.updateUserKycStatus({
      userId,
      status,
      rejectionNote,
    });

    return res.json({
      success: true,
      message: 'KYC status updated successfully',
      kyc,
    });
  } catch (err) {
    console.error('updateUserKycStatus error:', err);
    if (err.code === 'INVALID_KYC_STATUS') {
      return res.status(400).json({ success: false, message: 'status must be submitted, approved, or rejected' });
    }
    if (err.code === 'KYC_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'KYC not found for this user' });
    }
    return res.status(500).json({ success: false, message: 'Failed to update KYC status' });
  }
}

async function listGamesHistory(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const {
      status,
      game_id: gameId,
      contest_id: contestId,
      user_id: userId,
      date_from: dateFrom,
      date_to: dateTo,
    } = req.query || {};

    const result = await adminService.listGamesHistoryForAdmin({
      page,
      limit,
      status,
      gameId,
      contestId,
      userId,
      dateFrom,
      dateTo,
    });

    return res.json({
      success: true,
      message: 'Games history fetched successfully',
      ...result,
    });
  } catch (err) {
    console.error('listGamesHistory error:', err);
    if (err.code === 'INVALID_GAME_HISTORY_STATUS') {
      return res.status(400).json({
        success: false,
        message: 'status must be all, live, or completed (default when omitted: completed)',
      });
    }
    if (err.code === 'INVALID_GAME_ID_FILTER') {
      return res.status(400).json({ success: false, message: 'game_id must be a valid positive integer' });
    }
    if (err.code === 'INVALID_CONTEST_ID_FILTER') {
      return res.status(400).json({ success: false, message: 'contest_id must be a valid positive integer' });
    }
    if (err.code === 'INVALID_USER_ID_FILTER') {
      return res.status(400).json({ success: false, message: 'user_id must be a valid positive integer' });
    }
    if (err.code === 'INVALID_DATE_FROM') {
      return res.status(400).json({ success: false, message: 'date_from must be a valid date' });
    }
    if (err.code === 'INVALID_DATE_TO') {
      return res.status(400).json({ success: false, message: 'date_to must be a valid date' });
    }
    return res.status(500).json({ success: false, message: 'Failed to fetch games history' });
  }
}

async function getGameHistoryDetails(req, res) {
  try {
    const { sessionId } = req.params;
    const result = await adminService.getGameHistoryDetailsForAdmin(sessionId);
    return res.json({
      success: true,
      message: 'Game history details fetched successfully',
      ...result,
    });
  } catch (err) {
    console.error('getGameHistoryDetails error:', err);
    if (err.code === 'INVALID_SESSION_ID') {
      return res.status(400).json({ success: false, message: 'sessionId must be a valid positive integer' });
    }
    if (err.code === 'SESSION_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Game session not found' });
    }
    return res.status(500).json({ success: false, message: 'Failed to fetch game history details' });
  }
}

async function listGameTelemetry(req, res) {
  try {
    const result = await adminTelemetryService.listTelemetryForAdmin(req.query || {});
    return res.json({
      success: true,
      message: 'Telemetry events loaded',
      ...result,
    });
  } catch (err) {
    console.error('listGameTelemetry error:', err);
    if (err.code === 'INVALID_SESSION_ID') {
      return res.status(400).json({ success: false, message: 'session_id must be a valid positive integer' });
    }
    if (err.code === 'INVALID_USER_ID') {
      return res.status(400).json({ success: false, message: 'user_id must be a valid positive integer' });
    }
    if (err.code === 'INVALID_DATE_FROM' || err.code === 'INVALID_DATE_TO') {
      return res.status(400).json({ success: false, message: 'from/to must be valid dates' });
    }
    return res.status(500).json({ success: false, message: 'Failed to load telemetry events' });
  }
}

async function getGameTelemetrySessionReport(req, res) {
  try {
    const { sessionId } = req.params;
    const result = await adminTelemetryService.getSessionTelemetryForAdmin(sessionId, req.query || {});
    return res.json({
      success: true,
      message: 'Session telemetry report loaded',
      report: result,
    });
  } catch (err) {
    console.error('getGameTelemetrySessionReport error:', err);
    if (err.code === 'INVALID_SESSION_ID') {
      return res.status(400).json({ success: false, message: 'sessionId must be a valid positive integer' });
    }
    if (err.code === 'INVALID_DATE_FROM' || err.code === 'INVALID_DATE_TO') {
      return res.status(400).json({ success: false, message: 'from/to must be valid dates' });
    }
    return res.status(500).json({ success: false, message: 'Failed to load session telemetry report' });
  }
}

async function getGameTelemetryTrace(req, res) {
  try {
    const { traceId } = req.params;
    const result = await adminTelemetryService.getTraceForAdmin(traceId);
    return res.json({
      success: true,
      message: 'Telemetry trace loaded',
      ...result,
    });
  } catch (err) {
    console.error('getGameTelemetryTrace error:', err);
    if (err.code === 'TRACE_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Trace not found' });
    }
    return res.status(500).json({ success: false, message: 'Failed to load telemetry trace' });
  }
}

async function getGameTelemetrySummary(req, res) {
  try {
    const result = await adminTelemetryService.getTelemetrySummaryForAdmin(req.query || {});
    return res.json({
      success: true,
      message: 'Telemetry summary loaded',
      summary: result,
    });
  } catch (err) {
    console.error('getGameTelemetrySummary error:', err);
    if (err.code === 'INVALID_DATE_FROM' || err.code === 'INVALID_DATE_TO') {
      return res.status(400).json({ success: false, message: 'from/to must be valid dates' });
    }
    return res.status(500).json({ success: false, message: 'Failed to load telemetry summary' });
  }
}

async function listWalletTransactions(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const {
      filter,
      direction,
      transaction_type: transactionType,
      source,
      reference_type: referenceType,
      reference_id: referenceId,
      user_id: userId,
      phone,
      order_id: orderId,
      date_from: dateFrom,
      date_to: dateTo,
      min_amount: minAmount,
      max_amount: maxAmount,
    } = req.query || {};

    const result = await adminService.listWalletTransactionsForAdmin({
      page,
      limit,
      filter,
      direction,
      transactionType,
      source,
      referenceType,
      referenceId,
      userId,
      phone,
      orderId,
      dateFrom,
      dateTo,
      minAmount,
      maxAmount,
    });

    return res.json({
      success: true,
      message: 'Wallet transactions fetched successfully',
      ...result,
    });
  } catch (err) {
    console.error('listWalletTransactions error:', err);
    if (err.code === 'INVALID_WALLET_TX_FILTER') {
      return res.status(400).json({ success: false, message: 'filter must be all, won, lost, money_add, withdraw, release_bonus, game, recharge, or bonus' });
    }
    if (err.code === 'INVALID_WALLET_TX_DIRECTION') {
      return res.status(400).json({ success: false, message: 'direction must be all, credit, or debit' });
    }
    if (err.code === 'INVALID_USER_ID_FILTER') {
      return res.status(400).json({ success: false, message: 'user_id must be a valid positive integer' });
    }
    if (err.code === 'INVALID_REFERENCE_ID_FILTER') {
      return res.status(400).json({ success: false, message: 'reference_id must be a valid positive integer' });
    }
    if (err.code === 'INVALID_DATE_FROM') {
      return res.status(400).json({ success: false, message: 'date_from must be a valid date' });
    }
    if (err.code === 'INVALID_DATE_TO') {
      return res.status(400).json({ success: false, message: 'date_to must be a valid date' });
    }
    if (err.code === 'INVALID_MIN_AMOUNT') {
      return res.status(400).json({ success: false, message: 'min_amount must be a valid number' });
    }
    if (err.code === 'INVALID_MAX_AMOUNT') {
      return res.status(400).json({ success: false, message: 'max_amount must be a valid number' });
    }
    return res.status(500).json({ success: false, message: 'Failed to fetch wallet transactions' });
  }
}

async function listRecharges(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const {
      status,
      type,
      user_id: userId,
      phone,
      order_id: orderId,
      payment_ref: paymentRef,
      date_from: dateFrom,
      date_to: dateTo,
      min_amount: minAmount,
      max_amount: maxAmount,
    } = req.query || {};

    const result = await adminService.listRechargesForAdmin({
      page,
      limit,
      status,
      type,
      userId,
      phone,
      orderId,
      paymentRef,
      dateFrom,
      dateTo,
      minAmount,
      maxAmount,
    });

    return res.json({
      success: true,
      message: 'Recharge transactions fetched successfully',
      ...result,
    });
  } catch (err) {
    console.error('listRecharges error:', err);
    if (err.code === 'INVALID_RECHARGE_STATUS_FILTER') {
      return res.status(400).json({ success: false, message: 'status must be all, init, payment_success, failed, or not_paid' });
    }
    if (err.code === 'INVALID_RECHARGE_TYPE_FILTER') {
      return res.status(400).json({ success: false, message: 'type must be all, conventional, or p2p' });
    }
    if (err.code === 'INVALID_USER_ID_FILTER') {
      return res.status(400).json({ success: false, message: 'user_id must be a valid positive integer' });
    }
    if (err.code === 'INVALID_DATE_FROM') {
      return res.status(400).json({ success: false, message: 'date_from must be a valid date' });
    }
    if (err.code === 'INVALID_DATE_TO') {
      return res.status(400).json({ success: false, message: 'date_to must be a valid date' });
    }
    if (err.code === 'INVALID_MIN_AMOUNT') {
      return res.status(400).json({ success: false, message: 'min_amount must be a valid number' });
    }
    if (err.code === 'INVALID_MAX_AMOUNT') {
      return res.status(400).json({ success: false, message: 'max_amount must be a valid number' });
    }
    return res.status(500).json({ success: false, message: 'Failed to fetch recharge transactions' });
  }
}

async function getRechargeDetails(req, res) {
  try {
    const { rechargeId } = req.params;
    const result = await adminService.getRechargeDetailsForAdmin(rechargeId);
    return res.json({
      success: true,
      message: 'Recharge details fetched successfully',
      ...result,
    });
  } catch (err) {
    console.error('getRechargeDetails error:', err);
    if (err.code === 'INVALID_RECHARGE_ID') {
      return res.status(400).json({ success: false, message: 'rechargeId must be a valid positive integer' });
    }
    if (err.code === 'RECHARGE_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Recharge transaction not found' });
    }
    return res.status(500).json({ success: false, message: 'Failed to fetch recharge details' });
  }
}

async function getMaintenanceMode(req, res) {
  try {
    const result = await adminService.getMaintenanceModeForAdmin();
    return res.json({
      success: true,
      message: 'Maintenance mode fetched successfully',
      ...result,
    });
  } catch (err) {
    console.error('getMaintenanceMode error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch maintenance mode' });
  }
}

async function updateMaintenanceMode(req, res) {
  try {
    const {
      enabled,
      message,
    } = req.body || {};

    const result = await adminService.updateMaintenanceModeForAdmin({
      enabled,
      message,
      updatedBy: req.auth?.userId || null,
    });

    return res.json({
      success: true,
      message: `Maintenance mode ${result.maintenance_mode.enabled ? 'enabled' : 'disabled'} successfully`,
      ...result,
    });
  } catch (err) {
    console.error('updateMaintenanceMode error:', err);
    if (err.code === 'INVALID_MAINTENANCE_ENABLED') {
      return res.status(400).json({ success: false, message: 'enabled must be true or false' });
    }
    if (err.code === 'INVALID_UPDATED_BY_ADMIN_ID') {
      return res.status(400).json({ success: false, message: 'updated_by admin id must be a valid positive integer' });
    }
    return res.status(500).json({ success: false, message: 'Failed to update maintenance mode' });
  }
}

async function getAppSettings(req, res) {
  try {
    const result = await adminService.getAppSettingsForAdmin();
    return res.json({
      success: true,
      message: 'App settings fetched successfully',
      ...result,
    });
  } catch (err) {
    console.error('getAppSettings error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch app settings' });
  }
}

async function getAppUpdateConfig(req, res) {
  try {
    const result = await adminService.getAppUpdateConfigForAdmin();
    return res.json({
      success: true,
      message: 'App update config fetched successfully',
      ...result,
    });
  } catch (err) {
    console.error('getAppUpdateConfig error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch app update config' });
  }
}

async function listAppUpdateVersions(req, res) {
  try {
    const { platform } = req.params;
    const result = await adminService.listAppUpdateVersionsForAdmin({ platform });
    return res.json({
      success: true,
      message: 'App update versions fetched successfully',
      ...result,
    });
  } catch (err) {
    console.error('listAppUpdateVersions error:', err);
    if (err.code === 'INVALID_APP_UPDATE_PLATFORM') return res.status(400).json({ success: false, message: 'platform must be android or ios' });
    return res.status(500).json({ success: false, message: 'Failed to fetch app update versions' });
  }
}

async function updateAppUpdateConfig(req, res) {
  try {
    const { platform } = req.params;
    const {
      latest,
      minimum,
      url,
      release_notes: releaseNotes,
      enabled,
      metadata,
    } = req.body || {};
    const result = await adminService.updateAppUpdateConfigForAdmin({
      platform,
      latest,
      minimum,
      url,
      releaseNotes,
      enabled,
      metadata,
      updatedBy: req.auth?.adminId || null,
    });
    return res.json({
      success: true,
      message: 'App update config updated successfully',
      ...result,
    });
  } catch (err) {
    console.error('updateAppUpdateConfig error:', err);
    if (err.code === 'INVALID_APP_UPDATE_PLATFORM') return res.status(400).json({ success: false, message: 'platform must be android or ios' });
    if (err.code === 'INVALID_APP_UPDATE_LATEST') return res.status(400).json({ success: false, message: 'latest must be valid semver (x.y.z)' });
    if (err.code === 'INVALID_APP_UPDATE_MINIMUM') return res.status(400).json({ success: false, message: 'minimum must be valid semver (x.y.z)' });
    if (err.code === 'INVALID_APP_UPDATE_VERSION_RANGE') return res.status(400).json({ success: false, message: 'minimum version cannot be greater than latest version' });
    if (err.code === 'INVALID_APP_UPDATE_ENABLED') return res.status(400).json({ success: false, message: 'enabled must be true or false' });
    if (err.code === 'INVALID_APP_UPDATE_URL') return res.status(400).json({ success: false, message: 'url is required when enabled is true' });
    if (err.code === 'INVALID_UPDATED_BY_ADMIN_ID') return res.status(400).json({ success: false, message: 'updated_by admin id must be a valid positive integer' });
    return res.status(500).json({ success: false, message: 'Failed to update app update config' });
  }
}

async function uploadAppUpdateApk(req, res) {
  try {
    const uploadPinRaw = req.body?.upload_pin;
    const uploadPin = uploadPinRaw == null ? '' : String(uploadPinRaw).trim();
    if (!/^\d{4}$/.test(uploadPin)) {
      return res.status(400).json({
        success: false,
        message: 'upload_pin is required and must be exactly 4 digits',
      });
    }
    if (!APK_UPLOAD_ALLOWED_PINS.has(uploadPin)) {
      return res.status(403).json({ success: false, message: 'Invalid upload PIN' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'APK file is required (field name: file)' });
    }
    const {
      platform,
      version,
      minimum,
      release_notes: releaseNotes,
      enabled,
    } = req.body || {};

    const result = await adminService.uploadAppUpdateApkForAdmin({
      file: req.file,
      platform,
      version,
      minimum,
      releaseNotes,
      enabled,
      updatedBy: req.auth?.adminId || null,
    });

    return res.json({
      success: true,
      message: 'APK uploaded and app update config saved successfully',
      ...result,
    });
  } catch (err) {
    console.error('uploadAppUpdateApk error:', err);
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, message: 'APK size must be less than or equal to 200 MB' });
    }
    if (err.code === 'APK_FILE_REQUIRED') return res.status(400).json({ success: false, message: 'APK file is required' });
    if (err.code === 'INVALID_APP_UPDATE_PLATFORM') return res.status(400).json({ success: false, message: 'platform must be android or ios' });
    if (err.code === 'INVALID_APP_UPDATE_LATEST') return res.status(400).json({ success: false, message: 'version must be valid semver (x.y.z)' });
    if (err.code === 'INVALID_APP_UPDATE_MINIMUM') return res.status(400).json({ success: false, message: 'minimum must be valid semver (x.y.z)' });
    if (err.code === 'INVALID_APP_UPDATE_VERSION_RANGE') return res.status(400).json({ success: false, message: 'minimum version cannot be greater than version' });
    if (err.code === 'INVALID_APP_UPDATE_ENABLED') return res.status(400).json({ success: false, message: 'enabled must be true or false' });
    if (err.code === 'INVALID_APK_FILE_TYPE') return res.status(400).json({ success: false, message: 'Only .apk file is allowed for android upload' });
    if (err.code === 'IOS_BINARY_UPLOAD_NOT_SUPPORTED') return res.status(400).json({ success: false, message: 'Direct binary upload is currently supported only for android' });
    if (err.code === 'INVALID_UPDATED_BY_ADMIN_ID') return res.status(400).json({ success: false, message: 'updated_by admin id must be a valid positive integer' });
    if (err.message === 'S3_NOT_CONFIGURED') return res.status(500).json({ success: false, message: 'S3 not configured on server' });
    return res.status(500).json({ success: false, message: 'Failed to upload APK' });
  }
}

async function deleteOldAppUpdateVersions(req, res) {
  try {
    const { platform } = req.params;
    const result = await adminService.deleteOldAppUpdateVersionsForAdmin({
      platform,
      deletedBy: req.auth?.adminId || null,
    });
    return res.json({
      success: true,
      message: 'Old app update versions deleted successfully',
      ...result,
    });
  } catch (err) {
    console.error('deleteOldAppUpdateVersions error:', err);
    if (err.code === 'INVALID_APP_UPDATE_PLATFORM') return res.status(400).json({ success: false, message: 'platform must be android or ios' });
    if (err.code === 'INVALID_UPDATED_BY_ADMIN_ID') return res.status(400).json({ success: false, message: 'admin id must be a valid positive integer' });
    if (err.message === 'S3_NOT_CONFIGURED') return res.status(500).json({ success: false, message: 'S3 not configured on server' });
    return res.status(500).json({ success: false, message: 'Failed to delete old app update versions' });
  }
}

async function updateAvatarActive(req, res) {
  try {
    const { avatarId } = req.params;
    const { active } = req.body || {};
    const result = await adminService.updateAvatarActiveForAdmin({ avatarId, active });
    return res.json({ success: true, message: 'Avatar status updated successfully', ...result });
  } catch (err) {
    console.error('updateAvatarActive error:', err);
    if (err.code === 'INVALID_AVATAR_ID') return res.status(400).json({ success: false, message: 'avatarId must be a valid positive integer' });
    if (err.code === 'INVALID_ACTIVE_FLAG') return res.status(400).json({ success: false, message: 'active must be true or false' });
    if (err.code === 'AVATAR_NOT_FOUND') return res.status(404).json({ success: false, message: 'Avatar not found' });
    return res.status(500).json({ success: false, message: 'Failed to update avatar status' });
  }
}

async function updateAddCashOptionActive(req, res) {
  try {
    const { optionId } = req.params;
    const { active } = req.body || {};
    const result = await adminService.updateAddCashOptionActiveForAdmin({ optionId, active });
    return res.json({ success: true, message: 'Add cash option status updated successfully', ...result });
  } catch (err) {
    console.error('updateAddCashOptionActive error:', err);
    if (err.code === 'INVALID_ADD_CASH_OPTION_ID') return res.status(400).json({ success: false, message: 'optionId must be a valid positive integer' });
    if (err.code === 'INVALID_ACTIVE_FLAG') return res.status(400).json({ success: false, message: 'active must be true or false' });
    if (err.code === 'ADD_CASH_OPTION_NOT_FOUND') return res.status(404).json({ success: false, message: 'Add cash option not found' });
    return res.status(500).json({ success: false, message: 'Failed to update add cash option status' });
  }
}

async function updateWithdrawOptionActive(req, res) {
  try {
    const { optionId } = req.params;
    const { active } = req.body || {};
    const result = await adminService.updateWithdrawOptionActiveForAdmin({ optionId, active });
    return res.json({ success: true, message: 'Withdraw option status updated successfully', ...result });
  } catch (err) {
    console.error('updateWithdrawOptionActive error:', err);
    if (err.code === 'INVALID_WITHDRAW_OPTION_ID') return res.status(400).json({ success: false, message: 'optionId must be a valid positive integer' });
    if (err.code === 'INVALID_ACTIVE_FLAG') return res.status(400).json({ success: false, message: 'active must be true or false' });
    if (err.code === 'WITHDRAW_OPTION_NOT_FOUND') return res.status(404).json({ success: false, message: 'Withdraw option not found' });
    return res.status(500).json({ success: false, message: 'Failed to update withdraw option status' });
  }
}

async function updateFaqActive(req, res) {
  try {
    const { faqId } = req.params;
    const { active } = req.body || {};
    const result = await adminService.updateFaqActiveForAdmin({ faqId, active });
    return res.json({ success: true, message: 'FAQ status updated successfully', ...result });
  } catch (err) {
    console.error('updateFaqActive error:', err);
    if (err.code === 'INVALID_FAQ_ID') return res.status(400).json({ success: false, message: 'faqId must be a valid positive integer' });
    if (err.code === 'INVALID_ACTIVE_FLAG') return res.status(400).json({ success: false, message: 'active must be true or false' });
    if (err.code === 'FAQ_NOT_FOUND') return res.status(404).json({ success: false, message: 'FAQ not found' });
    return res.status(500).json({ success: false, message: 'Failed to update FAQ status' });
  }
}

async function updateSupport(req, res) {
  try {
    const { supportId } = req.params;
    const {
      active,
      redirect_url: redirectUrl,
      title,
      image_url: imageUrl,
      sort_order: sortOrder,
    } = req.body || {};

    const result = await adminService.updateSupportForAdmin({
      supportId,
      active,
      redirectUrl,
      title,
      imageUrl,
      sortOrder,
    });
    return res.json({ success: true, message: 'Support link updated successfully', ...result });
  } catch (err) {
    console.error('updateSupport error:', err);
    if (err.code === 'INVALID_SUPPORT_ID') return res.status(400).json({ success: false, message: 'supportId must be a valid positive integer' });
    if (err.code === 'INVALID_ACTIVE_FLAG') return res.status(400).json({ success: false, message: 'active must be true or false' });
    if (err.code === 'INVALID_SORT_ORDER') return res.status(400).json({ success: false, message: 'sort_order must be a valid integer >= 0' });
    if (err.code === 'NO_SUPPORT_UPDATE_FIELDS') return res.status(400).json({ success: false, message: 'Provide at least one updatable field' });
    if (err.code === 'SUPPORT_NOT_FOUND') return res.status(404).json({ success: false, message: 'Support link not found' });
    return res.status(500).json({ success: false, message: 'Failed to update support link' });
  }
}

async function createAvatar(req, res) {
  try {
    const {
      url,
      sort_order: sortOrder,
      active,
    } = req.body || {};
    const result = await adminService.createAvatarForAdmin({ url, sortOrder, active });
    return res.status(201).json({ success: true, message: 'Avatar created successfully', ...result });
  } catch (err) {
    console.error('createAvatar error:', err);
    if (err.code === 'INVALID_AVATAR_URL') return res.status(400).json({ success: false, message: 'url is required' });
    if (err.code === 'INVALID_SORT_ORDER') return res.status(400).json({ success: false, message: 'sort_order must be a valid integer >= 0' });
    if (err.code === 'INVALID_ACTIVE_FLAG') return res.status(400).json({ success: false, message: 'active must be true or false' });
    return res.status(500).json({ success: false, message: 'Failed to create avatar' });
  }
}

async function createAddCashOption(req, res) {
  try {
    const {
      base_amount: baseAmount,
      instant_cash: instantCash,
      bonus,
      is_hot: isHot,
      active,
      sort_order: sortOrder,
    } = req.body || {};
    const result = await adminService.createAddCashOptionForAdmin({
      baseAmount,
      instantCash,
      bonus,
      isHot,
      active,
      sortOrder,
    });
    return res.status(201).json({ success: true, message: 'Add cash option created successfully', ...result });
  } catch (err) {
    console.error('createAddCashOption error:', err);
    if (err.code === 'INVALID_BASE_AMOUNT') return res.status(400).json({ success: false, message: 'base_amount must be a valid positive number' });
    if (err.code === 'INVALID_INSTANT_CASH') return res.status(400).json({ success: false, message: 'instant_cash must be a valid number >= 0' });
    if (err.code === 'INVALID_BONUS') return res.status(400).json({ success: false, message: 'bonus must be a valid number >= 0' });
    if (err.code === 'INVALID_SORT_ORDER') return res.status(400).json({ success: false, message: 'sort_order must be a valid integer >= 0' });
    if (err.code === 'INVALID_ACTIVE_FLAG') return res.status(400).json({ success: false, message: 'active must be true or false' });
    if (err.code === 'INVALID_IS_HOT') return res.status(400).json({ success: false, message: 'is_hot must be true or false' });
    return res.status(500).json({ success: false, message: 'Failed to create add cash option' });
  }
}

async function createWithdrawOption(req, res) {
  try {
    const {
      amount,
      min_kyc_level: minKycLevel,
      is_hot: isHot,
      active,
      sort_order: sortOrder,
    } = req.body || {};
    const result = await adminService.createWithdrawOptionForAdmin({
      amount,
      minKycLevel,
      isHot,
      active,
      sortOrder,
    });
    return res.status(201).json({ success: true, message: 'Withdraw option created successfully', ...result });
  } catch (err) {
    console.error('createWithdrawOption error:', err);
    if (err.code === 'INVALID_WITHDRAW_AMOUNT') return res.status(400).json({ success: false, message: 'amount must be a valid positive number' });
    if (err.code === 'INVALID_MIN_KYC_LEVEL') return res.status(400).json({ success: false, message: 'min_kyc_level must be none, basic, or full' });
    if (err.code === 'INVALID_SORT_ORDER') return res.status(400).json({ success: false, message: 'sort_order must be a valid integer >= 0' });
    if (err.code === 'INVALID_ACTIVE_FLAG') return res.status(400).json({ success: false, message: 'active must be true or false' });
    if (err.code === 'INVALID_IS_HOT') return res.status(400).json({ success: false, message: 'is_hot must be true or false' });
    return res.status(500).json({ success: false, message: 'Failed to create withdraw option' });
  }
}

async function createFaq(req, res) {
  try {
    const {
      question,
      answer,
      active,
      sort_order: sortOrder,
    } = req.body || {};
    const result = await adminService.createFaqForAdmin({ question, answer, active, sortOrder });
    return res.status(201).json({ success: true, message: 'FAQ created successfully', ...result });
  } catch (err) {
    console.error('createFaq error:', err);
    if (err.code === 'INVALID_FAQ_QUESTION') return res.status(400).json({ success: false, message: 'question is required' });
    if (err.code === 'INVALID_FAQ_ANSWER') return res.status(400).json({ success: false, message: 'answer is required' });
    if (err.code === 'INVALID_SORT_ORDER') return res.status(400).json({ success: false, message: 'sort_order must be a valid integer >= 0' });
    if (err.code === 'INVALID_ACTIVE_FLAG') return res.status(400).json({ success: false, message: 'active must be true or false' });
    return res.status(500).json({ success: false, message: 'Failed to create FAQ' });
  }
}

async function createSupport(req, res) {
  try {
    const {
      key,
      title,
      image_url: imageUrl,
      redirect_url: redirectUrl,
      active,
      sort_order: sortOrder,
    } = req.body || {};
    const result = await adminService.createSupportForAdmin({
      key,
      title,
      imageUrl,
      redirectUrl,
      active,
      sortOrder,
    });
    return res.status(201).json({ success: true, message: 'Support link created successfully', ...result });
  } catch (err) {
    console.error('createSupport error:', err);
    if (err.code === 'INVALID_SUPPORT_KEY') return res.status(400).json({ success: false, message: 'key is required' });
    if (err.code === 'INVALID_SUPPORT_TITLE') return res.status(400).json({ success: false, message: 'title is required' });
    if (err.code === 'INVALID_SUPPORT_REDIRECT_URL') return res.status(400).json({ success: false, message: 'redirect_url is required' });
    if (err.code === 'INVALID_SORT_ORDER') return res.status(400).json({ success: false, message: 'sort_order must be a valid integer >= 0' });
    if (err.code === 'INVALID_ACTIVE_FLAG') return res.status(400).json({ success: false, message: 'active must be true or false' });
    if (err.code === 'SUPPORT_KEY_ALREADY_EXISTS') return res.status(409).json({ success: false, message: 'Support key already exists' });
    return res.status(500).json({ success: false, message: 'Failed to create support link' });
  }
}

function parsePagination(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  return { page, limit };
}

async function listWithdrawalFeedback(req, res) {
  try {
    const { page, limit } = parsePagination(req.query);
    const {
      status,
      user_id: userId,
      phone,
      search,
      date_from: dateFrom,
      date_to: dateTo,
    } = req.query || {};

    const result = await adminService.listReportFeedbackForAdmin({
      page,
      limit,
      type: 'withdrawal',
      status,
      userId,
      phone,
      search,
      dateFrom,
      dateTo,
    });

    return res.json({
      success: true,
      message: 'Withdrawal feedback fetched successfully',
      ...result,
    });
  } catch (err) {
    console.error('listWithdrawalFeedback error:', err);
    if (err.code === 'INVALID_SUPPORT_STATUS_FILTER') {
      return res.status(400).json({ success: false, message: 'status must be all, open, in_review, resolved, or rejected' });
    }
    if (err.code === 'INVALID_USER_ID_FILTER') {
      return res.status(400).json({ success: false, message: 'user_id must be a valid positive integer' });
    }
    if (err.code === 'INVALID_DATE_FROM') {
      return res.status(400).json({ success: false, message: 'date_from must be a valid date' });
    }
    if (err.code === 'INVALID_DATE_TO') {
      return res.status(400).json({ success: false, message: 'date_to must be a valid date' });
    }
    return res.status(500).json({ success: false, message: 'Failed to fetch withdrawal feedback' });
  }
}

async function listBugReportFeedback(req, res) {
  try {
    const { page, limit } = parsePagination(req.query);
    const {
      status,
      user_id: userId,
      phone,
      search,
      date_from: dateFrom,
      date_to: dateTo,
    } = req.query || {};

    const result = await adminService.listReportFeedbackForAdmin({
      page,
      limit,
      type: 'bug_report',
      status,
      userId,
      phone,
      search,
      dateFrom,
      dateTo,
    });

    return res.json({
      success: true,
      message: 'Bug reports fetched successfully',
      ...result,
    });
  } catch (err) {
    console.error('listBugReportFeedback error:', err);
    if (err.code === 'INVALID_SUPPORT_STATUS_FILTER') {
      return res.status(400).json({ success: false, message: 'status must be all, open, in_review, resolved, or rejected' });
    }
    if (err.code === 'INVALID_USER_ID_FILTER') {
      return res.status(400).json({ success: false, message: 'user_id must be a valid positive integer' });
    }
    if (err.code === 'INVALID_DATE_FROM') {
      return res.status(400).json({ success: false, message: 'date_from must be a valid date' });
    }
    if (err.code === 'INVALID_DATE_TO') {
      return res.status(400).json({ success: false, message: 'date_to must be a valid date' });
    }
    return res.status(500).json({ success: false, message: 'Failed to fetch bug reports' });
  }
}

async function listAddCashComplaints(req, res) {
  try {
    const { page, limit } = parsePagination(req.query);
    const {
      status,
      user_id: userId,
      phone,
      cash_transaction_id: cashTransactionId,
      utr_no: utrNo,
      date_from: dateFrom,
      date_to: dateTo,
    } = req.query || {};

    const result = await adminService.listAddCashComplaintsForAdmin({
      page,
      limit,
      status,
      userId,
      phone,
      cashTransactionId,
      utrNo,
      dateFrom,
      dateTo,
    });

    return res.json({
      success: true,
      message: 'Add cash complaints fetched successfully',
      ...result,
    });
  } catch (err) {
    console.error('listAddCashComplaints error:', err);
    if (err.code === 'INVALID_SUPPORT_STATUS_FILTER') {
      return res.status(400).json({ success: false, message: 'status must be all, open, in_review, resolved, or rejected' });
    }
    if (err.code === 'INVALID_USER_ID_FILTER') {
      return res.status(400).json({ success: false, message: 'user_id must be a valid positive integer' });
    }
    if (err.code === 'INVALID_DATE_FROM') {
      return res.status(400).json({ success: false, message: 'date_from must be a valid date' });
    }
    if (err.code === 'INVALID_DATE_TO') {
      return res.status(400).json({ success: false, message: 'date_to must be a valid date' });
    }
    return res.status(500).json({ success: false, message: 'Failed to fetch add cash complaints' });
  }
}

async function getWithdrawalFeedbackDetails(req, res) {
  try {
    const { feedbackId } = req.params;
    const result = await adminService.getReportFeedbackDetailsForAdmin({
      feedbackId,
      type: 'withdrawal',
    });
    return res.json({ success: true, message: 'Withdrawal feedback details fetched successfully', ...result });
  } catch (err) {
    console.error('getWithdrawalFeedbackDetails error:', err);
    if (err.code === 'INVALID_REPORT_FEEDBACK_ID') return res.status(400).json({ success: false, message: 'feedbackId must be a valid positive integer' });
    if (err.code === 'REPORT_FEEDBACK_NOT_FOUND') return res.status(404).json({ success: false, message: 'Withdrawal feedback not found' });
    return res.status(500).json({ success: false, message: 'Failed to fetch withdrawal feedback details' });
  }
}

async function updateWithdrawalFeedbackStatus(req, res) {
  try {
    const { feedbackId } = req.params;
    const { status, admin_notes: adminNotes } = req.body || {};
    const result = await adminService.updateReportFeedbackStatusForAdmin({
      feedbackId,
      type: 'withdrawal',
      status,
      adminNotes,
    });
    return res.json({ success: true, message: 'Withdrawal feedback updated successfully', ...result });
  } catch (err) {
    console.error('updateWithdrawalFeedbackStatus error:', err);
    if (err.code === 'INVALID_REPORT_FEEDBACK_ID') return res.status(400).json({ success: false, message: 'feedbackId must be a valid positive integer' });
    if (err.code === 'INVALID_SUPPORT_STATUS_UPDATE') return res.status(400).json({ success: false, message: 'status must be open, in_review, resolved, or rejected' });
    if (err.code === 'REPORT_FEEDBACK_NOT_FOUND') return res.status(404).json({ success: false, message: 'Withdrawal feedback not found' });
    return res.status(500).json({ success: false, message: 'Failed to update withdrawal feedback' });
  }
}

async function getBugReportDetails(req, res) {
  try {
    const { feedbackId } = req.params;
    const result = await adminService.getReportFeedbackDetailsForAdmin({
      feedbackId,
      type: 'bug_report',
    });
    return res.json({ success: true, message: 'Bug report details fetched successfully', ...result });
  } catch (err) {
    console.error('getBugReportDetails error:', err);
    if (err.code === 'INVALID_REPORT_FEEDBACK_ID') return res.status(400).json({ success: false, message: 'feedbackId must be a valid positive integer' });
    if (err.code === 'REPORT_FEEDBACK_NOT_FOUND') return res.status(404).json({ success: false, message: 'Bug report not found' });
    return res.status(500).json({ success: false, message: 'Failed to fetch bug report details' });
  }
}

async function updateBugReportStatus(req, res) {
  try {
    const { feedbackId } = req.params;
    const { status, admin_notes: adminNotes } = req.body || {};
    const result = await adminService.updateReportFeedbackStatusForAdmin({
      feedbackId,
      type: 'bug_report',
      status,
      adminNotes,
    });
    return res.json({ success: true, message: 'Bug report updated successfully', ...result });
  } catch (err) {
    console.error('updateBugReportStatus error:', err);
    if (err.code === 'INVALID_REPORT_FEEDBACK_ID') return res.status(400).json({ success: false, message: 'feedbackId must be a valid positive integer' });
    if (err.code === 'INVALID_SUPPORT_STATUS_UPDATE') return res.status(400).json({ success: false, message: 'status must be open, in_review, resolved, or rejected' });
    if (err.code === 'REPORT_FEEDBACK_NOT_FOUND') return res.status(404).json({ success: false, message: 'Bug report not found' });
    return res.status(500).json({ success: false, message: 'Failed to update bug report' });
  }
}

async function getAddCashComplaintDetails(req, res) {
  try {
    const { complaintId } = req.params;
    const result = await adminService.getAddCashComplaintDetailsForAdmin({ complaintId });
    return res.json({ success: true, message: 'Add cash complaint details fetched successfully', ...result });
  } catch (err) {
    console.error('getAddCashComplaintDetails error:', err);
    if (err.code === 'INVALID_ADD_CASH_COMPLAINT_ID') return res.status(400).json({ success: false, message: 'complaintId must be a valid positive integer' });
    if (err.code === 'ADD_CASH_COMPLAINT_NOT_FOUND') return res.status(404).json({ success: false, message: 'Add cash complaint not found' });
    return res.status(500).json({ success: false, message: 'Failed to fetch add cash complaint details' });
  }
}

async function triggerStaleSessionCleanup(req, res) {
  try {
    const staleAfterHours = req.body?.stale_after_hours ?? req.query?.stale_after_hours;
    const maxBatch = req.body?.max_batch ?? req.query?.max_batch;

    const result = await staleSessionCleanupScheduler.triggerStaleSessionCleanupFromAdmin({
      adminUserId: req.auth?.adminId,
      staleAfterHours: staleAfterHours === undefined || staleAfterHours === '' ? undefined : staleAfterHours,
      maxBatch: maxBatch === undefined || maxBatch === '' ? undefined : maxBatch,
    });

    return res.json({
      success: true,
      message: 'Stale session cleanup completed',
      cancelled_count: result.cancelled_count,
      cancelled_session_ids: result.cancelled_session_ids,
      stale_after_hours: result.stale_after_hours,
      max_batch: result.max_batch,
    });
  } catch (err) {
    console.error('triggerStaleSessionCleanup error:', err);
    if (err.code === 'INVALID_STALE_AFTER_HOURS') {
      return res.status(400).json({ success: false, message: err.message });
    }
    if (err.code === 'INVALID_MAX_BATCH') {
      return res.status(400).json({ success: false, message: err.message });
    }
    if (err.code === 'CLEANUP_LOCK_HELD') {
      return res.status(409).json({ success: false, message: err.message });
    }
    if (err.code === 'DATABASE_NOT_CONFIGURED') {
      return res.status(503).json({ success: false, message: 'Database not configured' });
    }
    return res.status(500).json({ success: false, message: 'Failed to run stale session cleanup' });
  }
}

async function getDashboard(req, res) {
  try {
    const dashboard = await adminLedgerService.getDashboardPayload();
    return res.json({
      success: true,
      message: 'Dashboard data loaded',
      ...dashboard,
    });
  } catch (err) {
    console.error('getDashboard error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load dashboard' });
  }
}

async function listAdminLedger(req, res) {
  try {
    const limit = parseInt(req.query.limit, 10);
    const offset = parseInt(req.query.offset, 10);
    const { event_type: eventType, from: fromRaw, to: toRaw } = req.query || {};

    let fromDate = null;
    let toDate = null;
    if (fromRaw) {
      const d = new Date(fromRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ success: false, message: 'from must be a valid date' });
      }
      fromDate = d.toISOString();
    }
    if (toRaw) {
      const d = new Date(toRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ success: false, message: 'to must be a valid date' });
      }
      toDate = d.toISOString();
    }

    const result = await adminLedgerService.listLedgerEntries({
      limit,
      offset,
      eventType,
      fromDate,
      toDate,
    });

    return res.json({
      success: true,
      message: 'Ledger entries loaded',
      ...result,
    });
  } catch (err) {
    console.error('listAdminLedger error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load ledger' });
  }
}

async function updateAddCashComplaintStatus(req, res) {
  try {
    const { complaintId } = req.params;
    const { status, admin_notes: adminNotes } = req.body || {};
    const result = await adminService.updateAddCashComplaintStatusForAdmin({
      complaintId,
      status,
      adminNotes,
    });
    return res.json({ success: true, message: 'Add cash complaint updated successfully', ...result });
  } catch (err) {
    console.error('updateAddCashComplaintStatus error:', err);
    if (err.code === 'INVALID_ADD_CASH_COMPLAINT_ID') return res.status(400).json({ success: false, message: 'complaintId must be a valid positive integer' });
    if (err.code === 'INVALID_SUPPORT_STATUS_UPDATE') return res.status(400).json({ success: false, message: 'status must be open, in_review, resolved, or rejected' });
    if (err.code === 'ADD_CASH_COMPLAINT_NOT_FOUND') return res.status(404).json({ success: false, message: 'Add cash complaint not found' });
    return res.status(500).json({ success: false, message: 'Failed to update add cash complaint' });
  }
}

module.exports = {
  createAddCashOption,
  createAvatar,
  createFaq,
  createSupport,
  createWithdrawOption,
  getDashboard,
  listAdminLedger,
  getAppUpdateConfig,
  listAppUpdateVersions,
  getAppSettings,
  getMaintenanceMode,
  getGameHistoryDetails,
  listGameTelemetry,
  getGameTelemetrySessionReport,
  getGameTelemetryTrace,
  getGameTelemetrySummary,
  getRechargeDetails,
  getUserDetails,
  updateAddCashOptionActive,
  updateAppUpdateConfig,
  updateAvatarActive,
  updateFaqActive,
  updateMaintenanceMode,
  updateSupport,
  listGamesHistory,
  triggerStaleSessionCleanup,
  listRecharges,
  listWalletTransactions,
  singleApkUpload,
  uploadAppUpdateApk,
  deleteOldAppUpdateVersions,
  listWithdrawalFeedback,
  listBugReportFeedback,
  listAddCashComplaints,
  getWithdrawalFeedbackDetails,
  updateWithdrawalFeedbackStatus,
  getBugReportDetails,
  updateBugReportStatus,
  getAddCashComplaintDetails,
  updateAddCashComplaintStatus,
  listKyc,
  updateWithdrawOptionActive,
  updateUserActiveStatus,
  updateUserKycStatus,
};
