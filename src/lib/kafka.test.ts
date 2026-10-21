import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { KAFKA, KAFKA_PRODUCER } from '@/lib/db';

const sendMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('KAFKA_URL', 'kafka://localhost');
  vi.stubEnv('KAFKA_BROKER', 'localhost:9092');
  vi.stubEnv('KAFKA_MAX_MESSAGE_BYTES', '100');
  globalThis[KAFKA] = {} as never;
  globalThis[KAFKA_PRODUCER] = { send: sendMock } as never;
  sendMock.mockReset().mockResolvedValue([{ topicName: 'event', partition: 0, errorCode: 0 }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete globalThis[KAFKA];
  delete globalThis[KAFKA_PRODUCER];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test('rejects an oversized member before sending any batch', async () => {
  const kafka = (await import('./kafka')).default;

  await expect(
    kafka.sendMessage('event', [{ value: 'small' }, { value: 'x'.repeat(200) }]),
  ).rejects.toMatchObject({ code: 'KAFKA_MESSAGE_TOO_LARGE' });
  expect(sendMock).not.toHaveBeenCalled();
});

test('returns acknowledged batches', async () => {
  vi.stubEnv('KAFKA_MAX_MESSAGE_BYTES', '15');
  const kafka = (await import('./kafka')).default;

  const acknowledgements = await kafka.sendMessage('event', [{ n: 1 }, { n: 2 }, { n: 3 }]);

  expect(sendMock).toHaveBeenCalledTimes(2);
  expect(acknowledgements).toHaveLength(2);
});

test('does not report success when the producer rejects a batch', async () => {
  sendMock.mockRejectedValueOnce(new Error('private broker details'));
  const kafka = (await import('./kafka')).default;

  await expect(kafka.sendMessage('event', { value: 'safe' })).rejects.toMatchObject({
    code: 'KAFKA_SEND_FAILED',
    message: 'Kafka delivery failed.',
  });
  expect(JSON.stringify(vi.mocked(console.error).mock.calls[0])).not.toContain(
    'private broker details',
  );
});

test('does not report success without a broker acknowledgement', async () => {
  sendMock.mockResolvedValueOnce([]);
  const kafka = (await import('./kafka')).default;

  await expect(kafka.sendMessage('event', { value: 'safe' })).rejects.toMatchObject({
    code: 'KAFKA_SEND_FAILED',
  });
});
