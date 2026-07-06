const {
  createPgError,
  httpsPostJson,
  extractGatewayMessage,
  isGatewaySuccess,
} = require('./pgHttpClient');

const GIFTAURA_PAYOUT_API_URL = process.env.GIFTAURA_PAYOUT_API_URL
  || 'https://pgapi.giftaura.shop/single_transaction';
const GIFTAURA_MERCHANT_ID = process.env.GIFTAURA_MERCHANT_ID || '';
const GIFTAURA_MERCHANT_TOKEN = process.env.GIFTAURA_MERCHANT_TOKEN
  || process.env.GIFTAURA_MERCHANT_SECRET
  || '';
const GIFTAURA_PAYOUT_REMARK = process.env.GIFTAURA_PAYOUT_REMARK || 'Withdrawal';

function normalizeAccountHolderName(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
  return normalized || 'User';
}

function normalizeContact(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits || '0000000000';
}

function normalizeEmail(value, contact) {
  const email = String(value || '').trim();
  if (email && email.includes('@')) return email;
  const phone = normalizeContact(contact);
  return `${phone}@ogrummy.com`;
}

function isConfigured() {
  return Boolean(GIFTAURA_MERCHANT_ID && GIFTAURA_MERCHANT_TOKEN);
}

function generatePayoutOrderId() {
  const timePart = Date.now().toString().slice(-13);
  const randPart = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
  return `${timePart}${randPart}`.padStart(18, '0').slice(-18);
}

function generateWithdrawNo(orderId) {
  return `NO.out${orderId}`;
}

function buildPayoutSaltPayload({
  merchantId = GIFTAURA_MERCHANT_ID,
  merchantToken = GIFTAURA_MERCHANT_TOKEN,
  accountNo,
  ifscCode,
  amount,
  bankName,
  remark = GIFTAURA_PAYOUT_REMARK,
  orderId,
  name,
  contact,
  email,
}) {
  const innerPayload = {
    merchant_id: String(merchantId),
    merchant_token: String(merchantToken),
    account_no: String(accountNo || '').trim(),
    ifsccode: String(ifscCode || '').trim().toUpperCase(),
    amount: String(Math.round(Number(amount) || 0)),
    bankname: String(bankName || '').trim(),
    remark: String(remark || GIFTAURA_PAYOUT_REMARK).trim(),
    orderid: String(orderId),
    name: normalizeAccountHolderName(name),
    contact: normalizeContact(contact),
    email: normalizeEmail(email, contact),
  };

  const salt = Buffer.from(JSON.stringify(innerPayload), 'utf8').toString('base64');
  return { salt, innerPayload };
}

function isPayoutGatewaySuccess(body = {}) {
  if (isGatewaySuccess(body)) return true;
  const status = String(body?.status ?? body?.Status ?? '').trim().toLowerCase();
  if (['success', 'successful', 'completed', 'paid', 'ok', '200', '201'].includes(status)) {
    return true;
  }
  const message = String(body?.message || body?.msg || '').trim().toLowerCase();
  if (message.includes('success')) return true;
  return false;
}

async function initiatePayout({
  orderId,
  amount,
  accountHolderName,
  bankName,
  accountNumber,
  ifscCode,
  mobile,
  email,
  remark = GIFTAURA_PAYOUT_REMARK,
}) {
  if (!isConfigured()) {
    throw createPgError('PG_NOT_CONFIGURED', 'Payout gateway is not configured');
  }

  const { salt, innerPayload } = buildPayoutSaltPayload({
    accountNo: accountNumber,
    ifscCode,
    amount,
    bankName,
    remark,
    orderId,
    name: accountHolderName,
    contact: mobile,
    email,
  });

  let response;
  try {
    response = await httpsPostJson(GIFTAURA_PAYOUT_API_URL, { salt }, 20000);
  } catch (error) {
    if (error.code) throw error;
    throw createPgError('PG_UNAVAILABLE', 'Unable to reach payout gateway', { cause: error });
  }

  const body = response.body;
  if (!isPayoutGatewaySuccess(body)) {
    throw createPgError(
      'PG_INIT_FAILED',
      extractGatewayMessage(body) || 'Payout gateway rejected the request',
      { httpStatus: response.statusCode, gatewayResponse: body }
    );
  }

  return {
    gateway_txn: body.gateway_txn || body.order_id || body.orderid || orderId,
    gateway_order_id: body.order_id || body.orderid || orderId,
    amount: body.amount || innerPayload.amount,
    raw: body,
  };
}

function normalizeCallbackStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (['success', 'successful', 'completed', 'paid', 'ok'].includes(normalized)) return 'successful';
  if (['failed', 'failure', 'error', 'rejected', 'declined'].includes(normalized)) return 'failed';
  if (['pending', 'processing', 'init'].includes(normalized)) return 'pending';
  return null;
}

function extractCallbackFields(query = {}) {
  const orderId = (
    query.order_id || query.orderid || query.orderId || query.gateway_txn || ''
  ).toString().trim();
  const paymentRef = (
    query.gateway_txn || query.txn_id || query.transaction_id || query.utr || orderId || null
  );
  const status = normalizeCallbackStatus(query.status || query.payout_status || query.txn_status);
  return { orderId, paymentRef, status };
}

module.exports = {
  isConfigured,
  generatePayoutOrderId,
  generateWithdrawNo,
  buildPayoutSaltPayload,
  initiatePayout,
  extractCallbackFields,
  normalizeCallbackStatus,
};
