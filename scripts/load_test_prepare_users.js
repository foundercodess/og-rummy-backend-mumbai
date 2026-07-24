#!/usr/bin/env node
'use strict';

/**
 * Prepare N load-test users with active login sessions + JWT tokens.
 *
 * Staging / load box ONLY — never point at production OTP or live wallets
 * you care about. Creates phones like 9700000001.. under LOAD_TEST_PHONE_PREFIX.
 *
 * Usage:
 *   node scripts/load_test_prepare_users.js --count 1000 --out /tmp/load_tokens.jsonl
 *
 * Requires DATABASE_URL + JWT_SECRET (from .env).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

// Prefer explicit override / --local-docker so .env RDS is not used by accident.
const localDockerUrl = 'postgresql://postgres:postgres@127.0.0.1:5432/og_rummy';
if (flag('local-docker')) {
  process.env.DATABASE_URL = localDockerUrl;
} else if (arg('database-url')) {
  process.env.DATABASE_URL = String(arg('database-url'));
}

const userModel = require('../models/user.model');
const loginAttemptModel = require('../models/loginAttempt.model');
const walletModel = require('../models/wallet.model');

const count = Math.max(1, Number(arg('count', '100')) || 100);
const outPath = path.resolve(arg('out', path.join(process.cwd(), 'load_tokens.jsonl')));
const phonePrefix = String(arg('phone-prefix', process.env.LOAD_TEST_PHONE_PREFIX || '97000'));
const startIndex = Math.max(0, Number(arg('start', '1')) || 1);
const jwtSecret = process.env.JWT_SECRET;
const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '7d';

function databaseHostLabel(url) {
  try {
    const u = new URL(url.replace(/^postgresql:/, 'http:'));
    return `${u.hostname}:${u.port || '5432'}${u.pathname || ''}`;
  } catch (_) {
    return '(unparseable DATABASE_URL)';
  }
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (or pass --local-docker)');
  process.exit(1);
}
if (!jwtSecret) {
  console.error('JWT_SECRET is required (use the same value as the running API / docker compose)');
  process.exit(1);
}
if (String(jwtSecret) === 'change-me-in-production') {
  console.warn(
    '[LOAD_PREPARE] WARNING: JWT_SECRET is the compose default. ' +
      'If the API container loaded a different secret from .env, sockets will fail with "Invalid or expired token".',
  );
}
console.log(`[LOAD_PREPARE] JWT_SECRET length=${String(jwtSecret).length} (must match API)`);
console.log(`[LOAD_PREPARE] database=${databaseHostLabel(process.env.DATABASE_URL)}`);
if (/rds\.amazonaws\.com/i.test(process.env.DATABASE_URL) && !flag('allow-remote-db')) {
  console.error(
    '[LOAD_PREPARE] Refusing remote RDS URL from .env for local load prep.\n' +
      '  Use:  node scripts/load_test_prepare_users.js --local-docker --count 500 --out load_tokens.jsonl\n' +
      '  Or:   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/og_rummy ...\n' +
      '  (pass --allow-remote-db only if you intentionally target that DB)',
  );
  process.exit(1);
}
if (flag('help')) {
  console.log(`Usage:
  node scripts/load_test_prepare_users.js --local-docker --count 500 --out load_tokens.jsonl
  node scripts/load_test_prepare_users.js --database-url postgres://... --count 500
`);
  process.exit(0);
}

function padPhone(index) {
  // Keep 10-digit Indian-style phones: prefix + zero-padded index
  const body = String(index).padStart(10 - phonePrefix.length, '0');
  return `${phonePrefix}${body}`.slice(0, 10);
}

function makeSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

(async () => {
  const stream = fs.createWriteStream(outPath, { flags: 'w' });
  let ok = 0;
  let failed = 0;

  console.log(`[LOAD_PREPARE] count=${count} prefix=${phonePrefix} out=${outPath}`);

  for (let i = 0; i < count; i += 1) {
    const phone = padPhone(startIndex + i);
    try {
      let user = await userModel.findByPhone(phone);
      if (!user) {
        user = await userModel.create(phone);
      }
      // users.view_id is varchar(6) — keep "L" + 5 digits (e.g. L00001).
      const viewId = `L${String(startIndex + i).padStart(5, '0')}`.slice(0, 6);
      if (!user.name || !String(user.name).trim() || !user.view_id || !String(user.view_id).trim()) {
        await userModel.verifyOtpAndMarkVerified(
          phone,
          `Load${startIndex + i}`,
          viewId,
          null,
        );
        user = await userModel.findByPhone(phone);
      }

      await walletModel.getOrCreateByUserId(user.id);

      const sessionId = makeSessionId();
      await loginAttemptModel.createActiveSession({
        userId: user.id,
        phone,
        deviceInfo: { load_test: true },
        ip: '127.0.0.1',
        userAgent: 'load-test-prepare',
        sessionId,
      });

      const token = jwt.sign(
        { userId: user.id, sessionId, role: 'user' },
        jwtSecret,
        { expiresIn: jwtExpiresIn },
      );

      stream.write(`${JSON.stringify({
        user_id: user.id,
        phone,
        session_id: sessionId,
        token,
      })}\n`);
      ok += 1;
      if (ok % 100 === 0) {
        console.log(`[LOAD_PREPARE] prepared ${ok}/${count}`);
      }
    } catch (err) {
      failed += 1;
      console.error(`[LOAD_PREPARE] phone=${phone} failed: ${err.message}`);
    }
  }

  stream.end();
  console.log(`[LOAD_PREPARE] done ok=${ok} failed=${failed} file=${outPath}`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
