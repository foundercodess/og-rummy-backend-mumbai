const noticeService = require('../services/notice.service');
const { emitActiveNotices } = require('../realtime/socketBus');

function handleNoticeError(res, err) {
  if (['NOTICE_MESSAGE_REQUIRED', 'INVALID_NOTICE_TYPE', 'INVALID_NOTICE_DATETIME', 'INVALID_NOTICE_WINDOW', 'INVALID_NOTICE_METADATA'].includes(err.code)) {
    return res.status(400).json({ success: false, message: err.message });
  }

  if (err.code === 'NOTICE_NOT_FOUND') {
    return res.status(404).json({ success: false, message: err.message });
  }

  console.error('notice controller error:', err);
  return res.status(500).json({ success: false, message: 'Notice request failed' });
}

async function listAll(req, res) {
  try {
    const notices = await noticeService.listAllNotices();
    return res.json({
      success: true,
      message: 'Notices retrieved successfully',
      notices,
    });
  } catch (err) {
    return handleNoticeError(res, err);
  }
}

async function create(req, res) {
  try {
    const notice = await noticeService.createNotice({
      message: req.body && req.body.message,
      type: req.body && req.body.type,
      isActive: req.body && req.body.is_active,
      sortOrder: req.body && req.body.sort_order,
      startsAt: req.body && req.body.starts_at,
      endsAt: req.body && req.body.ends_at,
      metadata: req.body && req.body.metadata,
      createdByAdminId: req.auth && req.auth.adminId,
    });

    await emitActiveNotices();

    return res.status(201).json({
      success: true,
      message: 'Notice created successfully',
      notice,
    });
  } catch (err) {
    return handleNoticeError(res, err);
  }
}

async function update(req, res) {
  try {
    const noticeId = Number(req.params.noticeId);
    if (!noticeId || Number.isNaN(noticeId) || noticeId <= 0) {
      return res.status(400).json({ success: false, message: 'Valid noticeId is required' });
    }

    const notice = await noticeService.updateNotice(noticeId, req.body || {});
    await emitActiveNotices();

    return res.json({
      success: true,
      message: 'Notice updated successfully',
      notice,
    });
  } catch (err) {
    return handleNoticeError(res, err);
  }
}

async function remove(req, res) {
  try {
    const noticeId = Number(req.params.noticeId);
    if (!noticeId || Number.isNaN(noticeId) || noticeId <= 0) {
      return res.status(400).json({ success: false, message: 'Valid noticeId is required' });
    }

    const result = await noticeService.deleteNotice(noticeId);
    await emitActiveNotices();

    return res.json({
      success: true,
      message: 'Notice deleted successfully',
      result,
    });
  } catch (err) {
    return handleNoticeError(res, err);
  }
}

module.exports = {
  listAll,
  create,
  update,
  remove,
};