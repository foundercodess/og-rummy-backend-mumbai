const assert = require('assert');
const telemetryService = require('../services/telemetry.service');

function testSummarize() {
  const payload = { session_id: 1, source: 'closed', groups: [{}, {}] };
  const summary = telemetryService.summarizePayload(payload);
  assert.strictEqual(summary.session_id, 1);
  assert.strictEqual(summary.groups_count, 2);
  assert.ok(summary.request_bytes > 0);
}

function testJsonBytes() {
  const bytes = telemetryService.estimateJsonBytes({ session_id: 558, source: 'closed' });
  assert.ok(bytes > 10);
}

function testTraceId() {
  const id = telemetryService.generateTraceId();
  assert.ok(id.length >= 16);
}

function testRtt() {
  const sent = new Date(Date.now() - 50).toISOString();
  const rtt = telemetryService.computeClientRttMs(sent, Date.now());
  assert.ok(rtt >= 40 && rtt <= 200);
}

function testResolveClientRtt() {
  const epochMs = Date.now() - 80;
  const fromIso = telemetryService.resolveClientRttMs(
    { client_sent_at: new Date(epochMs).toISOString() },
    Date.now()
  );
  assert.ok(fromIso >= 50 && fromIso <= 200);

  const fromEpoch = telemetryService.resolveClientRttMs(
    { client_sent_at: epochMs },
    Date.now()
  );
  assert.ok(fromEpoch >= 50 && fromEpoch <= 200);

  const fromExplicit = telemetryService.resolveClientRttMs({ client_rtt_ms: 123 }, Date.now());
  assert.strictEqual(fromExplicit, 123);
}

function testLatencyAnalytics() {
  const emitAt = new Date(Date.now() - 120).toISOString();
  const ackAt = new Date(Date.now() - 20).toISOString();
  const analytics = telemetryService.buildLatencyAnalytics([
    {
      channel: 'socket_ack',
      trace_id: 't1',
      handler_ms: 45,
      client_rtt_ms: null,
    },
    {
      channel: 'socket_emit',
      trace_id: 't2',
      server_received_at: emitAt,
    },
    {
      channel: 'client_ack',
      trace_id: 't2',
      client_ack_at: ackAt,
      delivery_ms: 100,
    },
  ]);
  assert.strictEqual(analytics.server_processing.sample_count, 1);
  assert.strictEqual(analytics.server_processing.avg_ms, 45);
  assert.strictEqual(analytics.client_request_rtt.sample_count, 0);
  assert.strictEqual(analytics.broadcast_delivery.sample_count, 1);
  assert.ok(analytics.broadcast_delivery.avg_ms >= 80);
}

async function testModelImport() {
  const model = require('../models/telemetry.model');
  assert.strictEqual(typeof model.insertEvent, 'function');
  assert.strictEqual(typeof model.listEvents, 'function');
}

async function run() {
  testSummarize();
  testJsonBytes();
  testTraceId();
  testRtt();
  testResolveClientRtt();
  testLatencyAnalytics();
  await testModelImport();
  console.log('verify_telemetry: PASS');
}

run().catch((err) => {
  console.error('verify_telemetry: FAIL', err);
  process.exit(1);
});
