const walletService = require('../services/wallet.service');

/** Create an Add Cash (recharge) transaction in init state. */
async function createAddCash(req, res) {
  try {
    const userId = req.user.id;
    const {
      amount,
      type,
      add_cash_option_id: addCashOptionId,
      currency,
      name,
      email,
      phone,
      promo_code: promoCode,
    } = req.body || {};

    const numericAmount = Number(amount);
    if (!amount || Number.isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Valid positive amount required' });
    }

    let tx;
    try {
      tx = await walletService.createAddCashInit({
        userId,
        amount: numericAmount,
        type,
        addCashOptionId,
        currency,
        name: name || null,
        email: email || null,
        phone: phone || null,
        promoCode: promoCode || null,
      });
    } catch (err) {
      if (err.code && ['INVALID_PROMO_CODE', 'PROMO_MIN_AMOUNT', 'PROMO_ALREADY_USED', 'PROMO_EXHAUSTED'].includes(err.code)) {
        return res.status(400).json({ success: false, message: err.message });
      }
      throw err;
    }

    return res.json({
      success: true,
      message: 'Add cash transaction created',
      transaction: tx,
    });
  } catch (err) {
    console.error('createAddCash error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create add cash transaction' });
  }
}

/** Update payment status for a recharge/add-cash transaction (by order_id). */
async function updatePaymentStatus(req, res) {
  const PAYMENT_STATUS_TIMEOUT_MS = 15000;

  const timeoutId = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ success: false, message: 'Payment status update timed out' });
    }
  }, PAYMENT_STATUS_TIMEOUT_MS);

  try {
    const { order_id: orderId, status, payment_ref: paymentRef, payment_response: paymentResponse } = req.body || {};

    if (!orderId || typeof orderId !== 'string') {
      clearTimeout(timeoutId);
      return res.status(400).json({ success: false, message: 'order_id is required' });
    }
    if (!status || !['init', 'payment_success', 'failed', 'not_paid'].includes(status)) {
      clearTimeout(timeoutId);
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    let paymentResponseStr = null;
    if (paymentResponse != null) {
      try {
        paymentResponseStr = typeof paymentResponse === 'string' ? paymentResponse : JSON.stringify(paymentResponse);
      } catch (e) {
        paymentResponseStr = String(paymentResponse);
      }
    }

    const tx = await walletService.updatePaymentStatus({
      orderId: orderId.trim(),
      status,
      paymentRef: paymentRef || null,
      paymentResponse: paymentResponseStr,
    });

    clearTimeout(timeoutId);

    if (!tx) {
      return res.status(404).json({ success: false, message: 'Transaction not found', order_id: orderId });
    }

    return res.json({
      success: true,
      message: 'Cash added to your account successfully',
      
      transaction: tx,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('updatePaymentStatus error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: 'Failed to update payment status' });
    }
  }
}

/** List recharge/add-cash transactions for the authenticated user. */
async function listUserTransactions(req, res) {
  try {
    const userId = req.user.id;
    const { limit, offset, date_from: dateFrom, date_to: dateTo } = req.query || {};

    const transactions = await walletService.listUserTransactions({
      userId,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      fromDate: dateFrom,
      toDate: dateTo,
    });

    return res.json({
      success: true,
      message: 'Transactions retrieved successfully',
      transactions,
    });
  } catch (err) {
    console.error('listUserTransactions error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve transactions' });
  }
}

/** List pending bonus transaction history (any source: rewards, promos, etc.) for the authenticated user. */
async function listPendingBonusTransactions(req, res) {
  try {
    const userId = req.user.id;
    const { limit, offset } = req.query || {};

    const { items, summary } = await walletService.listPendingBonusTransactions({
      userId,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });

    return res.json({
      success: true,
      message: 'Pending bonus transactions retrieved successfully',
      transactions: items,
      summary,
    });
  } catch (err) {
    console.error('listPendingBonusTransactions error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve pending bonus transactions' });
  }
}

/** List unified wallet transaction details for the authenticated user. */
async function listTransactionDetails(req, res) {
  try {
    const userId = req.user.id;
    const {
      limit,
      offset,
      date_from: dateFrom,
      date_to: dateTo,
      filter,
    } = req.query || {};

    const transactions = await walletService.listTransactionDetails({
      userId,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      fromDate: dateFrom,
      toDate: dateTo,
      filter,
    });

    return res.json({
      success: true,
      message: 'Transaction details retrieved successfully',
      transactions,
    });
  } catch (err) {
    if (err.code === 'INVALID_ACCOUNT_STATEMENT_FILTER') {
      return res.status(400).json({ success: false, message: err.message });
    }
    console.error('listTransactionDetails error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve transaction details' });
  }
}

module.exports = {
  createAddCash,
  updatePaymentStatus,
  listUserTransactions,
  listPendingBonusTransactions,
  listTransactionDetails,
};

