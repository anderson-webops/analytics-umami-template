import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { hash } from '@/lib/crypto';
import { hasCurrentSessionGeneration } from '@/lib/session-generation';
import { createUser, deleteUser, updateUser } from './user';

const {
  state,
  credentialState,
  transaction,
  runSerialized,
  runRevocation,
  assertAdmin,
  assertCurrent,
  getRequirement,
  redisMock,
} = vi.hoisted(() => {
  const state = { role: 'user', sessionGeneration: 0 };
  const credentialState = {
    password: 'synthetic-password',
    mfaId: undefined as string | undefined,
    existingUser: false,
  };
  const transaction = {
    user: {
      create: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    twoFactorAuth: { findUnique: vi.fn() },
    apiKey: { deleteMany: vi.fn() },
  };

  return {
    state,
    credentialState,
    transaction,
    runSerialized: vi.fn(),
    runRevocation: vi.fn(),
    assertAdmin: vi.fn(),
    assertCurrent: vi.fn(),
    getRequirement: vi.fn(),
    redisMock: { enabled: false, client: { get: vi.fn(), del: vi.fn() } },
  };
});

vi.mock('@/lib/prisma', () => ({ default: { client: {} } }));
vi.mock('@/lib/redis', () => ({ default: redisMock }));
vi.mock('./authorization', () => ({
  assertActorIsAdministrator: assertAdmin,
  assertCurrentActorAuth: assertCurrent,
  runSerializedUserMutation: runSerialized,
  runCredentialRevocationMutation: runRevocation,
}));
vi.mock('@/lib/two-factor/requirement', () => ({ getTwoFactorRequirement: getRequirement }));

beforeEach(() => {
  state.role = 'user';
  state.sessionGeneration = 0;
  credentialState.password = 'synthetic-password';
  credentialState.mfaId = undefined;
  credentialState.existingUser = false;
  transaction.user.findUnique.mockReset().mockImplementation(async ({ where }) =>
    where.username
      ? credentialState.existingUser
        ? { id: 'existing-user' }
        : null
      : {
          role: state.role,
          deletedAt: null,
          password: credentialState.password,
          sessionGeneration: state.sessionGeneration,
        },
  );
  transaction.twoFactorAuth.findUnique
    .mockReset()
    .mockImplementation(async () =>
      credentialState.mfaId ? { id: credentialState.mfaId, isEnabled: true } : null,
    );
  transaction.user.create.mockReset();
  transaction.user.count.mockReset().mockResolvedValue(2);
  transaction.user.update.mockReset().mockImplementation(async ({ data }) => {
    if (data.role) {
      state.role = typeof data.role === 'string' ? data.role : data.role.set;
    }
    state.sessionGeneration += data.sessionGeneration?.increment ?? 0;
    return { id: 'user-1', role: state.role };
  });
  transaction.apiKey.deleteMany.mockReset();
  runSerialized.mockReset().mockImplementation(callback => callback(transaction));
  runRevocation.mockReset().mockImplementation(callback => callback(transaction));
  assertAdmin.mockReset();
  assertCurrent.mockReset();
  getRequirement.mockReset().mockResolvedValue({ reason: null });
  redisMock.enabled = false;
  redisMock.client.get.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

const newUser = { id: 'user-2', username: 'second', password: 'synthetic', role: 'admin' } as const;
const currentSession = () => ({
  sessionGeneration: state.sessionGeneration,
  passwordFingerprint: hash(credentialState.password),
  mfaId: credentialState.mfaId,
});
const administratorAuth = {
  authType: 'session' as const,
  user: { id: 'admin-1', username: 'admin', role: 'admin', isAdmin: true },
};

test('a role round trip revokes sessions and API keys at each transition', async () => {
  await updateUser('user-1', { role: 'admin' }, 'admin-1', administratorAuth);
  expect(state).toEqual({ role: 'admin', sessionGeneration: 1 });
  expect(hasCurrentSessionGeneration(0, state.sessionGeneration)).toBe(false);
  expect(runSerialized).toHaveBeenCalledOnce();
  expect(runRevocation).not.toHaveBeenCalled();
  expect(transaction.apiKey.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  expect(transaction.apiKey.deleteMany).toHaveBeenCalledTimes(1);

  await updateUser('user-1', { role: 'user' }, 'admin-1', administratorAuth);
  expect(state).toEqual({ role: 'user', sessionGeneration: 2 });
  expect(hasCurrentSessionGeneration(0, state.sessionGeneration)).toBe(false);
  expect(hasCurrentSessionGeneration(1, state.sessionGeneration)).toBe(false);
  expect(transaction.apiKey.deleteMany).toHaveBeenCalledTimes(2);
});

test('a same-role update preserves current sessions', async () => {
  await updateUser('user-1', { role: 'user', username: 'renamed' }, 'admin-1', administratorAuth);

  expect(state.sessionGeneration).toBe(0);
  expect(runSerialized).toHaveBeenCalledOnce();
  expect(transaction.apiKey.deleteMany).not.toHaveBeenCalled();
  expect(transaction.user.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: { role: 'user', username: 'renamed' } }),
  );
});

test('Prisma set-form role transitions also revoke earlier sessions', async () => {
  await updateUser('user-1', { role: { set: 'admin' } }, 'admin-1', administratorAuth);

  expect(state).toEqual({ role: 'admin', sessionGeneration: 1 });
  expect(transaction.apiKey.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
});

test('combined role and password changes increment once and revoke API keys', async () => {
  await updateUser('user-1', { role: 'admin', password: 'new-hash' }, 'admin-1', administratorAuth);

  expect(state).toEqual({ role: 'admin', sessionGeneration: 1 });
  expect(runRevocation).toHaveBeenCalledOnce();
  expect(transaction.apiKey.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  expect(transaction.apiKey.deleteMany).toHaveBeenCalledTimes(1);
});

test('the last active administrator cannot be demoted', async () => {
  state.role = 'admin';
  transaction.user.count.mockResolvedValue(1);

  await expect(
    updateUser('user-1', { role: 'user' }, 'admin-1', administratorAuth),
  ).rejects.toThrow('LAST_ACTIVE_ADMIN');
  expect(transaction.user.update).not.toHaveBeenCalled();
});

test('user creation requires the locked current administrator check', async () => {
  assertAdmin.mockRejectedValue(new Error('ENTITY_ADMIN_REQUIRED'));

  await expect(
    createUser(
      { id: 'user-2', username: 'second', password: 'synthetic', role: 'user' },
      'admin-1',
      { sessionGeneration: 0, passwordFingerprint: hash('synthetic-password') },
    ),
  ).rejects.toThrow('ADMIN_AUTHORIZATION_CHANGED');
  expect(assertAdmin).toHaveBeenCalledWith(transaction, 'admin-1');
  expect(transaction.user.create).not.toHaveBeenCalled();
});

test('user creation rejects a session revoked after request authentication', async () => {
  const session = currentSession();
  state.sessionGeneration = 1;

  await expect(createUser(newUser, 'admin-1', session)).rejects.toThrow(
    'ADMIN_AUTHORIZATION_CHANGED',
  );
  expect(transaction.user.create).not.toHaveBeenCalled();
});

test('user creation rejects a password changed after request authentication', async () => {
  const session = currentSession();
  credentialState.password = 'replacement-password';

  await expect(createUser(newUser, 'admin-1', session)).rejects.toThrow(
    'ADMIN_AUTHORIZATION_CHANGED',
  );
  expect(transaction.user.create).not.toHaveBeenCalled();
});

test('user creation rejects an MFA factor changed after request authentication', async () => {
  credentialState.mfaId = 'factor-1';
  const session = currentSession();
  credentialState.mfaId = 'factor-2';

  await expect(createUser(newUser, 'admin-1', session)).rejects.toThrow(
    'ADMIN_AUTHORIZATION_CHANGED',
  );
  expect(transaction.user.create).not.toHaveBeenCalled();
});

test('user creation fails closed without the authenticated session generation', async () => {
  await expect(
    createUser(newUser, 'admin-1', { ...currentSession(), sessionGeneration: undefined as never }),
  ).rejects.toThrow('ADMIN_AUTHORIZATION_CHANGED');
  expect(transaction.user.create).not.toHaveBeenCalled();
});

test('current administrator sessions create users with and without local MFA', async () => {
  transaction.user.create.mockResolvedValue({ id: newUser.id });

  await expect(createUser(newUser, 'admin-1', currentSession())).resolves.toEqual({
    id: newUser.id,
  });
  credentialState.mfaId = 'factor-1';
  await expect(createUser(newUser, 'admin-1', currentSession())).resolves.toEqual({
    id: newUser.id,
  });
  expect(transaction.user.create).toHaveBeenCalledTimes(2);
});

test('cloud administrator sessions do not require a local MFA factor', async () => {
  vi.stubEnv('CLOUD_MODE', 'true');
  credentialState.mfaId = 'factor-1';
  transaction.user.create.mockResolvedValue({ id: newUser.id });

  await expect(createUser(newUser, 'admin-1', currentSession())).resolves.toEqual({
    id: newUser.id,
  });
  expect(transaction.twoFactorAuth.findUnique).not.toHaveBeenCalled();
  expect(transaction.user.create).toHaveBeenCalledOnce();
});

test('revoked no-MFA sessions cannot create a user after MFA enrollment', async () => {
  const session = currentSession();
  credentialState.mfaId = 'factor-1';

  await expect(createUser(newUser, 'admin-1', session)).rejects.toThrow(
    'ADMIN_AUTHORIZATION_CHANGED',
  );
  expect(transaction.user.create).not.toHaveBeenCalled();
});

test.each(['user', 'team', 'global'])(
  'user creation rejects a newly required %s MFA enrollment',
  async reason => {
    getRequirement.mockResolvedValue({ reason });

    await expect(createUser(newUser, 'admin-1', currentSession())).rejects.toThrow(
      'ADMIN_AUTHORIZATION_CHANGED',
    );
    expect(transaction.user.create).not.toHaveBeenCalled();
  },
);

test('revoked sessions cannot probe whether a username already exists', async () => {
  const session = currentSession();
  state.sessionGeneration += 1;
  credentialState.existingUser = true;

  await expect(createUser(newUser, 'admin-1', session)).rejects.toThrow(
    'ADMIN_AUTHORIZATION_CHANGED',
  );
  expect(transaction.user.findUnique).not.toHaveBeenCalledWith(
    expect.objectContaining({ where: { username: newUser.username } }),
  );
});

test('current sessions still reject duplicate usernames, including soft-deleted accounts', async () => {
  credentialState.existingUser = true;

  await expect(createUser(newUser, 'admin-1', currentSession())).rejects.toThrow(
    'USER_ALREADY_EXISTS',
  );
  expect(transaction.user.create).not.toHaveBeenCalled();
});

test('a Redis logout completed after authentication denies pending user creation', async () => {
  redisMock.enabled = true;
  redisMock.client.get.mockResolvedValue(null);

  await expect(
    createUser(newUser, 'admin-1', { ...currentSession(), authKey: 'auth:old' }),
  ).rejects.toThrow('ADMIN_AUTHORIZATION_CHANGED');
  expect(redisMock.client.get).toHaveBeenCalledWith('auth:old');
  expect(transaction.user.create).not.toHaveBeenCalled();
});

test('a current Redis administrator session still creates a user', async () => {
  redisMock.enabled = true;
  const session = currentSession();
  redisMock.client.get.mockResolvedValue({
    userId: 'admin-1',
    role: 'admin',
    pwd: session.passwordFingerprint,
    sessionGeneration: session.sessionGeneration,
  });
  transaction.user.create.mockResolvedValue({ id: newUser.id });

  await expect(
    createUser(newUser, 'admin-1', { ...session, authKey: 'auth:current' }),
  ).resolves.toEqual({ id: newUser.id });
  expect(redisMock.client.get).toHaveBeenCalledWith('auth:current');
});

test('user deletion requires the locked current administrator check', async () => {
  assertAdmin.mockRejectedValue(new Error('ENTITY_ADMIN_REQUIRED'));

  await expect(deleteUser('user-1', 'admin-1', administratorAuth)).rejects.toThrow(
    'ADMIN_AUTHORIZATION_CHANGED',
  );
  expect(assertAdmin).toHaveBeenCalledWith(transaction, 'admin-1');
  expect(transaction.user.update).not.toHaveBeenCalled();
});
