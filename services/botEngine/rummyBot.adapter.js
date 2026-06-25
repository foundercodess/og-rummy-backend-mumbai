const BaseBotAdapter = require('./baseBot.adapter');

class RummyBotAdapter extends BaseBotAdapter {
  constructor() {
    super({ key: 'rummy' });
  }

  supportsSession(session) {
    const gameName = String(session?.game?.name || session?.game_name || '').toLowerCase();
    if (!gameName) return false;

    // Covers current and future rummy variants (points, pool, deals, spin & go, etc.)
    return ['rummy', 'points', 'pool', 'deal', 'spin', 'practice'].some((token) => gameName.includes(token));
  }
}

module.exports = RummyBotAdapter;
