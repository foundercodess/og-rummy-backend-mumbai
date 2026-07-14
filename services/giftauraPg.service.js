const { URL } = require('url');
const {
  createPgError,
  httpsPostJson,
  httpsGetJson,
  extractGatewayMessage,
} = require('./pgHttpClient');

const GIFTAURA_MERCHANT_ID = process.env.GIFTAURA_MERCHANT_ID || '';
const GIFTAURA_PG_TYPE = process.env.GIFTAURA_PG_TYPE || '2';
const GIFTAURA_REMARK = process.env.GIFTAURA_REMARK || 'Add Cash';
const GIFTAURA_REDIRECT_URL = process.env.GIFTAURA_REDIRECT_URL || '';
const PUBLIC_API_BASE_URL = process.env.PUBLIC_API_BASE_URL || '';
const GIFTAURA_PG_API_URL = process.env.GIFTAURA_PG_API_URL || 'https://pgapi.giftaura.shop/paynow';
const GIFTAURA_PAYIN_STATUS_API_URL = process.env.GIFTAURA_PAYIN_STATUS_API_URL
  || 'https://pgapi.giftaura.shop/payinstatus';

function resolveRedirectUrl() {
  if (GIFTAURA_REDIRECT_URL) return GIFTAURA_REDIRECT_URL;
  if (!PUBLIC_API_BASE_URL) return '';
  return `${PUBLIC_API_BASE_URL.replace(/\/$/, '')}/api/wallet/payment-callback`;
}

function isConfigured() {
  return Boolean(GIFTAURA_MERCHANT_ID && resolveRedirectUrl());
}

function getRedirectUrl() {
  return resolveRedirectUrl();
}

function buildRedirectUrl(orderId) {
  const base = resolveRedirectUrl();
  if (!base) return '';
  const url = new URL(base);
  if (orderId) {
    url.searchParams.set('order_id', String(orderId));
  }
  return url.toString();
}

/** 18-digit numeric order id (GiftAura format). */
function generatePgOrderId() {
  const timePart = Date.now().toString().slice(-13);
  const randPart = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
  return `${timePart}${randPart}`.padStart(18, '0').slice(-18);
}

function isPaynowGatewaySuccess(body = {}) {
  const status = String(body?.status ?? '').trim().toUpperCase();
  if (status === 'SUCCESS') return true;
  if (status === '200' || status === '201') return Boolean(body?.payment_link);
  return false;
}

async function initiatePayment({
  orderId,
  amount,
  name,
  email,
  mobile,
  remark = GIFTAURA_REMARK,
}) {
  if (!isConfigured()) {
    throw createPgError('PG_NOT_CONFIGURED', 'Payment gateway is not configured');
  }

  const payload = {
    merchantid: GIFTAURA_MERCHANT_ID,
    orderid: String(orderId),
    amount: String(Math.round(Number(amount) || 0)),
    name: String(name || 'User').trim() || 'User',
    email: String(email || '').trim() || 'user@ogrummy.com',
    mobile: String(mobile || '').trim() || '0000000000',
    remark: String(remark || GIFTAURA_REMARK).trim() || GIFTAURA_REMARK,
    type: String(GIFTAURA_PG_TYPE),
    redirect_url: resolveRedirectUrl(),
  };

  let response;
  try {
    response = await httpsPostJson(GIFTAURA_PG_API_URL, payload, 20000);
  } catch (error) {
    if (error.code) throw error;
    throw createPgError('PG_UNAVAILABLE', 'Unable to reach payment gateway', { cause: error });
  }

  const body = response.body;
  if (!isPaynowGatewaySuccess(body) || !body?.payment_link) {
    const gatewayMessage = extractGatewayMessage(body);
    throw createPgError(
      'PG_INIT_FAILED',
      gatewayMessage || 'Payment gateway rejected the request',
      {
        httpStatus: response.statusCode,
        gatewayResponse: body,
      }
    );
  }

  return {
    payment_link: body.payment_link,
    gateway_txn: body.gateway_txn || body.order_id || orderId,
    gateway_order_id: body.order_id || orderId,
    amount: body.amount || payload.amount,
    raw: body,
  };
}

function normalizePayinStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'success') return 'payment_success';
  if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'declined'].includes(normalized)) {
    return 'failed';
  }
  if (['pending', 'init', 'processing'].includes(normalized)) return 'not_paid';
  return 'not_paid';
}

function parsePayinStatusBody(body = {}, fallbackOrderId = null) {
  const status = String(body?.status ?? '').trim().toLowerCase();
  if (!status) return null;

  const transactionId = String(
    body.transactionid || body.transaction_id || body.order_id || fallbackOrderId || ''
  ).trim();

  return {
    status,
    normalizedStatus: normalizePayinStatus(status),
    transactionId: transactionId || String(fallbackOrderId || '').trim(),
    amount: body.amount != null ? Number(body.amount) : null,
    utr: String(body.utr || '').trim() || null,
    date: body.date || null,
    vpa: body.vpa || null,
    raw: body,
  };
}

/**
 * GiftAura pay-in status: GET /payinstatus?order_id=...
 * status: success | pending | failed
 */
async function fetchPayinStatusByOrderId(orderId) {
  if (!isConfigured()) {
    throw createPgError('PG_NOT_CONFIGURED', 'Payment gateway is not configured');
  }

  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) {
    throw createPgError('INVALID_ORDER_ID', 'order_id is required');
  }

  const url = new URL(GIFTAURA_PAYIN_STATUS_API_URL);
  url.searchParams.set('order_id', normalizedOrderId);

  let response;
  try {
    response = await httpsGetJson(url.toString(), 20000);
  } catch (error) {
    if (error.code) throw error;
    throw createPgError('PG_UNAVAILABLE', 'Unable to reach pay-in status API', { cause: error });
  }

  const parsed = parsePayinStatusBody(response.body, normalizedOrderId);
  if (!parsed) {
    throw createPgError(
      'PG_STATUS_FAILED',
      extractGatewayMessage(response.body) || 'Pay-in status API returned an invalid response',
      { httpStatus: response.statusCode, gatewayResponse: response.body }
    );
  }

  return parsed;
}

function normalizeCallbackStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (['success', 'successful', 'payment_success', 'paid', 'completed', 'ok'].includes(normalized)) {
    return 'payment_success';
  }
  if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'declined'].includes(normalized)) {
    return 'failed';
  }
  if (['not_paid', 'pending', 'init'].includes(normalized)) {
    return 'not_paid';
  }
  return null;
}

function extractCallbackFields(query = {}) {
  const orderId = (
    query.order_id
    || query.orderid
    || query.orderId
    || query.merchant_order_id
    || query.merchantorderid
    || query.client_txn_id
    || query.txnid
    || query.txn_id
    || query.reference
    || query.gateway_order_id
    || query.gateway_txn
    || ''
  ).toString().trim();

  const paymentRef = (
    query.gateway_txn
    || query.txn_id
    || query.txnid
    || query.transaction_id
    || query.payment_ref
    || query.utr
    || query.payoutid
    || orderId
    || null
  );

  const status = normalizeCallbackStatus(
    query.status
    || query.payment_status
    || query.txn_status
    || query.result
    || query.response
  );

  return { orderId, paymentRef, status };
}


module.exports = {
  isConfigured,
  getRedirectUrl,
  buildRedirectUrl,
  generatePgOrderId,
  initiatePayment,
  fetchPayinStatusByOrderId,
  normalizePayinStatus,
  extractCallbackFields,
  normalizeCallbackStatus,
};
