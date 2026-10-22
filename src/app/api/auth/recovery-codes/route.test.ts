import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { hash } from '@/lib/crypto';
import { SessionRevokedError } from '@/queries/prisma/authorization';

const mocks = vi.hoisted(() => {
  const transaction = {
    loginRecoveryCredential: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    user: { findUnique: vi.fn() },
  };

  return {
    transaction,
    parseRequest: vi.fn(),
    count: vi.fn(),
    getUser: vi.fn(),
    reservePasswordVerificationAttempt: vi.fn(),
    checkPassword: vi.fn(),
    generateLoginRecoveryCodes: vi.fn(),
    getLoginRecoveryKeyFingerprint: vi.fn(),
    runActiveSessionMutation: vi.fn(),
    assertCurrentActorAuth: vi.fn(),
    assertActorIsAdministrator: vi.fn(),
  };
});

vi.mock('@/lib/request', () => ({ parseRequest: mocks.parseRequest }));
vi.mock('@/lib/prisma', () => ({
  default: { client: { loginRecoveryCredential: { count: mocks.count } } },
}));
vi.mock('@/queries/prisma/user', () => ({ getUser: mocks.getUser }));
vi.mock('@/lib/password', () => ({
  checkPassword: mocks.checkPassword,
  isAcceptableLoginPassword: () => true,
  isStrongPassword: () => true,
}));
vi.mock('@/lib/password-verification-rate-limit', () => ({
  reservePasswordVerificationAttempt: mocks.reservePasswordVerificationAttempt,
}));
vi.mock('@/lib/login-recovery', () => ({
  generateLoginRecoveryCodes: mocks.generateLoginRecoveryCodes,
  getLoginRecoveryKeyFingerprint: mocks.getLoginRecoveryKeyFingerprint,
}));
vi.mock('@/queries/prisma/authorization', () => ({
  SessionRevokedError: class SessionRevokedError extends Error {},
  runActiveSessionMutation: mocks.runActiveSessionMutation,
  assertCurrentActorAuth: mocks.assertCurrentActorAuth,
  assertActorIsAdministrator: mocks.assertActorIsAdministrator,
}));

import { GET, POST } from './route';

const auth = {
  authType: 'session',
  user: { id: 'user-1', role: 'admin' },
  sessionGeneration: 1,
  passwordFingerprint: hash('stored-hash'),
  mfaVerified: true,
  mfaId: 'factor-1',
};

beforeEach(() => {
  vi.stubEnv('CLOUD_MODE', '0');
  vi.stubEnv('DISABLE_LOGIN', '0');
  for (const mock of [
    mocks.parseRequest,
    mocks.count,
    mocks.getUser,
    mocks.reservePasswordVerificationAttempt,
    mocks.checkPassword,
    mocks.generateLoginRecoveryCodes,
    mocks.getLoginRecoveryKeyFingerprint,
    mocks.runActiveSessionMutation,
    mocks.assertCurrentActorAuth,
    mocks.assertActorIsAdministrator,
    mocks.transaction.user.findUnique,
    mocks.transaction.loginRecoveryCredential.deleteMany,
    mocks.transaction.loginRecoveryCredential.createMany,
  ]) {
    mock.mockReset();
  }

  mocks.parseRequest.mockResolvedValue({ auth, body: { password: 'current-password' } });
  mocks.count.mockResolvedValue(4);
  mocks.getUser.mockResolvedValue({ id: 'user-1', password: 'stored-hash' });
  mocks.transaction.user.findUnique.mockResolvedValue({ password: 'stored-hash' });
  mocks.reservePasswordVerificationAttempt.mockResolvedValue({ allowed: true, retryAfter: 0 });
  mocks.checkPassword.mockResolvedValue(true);
  mocks.generateLoginRecoveryCodes.mockReturnValue([
    { code: 'UR-ONE', digest: 'digest-one' },
    { code: 'UR-TWO', digest: 'digest-two' },
  ]);
  mocks.getLoginRecoveryKeyFingerprint.mockReturnValue('key-fingerprint');
  mocks.runActiveSessionMutation.mockImplementation(async (_auth, operation) =>
    operation(mocks.transaction),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(method: string) {
  return new Request('https://analytics.example.com/api/auth/recovery-codes', {
    method,
    headers: { 'Content-Type': 'application/json', Origin: 'https://analytics.example.com' },
  });
}

test('reports only the current session owner’s remaining code count', async () => {
  const response = await GET(request('GET'));

  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  await expect(response.json()).resolves.toEqual({ remaining: 4 });
  expect(mocks.count).toHaveBeenCalledWith({
    where: {
      userId: 'user-1',
      passwordFingerprint: hash('stored-hash'),
      keyFingerprint: 'key-fingerprint',
      consumedAt: null,
    },
  });
});

test.each(['api-key', 'share'])('%s authentication cannot issue recovery codes', async authType => {
  mocks.parseRequest.mockResolvedValue({ auth: { ...auth, authType }, body: { password: 'p' } });

  const response = await POST(request('POST'));

  expect(response.status).toBe(401);
  expect(mocks.getUser).not.toHaveBeenCalled();
  expect(mocks.runActiveSessionMutation).not.toHaveBeenCalled();
});

test('a current session and password rotate codes in one authorized transaction', async () => {
  const response = await POST(request('POST'));

  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  await expect(response.json()).resolves.toEqual({ recoveryCodes: ['UR-ONE', 'UR-TWO'] });
  expect(mocks.reservePasswordVerificationAttempt).toHaveBeenCalledWith('user-1');
  expect(mocks.checkPassword).toHaveBeenCalledWith('current-password', 'stored-hash');
  expect(mocks.assertCurrentActorAuth).toHaveBeenCalledWith(mocks.transaction, 'user-1', auth);
  expect(mocks.transaction.loginRecoveryCredential.deleteMany).toHaveBeenCalledWith({
    where: { userId: 'user-1' },
  });
  expect(mocks.transaction.loginRecoveryCredential.createMany).toHaveBeenCalledWith({
    data: [
      {
        userId: 'user-1',
        codeDigest: 'digest-one',
        passwordFingerprint: hash('stored-hash'),
        keyFingerprint: 'key-fingerprint',
      },
      {
        userId: 'user-1',
        codeDigest: 'digest-two',
        passwordFingerprint: hash('stored-hash'),
        keyFingerprint: 'key-fingerprint',
      },
    ],
  });
});

test('a non-administrator cannot issue codes for another account', async () => {
  mocks.parseRequest.mockResolvedValue({
    auth: { ...auth, user: { id: 'user-1', role: 'user' } },
    body: { password: 'current-password', userId: '00000000-0000-4000-8000-000000000002' },
  });

  const response = await POST(request('POST'));

  expect(response.status).toBe(403);
  expect(mocks.checkPassword).not.toHaveBeenCalled();
  expect(mocks.runActiveSessionMutation).not.toHaveBeenCalled();
});

test('a current administrator can issue one-time codes for another active owner', async () => {
  const targetUserId = '00000000-0000-4000-8000-000000000002';
  mocks.parseRequest.mockResolvedValue({
    auth,
    body: { password: 'current-password', userId: targetUserId },
  });
  mocks.transaction.user.findUnique.mockResolvedValue({ password: 'target-hash' });

  const response = await POST(request('POST'));

  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(mocks.checkPassword).toHaveBeenCalledWith('current-password', 'stored-hash');
  expect(mocks.assertCurrentActorAuth).toHaveBeenCalledWith(mocks.transaction, 'user-1', auth);
  expect(mocks.assertActorIsAdministrator).toHaveBeenCalledWith(mocks.transaction, 'user-1');
  expect(mocks.transaction.user.findUnique).toHaveBeenCalledWith({
    where: { id: targetUserId, deletedAt: null },
    select: { password: true },
  });
  expect(mocks.transaction.loginRecoveryCredential.deleteMany).toHaveBeenCalledWith({
    where: { userId: targetUserId },
  });
  expect(mocks.transaction.loginRecoveryCredential.createMany).toHaveBeenCalledWith({
    data: [
      {
        userId: targetUserId,
        codeDigest: 'digest-one',
        passwordFingerprint: hash('target-hash'),
        keyFingerprint: 'key-fingerprint',
      },
      {
        userId: targetUserId,
        codeDigest: 'digest-two',
        passwordFingerprint: hash('target-hash'),
        keyFingerprint: 'key-fingerprint',
      },
    ],
  });
  await expect(response.json()).resolves.toEqual({ recoveryCodes: ['UR-ONE', 'UR-TWO'] });
});

test('a deleted or missing target receives no codes', async () => {
  mocks.parseRequest.mockResolvedValue({
    auth,
    body: { password: 'current-password', userId: '00000000-0000-4000-8000-000000000002' },
  });
  mocks.transaction.user.findUnique.mockResolvedValue(null);

  const response = await POST(request('POST'));

  expect(response.status).toBe(404);
  expect(mocks.transaction.loginRecoveryCredential.deleteMany).not.toHaveBeenCalled();
  expect(mocks.transaction.loginRecoveryCredential.createMany).not.toHaveBeenCalled();
});

test('a downgraded administrator cannot issue codes for another account', async () => {
  mocks.parseRequest.mockResolvedValue({
    auth,
    body: { password: 'current-password', userId: '00000000-0000-4000-8000-000000000002' },
  });
  mocks.assertActorIsAdministrator.mockRejectedValue(new Error('ENTITY_ADMIN_REQUIRED'));

  const response = await POST(request('POST'));

  expect(response.status).toBe(401);
  expect(mocks.transaction.loginRecoveryCredential.deleteMany).not.toHaveBeenCalled();
  expect(mocks.transaction.loginRecoveryCredential.createMany).not.toHaveBeenCalled();
});

test('a wrong password cannot rotate or reveal recovery codes', async () => {
  mocks.checkPassword.mockResolvedValue(false);

  const response = await POST(request('POST'));

  expect(response.status).toBe(400);
  expect(mocks.generateLoginRecoveryCodes).not.toHaveBeenCalled();
  expect(mocks.runActiveSessionMutation).not.toHaveBeenCalled();
});

test('password-attempt exhaustion cannot be bypassed by the issuance route', async () => {
  mocks.reservePasswordVerificationAttempt.mockResolvedValue({ allowed: false, retryAfter: 83 });

  const response = await POST(request('POST'));

  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('83');
  expect(mocks.checkPassword).not.toHaveBeenCalled();
});

test('stale or incomplete factor authorization cannot rotate codes', async () => {
  mocks.assertCurrentActorAuth.mockRejectedValue(new Error('ENTITY_ACTOR_NOT_AUTHORIZED'));

  const response = await POST(request('POST'));

  expect(response.status).toBe(401);
  expect(mocks.transaction.loginRecoveryCredential.deleteMany).not.toHaveBeenCalled();
  expect(mocks.transaction.loginRecoveryCredential.createMany).not.toHaveBeenCalled();
});

test('a revoked session cannot rotate codes', async () => {
  mocks.runActiveSessionMutation.mockRejectedValue(new SessionRevokedError());

  const response = await POST(request('POST'));

  expect(response.status).toBe(401);
  expect(mocks.transaction.loginRecoveryCredential.deleteMany).not.toHaveBeenCalled();
});

test('disabled local login rejects recovery issuance before parsing the body', async () => {
  vi.stubEnv('DISABLE_LOGIN', '1');

  const response = await POST(request('POST'));

  expect(response.status).toBe(403);
  expect(mocks.parseRequest).not.toHaveBeenCalled();
});
