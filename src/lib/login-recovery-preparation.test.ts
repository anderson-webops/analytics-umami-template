import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { hash } from '@/lib/crypto';
import {
  confirmPreparedLoginRecoveryCodes,
  generateLoginRecoveryCodes,
  getLoginRecoveryPreparationKeys,
  persistLoginRecoveryCodes,
  prepareLoginRecoveryCodes,
  RecoveryPreparationError,
  RecoveryTargetNotFoundError,
} from './login-recovery';

vi.mock('@/lib/prisma', () => ({ default: { client: {} } }));

let settings: Map<string, string>;
let password: string;
let targetExists: boolean;
let credentials: Array<{ code: string; digest: string }>;
let active: Array<{ codeDigest: string; passwordFingerprint: string; keyFingerprint: string }>;
let transaction: Prisma.TransactionClient;

beforeEach(() => {
  vi.stubEnv('APP_SECRET', 'synthetic-preparation-secret-0000000000000000');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-05T01:00:00Z'));
  settings = new Map();
  password = 'current-hash';
  targetExists = true;
  credentials = generateLoginRecoveryCodes();
  active = [
    { codeDigest: 'previous', passwordFingerprint: hash(password), keyFingerprint: 'previous-key' },
  ];
  transaction = {
    $queryRaw: vi.fn(async (_query, key) =>
      settings.has(key) ? [{ value: settings.get(key) }] : [],
    ),
    user: { findUnique: vi.fn(async () => (targetExists ? { password } : null)) },
    appSetting: {
      upsert: vi.fn(async ({ where, create, update }) => {
        settings.set(where.key, settings.has(where.key) ? update.value : create.value);
      }),
      findUnique: vi.fn(async ({ where }) =>
        settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null,
      ),
      deleteMany: vi.fn(async ({ where }) => {
        for (const key of where.key.in) settings.delete(key);
      }),
    },
    loginRecoveryCredential: {
      deleteMany: vi.fn(async () => {
        active = [];
      }),
      createMany: vi.fn(async ({ data }) => {
        active.push(...data);
      }),
    },
  } as unknown as Prisma.TransactionClient;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test('interrupted preparation preserves the active set and stores bounded digest-only pending data', async () => {
  await prepareLoginRecoveryCodes(transaction, 'owner', credentials);
  expect(active.map(row => row.codeDigest)).toEqual(['previous']);
  const stored = settings.get(getLoginRecoveryPreparationKeys('owner').pending);
  expect(stored).toBeDefined();
  for (const { code } of credentials) expect(stored).not.toContain(code);
  expect(JSON.parse(stored ?? 'null').digests).toHaveLength(8);
  expect(JSON.parse(stored ?? 'null').expiresAt).toBe(Date.now() + 900_000);
  await prepareLoginRecoveryCodes(transaction, 'owner', generateLoginRecoveryCodes());
  expect(settings.size).toBe(1);
  expect(active.map(row => row.codeDigest)).toEqual(['previous']);
});

test('owner proof atomically replaces the set with seven unused codes and durable exact-batch confirmation', async () => {
  await prepareLoginRecoveryCodes(transaction, 'owner', credentials);
  const keys = getLoginRecoveryPreparationKeys('owner');
  const batchId = JSON.parse(settings.get(keys.pending) ?? 'null').batchId;
  await confirmPreparedLoginRecoveryCodes(transaction, 'owner', credentials[0].code);
  expect(active.map(row => row.codeDigest)).toEqual(credentials.slice(1).map(row => row.digest));
  expect(settings.has(keys.pending)).toBe(false);
  expect(JSON.parse(settings.get(keys.confirmed) ?? 'null')).toMatchObject({
    version: 1,
    userId: 'owner',
    batchId,
    passwordFingerprint: hash(password),
    proofDigest: credentials[0].digest,
  });
  for (const { code } of credentials) expect(settings.get(keys.confirmed)).not.toContain(code);
});

test('lost confirmation response is safely repeatable without reactivating or restoring spent codes', async () => {
  await prepareLoginRecoveryCodes(transaction, 'owner', credentials);
  await confirmPreparedLoginRecoveryCodes(transaction, 'owner', credentials[0].code);
  active.pop();
  const receipt = settings.get(getLoginRecoveryPreparationKeys('owner').confirmed);
  await confirmPreparedLoginRecoveryCodes(transaction, 'owner', credentials[0].code);
  expect(active).toHaveLength(6);
  expect(settings.get(getLoginRecoveryPreparationKeys('owner').confirmed)).toBe(receipt);
  expect(transaction.loginRecoveryCredential.deleteMany).toHaveBeenCalledOnce();
});

test.each(['password', 'key', 'expiry', 'wrong-code', 'wrong-owner', 'malformed-record'])(
  '%s cannot activate pending codes',
  async change => {
    await prepareLoginRecoveryCodes(transaction, 'owner', credentials);
    const keys = getLoginRecoveryPreparationKeys('owner');
    if (change === 'password') password = 'replacement-password';
    if (change === 'key')
      vi.stubEnv('APP_SECRET', 'replacement-preparation-secret-000000000000000');
    if (change === 'expiry') vi.advanceTimersByTime(900_000);
    if (change === 'malformed-record') settings.set(keys.pending, '{broken');
    const code =
      change === 'wrong-code' ? generateLoginRecoveryCodes()[0].code : credentials[0].code;
    const owner = change === 'wrong-owner' ? 'different-owner' : 'owner';
    await expect(
      confirmPreparedLoginRecoveryCodes(transaction, owner, code),
    ).rejects.toBeInstanceOf(RecoveryPreparationError);
    expect(active.map(row => row.codeDigest)).toEqual(['previous']);
  },
);

test('superseding pending preparation rejects a stale code without discarding active recovery', async () => {
  await prepareLoginRecoveryCodes(transaction, 'owner', credentials);
  const next = generateLoginRecoveryCodes();
  await prepareLoginRecoveryCodes(transaction, 'owner', next);
  await expect(
    confirmPreparedLoginRecoveryCodes(transaction, 'owner', credentials[0].code),
  ).rejects.toBeInstanceOf(RecoveryPreparationError);
  expect(active.map(row => row.codeDigest)).toEqual(['previous']);
  await confirmPreparedLoginRecoveryCodes(transaction, 'owner', next[0].code);
  expect(active).toHaveLength(7);
});

test('a confirmed receipt cannot be reused for a different pending batch', async () => {
  await prepareLoginRecoveryCodes(transaction, 'owner', credentials);
  await confirmPreparedLoginRecoveryCodes(transaction, 'owner', credentials[0].code);
  await prepareLoginRecoveryCodes(transaction, 'owner', generateLoginRecoveryCodes());
  await expect(
    confirmPreparedLoginRecoveryCodes(transaction, 'owner', credentials[0].code),
  ).rejects.toBeInstanceOf(RecoveryPreparationError);
  expect(active).toHaveLength(7);
});

test.each(['prepare', 'confirm'])('deleted owners cannot %s', async action => {
  targetExists = false;
  const operation =
    action === 'prepare'
      ? prepareLoginRecoveryCodes(transaction, 'owner', credentials)
      : confirmPreparedLoginRecoveryCodes(transaction, 'owner', credentials[0].code);
  await expect(operation).rejects.toBeInstanceOf(RecoveryTargetNotFoundError);
  expect(settings.size).toBe(0);
  expect(active).toHaveLength(1);
});

test('protected lost-code issuance invalidates local pending/confirmed metadata but does not manufacture owner proof', async () => {
  const keys = getLoginRecoveryPreparationKeys('owner');
  settings.set(keys.pending, 'old-pending');
  settings.set(keys.confirmed, 'old-receipt');
  await persistLoginRecoveryCodes(transaction, 'owner', credentials);
  expect(settings.size).toBe(0);
  expect(active).toHaveLength(8);
});

test('confirmation excludes every already spent pending credential', async () => {
  await prepareLoginRecoveryCodes(transaction, 'owner', credentials);
  const key = getLoginRecoveryPreparationKeys('owner').pending;
  const pending = JSON.parse(settings.get(key) ?? 'null');
  pending.consumedDigests = [credentials[1].digest, credentials[2].digest];
  settings.set(key, JSON.stringify(pending));
  await confirmPreparedLoginRecoveryCodes(transaction, 'owner', credentials[0].code);
  expect(active.map(row => row.codeDigest)).toEqual(credentials.slice(3).map(row => row.digest));
});

test('a spent proof or last pending code cannot establish unusable recovery', async () => {
  await prepareLoginRecoveryCodes(transaction, 'owner', credentials);
  const key = getLoginRecoveryPreparationKeys('owner').pending;
  const pending = JSON.parse(settings.get(key) ?? 'null');
  pending.consumedDigests = credentials.slice(0, 7).map(row => row.digest);
  settings.set(key, JSON.stringify(pending));
  await expect(
    confirmPreparedLoginRecoveryCodes(transaction, 'owner', credentials[0].code),
  ).rejects.toBeInstanceOf(RecoveryPreparationError);
  await expect(
    confirmPreparedLoginRecoveryCodes(transaction, 'owner', credentials[7].code),
  ).rejects.toBeInstanceOf(RecoveryPreparationError);
  expect(active.map(row => row.codeDigest)).toEqual(['previous']);
});

test('uppercase UUID preparation can be confirmed by the canonical owner', async () => {
  const ownerId = 'abcdef01-2345-4678-9123-abcdef012345';
  await prepareLoginRecoveryCodes(transaction, ownerId.toUpperCase(), credentials);
  const key = getLoginRecoveryPreparationKeys(ownerId).pending;
  expect(JSON.parse(settings.get(key) ?? 'null').userId).toBe(ownerId);
  await confirmPreparedLoginRecoveryCodes(transaction, ownerId, credentials[0].code);
  expect(active).toHaveLength(7);
});

test('uppercase operator target clears canonical pending and confirmation metadata', async () => {
  const ownerId = 'abcdef01-2345-4678-9123-abcdef012345';
  const keys = getLoginRecoveryPreparationKeys(ownerId);
  await prepareLoginRecoveryCodes(transaction, ownerId, credentials);
  settings.set(keys.confirmed, 'previous-receipt');
  await persistLoginRecoveryCodes(transaction, ownerId.toUpperCase(), generateLoginRecoveryCodes());
  expect(settings.has(keys.pending)).toBe(false);
  expect(settings.has(keys.confirmed)).toBe(false);
});
