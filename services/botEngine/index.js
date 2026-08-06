const crypto = require('crypto');
const gameplayService = require('../gameplay.service');
const gameSessionModel = require('../../models/gameSession.model');
const userModel = require('../../models/user.model');
const avatarModel = require('../../models/avatar.model');
const redisLockService = require('../redisLock.service');
const botLeaseService = require('../botLease.service');
const { startProcessLeader } = require('../processLeader.service');
const { startPregame } = require('../../realtime/pregameOrchestrator');
const RummyBotAdapter = require('./rummyBot.adapter');

const DEFAULTS = {
  enabled: false,
  injectAfterSeconds: 30,
  scanEveryMs: 5000,
  scanBatchLimit: 25,
  poolSize: 200,
  autoReady: true,
  namePrefix: 'RummyBot-',
  phonePrefix: '98999',
  lockTtlSeconds: 20,
};

const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function toBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sessionRoom(sessionId) {
  return `game-session:${sessionId}`;
}

function buildConfig() {
  return {
    enabled: toBool(process.env.BOT_ENGINE_ENABLED, DEFAULTS.enabled),
    injectAfterSeconds: Math.max(5, toNumber(process.env.BOT_INJECT_AFTER_SECONDS, DEFAULTS.injectAfterSeconds)),
    scanEveryMs: Math.max(1000, toNumber(process.env.BOT_SCAN_EVERY_MS, DEFAULTS.scanEveryMs)),
    scanBatchLimit: Math.max(1, Math.min(200, toNumber(process.env.BOT_SCAN_BATCH_LIMIT, DEFAULTS.scanBatchLimit))),
    poolSize: Math.max(10, Math.min(10000, toNumber(process.env.BOT_POOL_SIZE, DEFAULTS.poolSize))),
    autoReady: toBool(process.env.BOT_AUTO_READY, DEFAULTS.autoReady),
    namePrefix: String(process.env.BOT_NAME_PREFIX || DEFAULTS.namePrefix),
    phonePrefix: String(process.env.BOT_PHONE_PREFIX || DEFAULTS.phonePrefix).replace(/\D/g, ''),
    lockTtlSeconds: Math.max(5, toNumber(process.env.BOT_SESSION_LOCK_TTL_SECONDS, DEFAULTS.lockTtlSeconds)),
  };
}

function buildBotPhone(index, phonePrefix) {
  const suffix = String(index).padStart(6, '0');
  return `${phonePrefix}${suffix}`.slice(0, 15);
}

function isBotPlayer(player) {
  return player?.metadata?.is_bot === true;
}

function chooseAdapter(session, adapters) {
  return adapters.find((adapter) => adapter.supportsSession(session)) || null;
}

function generateRandomBotName(length = 10) {
  const bytes = crypto.randomBytes(Math.max(6, length));
  return Array.from(bytes.slice(0, length), (b) => ALPHANUMERIC[b % ALPHANUMERIC.length]).join('');
}

function shouldRefreshBotName(existingName, config) {
  const normalizedName = String(existingName || '').trim();
  if (!normalizedName) return true;
  if (normalizedName.startsWith(config.namePrefix)) return true;
  return /^rummybot-/i.test(normalizedName);
}

async function ensureBotUser(index, config) {
  const phone = buildBotPhone(index, config.phonePrefix);
  const existing = await userModel.findByPhone(phone);
  if (existing) {
    if (existing.is_bot !== true) {
      await userModel.markAsBot(existing.id);
    }

    const shouldUpdateName = shouldRefreshBotName(existing.name, config);
    const shouldUpdateAvatar = !existing.avatar || String(existing.avatar).trim() === '';

    if (shouldUpdateName || shouldUpdateAvatar) {
      const nextName = shouldUpdateName ? generateRandomBotName() : existing.name;
      const nextAvatar = shouldUpdateAvatar ? await avatarModel.getRandomAvatarUrl() : existing.avatar;

      await userModel.updateProfile(existing.id, {
        name: nextName,
        avatar: nextAvatar,
      });
      return userModel.findById(existing.id);
    }

    return existing;
  }

  const created = await userModel.create(phone);
  const randomName = generateRandomBotName();
  const randomAvatar = await avatarModel.getRandomAvatarUrl();
  await userModel.verifyOtpAndMarkVerified(phone, randomName, null, randomAvatar);
  await userModel.markAsBot(created.id);
  return userModel.findByPhone(phone);
}

async function maybeInjectBotsInSession(io, session, config, adapters) {
  if (!session || session.status !== 'waiting') return;

  const lockKey = `lock:bot-inject:session:${session.id}`;
  const lockOwner = `bot-engine:${process.pid}`;
  const acquired = await redisLockService.acquireLock(lockKey, lockOwner, config.lockTtlSeconds);
  if (!acquired) return;

  try {
    const fresh = await gameplayService.getSessionState(session.id);
    if (!fresh || fresh.status !== 'waiting') return;

    const adapter = chooseAdapter(fresh, adapters);
    if (!adapter) {
      const gameName = fresh?.game?.name || 'unknown';
      console.log(`[BOT][${fresh.id}] No adapter matched for game=${gameName}`);
      return;
    }

    const players = Array.isArray(fresh.players) ? fresh.players : [];
    const joinedCount = players.length;
    const seatsNeeded = Math.max(0, Number(fresh.max_players) - joinedCount);
    if (seatsNeeded <= 0) return;

    const existingBotIds = new Set(players.filter(isBotPlayer).map((p) => Number(p.user_id)));
    let injectedCount = 0;
    const triedIndices = new Set();

    while (injectedCount < seatsNeeded && triedIndices.size < config.poolSize) {
      const index = botLeaseService.pickRandomUnusedBotIndex(config.poolSize, triedIndices);
      if (index == null) break;
      triedIndices.add(index);

      const botUser = await ensureBotUser(index, config);
      if (!botUser) continue;
      if (existingBotIds.has(Number(botUser.id))) continue;

      const leased = await botLeaseService.acquireBotLease(fresh.id, botUser.id, {
        refreshDisplayName: true,
      });
      if (!leased) continue;

      try {
        const joinedState = await gameplayService.joinSession({
          sessionIdOrCode: fresh.id,
          userId: botUser.id,
          skipBalanceCheck: true, // bots don't hold real wallet funds
        });

        const botPlayer = joinedState.players.find((p) => Number(p.user_id) === Number(botUser.id));
        if (botPlayer) {
          await gameSessionModel.updatePlayerMetadata(fresh.id, botUser.id, {
            ...(botPlayer.metadata || {}),
            host: false,
            ready: config.autoReady,
            is_bot: true,
            bot_engine: adapter.key,
          });
        }

        await gameSessionModel.insertEvent({
          sessionId: fresh.id,
          userId: botUser.id,
          eventType: 'bot_joined',
          payload: {
            bot_user_id: botUser.id,
            bot_engine: adapter.key,
          },
        });

        await adapter.onBotInjected({
          sessionId: fresh.id,
          userId: botUser.id,
        });

        existingBotIds.add(Number(botUser.id));
        injectedCount += 1;
      } catch (joinErr) {
        await botLeaseService.releaseBotLease(fresh.id, botUser.id);
        console.warn(`[BOT][${fresh.id}] Bot join skipped uid=${botUser.id}: ${joinErr.message}`);
      }
    }

    if (injectedCount > 0) {
      console.log(`[BOT][${fresh.id}] Injected ${injectedCount} bot(s)`);
      const updatedSession = await gameplayService.getSessionState(fresh.id);
      io.to(sessionRoom(fresh.id)).emit('session:state', updatedSession);

      if (updatedSession?.status === 'ready') {
        startPregame(io, fresh.id).catch((err) => {
          console.error(`[BOT][${fresh.id}] Failed to start pregame: ${err.message}`);
        });
      }
    }
  } catch (err) {
    console.error(`[BOT][${session.id}] Injection failed: ${err.message}`);
  } finally {
    await redisLockService.releaseLock(lockKey, lockOwner);
  }
}

function startBotEngine(io) {
  const config = buildConfig();
  const adapters = [new RummyBotAdapter()];

  if (!config.enabled) {
    console.log('[BOT] Engine disabled');
    return {
      stop: () => {},
      config,
    };
  }

  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const sessions = await gameSessionModel.listStaleWaitingSessions({
        olderThanSeconds: config.injectAfterSeconds,
        limit: config.scanBatchLimit,
      });

      if (sessions.length > 0) {
        console.log(`[BOT] Tick found ${sessions.length} stale waiting session(s)`);
      }

      for (const session of sessions) {
        // Sequential execution per tick avoids DB spikes and lock contention.
        // eslint-disable-next-line no-await-in-loop
        await maybeInjectBotsInSession(io, session, config, adapters);
      }
    } catch (err) {
      console.error(`[BOT] Tick failed: ${err.message}`);
    } finally {
      running = false;
    }
  };

  let leaderHandle = null;

  const intervalId = setInterval(() => {
    if (leaderHandle && typeof leaderHandle.isLeader === 'function' && !leaderHandle.isLeader()) {
      return;
    }
    tick().catch((err) => {
      console.error(`[BOT] Tick crash: ${err.message}`);
    });
  }, config.scanEveryMs);

  leaderHandle = startProcessLeader('bot-engine-scan', {
    onBecomeLeader: () => {
      console.log('[BOT] Acquired scan leadership');
      tick().catch((err) => {
        console.error(`[BOT] Leader initial tick failed: ${err.message}`);
      });
    },
    onLoseLeadership: () => {
      console.log('[BOT] Lost scan leadership');
    },
  });

  tick().catch((err) => {
    console.error(`[BOT] Initial tick failed: ${err.message}`);
  });

  console.log(
    `[BOT] Engine started enabled=true injectAfter=${config.injectAfterSeconds}s scanEvery=${config.scanEveryMs}ms leader-elected`
  );

  return {
    stop: () => {
      clearInterval(intervalId);
      if (leaderHandle) leaderHandle.stop().catch(() => {});
    },
    config,
  };
}

module.exports = {
  startBotEngine,
};
