const supportService = require('../services/support.service');

function asNonEmptyString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function parsePaymentTime(value) {
  if (value == null || value === '') return null;
  const d = new Date(value);
  // eslint-disable-next-line no-restricted-globals
  if (isNaN(d.getTime())) return null;
  return d;
}

async function createAddCashComplaint(req, res) {
  try {
    const userId = req.user.id;
    const {
      cash_transaction_id: cashTransactionIdRaw,
      payment_proof_image_url: paymentProofImageUrlRaw,
      utr_no: utrNoRaw,
      payment_time: paymentTimeRaw,
      phone: phoneRaw,
    } = req.body || {};

    const cashTransactionId = asNonEmptyString(cashTransactionIdRaw);
    const paymentProofImageUrl = asNonEmptyString(paymentProofImageUrlRaw);
    const utrNo = asNonEmptyString(utrNoRaw);
    const phone = asNonEmptyString(phoneRaw);
    const paymentTime = parsePaymentTime(paymentTimeRaw);

    if (!cashTransactionId) {
      return res.status(400).json({ success: false, message: 'cash_transaction_id is required' });
    }
    if (!paymentProofImageUrl) {
      return res.status(400).json({ success: false, message: 'payment_proof_image_url is required' });
    }
    if (paymentTimeRaw != null && paymentTime == null) {
      return res.status(400).json({ success: false, message: 'payment_time must be a valid date/time' });
    }

    const complaint = await supportService.createAddCashComplaint({
      userId,
      cashTransactionId,
      paymentProofImageUrl,
      utrNo,
      paymentTime,
      phone,
    });

    return res.json({
      success: true,
      message: 'Add cash complaint submitted',
      complaint,
    });
  } catch (err) {
    console.error('createAddCashComplaint error:', err);
    if (err && err.code === 'INVALID_CASH_TRANSACTION_ID') {
      return res.status(400).json({ success: false, message: 'cash_transaction_id is invalid' });
    }
    return res.status(500).json({ success: false, message: 'Failed to submit complaint' });
  }
}

async function listAddCashComplaints(req, res) {
  try {
    const userId = req.user.id;
    const { limit, offset } = req.query || {};
    const complaints = await supportService.listAddCashComplaints({
      userId,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return res.json({ success: true, message: 'Complaints retrieved successfully', complaints });
  } catch (err) {
    console.error('listAddCashComplaints error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve complaints' });
  }
}

async function createReportFeedback(req, res) {
  try {
    const userId = req.user.id;
    const {
      type: typeRaw,
      feedback_content: feedbackContentRaw,
      picture_urls: pictureUrlsRaw,
      phone: phoneRaw,
    } = req.body || {};

    const type = asNonEmptyString(typeRaw);
    const feedbackContent = asNonEmptyString(feedbackContentRaw);
    const phone = asNonEmptyString(phoneRaw);

    if (!type || !['withdrawal', 'bug_report'].includes(type)) {
      return res.status(400).json({ success: false, message: 'type must be one of: withdrawal, bug_report' });
    }
    if (!feedbackContent) {
      return res.status(400).json({ success: false, message: 'feedback_content is required' });
    }

    let pictureUrls = [];
    if (pictureUrlsRaw != null) {
      if (!Array.isArray(pictureUrlsRaw)) {
        return res.status(400).json({ success: false, message: 'picture_urls must be an array' });
      }
      pictureUrls = pictureUrlsRaw
        .map(asNonEmptyString)
        .filter(Boolean)
        .slice(0, 3);
      if (pictureUrlsRaw.length > 3) {
        return res.status(400).json({ success: false, message: 'picture_urls can include at most 3 URLs' });
      }
    }

    const feedback = await supportService.createReportFeedback({
      userId,
      type,
      feedbackContent,
      pictureUrls,
      phone,
    });

    return res.json({
      success: true,
      message: 'Feedback submitted',
      feedback,
    });
  } catch (err) {
    console.error('createReportFeedback error:', err);
    return res.status(500).json({ success: false, message: 'Failed to submit feedback' });
  }
}

async function listReportFeedback(req, res) {
  try {
    const userId = req.user.id;
    const { limit, offset, type } = req.query || {};
    if (type && !['withdrawal', 'bug_report'].includes(String(type))) {
      return res.status(400).json({ success: false, message: 'type must be one of: withdrawal, bug_report' });
    }
    const feedback = await supportService.listReportFeedback({
      userId,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      type: type ? String(type) : null,
    });
    return res.json({ success: true, message: 'Feedback retrieved successfully', feedback });
  } catch (err) {
    console.error('listReportFeedback error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve feedback' });
  }
}

module.exports = {
  createAddCashComplaint,
  listAddCashComplaints,
  createReportFeedback,
  listReportFeedback,
};

