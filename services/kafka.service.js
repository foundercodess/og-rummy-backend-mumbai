const { Kafka, logLevel } = require('kafkajs');

let kafka = null;
let producer = null;

function getKafka() {
  const brokers = String(process.env.KAFKA_BROKERS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (!brokers.length) return null;
  if (kafka) return kafka;

  kafka = new Kafka({
    clientId: process.env.KAFKA_CLIENT_ID || 'og-rummy-backend',
    brokers,
    logLevel: logLevel.NOTHING,
  });

  return kafka;
}

async function getProducer() {
  if (producer) return producer;
  const client = getKafka();
  if (!client) return null;

  producer = client.producer();
  await producer.connect();
  return producer;
}

async function publish(topic, messages) {
  const kafkaProducer = await getProducer();
  if (!kafkaProducer) return { ok: null, message: 'not configured' };

  await kafkaProducer.send({
    topic,
    messages,
  });

  return { ok: true };
}

async function pingKafka() {
  const client = getKafka();
  if (!client) return { ok: null, message: 'not configured' };

  try {
    const admin = client.admin();
    await admin.connect();
    await admin.listTopics();
    await admin.disconnect();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  getKafka,
  getProducer,
  publish,
  pingKafka,
};
