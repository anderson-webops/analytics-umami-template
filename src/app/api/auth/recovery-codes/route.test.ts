import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { hash } from '@/lib/crypto';
import { RecoveryPreparationError, RecoveryTargetNotFoundError } from '@/lib/login-recovery';
import { SessionRevokedError } from '@/queries/prisma/authorization';
import { rotateLoginRecoveryCodesSchema } from './schema';

const mocks = vi.hoisted(() => ({
  transaction: {},
  parseRequest: vi.fn(),
  count: vi.fn(),
  getUser: vi.fn(),
  reservePasswordVerificationAttempt: vi.fn(),
  checkPassword: vi.fn(),
  generateLoginRecoveryCodes: vi.fn(),
  getLoginRecoveryKeyFingerprint: vi.fn(),
  prepareLoginRecoveryCodes: vi.fn(),
  confirmPreparedLoginRecoveryCodes: vi.fn(),
  runActiveSessionMutation: vi.fn(),
  assertCurrentActorAuth: vi.fn(),
  assertActorIsAdministrator: vi.fn(),
}));

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
  RecoveryTargetNotFoundError: class RecoveryTargetNotFoundError extends Error {},
  RecoveryPreparationError: class RecoveryPreparationError extends Error {},
  generateLoginRecoveryCodes: mocks.generateLoginRecoveryCodes,
  getLoginRecoveryKeyFingerprint: mocks.getLoginRecoveryKeyFingerprint,
  prepareLoginRecoveryCodes: mocks.prepareLoginRecoveryCodes,
  confirmPreparedLoginRecoveryCodes: mocks.confirmPreparedLoginRecoveryCodes,
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
const proof = `UR-${'A'.repeat(64)}`;
const confirmation = {
  action: 'confirm',
  password: 'current-password',
  recoveryCode: proof,
  saved: true,
};

beforeEach(() => {
  vi.stubEnv('CLOUD_MODE', '0');
  vi.stubEnv('DISABLE_LOGIN', '0');
  for (const mock of Object.values(mocks)) {
    if (vi.isMockFunction(mock)) mock.mockReset();
  }
  mocks.parseRequest.mockResolvedValue({ auth, body: { password: 'current-password' } });
  mocks.count.mockResolvedValue(4);
  mocks.getUser.mockResolvedValue({ id: 'user-1', password: 'stored-hash' });
  mocks.reservePasswordVerificationAttempt.mockResolvedValue({ allowed: true, retryAfter: 0 });
  mocks.checkPassword.mockResolvedValue(true);
  mocks.generateLoginRecoveryCodes.mockReturnValue([{ code: 'UR-ONE', digest: 'digest-one' }]);
  mocks.getLoginRecoveryKeyFingerprint.mockReturnValue('key-fingerprint');
  mocks.runActiveSessionMutation.mockImplementation(async (_auth, operation) =>
    operation(mocks.transaction),
  );
});

afterEach(() => vi.unstubAllEnvs());

function request(method = 'POST') {
  return new Request('https://analytics.example.com/api/auth/recovery-codes', {
    method,
    headers: { 'Content-Type': 'application/json', Origin: 'https://analytics.example.com' },
  });
}

test('reports only current-password and current-key active codes with no caching', async () => {
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

test.each(['api-key', 'share'])('%s cannot prepare or confirm codes', async authType => {
  for (const body of [{ password: 'current-password' }, confirmation]) {
    mocks.parseRequest.mockResolvedValue({ auth: { ...auth, authType }, body });
    expect((await POST(request())).status).toBe(401);
  }
  expect(mocks.getUser).not.toHaveBeenCalled();
  expect(mocks.runActiveSessionMutation).not.toHaveBeenCalled();
});

test('enrollment-only authority cannot prepare or confirm recovery', async () => {
  for (const body of [{ password: 'current-password' }, confirmation]) {
    mocks.parseRequest.mockResolvedValue({ auth: { ...auth, enrollmentOnly: true }, body });
    expect((await POST(request())).status).toBe(401);
  }
  expect(mocks.runActiveSessionMutation).not.toHaveBeenCalled();
});

test('preparation retains the active set and explicitly awaits owner confirmation', async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  await expect(response.json()).resolves.toEqual({
    recoveryCodes: ['UR-ONE'],
    requiresOwnerConfirmation: true,
  });
  expect(mocks.reservePasswordVerificationAttempt).toHaveBeenCalledWith('user-1');
  expect(mocks.checkPassword).toHaveBeenCalledWith('current-password', 'stored-hash');
  expect(mocks.assertCurrentActorAuth).toHaveBeenCalledWith(mocks.transaction, 'user-1', auth);
  expect(mocks.prepareLoginRecoveryCodes).toHaveBeenCalledWith(mocks.transaction, 'user-1', [
    { code: 'UR-ONE', digest: 'digest-one' },
  ]);
  expect(mocks.confirmPreparedLoginRecoveryCodes).not.toHaveBeenCalled();
});

test('only the current owner confirms a saved replacement using current password and session', async () => {
  mocks.parseRequest.mockResolvedValue({ auth, body: confirmation });
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  await expect(response.json()).resolves.toEqual({ confirmed: true });
  expect(mocks.assertCurrentActorAuth).toHaveBeenCalledWith(mocks.transaction, 'user-1', auth);
  expect(mocks.confirmPreparedLoginRecoveryCodes).toHaveBeenCalledWith(
    mocks.transaction,
    'user-1',
    proof,
  );
  expect(mocks.generateLoginRecoveryCodes).not.toHaveBeenCalled();
  expect(mocks.prepareLoginRecoveryCodes).not.toHaveBeenCalled();
});

test('a non-administrator cannot prepare codes for another account', async () => {
  mocks.parseRequest.mockResolvedValue({
    auth: { ...auth, user: { id: 'user-1', role: 'user' } },
    body: { password: 'p', userId: 'other' },
  });
  expect((await POST(request())).status).toBe(403);
  expect(mocks.checkPassword).not.toHaveBeenCalled();
});

test('an administrator may prepare but not confirm another owner’s codes', async () => {
  mocks.parseRequest.mockResolvedValue({ auth, body: { password: 'p', userId: 'other' } });
  expect((await POST(request())).status).toBe(200);
  expect(mocks.assertActorIsAdministrator).toHaveBeenCalledWith(mocks.transaction, 'user-1');
  expect(mocks.prepareLoginRecoveryCodes).toHaveBeenCalledWith(
    mocks.transaction,
    'other',
    expect.any(Array),
  );
  expect(
    rotateLoginRecoveryCodesSchema.safeParse({
      ...confirmation,
      userId: '00000000-0000-4000-8000-000000000002',
    }).success,
  ).toBe(false);
});

test('an uppercase own-account UUID is not treated as another owner', async () => {
  const ownerId = 'abcdef01-2345-4678-9123-abcdef012345';
  mocks.parseRequest.mockResolvedValue({
    auth: { ...auth, user: { id: ownerId, role: 'user' } },
    body: { password: 'p', userId: ownerId.toUpperCase() },
  });
  expect((await POST(request())).status).toBe(200);
  expect(mocks.assertActorIsAdministrator).not.toHaveBeenCalled();
  expect(mocks.prepareLoginRecoveryCodes).toHaveBeenCalledWith(
    mocks.transaction,
    ownerId,
    expect.any(Array),
  );
});

test.each([
  { ...confirmation, saved: false },
  { ...confirmation, saved: undefined },
  { ...confirmation, recoveryCode: 'wrong' },
  { ...confirmation, action: 'activate' },
])('invalid confirmation never satisfies the public schema: %j', body => {
  expect(rotateLoginRecoveryCodesSchema.safeParse(body).success).toBe(false);
});

test('legacy immediate-rotation clients fail validation instead of receiving expiring pending codes as active', () => {
  expect(rotateLoginRecoveryCodesSchema.safeParse({ password: 'current-password' }).success).toBe(
    false,
  );
  expect(
    rotateLoginRecoveryCodesSchema.safeParse({ action: 'prepare', password: 'current-password' })
      .success,
  ).toBe(true);
});

test.each(['prepare', 'confirm'])('wrong password cannot %s codes', async action => {
  mocks.parseRequest.mockResolvedValue({
    auth,
    body: action === 'confirm' ? confirmation : { password: 'wrong' },
  });
  mocks.checkPassword.mockResolvedValue(false);
  expect((await POST(request())).status).toBe(400);
  expect(mocks.runActiveSessionMutation).not.toHaveBeenCalled();
});

test('a missing target receives no prepared codes', async () => {
  mocks.prepareLoginRecoveryCodes.mockRejectedValue(new RecoveryTargetNotFoundError());
  expect((await POST(request())).status).toBe(404);
});

test('stale, expired or wrong-batch confirmation leaves recovery unchanged', async () => {
  mocks.parseRequest.mockResolvedValue({ auth, body: confirmation });
  mocks.confirmPreparedLoginRecoveryCodes.mockRejectedValue(new RecoveryPreparationError());
  expect((await POST(request())).status).toBe(400);
});

test.each(['ENTITY_ADMIN_REQUIRED', 'ENTITY_ACTOR_NOT_AUTHORIZED'])(
  'mutation-time %s rejection prevents preparation',
  async message => {
    mocks.assertCurrentActorAuth.mockRejectedValue(new Error(message));
    expect((await POST(request())).status).toBe(401);
    expect(mocks.prepareLoginRecoveryCodes).not.toHaveBeenCalled();
  },
);

test('a downgraded administrator cannot prepare another owner’s codes', async () => {
  mocks.parseRequest.mockResolvedValue({ auth, body: { password: 'p', userId: 'other' } });
  mocks.assertActorIsAdministrator.mockRejectedValue(new Error('ENTITY_ADMIN_REQUIRED'));
  expect((await POST(request())).status).toBe(401);
  expect(mocks.prepareLoginRecoveryCodes).not.toHaveBeenCalled();
});

test('revoked session cannot confirm or prepare codes', async () => {
  mocks.runActiveSessionMutation.mockRejectedValue(new SessionRevokedError());
  expect((await POST(request())).status).toBe(401);
  expect(mocks.prepareLoginRecoveryCodes).not.toHaveBeenCalled();
});

test('password-attempt exhaustion remains enforced', async () => {
  mocks.reservePasswordVerificationAttempt.mockResolvedValue({ allowed: false, retryAfter: 83 });
  const response = await POST(request());
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('83');
  expect(mocks.checkPassword).not.toHaveBeenCalled();
});

test('unavailable password-attempt storage fails closed', async () => {
  mocks.reservePasswordVerificationAttempt.mockRejectedValue(new Error('unavailable'));
  expect((await POST(request())).status).toBe(503);
  expect(mocks.checkPassword).not.toHaveBeenCalled();
});

test.each(['CLOUD_MODE', 'DISABLE_LOGIN'])('%s rejects before parsing', async flag => {
  vi.stubEnv(flag, '1');
  expect((await POST(request())).status).toBe(flag === 'CLOUD_MODE' ? 404 : 403);
  expect(mocks.parseRequest).not.toHaveBeenCalled();
});
