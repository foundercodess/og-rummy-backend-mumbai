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
  extractGatewayMessage,
  isGatewaySuccess,
};
