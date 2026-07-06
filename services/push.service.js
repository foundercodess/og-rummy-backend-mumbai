const fs = require('fs');
const userDeviceTokenModel = require('../models/userDeviceToken.model');

let firebaseAdmin = null;
let messaging = null;
let initAttempted = false;

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

async function sendToTokens(tokens, { title, body, data = {} }) {
  const fcm = ensureInitialized();
  if (!fcm || !tokens.length) {
    return { sent: 0, failed: 0, skipped: true };
  }

  const payloadData = normalizeDataPayload(data);
  let sent = 0;
  let failed = 0;

  for (const token of tokens) {
    try {
      await fcm.send({
        token,
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
      sent += 1;
    } catch (error) {
      failed += 1;
      const code = error?.code || error?.errorInfo?.code || '';
      if (
        code === 'messaging/registration-token-not-registered'
        || code === 'messaging/invalid-registration-token'
      ) {
        await userDeviceTokenModel.deactivateTokenByValue(token);
      }
      console.error('[push] FCM send failed:', code || error.message);
    }
  }

  return { sent, failed, skipped: false };
}

async function sendToUser(userId, { title, body, data = {} }) {
  const rows = await userDeviceTokenModel.listActiveByUserId(userId);
  const tokens = rows.map((row) => row.fcm_token).filter(Boolean);
  return sendToTokens(tokens, { title, body, data });
}

module.exports = {
  isConfigured,
  sendToUser,
  sendToTokens,
};
