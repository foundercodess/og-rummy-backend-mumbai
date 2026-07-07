const dns = require('dns').promises;
const https = require('https');
const { URL } = require('url');
const GIFTAURA_MERCHANT_ID = process.env.GIFTAURA_MERCHANT_ID || '';
const GIFTAURA_PG_TYPE = process.env.GIFTAURA_PG_TYPE || '2';
const GIFTAURA_REMARK = process.env.GIFTAURA_REMARK || 'Add Cash';
const GIFTAURA_REDIRECT_URL = process.env.GIFTAURA_REDIRECT_URL || '';
const PUBLIC_API_BASE_URL = process.env.PUBLIC_API_BASE_URL || '';

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

function createPgError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function extractGatewayMessage(body = {}) {
  return (
    body.error
    || body.message
    || body.msg
    || body.reason
    || null
  );
}

function isGatewaySuccess(body = {}) {
  const status = String(body?.status ?? '').trim().toUpperCase();
  if (status === 'SUCCESS') return true;
  if (status === '200' || status === '201') return Boolean(body?.payment_link);
  return false;
}

async function resolveHostIpv4(hostname) {
  try {
    const addresses = await dns.resolve4(hostname);
    if (addresses?.[0]) return addresses[0];
  } catch (_) {
    // Docker DNS can intermittently fail; fall back below.
  }

  return new Promise((resolve, reject) => {
    require('dns').lookup(hostname, { family: 4 }, (error, address) => {
      if (error || !address) {
        reject(error || new Error(`Unable to resolve ${hostname}`));
        return;
      }
      resolve(address);
    });
  });
}

/** Node fetch can fail in Docker (IPv6/DNS). Use IPv4 HTTPS directly. */
async function httpsPostJson(urlString, payload, timeoutMs = 20000) {
  const url = new URL(urlString);
  const body = JSON.stringify(payload);
  let host = url.hostname;

  try {
    host = await resolveHostIpv4(url.hostname);
  } catch (error) {
    throw createPgError('PG_UNAVAILABLE', 'Unable to reach payment gateway', { cause: error });
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        servername: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Host: url.hostname,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch (error) {
            reject(createPgError('PG_INVALID_RESPONSE', 'Payment gateway returned an invalid response', {
              cause: error,
              httpStatus: res.statusCode,
            }));
            return;
          }
          resolve({ statusCode: res.statusCode || 0, body: parsed });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(createPgError('PG_UNAVAILABLE', 'Payment gateway request timed out'));
    });

    req.on('error', (error) => {
      reject(createPgError('PG_UNAVAILABLE', 'Unable to reach payment gateway', { cause: error }));
    });

    req.write(body);
    req.end();
  });
}

const GIFTAURA_PG_API_URL = process.env.GIFTAURA_PG_API_URL || 'https://pgapi.giftaura.shop/paynow';

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
    // PG expects a plain redirect URL (no query params).
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
  if (!isGatewaySuccess(body) || !body?.payment_link) {
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
    || query.reference
    || query.gateway_txn
    || ''
  ).toString().trim();

  const paymentRef = (
    query.gateway_txn
    || query.txn_id
    || query.transaction_id
    || query.payment_ref
    || query.utr
    || orderId
    || null
  );

  const status = normalizeCallbackStatus(
    query.status
    || query.payment_status
    || query.txn_status
    || query.result
  );

  return { orderId, paymentRef, status };
}

module.exports = {
  isConfigured,
  getRedirectUrl,
  buildRedirectUrl,
  generatePgOrderId,
  initiatePayment,
  extractCallbackFields,
  normalizeCallbackStatus,
};
