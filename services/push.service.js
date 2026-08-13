const fs = require('fs');
const userDeviceTokenModel = require('../models/userDeviceToken.model');

let firebaseAdmin = null;
let messaging = null;
let initAttempted = false;

const MULTICAST_MAX = 500;

function loadServiceAccount() {
  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (base64) {
    try {
      return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    } catch (error) {
      console.error('[push] Failed to parse FIREBASE_SERVICE_ACCOUNT_BASE64:', error.message);
      return null;
    }
  }

  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (filePath && fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      console.error('[push] Failed to read FIREBASE_SERVICE_ACCOUNT_PATH:', error.message);
      return null;
    }
  }

  return null;
}

function ensureInitialized() {
  if (initAttempted) return messaging;
  initAttempted = true;

  const serviceAccount = loadServiceAccount();
  if (!serviceAccount) {
    return null;
  }

  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const { initializeApp, getApps, cert } = require('firebase-admin');
    const { getMessaging } = require('firebase-admin/messaging');
    if (!getApps().length) {
      initializeApp({
        credential: cert(serviceAccount),
      });
    }
    firebaseAdmin = { getApps, getMessaging };
    messaging = getMessaging();
  } catch (error) {
    console.error('[push] Firebase Admin init failed:', error.message);
    messaging = null;
  }

  return messaging;
}

function isConfigured() {
  return Boolean(ensureInitialized());
}

function normalizeDataPayload(data = {}) {
  const normalized = {};
  Object.entries(data || {}).forEach(([key, value]) => {
    if (value == null) return;
    normalized[String(key)] = typeof value === 'string' ? value : JSON.stringify(value);
  });
  return normalized;
}

function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function deactivateInvalidToken(token, code) {
  if (
    code === 'messaging/registration-token-not-registered'
    || code === 'messaging/invalid-registration-token'
  ) {
    await userDeviceTokenModel.deactivateTokenByValue(token);
  }
}

/**
 * Preferred path: FCM multicast (sendEachForMulticast), up to 500 tokens / call.
 */
async function sendMulticast(tokens, { title, body, data = {} }) {
  const fcm = ensureInitialized();
  const uniqueTokens = [...new Set((tokens || []).map((t) => String(t || '').trim()).filter(Boolean))];
  if (!fcm || !uniqueTokens.length) {
    return { sent: 0, failed: 0, skipped: true, batches: 0 };
  }

  const payloadData = normalizeDataPayload(data);
  let sent = 0;
  let failed = 0;
  let batches = 0;

  for (const batch of chunkArray(uniqueTokens, MULTICAST_MAX)) {
    batches += 1;
    try {
      const response = await fcm.sendEachForMulticast({
        tokens: batch,
        notification: {
          title: String(title || 'OG Rummy'),
          body: String(body || ''),
        },
        data: payloadData,
        android: {
          priority: 'high',
          notification: {
            channelId: process.env.FCM_ANDROID_CHANNEL_ID || 'og_rummy_default',
          },
        },
      });

      sent += Number(response.successCount) || 0;
      failed += Number(response.failureCount) || 0;

      const responses = response.responses || [];
      for (let i = 0; i < responses.length; i += 1) {
        const item = responses[i];
        if (item?.success) continue;
        const code = item?.error?.code || '';
        await deactivateInvalidToken(batch[i], code);
      }
    } catch (error) {
      failed += batch.length;
      console.error('[push] FCM multicast batch failed:', error.message);
    }
  }

  return { sent, failed, skipped: false, batches };
}

/** Fallback single-token loop (used only when multicast is unavailable). */
async function sendToTokens(tokens, { title, body, data = {} }) {
  return sendMulticast(tokens, { title, body, data });
}

async function sendToUser(userId, { title, body, data = {} }) {
  const rows = await userDeviceTokenModel.listActiveByUserId(userId);
  const tokens = rows.map((row) => row.fcm_token).filter(Boolean);
  return sendMulticast(tokens, { title, body, data });
}

module.exports = {
  isConfigured,
  sendToUser,
  sendToTokens,
  sendMulticast,
  MULTICAST_MAX,
};
