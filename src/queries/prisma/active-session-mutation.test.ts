import { beforeEach, expect, test, vi } from 'vitest';
import type { Auth } from '@/lib/types';
import { runActiveSessionMutation, SessionRevokedError } from './authorization';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  redisGet: vi.fn(),
  redisEnabled: { value: true },
  hash: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: { transaction: mocks.transaction },
}));

vi.mock('@/lib/redis', () => ({
  default: {
    get enabled() {
      return mocks.redisEnabled.value;
    },
    client: { get: mocks.redisGet },
  },
}));

vi.mock('@/lib/crypto', () => ({ hash: mocks.hash }));

const auth: Auth = {
  authType: 'session',
  authKey: 'auth:synthetic',
  user: { id: 'user-1', username: 'alice', role: 'user', isAdmin: false },
  sessionGeneration: 3,
  passwordFingerprint: 'fingerprint',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redisEnabled.value = true;
  mocks.hash.mockReturnValue('fingerprint');
  mocks.queryRaw.mockImplementation(async strings =>
    strings.join('').includes('FROM "user"')
      ? [{ password: 'password-hash', role: 'user', sessionGeneration: 3 }]
      : [{ pg_advisory_xact_lock: '' }],
  );
  mocks.redisGet.mockResolvedValue({
    userId: 'user-1',
    role: 'user',
    pwd: 'fingerprint',
    sessionGeneration: 3,
  });
  mocks.transaction.mockImplementation(async operation => operation({ $queryRaw: mocks.queryRaw }));
});

test('locks revocation and the current user before running a live Redis session mutation', async () => {
  const operation = vi.fn().mockResolvedValue('written');

  await expect(runActiveSessionMutation(auth, operation)).resolves.toBe('written');

  expect(mocks.queryRaw.mock.calls[0][0].join('')).toContain('pg_advisory_xact_lock');
  expect(mocks.queryRaw.mock.calls[1][0].join('')).toContain('FOR UPDATE');
  expect(mocks.queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
    mocks.redisGet.mock.invocationCallOrder[0],
  );
  expect(mocks.redisGet.mock.invocationCallOrder[0]).toBeLessThan(
    operation.mock.invocationCallOrder[0],
  );
});

test.each([
  ['missing key', null],
  ['other user', { userId: 'user-2', role: 'user', pwd: 'fingerprint', sessionGeneration: 3 }],
  ['old generation', { userId: 'user-1', role: 'user', pwd: 'fingerprint', sessionGeneration: 2 }],
  ['other role', { userId: 'user-1', role: 'admin', pwd: 'fingerprint', sessionGeneration: 3 }],
  ['old password', { userId: 'user-1', role: 'user', pwd: 'old', sessionGeneration: 3 }],
])('rejects %s after session revocation without running the mutation', async (_, session) => {
  mocks.redisGet.mockResolvedValue(session);
  const operation = vi.fn();

  await expect(runActiveSessionMutation(auth, operation)).rejects.toBeInstanceOf(
    SessionRevokedError,
  );
  expect(operation).not.toHaveBeenCalled();
});

test.each([
  ['deleted user', []],
  ['changed role', [{ password: 'password-hash', role: 'admin', sessionGeneration: 3 }]],
  ['changed generation', [{ password: 'password-hash', role: 'user', sessionGeneration: 4 }]],
])('rejects %s before reading the Redis key', async (_, users) => {
  mocks.queryRaw.mockImplementation(async strings =>
    strings.join('').includes('FROM "user"') ? users : [{}],
  );
  const operation = vi.fn();

  await expect(runActiveSessionMutation(auth, operation)).rejects.toBeInstanceOf(
    SessionRevokedError,
  );
  expect(mocks.redisGet).not.toHaveBeenCalled();
  expect(operation).not.toHaveBeenCalled();
});

test('accepts a still-current stateless session without a Redis key', async () => {
  const operation = vi.fn().mockResolvedValue('written');

  await expect(runActiveSessionMutation({ ...auth, authKey: undefined }, operation)).resolves.toBe(
    'written',
  );
  expect(mocks.redisGet).not.toHaveBeenCalled();
});

test('rejects incomplete session evidence before starting a transaction', async () => {
  const operation = vi.fn();

  await expect(
    runActiveSessionMutation({ ...auth, passwordFingerprint: undefined }, operation),
  ).rejects.toBeInstanceOf(SessionRevokedError);
  expect(mocks.transaction).not.toHaveBeenCalled();
});
