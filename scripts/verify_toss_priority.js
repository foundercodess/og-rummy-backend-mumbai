const assert = require('assert');
const { __testHooks } = require('../realtime/pregameOrchestrator');

function card(suit, rank, value) {
  return {
    card_id: `test_${suit}_${rank}`,
    suit,
    rank,
    value,
    display: `${suit[0].toUpperCase()}${rank}`,
    is_joker: false,
  };
}

function pickTossWinner(entries) {
  const maxValue = Math.max(...entries.map((e) => e.toss_value));
  const topEntries = entries.filter((e) => e.toss_value === maxValue);
  topEntries.sort((a, b) => {
    if (a.toss_suit_rank !== b.toss_suit_rank) {
      return a.toss_suit_rank - b.toss_suit_rank;
    }
    return a.seat_no - b.seat_no;
  });
  return topEntries[0];
}

function run() {
  assert(__testHooks, 'Expected pregameOrchestrator __testHooks');
  const { getTossCardStrength, getTossSuitRank, TOSS_SUIT_ORDER } = __testHooks;

  assert.strictEqual(getTossSuitRank(card('spades', 'K', 10)), 1);
  assert.strictEqual(getTossSuitRank(card('hearts', 'K', 10)), 2);
  assert.strictEqual(getTossSuitRank(card('diamonds', 'K', 10)), 3);
  assert.strictEqual(getTossSuitRank(card('clubs', 'K', 10)), 4);
  assert(TOSS_SUIT_ORDER.indexOf('spades') < TOSS_SUIT_ORDER.indexOf('diamonds'));

  const spadesKing = card('spades', 'K', 10);
  const diamondsKing = card('diamonds', 'K', 10);
  const heartsQueen = card('hearts', 'Q', 10);
  const clubsAce = card('clubs', 'A', 10);

  const kingTie = pickTossWinner([
    {
      user_id: 202,
      seat_no: 2,
      toss_value: getTossCardStrength(diamondsKing),
      toss_suit_rank: getTossSuitRank(diamondsKing),
    },
    {
      user_id: 101,
      seat_no: 1,
      toss_value: getTossCardStrength(spadesKing),
      toss_suit_rank: getTossSuitRank(spadesKing),
    },
  ]);
  assert.strictEqual(kingTie.user_id, 101, 'Spades K must beat Diamonds K on equal rank');

  const rankBeatsSuit = pickTossWinner([
    {
      user_id: 301,
      seat_no: 1,
      toss_value: getTossCardStrength(clubsAce),
      toss_suit_rank: getTossSuitRank(clubsAce),
    },
    {
      user_id: 302,
      seat_no: 2,
      toss_value: getTossCardStrength(heartsQueen),
      toss_suit_rank: getTossSuitRank(heartsQueen),
    },
  ]);
  assert.strictEqual(rankBeatsSuit.user_id, 301, 'Ace must beat Queen regardless of suit');

  const seatTieBreak = pickTossWinner([
    {
      user_id: 401,
      seat_no: 3,
      toss_value: getTossCardStrength(spadesKing),
      toss_suit_rank: getTossSuitRank(spadesKing),
    },
    {
      user_id: 402,
      seat_no: 1,
      toss_value: getTossCardStrength(spadesKing),
      toss_suit_rank: getTossSuitRank(spadesKing),
    },
  ]);
  assert.strictEqual(seatTieBreak.user_id, 402, 'Lower seat_no should win identical rank+suit toss ties');

  console.log('verify_toss_priority: PASS');
}

run();
