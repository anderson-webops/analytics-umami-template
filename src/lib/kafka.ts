import type * as tls from 'node:tls';
import debug from 'debug';
import { Kafka, logLevel, type Producer, type RecordMetadata, type SASLOptions } from 'kafkajs';
import { KAFKA, KAFKA_PRODUCER } from '@/lib/db';
import { isEnvEnabled } from '@/lib/env';

const log = debug('umami:kafka');
const CONNECT_TIMEOUT = 5000;
const SEND_TIMEOUT = 3000;
const ACKS = 1;
const DEFAULT_MAX_MESSAGE_BYTES = 900_000;

let kafka: Kafka;
let producer: Producer;
const enabled = Boolean(process.env.KAFKA_URL && process.env.KAFKA_BROKER);

type KafkaMessage = Record<string, unknown>;
type KafkaProducerMessage = { value: string };

export function getMaxMessageBytes() {
  const size = Number(process.env.KAFKA_MAX_MESSAGE_BYTES);

  return Number.isFinite(size) && size > 0 ? size : DEFAULT_MAX_MESSAGE_BYTES;
}

function getMessageSize(value: string) {
  return Buffer.byteLength(value, 'utf8');
}

function getMessages(message: KafkaMessage | KafkaMessage[]) {
  const items = Array.isArray(message) ? message : [message];

  return items.map(item => {
    const value = JSON.stringify(item);

    return { value, size: getMessageSize(value) };
  });
}

function getClient() {
  const { protocol, username, password } = new URL(process.env.KAFKA_URL);
  const brokers = process.env.KAFKA_BROKER.split(',');
  const mechanism =
    (process.env.KAFKA_SASL_MECHANISM as 'plain' | 'scram-sha-256' | 'scram-sha-512') || 'plain';
  const useTls =
    protocol === 'kafkas:' || isEnvEnabled('KAFKA_SSL') || Boolean(username && password);

  const ssl: { ssl?: tls.ConnectionOptions | boolean; sasl?: SASLOptions } =
    username && password
      ? {
          ssl: {
            rejectUnauthorized: process.env.KAFKA_SSL_ALLOW_UNAUTHORIZED !== 'true',
          },
          sasl: {
            mechanism,
            username,
            password,
          },
        }
      : useTls
        ? { ssl: true }
        : {};

  const client: Kafka = new Kafka({
    clientId: 'umami',
    brokers: brokers,
    connectionTimeout: CONNECT_TIMEOUT,
    logLevel: logLevel.ERROR,
    ...ssl,
  });

  if (process.env.NODE_ENV !== 'production') {
    globalThis[KAFKA] = client;
  }

  log('Kafka initialized');

  return client;
}

async function getProducer(): Promise<Producer> {
  const producer = kafka.producer();
  await producer.connect();

  if (process.env.NODE_ENV !== 'production') {
    globalThis[KAFKA_PRODUCER] = producer;
  }

  log('Kafka producer initialized');

  return producer;
}

async function sendMessage(
  topic: string,
  message: KafkaMessage | KafkaMessage[],
): Promise<RecordMetadata[]> {
  try {
    const maxMessageBytes = getMaxMessageBytes();
    const messages = getMessages(message);
    const oversized = messages.find(({ size }) => size > maxMessageBytes);

    if (oversized) {
      throw Object.assign(new Error('Kafka message exceeds the configured limit.'), {
        code: 'KAFKA_MESSAGE_TOO_LARGE',
      });
    }

    await connect();

    const result: RecordMetadata[] = [];
    let batch: KafkaProducerMessage[] = [];
    let batchSize = 0;

    for (const { value, size } of messages) {
      if (batch.length && batchSize + size > maxMessageBytes) {
        const acknowledgements = await producer.send({
          topic,
          messages: batch,
          timeout: SEND_TIMEOUT,
          acks: ACKS,
        });

        if (!acknowledgements.length) {
          throw new Error('KAFKA_SEND_UNACKNOWLEDGED');
        }

        result.push(...acknowledgements);
        batch = [];
        batchSize = 0;
      }

      batch.push({ value });
      batchSize += size;
    }

    if (batch.length) {
      const acknowledgements = await producer.send({
        topic,
        messages: batch,
        timeout: SEND_TIMEOUT,
        acks: ACKS,
      });

      if (!acknowledgements.length) {
        throw new Error('KAFKA_SEND_UNACKNOWLEDGED');
      }

      result.push(...acknowledgements);
    }

    return result;
  } catch (e) {
    const name = e instanceof Error ? e.name : typeof e;
    const rawCode = typeof e === 'object' && e && 'code' in e ? e.code : undefined;
    const code =
      typeof rawCode === 'string' && /^[A-Za-z0-9_-]{1,50}$/.test(rawCode) ? rawCode : undefined;

    // eslint-disable-next-line no-console
    console.error('Kafka send failed', { name, ...(code ? { code } : {}) });

    throw Object.assign(new Error('Kafka delivery failed.'), {
      code: code === 'KAFKA_MESSAGE_TOO_LARGE' ? code : 'KAFKA_SEND_FAILED',
    });
  }
}

async function connect(): Promise<Kafka> {
  if (!kafka) {
    kafka = process.env.KAFKA_URL && process.env.KAFKA_BROKER && (globalThis[KAFKA] || getClient());

    if (kafka) {
      producer = globalThis[KAFKA_PRODUCER] || (await getProducer());
    }
  }

  return kafka;
}

export default {
  enabled,
  client: kafka,
  producer,
  log,
  connect,
  sendMessage,
};
