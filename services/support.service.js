const addCashComplaintModel = require('../models/addCashComplaint.model');
const reportsFeedbackModel = require('../models/reportsFeedback.model');
const rechargeTxModel = require('../models/rechargeTransaction.model');

async function createAddCashComplaint({
  userId,
  cashTransactionId,
  paymentProofImageUrl,
  utrNo = null,
  paymentTime = null,
  phone = null,
}) {
  // Strict validation: cashTransactionId must match our recharge_transactions.order_id for this user
  const tx = await rechargeTxModel.findByOrderId(cashTransactionId);
  if (!tx || tx.user_id !== userId) {
    const err = new Error('Invalid cash_transaction_id');
    err.code = 'INVALID_CASH_TRANSACTION_ID';
    throw err;
  }
  const rechargeTransactionId = tx.id;

  const row = await addCashComplaintModel.create({
    userId,
    cashTransactionId,
    rechargeTransactionId,
    paymentProofImageUrl,
    utrNo,
    paymentTime,
    phone,
  });
  return addCashComplaintModel.formatForResponse(row);
}

async function listAddCashComplaints({ userId, limit, offset }) {
  return addCashComplaintModel.listByUserId({ userId, limit, offset });
}

async function createReportFeedback({ userId, type, feedbackContent, pictureUrls = [], phone = null }) {
  const row = await reportsFeedbackModel.create({
    userId,
    type,
    feedbackContent,
    pictureUrls,
    phone,
  });
  return reportsFeedbackModel.formatForResponse(row);
}

async function listReportFeedback({ userId, limit, offset, type = null }) {
  return reportsFeedbackModel.listByUserId({ userId, limit, offset, type });
}

module.exports = {
  createAddCashComplaint,
  listAddCashComplaints,
  createReportFeedback,
  listReportFeedback,
};

