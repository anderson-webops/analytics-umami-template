import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { hash } from '@/lib/crypto';
import {
  consumeLoginRecoveryCode,
  digestLoginRecoveryCode,
  generateLoginRecoveryCodes,
  getLoginRecoveryKeyFingerprint,
  lookupLoginRecoveryCode,
} from './login-recovery';

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn() }));

vi.mock('@/lib/prisma', () => ({ default: { client: { $queryRaw: mocks.queryRaw } } }));

beforeEach(() => vi.stubEnv('APP_SECRET', 'synthetic-login-recovery-secret-0000000000000000'));

afterEach(() => {
  mocks.queryRaw.mockReset();
  vi.unstubAllEnvs();
});

test('issues distinct high-entropy codes and stores only their digests', () => {
  const credentials = generateLoginRecoveryCodes();

  expect(credentials).toHaveLength(8);
  expect(new Set(credentials.map(({ code }) => code)).size).toBe(8);
  for (const { code, digest } of credentials) {
    expect(code).toMatch(/^UR-[0-9A-F]{64}$/);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(code);
    expect(digestLoginRecoveryCode(code.toLowerCase())).toBe(digest);
  }
});

test('a key rotation invalidates old codes and changes the coverage fingerprint', () => {
  const [{ code }] = generateLoginRecoveryCodes();
  const oldFingerprint = getLoginRecoveryKeyFingerprint();
  vi.stubEnv('APP_SECRET', 'replacement-login-recovery-secret-000000000000000');

  expect(getLoginRecoveryKeyFingerprint()).not.toBe(oldFingerprint);
  expect(digestLoginRecoveryCode(code)).toBeNull();
});

test.each(['', 'UR-short', `UR-${'G'.repeat(64)}`, `UR-${'A'.repeat(65)}`, `UR-${'A'.repeat(64)}`])(
  'rejects malformed recovery codes without a database lookup',
  async code => {
    expect(digestLoginRecoveryCode(code)).toBeNull();
    expect(await lookupLoginRecoveryCode('alice', code)).toBeNull();
    expect(
      await consumeLoginRecoveryCode('alice', code, {
        userId: 'user-1',
        passwordHash: 'synthetic-password-hash',
      }),
    ).toBeNull();
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  },
);

test('consumes a code atomically for only its live owner', async () => {
  const [{ code, digest }] = generateLoginRecoveryCodes();
  mocks.queryRaw.mockResolvedValueOnce([{ userId: 'user-1' }]);

  expect(
    await consumeLoginRecoveryCode(' ALICE ', code, {
      userId: 'user-1',
      passwordHash: 'synthetic-password-hash',
    }),
  ).toBe('user-1');
  const query = mocks.queryRaw.mock.calls[0];
  expect(query.join('?')).toContain('UPDATE "login_recovery_credential"');
  expect(query.join('?')).toContain('credential."consumed_at" IS NULL');
  expect(query.join('?')).toContain('owner."deleted_at" IS NULL');
  expect(query.join('?')).toContain('owner."password" =');
  expect(query.join('?')).toContain('credential."password_fingerprint" =');
  expect(query.join('?')).toContain('credential."key_fingerprint" =');
  expect(query).toContain(digest);
  expect(query).toContain(hash('synthetic-password-hash'));
  expect(query).toContain('alice');
});

test('looks up a valid code without consuming it', async () => {
  const [{ code, digest }] = generateLoginRecoveryCodes();
  mocks.queryRaw.mockResolvedValueOnce([
    {
      userId: 'user-1',
      passwordHash: 'synthetic-password-hash',
      passwordFingerprint: hash('synthetic-password-hash'),
    },
  ]);

  expect(await lookupLoginRecoveryCode(' ALICE ', code)).toEqual({
    userId: 'user-1',
    passwordHash: 'synthetic-password-hash',
  });
  const query = mocks.queryRaw.mock.calls[0];
  expect(query.join('?')).toContain('credential."consumed_at" IS NULL');
  expect(query.join('?')).toContain('owner."deleted_at" IS NULL');
  expect(query.join('?')).toContain('credential."password_fingerprint"');
  expect(query.join('?')).toContain('credential."key_fingerprint" =');
  expect(query).toContain(digest);
  expect(query).toContain('alice');
});

test('a used, wrong-owner, or missing code does not authenticate', async () => {
  const [{ code }] = generateLoginRecoveryCodes();
  mocks.queryRaw.mockResolvedValue([]);

  expect(
    await consumeLoginRecoveryCode('alice', code, {
      userId: 'user-1',
      passwordHash: 'synthetic-password-hash',
    }),
  ).toBeNull();
});

test('a code bound to a prior password hash does not match the current account', async () => {
  const [{ code }] = generateLoginRecoveryCodes();
  mocks.queryRaw.mockResolvedValueOnce([
    {
      userId: 'user-1',
      passwordHash: 'new-password-hash',
      passwordFingerprint: hash('old-password-hash'),
    },
  ]);

  expect(await lookupLoginRecoveryCode('alice', code)).toBeNull();
});
