const BaseBotAdapter = require('./baseBot.adapter');
const { isTeenPattiSession } = require('../gameFamily');

class TeenPattiBotAdapter extends BaseBotAdapter {
  constructor() {
    super({ key: 'teenpatti' });
  }

  supportsSession(session) {
    return isTeenPattiSession(session);
  }
}

module.exports = TeenPattiBotAdapter;
