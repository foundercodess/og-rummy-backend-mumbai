const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function loadHarness() {
  const filePath = path.join(__dirname, '..', 'realtime', 'socketServer.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const instrumented = `${source}\nmodule.exports.__test = { settleGameResult };`;

  const module = { exports: {} };
  const walletRowsByUser = new Map();
  const walletRowsById = new Map();
  const txRows = [];
  let released = false;

  function seedWallet(wallet) {
    const normalized = {
      id: Number(wallet.id),
      user_id: Number(wallet.user_id),
      deposit: roundCurrency(wallet.deposit),
      withdrawable: roundCurrency(wallet.withdrawable),
      pending_bonus: roundCurrency(wallet.pending_bonus),
      released_bonus: roundCurrency(wallet.released_bonus),
      total_balance: roundCurrency(wallet.total_balance),
    };
    walletRowsByUser.set(normalized.user_id, normalized);
    walletRowsById.set(normalized.id, normalized);
  }

  seedWallet({
    id: 1001,
    user_id: 11,
    deposit: 100,
    withdrawable: 50,
    pending_bonus: 0,
    released_bonus: 0,
    total_balance: 150,
  });
  seedWallet({
    id: 1002,
    user_id: 22,
    deposit: 210,
    withdrawable: 0,
    pending_bonus: 50,
    released_bonus: 0,
    total_balance: 210,
  });

  const fakeClient = {
    async query(sql, params = []) {
      if (
        /^\s*BEGIN/i.test(sql)
        || /^\s*COMMIT/i.test(sql)
        || /^\s*ROLLBACK/i.test(sql)
        || /SET LOCAL statement_timeout/i.test(sql)
        || /SAVEPOINT/i.test(sql)
        || /ROLLBACK TO SAVEPOINT/i.test(sql)
        || /RELEASE SAVEPOINT/i.test(sql)
      ) {
        return { rows: [] };
      }

      if (/SELECT id,\s*deposit,\s*withdrawable,\s*pending_bonus,\s*released_bonus,\s*total_balance FROM wallets WHERE user_id = \$1 FOR UPDATE/i.test(sql)) {
        const userId = Number(params[0]);
        const row = walletRowsByUser.get(userId);
        return { rows: row ? [{ ...row }] : [] };
      }

      if (/UPDATE wallets\s+SET deposit\s*=\s*deposit \+ \$2,\s*withdrawable\s*=\s*withdrawable \+ \$2,\s*total_balance\s*=\s*total_balance \+ \$2/i.test(sql)) {
        const walletId = Number(params[0]);
        const amount = roundCurrency(params[1]);
        const row = walletRowsById.get(walletId);
        assert(row, `Missing wallet for winner update id=${walletId}`);
        row.deposit = roundCurrency(row.deposit + amount);
        row.withdrawable = roundCurrency(row.withdrawable + amount);
        row.total_balance = roundCurrency(row.total_balance + amount);
        return { rows: [] };
      }

      if (/UPDATE wallets\s+SET deposit\s*=\s*\$2,\s*released_bonus\s*=\s*\$3,\s*withdrawable\s*=\s*\$4,\s*total_balance\s*=\s*\$5/i.test(sql)) {
        const walletId = Number(params[0]);
        const row = walletRowsById.get(walletId);
        assert(row, `Missing wallet for loser debit update id=${walletId}`);
        row.deposit = roundCurrency(params[1]);
        row.released_bonus = roundCurrency(params[2]);
        row.withdrawable = roundCurrency(params[3]);
        row.total_balance = roundCurrency(params[4]);
        return { rows: [] };
      }

      if (/SELECT[\s\S]*FROM wallet_transactions pb[\s\S]*pending_bonus_credit/i.test(sql)) {
        const userId = Number(params[0]);
        const walletId = Number(params[1]);
        const row = walletRowsByUser.get(userId);
        if (!row || Number(row.id) !== walletId || row.pending_bonus <= 0) {
          return { rows: [] };
        }
        return {
          rows: [{
            id: 9001,
            amount: row.pending_bonus,
            expires_at: null,
            released_amount: 0,
          }],
        };
      }

      if (/UPDATE wallets\s+SET pending_bonus\s*=\s*GREATEST\(0,\s*pending_bonus - \$2\),\s*released_bonus\s*=\s*released_bonus \+ \$2,\s*total_balance\s*=\s*total_balance \+ \$2/i.test(sql)) {
        const walletId = Number(params[0]);
        const amount = roundCurrency(params[1]);
        const row = walletRowsById.get(walletId);
        assert(row, `Missing wallet for bonus release update id=${walletId}`);
        row.pending_bonus = roundCurrency(Math.max(0, row.pending_bonus - amount));
        row.released_bonus = roundCurrency(row.released_bonus + amount);
        row.total_balance = roundCurrency(row.total_balance + amount);
        return { rows: [] };
      }

      if (/INSERT INTO wallet_transactions/i.test(sql)) {
        let txType = null;
        if (sql.includes("'game_win_credit'")) txType = 'game_win_credit';
        else if (sql.includes("'game_loss_debit'")) txType = 'game_loss_debit';
        else if (sql.includes("'bonus_release_credit'")) txType = 'bonus_release_credit';
        txRows.push({
          txType,
          params: [...params],
        });
        return { rows: [] };
      }

      if (/SELECT user_id,\s*metadata FROM game_session_players WHERE game_session_id = \$1/i.test(sql)) {
        return { rows: [] };
      }

      if (/INSERT INTO admin_ledger/i.test(sql)) {
        return { rows: [] };
      }

      throw new Error(`Unhandled SQL in harness: ${sql}`);
    },
    release() {
      released = true;
    },
  };

  const noop = () => {};
  const sandbox = {
    module,
    exports: module.exports,
    require(request) {
      switch (request) {
        case 'socket.io':
          return { Server: function Server() {} };
        case '@socket.io/redis-adapter':
          return { createAdapter: noop };
        case '../services/gameplay.service':
          return {};
        case '../models/gameSession.model':
          return {};
        case '../services/grouping.service':
          return {
            buildBestGrouping: () => ({ groups: [], summary: {} }),
            evaluateSubmittedGrouping: () => ({ groups: [], summary: {} }),
          };
        case '../services/redisLock.service':
          return { claimEventIdempotency: async () => true };
        case '../db':
          return {
            pool: {
              async connect() {
                return fakeClient;
              },
            },
          };
        case '../services/redis.service':
          return { getSocketAdapterRedisClients: async () => null };
        case './socketRegistry':
          return { getSocketIds: () => [], addSocket: noop, removeSocket: noop };
        case './socketAuth':
          return { socketAuth: noop };
        case './socketBus':
          return { emitActiveNotices: async () => {}, setSocketIO: noop };
        case './pregameOrchestrator':
          return { startPregame: async () => {}, cancelPregame: async () => {} };
        case './turnSchedulerBridge':
          return { setTurnTimerStarter: noop };
        case '../services/botEngine/rummyBotStrategy':
          return {
            chooseBotPickSource: () => 'closed',
            chooseBotDiscardCard: () => null,
            getCardValue: () => 0,
            isCardIsolated: () => false,
          };
        default:
          return require(request);
      }
    },
    __dirname: path.dirname(filePath),
    __filename: filePath,
    process,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Buffer,
  };

  vm.runInNewContext(instrumented, sandbox, { filename: filePath });

  return {
    settleGameResult: module.exports.__test.settleGameResult,
    getWalletByUserId: (userId) => {
      const row = walletRowsByUser.get(Number(userId));
      return row ? { ...row } : null;
    },
    getTransactions: () => txRows.slice(),
    wasReleased: () => released,
  };
}

async function main() {
  const harness = loadHarness();
  const sessionId = 7407;
  const finalizedResults = [
    { user_id: 11, seat_no: 1, points: 0, is_winner: true },
    { user_id: 22, seat_no: 2, points: 20, is_winner: false },
  ];
  const winnerUserId = 11;
  const pointValue = 1;

  const settlement = await harness.settleGameResult(sessionId, finalizedResults, winnerUserId, pointValue);
  assert(settlement, 'Expected settlement response');

  // Winner assertion: points loss pool is 20, commission 12% => winner gain 17.6
  const winner = harness.getWalletByUserId(11);
  assert(winner, 'Winner wallet missing');
  assert(Number(winner.deposit) === 117.6, `Winner deposit mismatch: ${winner.deposit}`);
  assert(Number(winner.withdrawable) === 67.6, `Winner withdrawable mismatch: ${winner.withdrawable}`);
  assert(Number(winner.total_balance) === 167.6, `Winner total_balance mismatch: ${winner.total_balance}`);

  // Loser assertion: debit 20 from deposit-first, then 10% bonus release (=2)
  const loser = harness.getWalletByUserId(22);
  assert(loser, 'Loser wallet missing');
  assert(Number(loser.deposit) === 190, `Loser deposit mismatch: ${loser.deposit}`);
  assert(Number(loser.withdrawable) === 0, `Loser withdrawable mismatch: ${loser.withdrawable}`);
  assert(Number(loser.pending_bonus) === 48, `Loser pending_bonus mismatch: ${loser.pending_bonus}`);
  assert(Number(loser.released_bonus) === 2, `Loser released_bonus mismatch: ${loser.released_bonus}`);
  assert(Number(loser.total_balance) === 192, `Loser total_balance mismatch: ${loser.total_balance}`);

  const txRows = harness.getTransactions();
  assert(txRows.some((row) => row.txType === 'game_win_credit'), 'Missing game_win_credit transaction');
  assert(txRows.some((row) => row.txType === 'game_loss_debit'), 'Missing game_loss_debit transaction');
  assert(txRows.some((row) => row.txType === 'bonus_release_credit'), 'Missing bonus_release_credit transaction');
  assert(harness.wasReleased(), 'Expected DB client release');

  console.log('verify_wallet_settlement_runtime: PASS');
}

main().catch((err) => {
  console.error('verify_wallet_settlement_runtime: FAIL');
  console.error(err.stack || err.message);
  process.exit(1);
});

