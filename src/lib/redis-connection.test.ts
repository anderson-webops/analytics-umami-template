import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const redisState = vi.hoisted(() => {
  const listeners = new Map<string, () => void>();
  const client = {
    connect: vi.fn(),
    destroy: vi.fn(),
    isOpen: false,
    isReady: false,
    on: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
      return client;
    }),
  };

  return { client, listeners };
});

vi.mock('redis', () => ({
  createClient: vi.fn(() => redisState.client),
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379');
  redisState.listeners.clear();
  redisState.client.connect.mockReset();
  redisState.client.destroy.mockReset();
  redisState.client.on.mockClear();
  redisState.client.isOpen = false;
  redisState.client.isReady = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test('a readiness deadline bounds an existing reconnect and permits recovery', async () => {
  let rejectConnection!: (error: Error) => void;
  redisState.client.connect
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          redisState.client.isOpen = true;
          rejectConnection = reject;
        }),
    )
    .mockImplementationOnce(async () => {
      redisState.client.isOpen = true;
      redisState.client.isReady = true;
    });
  redisState.client.destroy.mockImplementation(() => {
    redisState.client.isOpen = false;
    redisState.client.isReady = false;
    rejectConnection(new Error('connection destroyed'));
    redisState.listeners.get('end')?.();
  });

  const redis = (await import('./redis')).default;
  const ordinaryConnection = redis.client.connect();
  const ordinaryRejection = expect(ordinaryConnection).rejects.toThrow();
  const readinessConnection = redis.client.connect(1_000);
  const readinessRejection = expect(readinessConnection).rejects.toThrow();

  await vi.advanceTimersByTimeAsync(1_000);
  await Promise.all([ordinaryRejection, readinessRejection]);
  expect(redisState.client.destroy).toHaveBeenCalledOnce();

  await expect(redis.client.connect(1_000)).resolves.toBeUndefined();
  expect(redisState.client.connect).toHaveBeenCalledTimes(2);
});
