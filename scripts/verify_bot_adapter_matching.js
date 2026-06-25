const RummyBotAdapter = require('../services/botEngine/rummyBot.adapter');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const adapter = new RummyBotAdapter();

  assert(adapter.supportsSession({ game: { name: 'Points' } }) === true, 'Expected Points to be supported');
  assert(adapter.supportsSession({ game: { name: '101 Pool' } }) === true, 'Expected Pool to be supported');
  assert(adapter.supportsSession({ game: { name: 'Deals' } }) === true, 'Expected Deals to be supported');
  assert(adapter.supportsSession({ game: { name: 'Spin & Go' } }) === true, 'Expected Spin & Go to be supported');
  assert(adapter.supportsSession({ game: { name: 'Practice' } }) === true, 'Expected Practice to be supported');
  assert(adapter.supportsSession({ game: { name: '' } }) === false, 'Expected empty game name to be unsupported');
  assert(adapter.supportsSession({}) === false, 'Expected missing game object to be unsupported');

  console.log('verify_bot_adapter_matching: PASS');
}

try {
  main();
} catch (err) {
  console.error('verify_bot_adapter_matching: FAIL');
  console.error(err.stack || err.message);
  process.exit(1);
}
