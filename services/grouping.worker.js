'use strict';

/**
 * Worker-thread entry for CPU-heavy grouping DFS.
 * Main thread stays free for pick/discard ACKs under load.
 */
const { parentPort } = require('worker_threads');
const groupingService = require('./grouping.service');

parentPort.on('message', (msg) => {
  const id = msg?.id;
  const method = String(msg?.method || '');
  try {
    let result = null;
    if (method === 'buildBestGrouping') {
      result = groupingService.buildBestGrouping(
        msg.cards || [],
        msg.wildJoker || null,
        msg.options || {},
      );
    } else if (method === 'evaluateSubmittedGrouping') {
      result = groupingService.evaluateSubmittedGrouping(
        msg.cards || [],
        msg.wildJoker || null,
        msg.submittedGroups || [],
      );
    } else {
      throw new Error(`Unknown grouping worker method: ${method}`);
    }
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({
      id,
      ok: false,
      error: err?.message || String(err),
    });
  }
});
