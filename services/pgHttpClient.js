const dns = require('dns').promises;
const https = require('https');
const { URL } = require('url');

function createPgError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
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

function parseHttpsJsonResponse(res, resolve, reject) {
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

function httpsRequestJson(urlString, { method = 'GET', payload = null, timeoutMs = 20000 } = {}) {
  const url = new URL(urlString);
  const body = payload == null ? null : JSON.stringify(payload);

  return resolveHostIpv4(url.hostname)
    .then((host) => new Promise((promiseResolve, promiseReject) => {
      const headers = {
        Accept: 'application/json',
        Host: url.hostname,
      };
      if (body != null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body);
      }

      const req = https.request(
        {
          host,
          servername: url.hostname,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method,
          headers,
          timeout: timeoutMs,
        },
        (res) => parseHttpsJsonResponse(res, promiseResolve, promiseReject)
      );

      req.on('timeout', () => {
        req.destroy();
        promiseReject(createPgError('PG_UNAVAILABLE', 'Payment gateway request timed out'));
      });

      req.on('error', (error) => {
        promiseReject(createPgError('PG_UNAVAILABLE', 'Unable to reach payment gateway', { cause: error }));
      });

      if (body != null) req.write(body);
      req.end();
    }))
    .catch((error) => {
      if (error.code) throw error;
      throw createPgError('PG_UNAVAILABLE', 'Unable to reach payment gateway', { cause: error });
    });
}

async function httpsPostJson(urlString, payload, timeoutMs = 20000) {
  return httpsRequestJson(urlString, { method: 'POST', payload, timeoutMs });
}

async function httpsGetJson(urlString, timeoutMs = 20000) {
  return httpsRequestJson(urlString, { method: 'GET', timeoutMs });
}

function extractGatewayMessage(body = {}) {
  return body.error || body.message || body.msg || body.reason || null;
}

function isGatewaySuccess(body = {}) {
  const status = String(body?.status ?? '').trim().toUpperCase();
  if (status === 'SUCCESS') return true;
  if (status === '200' || status === '201') return true;
  return false;
}

module.exports = {
  createPgError,
  httpsPostJson,
  httpsGetJson,
  extractGatewayMessage,
  isGatewaySuccess,
};
