class BaseBotAdapter {
  constructor({ key }) {
    this.key = key || 'base';
  }

  supportsSession(_session) {
    return false;
  }

  // Hook for future game-specific behavior (turn play, custom policies, etc.)
  async onBotInjected(_context) {}
}

module.exports = BaseBotAdapter;
