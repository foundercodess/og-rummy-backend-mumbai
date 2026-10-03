const assert = require('assert');
const {
  cardValue,
  decideOutcome,
  grossReturn,
  settleUser,
  splitCredit,
  payoutByOutcome,
  worstCasePayout,
} = require('../services/dragontiger/dtRules.service');
const { DragonTigerShoe, buildCards } = require('../services/dragontiger/dtShoe.service');
const { derivePhase } = require('../realtime/dragontiger/phase');

function main() {
  // Rank order: A low, K high; suits ignored.
  assert.strictEqual(cardValue('SA'), 1);
  assert.strictEqual(cardValue('H10'), 10);
  assert.strictEqual(cardValue('DK'), 13);
  assert.strictEqual(decideOutcome('SK', 'HQ'), 'dragon');
  assert.strictEqual(decideOutcome('SA', 'H2'), 'tiger');
  assert.strictEqual(decideOutcome('S7', 'D7'), 'tie');
  assert.throws(() => cardValue('X9'));

  // Gross returns (stake included).
  assert.strictEqual(grossReturn('dragon', 100, 'dragon'), 200);
  assert.strictEqual(grossReturn('tiger', 100, 'dragon'), 0);
  assert.strictEqual(grossReturn('tie', 100, 'tie'), 900);
  assert.strictEqual(grossReturn('dragon', 100, 'tie'), 50);
  assert.strictEqual(grossReturn('tie', 100, 'tiger'), 0);

  // Commission only on positive net, per user per round.
  const win = settleUser({ dragon: 100, tiger: 0, tie: 0 }, 'dragon', 5);
  assert.deepStrictEqual(win, { staked: 100, returned: 200, commission: 5, credited: 195, net: 95 });
  const hedge = settleUser({ dragon: 100, tiger: 100, tie: 0 }, 'dragon', 5);
  assert.strictEqual(hedge.commission, 0);
  assert.strictEqual(hedge.credited, 200);
  const halfBack = settleUser({ dragon: 100, tiger: 0, tie: 0 }, 'tie', 5);
  assert.deepStrictEqual(halfBack, { staked: 100, returned: 50, commission: 0, credited: 50, net: -50 });
  const tieWin = settleUser({ dragon: 0, tiger: 0, tie: 100 }, 'tie', 5);
  assert.deepStrictEqual(tieWin, { staked: 100, returned: 900, commission: 40, credited: 860, net: 760 });
  const loss = settleUser({ dragon: 0, tiger: 100, tie: 0 }, 'dragon', 5);
  assert.strictEqual(loss.credited, 0);

  // Stake returns to its original buckets; only winnings become withdrawable.
  const split = splitCredit({ staked: 100, credited: 195, fromDeposit: 60, fromReleasedBonus: 40, fromWithdrawable: 0 });
  assert.deepStrictEqual(split, { toDeposit: 60, toReleasedBonus: 40, toWithdrawable: 95 });
  const partial = splitCredit({ staked: 100, credited: 50, fromDeposit: 60, fromReleasedBonus: 40, fromWithdrawable: 0 });
  assert.deepStrictEqual(partial, { toDeposit: 30, toReleasedBonus: 20, toWithdrawable: 0 });
  const hedgeSplit = splitCredit({ staked: 200, credited: 200, fromDeposit: 200, fromReleasedBonus: 0, fromWithdrawable: 0 });
  assert.strictEqual(hedgeSplit.toWithdrawable, 0);

  // Exposure for the round payout cap.
  assert.deepStrictEqual(payoutByOutcome({ dragon: 1000, tiger: 500, tie: 100 }), { dragon: 2000, tiger: 1000, tie: 1650 });
  assert.strictEqual(worstCasePayout({ dragon: 1000, tiger: 500, tie: 100 }), 2000);

  // 8-deck shoe: every card exactly 8 times; draws never repeat within a shoe.
  const cards = buildCards(8);
  assert.strictEqual(cards.length, 416);
  const counts = cards.reduce((m, c) => m.set(c, (m.get(c) || 0) + 1), new Map());
  assert.strictEqual(counts.size, 52);
  for (const n of counts.values()) assert.strictEqual(n, 8);
  const shoe = new DragonTigerShoe({ decks: 8, cutRemaining: 60 });
  const seen = new Map();
  for (let i = 0; i < 170; i += 1) {
    const pair = shoe.drawPair();
    for (const card of [pair.dragon, pair.tiger]) seen.set(card, (seen.get(card) || 0) + 1);
  }
  for (const n of seen.values()) assert.ok(n <= 8);

  // Exact house edge for an 8-deck shoe (not simulated).
  const total = 416;
  const pTie = (13 * 32 * 31) / (total * (total - 1));
  const pDragon = (1 - pTie) / 2;
  const edgeDragon = -(pDragon * 1 - pDragon * 1 - pTie * 0.5);
  const edgeTie = -(pTie * 8 - (1 - pTie));
  assert.ok(Math.abs(edgeDragon - 0.0373) < 0.001, `dragon edge ${edgeDragon}`);
  assert.ok(Math.abs(edgeTie - 0.3277) < 0.001, `tie edge ${edgeTie}`);

  // Phase derivation from round rows.
  const now = Date.now();
  assert.strictEqual(derivePhase(null).phase, 'waiting');
  assert.strictEqual(derivePhase({ status: 'betting', betting_ends_at: new Date(now + 5000) }).phase, 'betting');
  assert.strictEqual(
    derivePhase({ status: 'settled', locked_at: new Date(now - 1000), reveal_seconds: 5, result_seconds: 3 }, now).phase,
    'reveal'
  );
  assert.strictEqual(
    derivePhase({ status: 'settled', locked_at: new Date(now - 6000), reveal_seconds: 5, result_seconds: 3 }, now).phase,
    'result'
  );
  assert.strictEqual(
    derivePhase({ status: 'settled', locked_at: new Date(now - 9000), reveal_seconds: 5, result_seconds: 3 }, now).phase,
    'intermission'
  );

  console.log('verify_dragontiger_rules: PASS');
}

try {
  main();
} catch (err) {
  console.error('verify_dragontiger_rules: FAIL');
  console.error(err.stack || err.message);
  process.exit(1);
}
