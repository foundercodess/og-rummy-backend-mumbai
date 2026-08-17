#!/usr/bin/env node
'use strict';

/**
 * One command: generate load phones, send-otp, verify 1111, fund wallet,
 * bootstrap HTTP, play rummy, write phase funnel logs.
 *
 * Example (6P Points):
 *   node scripts/run_load_cycle.js --tables 50 --max-players 6 --game-id 3 --contest-id 199
 *
 * Extra flags are passed through to load_test_gameplay.js.
 */

const { spawn } = require('child_process');
const path = require('path');

const gameplay = path.join(__dirname, 'load_test_gameplay.js');
const forwarded = process.argv.slice(2);

const extras = [];
if (!forwarded.includes('--full-cycle')) extras.push('--full-cycle');
if (!forwarded.includes('--url') && process.env.LOAD_TEST_URL) {
  extras.push('--url', process.env.LOAD_TEST_URL);
}

const child = spawn(process.execPath, [gameplay, ...extras, ...forwarded], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code == null ? 1 : code);
});
