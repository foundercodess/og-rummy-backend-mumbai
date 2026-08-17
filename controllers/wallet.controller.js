const walletService = require('../services/wallet.service');
const giftauraPgService = require('../services/giftauraPg.service');
const userModel = require('../models/user.model');

function renderPaymentCallbackPage({ success, message, orderId }) {
  const title = success ? 'Payment Successful' : 'Payment Failed';
  const color = success ? '#1b8f3a' : '#c0392b';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; background: #0f172a; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #111827; border-radius: 12px; padding: 24px; max-width: 420px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,.35); }
    h1 { color: ${color}; margin: 0 0 12px; font-size: 24px; }
    p { margin: 8px 0; line-height: 1.5; color: #d1d5db; }
    .order { font-size: 12px; color: #9ca3af; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
    <p class="order">Order ID: ${orderId || '-'}</p>
    <p>You can close this window and return to the app.</p>
  </div>
</body>
</html>`;
}

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

    let result;
    try {
      result = await walletService.createAddCashInit({
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
      if (err.code === 'PG_NOT_CONFIGURED') {
        return res.status(503).json({ success: false, message: 'Payment gateway is not configured' });
      }
      if (err.code && ['PG_UNAVAILABLE', 'PG_INVALID_RESPONSE', 'PG_INIT_FAILED'].includes(err.code)) {
        console.error('createAddCash PG error:', err.code, err.message, err.gatewayResponse || '');
        return res.status(502).json({
          success: false,
          message: err.message || 'Failed to initiate payment',
        });
      }
      if (err.code === 'ETIMEOUT' || err.syscall === 'queryA') {
        return res.status(502).json({
          success: false,
          message: 'Unable to reach payment gateway. Please try again.',
        });
      }
      throw err;
    }

    return res.json({
      success: true,
      message: 'Add cash transaction created',
      transaction: result.transaction,
      payment: result.payment,
    });
  } catch (err) {
    console.error('createAddCash error:', err);
    if (err.code === 'ETIMEOUT' || err.syscall === 'queryA') {
      return res.status(502).json({
        success: false,
        message: 'Unable to reach payment gateway. Please try again.',
      });
    }
    return res.status(500).json({ success: false, message: 'Failed to create add cash transaction' });
  }
}

/** GiftAura PG redirect callback (web-based redirection after payment). */
function collectPaymentCallbackPayload(req) {
  const query = req.query && typeof req.query === 'object' ? req.query : {};
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  return { ...query, ...body };
}

async function paymentCallback(req, res) {
  const payload = collectPaymentCallbackPayload(req);
  try {
    const { tx, resolvedStatus, redirectOnly } = await walletService.handlePaymentCallback(payload);
    if (redirectOnly) {
      return res.status(200).send(renderPaymentCallbackPage({
        success: true,
        message: 'Payment received. You can return to the app.',
        orderId: '',
      }));
    }
    if (!tx) {
      return res.status(404).send(renderPaymentCallbackPage({
        success: false,
        message: 'Transaction not found.',
        orderId: payload.order_id || payload.orderid || '',
      }));
    }

    const success = resolvedStatus === 'payment_success';
    return res.status(success ? 200 : 400).send(renderPaymentCallbackPage({
      success,
      message: success
        ? 'Your payment was received successfully.'
        : 'Payment could not be completed. Please try again.',
      orderId: tx.order_id,
    }));
  } catch (err) {
    console.error('paymentCallback error:', err.message, 'payload:', JSON.stringify(payload));
    return res.status(400).send(renderPaymentCallbackPage({
      success: false,
      message: err.message || 'Invalid payment callback.',
      orderId: payload.order_id || payload.orderid || '',
    }));
  }
}

/** Poll recharge status for the authenticated user after PG redirect. */
async function getRechargeStatus(req, res) {
  try {
    const userId = req.user.id;
    const orderId = String(req.query?.order_id || req.params?.orderId || '').trim();
    if (!orderId) {
      return res.status(400).json({ success: false, message: 'order_id is required' });
    }

    const tx = await walletService.getRechargeByOrderIdForUser({ userId, orderId });
    if (!tx) {
      return res.status(404).json({ success: false, message: 'Transaction not found', order_id: orderId });
    }

    return res.json({
      success: true,
      message: 'Transaction status retrieved',
      transaction: tx,
      redirect_url: giftauraPgService.getRedirectUrl(),
    });
  } catch (err) {
    console.error('getRechargeStatus error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve transaction status' });
  }
}

/** Verify pay-in with GiftAura status API and credit wallet when PG reports success. */
async function confirmRechargePayment(req, res) {
  try {
    const userId = req.user.id;
    const orderId = String(req.body?.order_id || req.query?.order_id || '').trim();
    if (!orderId) {
      return res.status(400).json({ success: false, message: 'order_id is required' });
    }

    const result = await walletService.confirmRechargePayment({ userId, orderId });
    if (!result.found) {
      return res.status(404).json({ success: false, message: 'Transaction not found', order_id: orderId });
    }

    const tx = result.tx;
    const pgStatus = String(result.pgStatus || '').toLowerCase();

    if (pgStatus === 'success' || tx?.status === 'payment_success') {
      return res.json({
        success: true,
        message: 'Cash added to your account successfully',
        pg_status: result.pgStatus,
        credited: true,
        transaction: tx,
      });
    }

    if (pgStatus === 'failed' || tx?.status === 'failed') {
      return res.json({
        success: false,
        message: 'Payment failed. Please try again.',
        pg_status: result.pgStatus,
        credited: false,
        transaction: tx,
      });
    }

    return res.json({
      success: true,
      message: 'Payment is still processing. It will be credited to your wallet automatically.',
      pg_status: result.pgStatus || 'pending',
      credited: false,
      pending: true,
      transaction: tx,
    });
  } catch (err) {
    console.error('confirmRechargePayment error:', err);
    if (err.code === 'PG_AMOUNT_MISMATCH') {
      return res.status(409).json({
        success: false,
        message: 'Payment amount mismatch. Please contact support.',
        code: err.code,
      });
    }
    if (err.code === 'PG_NOT_CONFIGURED' || err.code === 'PG_UNAVAILABLE') {
      return res.status(503).json({ success: false, message: err.message || 'Payment gateway unavailable' });
    }
    return res.status(500).json({ success: false, message: 'Failed to confirm payment' });
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

    const existing = await walletService.getRechargeByOrderIdForUser({
      userId: req.user.id,
      orderId: orderId.trim(),
    });
    if (!existing) {
      clearTimeout(timeoutId);
      return res.status(404).json({ success: false, message: 'Transaction not found', order_id: orderId });
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

async function fundLoadTestWallet(req, res) {
  try {
    const minAmount = Math.max(1, Number(req.body?.amount || process.env.LOAD_TEST_WALLET_FUND || 10000) || 10000);
    const user = await userModel.findById(req.user.id);
    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }
    const prefix = String(process.env.LOAD_TEST_PHONE_PREFIX || '97000');
    const phone = String(user.phone || '').replace(/\D/g, '');
    if (!phone.startsWith(prefix)) {
      return res.status(403).json({ success: false, message: 'Load-test fund is only allowed for scripted phones' });
    }

    const result = await walletService.ensureLoadTestFunds(req.user.id, minAmount);
    return res.json({
      success: true,
      message: result.funded ? 'Wallet funded for load test' : 'Wallet already at minimum',
      funded: result.funded,
      credited: result.credited || 0,
      wallet: result.wallet,
    });
  } catch (err) {
    console.error('fundLoadTestWallet error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to fund wallet' });
  }
}

module.exports = {
  createAddCash,
  paymentCallback,
  getRechargeStatus,
  confirmRechargePayment,
  updatePaymentStatus,
  listUserTransactions,
  listPendingBonusTransactions,
  listTransactionDetails,
  fundLoadTestWallet,
};

