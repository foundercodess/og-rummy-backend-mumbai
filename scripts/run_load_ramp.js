#!/usr/bin/env node
'use strict';

/**
 * Stepwise gameplay ramp (up, then optional down).
 *
 * For each table count: invent enough phones (or reuse/prepare tokens), run a
 * hold/ramp load via load_test_gameplay.js, score pass/fail, then climb or stop.
 *
 * Examples:
 *   # 6P ladder to 20k (phones + OTP 1111 + fund per step)
 *   node scripts/run_load_ramp.js \
 *     --url http://og-rummy-alb-791534744.ap-south-1.elb.amazonaws.com \
 *     --steps 100,200,500,1000,2000,5000,10000,20000 \
 *     --max-players 6 --game-id 3 --contest-id 199 \
 *     --concurrency 50 --hold-seconds 180 --max-game-seconds 900 \
 *     --ramp-down
 *
 *   # Geometric: 100 → 200 → 400 … → ≤20000
 *   node scripts/run_load_ramp.js \
 *     --from 100 --to 20000 --mult 2 \
 *     --max-players 2 --game-id 3 --contest-id 198 \
 *     --concurrency 50 --hold-seconds 120
 *
 *   # Prep JWTs in DB once (needs DATABASE_URL + JWT_SECRET), then reuse tokens
 *   node scripts/run_load_ramp.js \
 *     --user-mode prepare-db --allow-remote-db \
 *     --steps 100,200,500 --max-players 6 --game-id 3 --contest-id 199
 *
 * Pass gate (defaults): ok_rate ≥ 90%, fail_rate ≤ 5%, soft_timeout_rate ≤ 10%,
 * backpressure_per_table ≤ 1. Override with --min-ok-rate / --max-fail-rate /
 * --max-soft-timeout-rate / --max-backpressure-per-table.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

if (flag('help')) {
  console.log(fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1]);
  process.exit(0);
}

const rootDir = path.join(__dirname, '..');
const gameplayScript = path.join(__dirname, 'load_test_gameplay.js');
const prepareScript = path.join(__dirname, 'load_test_prepare_users.js');

const baseUrl = String(
  arg('url', process.env.LOAD_TEST_URL || 'http://og-rummy-alb-791534744.ap-south-1.elb.amazonaws.com'),
).replace(/\/$/, '');
const maxPlayers = Math.max(2, Math.min(6, Number(arg('max-players', '6')) || 6));
const gameId = Number(arg('game-id', process.env.LOAD_TEST_GAME_ID || '3'));
const contestId = Number(arg('contest-id', process.env.LOAD_TEST_CONTEST_ID || (maxPlayers >= 6 ? '199' : '198')));
const concurrency = Math.max(1, Number(arg('concurrency', '50')) || 50);
const holdSeconds = Math.max(0, Number(arg('hold-seconds', '180')) || 0);
const maxGameSeconds = Math.max(30, Number(arg('max-game-seconds', '900')) || 900);
const cooldownSeconds = Math.max(0, Number(arg('cooldown-seconds', '45')) || 0);
const fundAmount = Math.max(0, Number(arg('fund', process.env.LOAD_TEST_WALLET_FUND || '10000')) || 0);
const phonePrefix = String(arg('phone-prefix', process.env.LOAD_TEST_PHONE_PREFIX || '97000'));
const phoneStartBase = Math.max(1, Number(arg('start', '1')) || 1);
const reportDir = path.resolve(arg('report-dir', path.join(rootDir, 'load_reports')));
const reportPrefix = String(arg('report-prefix', 'ramp') || 'ramp').replace(/[^\w.-]+/g, '_');
const userMode = String(arg('user-mode', 'full-cycle')).toLowerCase(); // full-cycle | phones | prepare-db
const onFail = String(arg('on-fail', 'stop')).toLowerCase(); // stop | down | continue
const doRampDown = flag('ramp-down');
const maxFailRate = Math.max(0, Math.min(1, Number(arg('max-fail-rate', '0.05')) || 0));
const maxSoftTimeoutRate = Math.max(0, Math.min(1, Number(arg('max-soft-timeout-rate', '0.10')) || 0));
const maxBackpressurePerTable = Math.max(0, Number(arg('max-backpressure-per-table', '1')) || 0);
const minOkRate = Math.max(0, Math.min(1, Number(arg('min-ok-rate', '0.90')) || 0));
const dryRun = flag('dry-run');

function parseSteps() {
  const raw = arg('steps', '');
  if (raw) {
    const steps = String(raw)
      .split(/[, ]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 1)
      .map((n) => Math.floor(n));
    return [...new Set(steps)].sort((a, b) => a - b);
  }
  const from = Math.max(1, Math.floor(Number(arg('from', '100')) || 100));
  const to = Math.max(from, Math.floor(Number(arg('to', '20000')) || 20000));
  const mult = Math.max(1.1, Number(arg('mult', '2')) || 2);
  const steps = [];
  let cur = from;
  while (cur < to) {
    steps.push(Math.floor(cur));
    cur = Math.ceil(cur * mult);
  }
  steps.push(to);
  return [...new Set(steps)].sort((a, b) => a - b);
}

const upSteps = parseSteps();
if (!upSteps.length) {
  console.error('Provide --steps 100,200,500 or --from/--to/--mult');
  process.exit(1);
}
if (!Number.isFinite(gameId) || gameId <= 0 || !Number.isFinite(contestId) || contestId <= 0) {
  console.error('Required: --game-id and --contest-id');
  process.exit(1);
}
if (!['full-cycle', 'phones', 'prepare-db'].includes(userMode)) {
  console.error('--user-mode must be full-cycle | phones | prepare-db');
  process.exit(1);
}
if (!['stop', 'down', 'continue'].includes(onFail)) {
  console.error('--on-fail must be stop | down | continue');
  process.exit(1);
}

const seatsPerTable = maxPlayers;
const peakTables = Math.max(...upSteps);
const peakSeats = peakTables * seatsPerTable;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function padPhone(index) {
  const body = String(index).padStart(Math.max(1, 10 - phonePrefix.length), '0');
  return `${phonePrefix}${body}`.slice(0, 10);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Slice [offset, offset+count) lines from a JSONL token/phone pool into a step file. */
function sliceJsonl(srcPath, destPath, offset, count) {
  const lines = fs.readFileSync(srcPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const slice = lines.slice(offset, offset + count);
  if (slice.length < count) {
    throw new Error(
      `Token pool too small: need ${count} rows at offset ${offset}, have ${lines.length} in ${srcPath}`,
    );
  }
  ensureDir(path.dirname(destPath));
  fs.writeFileSync(destPath, `${slice.join('\n')}\n`, 'utf8');
  return destPath;
}

function spawnNode(scriptPath, args, { cwd = rootDir } = {}) {
  return new Promise((resolve) => {
    console.log(`[RAMP] $ node ${path.relative(rootDir, scriptPath)} ${args.join(' ')}`);
    if (dryRun) {
      resolve({ code: 0, signal: null });
      return;
    }
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code, signal) => resolve({ code: code == null ? 1 : code, signal }));
  });
}

function writePhoneRows(filePath, count, startIndex) {
  ensureDir(path.dirname(filePath));
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(JSON.stringify({ phone: padPhone(startIndex + i), user_id: null, token: null }));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

async function prepareDbTokens(outPath, count, startIndex) {
  const args = [
    '--count', String(count),
    '--start', String(startIndex),
    '--fund', String(fundAmount),
    '--phone-prefix', phonePrefix,
    '--out', outPath,
  ];
  if (flag('allow-remote-db')) args.push('--allow-remote-db');
  if (flag('local-docker')) args.push('--local-docker');
  if (arg('database-url')) args.push('--database-url', String(arg('database-url')));
  const { code } = await spawnNode(prepareScript, args);
  if (code !== 0) {
    throw new Error(`load_test_prepare_users exited ${code}`);
  }
  if (!fs.existsSync(outPath)) {
    throw new Error(`Expected token file missing: ${outPath}`);
  }
  return outPath;
}

function findLatestSummary(prefix) {
  if (!fs.existsSync(reportDir)) return null;
  const files = fs.readdirSync(reportDir)
    .filter((f) => f.startsWith(`${prefix}_`) && f.endsWith('_summary.json'))
    .map((f) => ({
      f,
      mtime: fs.statSync(path.join(reportDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return null;
  const full = path.join(reportDir, files[0].f);
  try {
    return { path: full, summary: JSON.parse(fs.readFileSync(full, 'utf8')) };
  } catch (err) {
    console.warn(`[RAMP] failed to parse summary ${full}: ${err.message}`);
    return { path: full, summary: null };
  }
}

function backpressureCount(summary) {
  const roots = Array.isArray(summary?.root_causes) ? summary.root_causes : [];
  const hit = roots.find((r) => r && r.root_cause === 'server_backpressure');
  return Number(hit?.count || 0) || 0;
}

function scoreStep(summary, tables) {
  if (!summary) {
    return {
      pass: false,
      reasons: ['missing_summary'],
      metrics: {},
    };
  }
  const total = Math.max(1, Number(summary.tables) || tables);
  const ok = Number(summary.ok) || 0;
  const failed = Number(summary.failed) || 0;
  const soft = Number(summary.soft_timeout_drop) || 0;
  const bp = backpressureCount(summary);
  const failRate = failed / total;
  const softRate = soft / total;
  const okRate = ok / total;
  const bpPerTable = bp / total;
  const reasons = [];
  if (okRate < minOkRate) reasons.push(`ok_rate ${okRate.toFixed(3)} < ${minOkRate}`);
  if (failRate > maxFailRate) reasons.push(`fail_rate ${failRate.toFixed(3)} > ${maxFailRate}`);
  if (softRate > maxSoftTimeoutRate) {
    reasons.push(`soft_timeout_rate ${softRate.toFixed(3)} > ${maxSoftTimeoutRate}`);
  }
  if (bpPerTable > maxBackpressurePerTable) {
    reasons.push(`backpressure_per_table ${bpPerTable.toFixed(2)} > ${maxBackpressurePerTable}`);
  }
  return {
    pass: reasons.length === 0,
    reasons,
    metrics: {
      tables: total,
      ok,
      failed,
      soft_timeout_drop: soft,
      server_backpressure: bp,
      ok_rate: Number(okRate.toFixed(4)),
      fail_rate: Number(failRate.toFixed(4)),
      soft_timeout_rate: Number(softRate.toFixed(4)),
      backpressure_per_table: Number(bpPerTable.toFixed(4)),
      peak_open_sockets: summary.peak_open_sockets ?? null,
      peak_active_sessions: summary.peak_active_sessions ?? null,
      report_summary: summary.report_summary || null,
    },
  };
}

async function runOneStep({ tables, direction, phoneStart, tokensPath, poolOffset }) {
  const stepPrefix = `${reportPrefix}_${direction}_${tables}t`;
  const seats = tables * seatsPerTable;
  let stepTokensPath = tokensPath;

  if (userMode !== 'full-cycle') {
    if (!tokensPath || !fs.existsSync(tokensPath)) {
      throw new Error(`Missing shared token/phone pool for user-mode=${userMode}`);
    }
    stepTokensPath = path.join(reportDir, `${stepPrefix}_users.jsonl`);
    if (!dryRun) {
      sliceJsonl(tokensPath, stepTokensPath, poolOffset, seats);
    }
  }

  const args = [
    '--url', baseUrl,
    '--tables', String(tables),
    '--target-active-tables', String(tables),
    '--max-players', String(maxPlayers),
    '--game-id', String(gameId),
    '--contest-id', String(contestId),
    '--concurrency', String(concurrency),
    '--hold-seconds', String(holdSeconds),
    '--max-game-seconds', String(maxGameSeconds),
    '--fund', String(fundAmount),
    '--phone-prefix', phonePrefix,
    '--start', String(phoneStart),
    '--report-dir', reportDir,
    '--report-prefix', stepPrefix,
  ];

  if (userMode === 'full-cycle') {
    args.push('--full-cycle');
  } else if (userMode === 'phones') {
    args.push('--live-login', '--fund-wallets', '--tokens', stepTokensPath);
  } else if (userMode === 'prepare-db') {
    args.push('--tokens', stepTokensPath);
  }

  const startedAt = new Date().toISOString();
  const { code, signal } = await spawnNode(gameplayScript, args);
  const endedAt = new Date().toISOString();

  if (dryRun) {
    return {
      direction,
      tables,
      phone_start: phoneStart,
      seats,
      exit_code: 0,
      signal: null,
      started_at: startedAt,
      ended_at: endedAt,
      summary_path: null,
      pass: true,
      reasons: ['dry_run'],
      metrics: { dry_run: true },
    };
  }

  const latest = findLatestSummary(stepPrefix);
  const scored = scoreStep(latest?.summary, tables);

  return {
    direction,
    tables,
    phone_start: phoneStart,
    seats,
    exit_code: code,
    signal,
    started_at: startedAt,
    ended_at: endedAt,
    summary_path: latest?.path || null,
    pass: scored.pass && code === 0,
    reasons: [
      ...(code !== 0 ? [`gameplay_exit_${code}`] : []),
      ...scored.reasons,
    ],
    metrics: scored.metrics,
  };
}

function phoneStartForStep(stepIndex, steps) {
  // Unique phone ranges per step so prior sessions do not collide.
  let offset = 0;
  for (let i = 0; i < stepIndex; i += 1) {
    offset += steps[i] * seatsPerTable;
  }
  return phoneStartBase + offset;
}

(async () => {
  ensureDir(reportDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const masterPath = path.join(reportDir, `${reportPrefix}_master_${stamp}.json`);

  console.log('[RAMP] plan', {
    url: baseUrl,
    userMode,
    maxPlayers,
    seatsPerTable,
    gameId,
    contestId,
    concurrency,
    holdSeconds,
    maxGameSeconds,
    cooldownSeconds,
    upSteps,
    rampDown: doRampDown,
    onFail,
    peakTables,
    peakSeats,
    gates: { minOkRate, maxFailRate, maxSoftTimeoutRate, maxBackpressurePerTable },
    dryRun,
  });

  let sharedTokensPath = null;
  const upPhoneCount = upSteps.reduce((s, t) => s + t * seatsPerTable, 0);
  const reserveDown = doRampDown || onFail === 'down';
  // Extra pool for down steps (mirrors up ladder in reverse, excluding peak).
  const downPhoneCount = reserveDown
    ? upSteps.slice(0, -1).reduce((s, t) => s + t * seatsPerTable, 0)
    : 0;
  const poolPhoneCount = upPhoneCount + downPhoneCount;

  if (userMode === 'phones') {
    sharedTokensPath = path.join(reportDir, `${reportPrefix}_phones_${stamp}.jsonl`);
    writePhoneRows(sharedTokensPath, poolPhoneCount, phoneStartBase);
    console.log('[RAMP] wrote phone pool', {
      path: sharedTokensPath,
      count: poolPhoneCount,
      up: upPhoneCount,
      down_reserve: downPhoneCount,
    });
  } else if (userMode === 'prepare-db') {
    sharedTokensPath = path.join(reportDir, `${reportPrefix}_tokens_${stamp}.jsonl`);
    console.log('[RAMP] preparing DB users', {
      count: poolPhoneCount,
      up: upPhoneCount,
      down_reserve: downPhoneCount,
      out: sharedTokensPath,
    });
    await prepareDbTokens(sharedTokensPath, poolPhoneCount, phoneStartBase);
  }

  const results = [];
  let lastPassTables = null;
  let abortRamp = false;
  let downSteps = [];

  for (let i = 0; i < upSteps.length; i += 1) {
    const tables = upSteps[i];
    const phoneStart = phoneStartForStep(i, upSteps);
    console.log('\n[RAMP] ========== UP step', {
      index: i + 1,
      of: upSteps.length,
      tables,
      seats: tables * seatsPerTable,
      phoneStart,
    });

    const result = await runOneStep({
      tables,
      direction: 'up',
      phoneStart,
      tokensPath: sharedTokensPath,
      poolOffset: phoneStart - phoneStartBase,
    });
    results.push(result);
    console.log('[RAMP] step result', {
      tables: result.tables,
      pass: result.pass,
      reasons: result.reasons,
      metrics: result.metrics,
    });

    if (result.pass) {
      lastPassTables = tables;
    } else if (onFail === 'stop') {
      abortRamp = true;
      console.warn('[RAMP] aborting climb (--on-fail stop)');
      break;
    } else if (onFail === 'down') {
      abortRamp = true;
      const idx = lastPassTables == null
        ? -1
        : upSteps.indexOf(lastPassTables);
      downSteps = idx >= 0 ? upSteps.slice(0, idx + 1).reverse() : [];
      console.warn('[RAMP] climbing stopped; will ramp down through last pass', {
        lastPassTables,
        downSteps,
      });
      break;
    } else {
      console.warn('[RAMP] step failed; continuing (--on-fail continue)');
    }

    if (i < upSteps.length - 1 && cooldownSeconds > 0 && !dryRun) {
      console.log(`[RAMP] cooldown ${cooldownSeconds}s`);
      await sleep(cooldownSeconds * 1000);
    }
  }

  if (!abortRamp && doRampDown) {
    downSteps = [...upSteps].reverse().slice(1);
  }

  if (downSteps.length) {
    let downPhoneCursor = upPhoneCount;
    for (let i = 0; i < downSteps.length; i += 1) {
      const tables = downSteps[i];
      const seats = tables * seatsPerTable;
      const phoneStart = phoneStartBase + downPhoneCursor;
      const poolOffset = downPhoneCursor;
      console.log('\n[RAMP] ========== DOWN step', {
        index: i + 1,
        of: downSteps.length,
        tables,
        seats,
        phoneStart,
      });
      const result = await runOneStep({
        tables,
        direction: 'down',
        phoneStart,
        tokensPath: sharedTokensPath,
        poolOffset,
      });
      results.push(result);
      downPhoneCursor += seats;
      console.log('[RAMP] step result', {
        tables: result.tables,
        pass: result.pass,
        reasons: result.reasons,
        metrics: result.metrics,
      });
      if (i < downSteps.length - 1 && cooldownSeconds > 0 && !dryRun) {
        console.log(`[RAMP] cooldown ${cooldownSeconds}s`);
        await sleep(cooldownSeconds * 1000);
      }
    }
  }

  const passed = results.filter((r) => r.pass).map((r) => r.tables);
  const failed = results.filter((r) => !r.pass).map((r) => ({
    tables: r.tables,
    direction: r.direction,
    reasons: r.reasons,
  }));
  const maxPassed = passed.length ? Math.max(...passed) : 0;

  const master = {
    started_at: results[0]?.started_at || new Date().toISOString(),
    ended_at: new Date().toISOString(),
    url: baseUrl,
    user_mode: userMode,
    max_players: maxPlayers,
    game_id: gameId,
    contest_id: contestId,
    concurrency,
    hold_seconds: holdSeconds,
    max_game_seconds: maxGameSeconds,
    up_steps: upSteps,
    ramp_down: doRampDown || onFail === 'down',
    on_fail: onFail,
    gates: {
      min_ok_rate: minOkRate,
      max_fail_rate: maxFailRate,
      max_soft_timeout_rate: maxSoftTimeoutRate,
      max_backpressure_per_table: maxBackpressurePerTable,
    },
    max_passed_tables: maxPassed,
    last_pass_tables: lastPassTables,
    results,
    failed,
    tokens_path: sharedTokensPath,
  };

  if (!dryRun) {
    fs.writeFileSync(masterPath, `${JSON.stringify(master, null, 2)}\n`, 'utf8');
  }

  console.log('\n[RAMP] master summary', {
    max_passed_tables: maxPassed,
    last_pass_tables: lastPassTables,
    failed,
    master: dryRun ? '(dry-run)' : masterPath,
  });

  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('[RAMP] fatal', err);
  process.exit(1);
});
