import { beforeEach, expect, test, vi } from 'vitest';
import { hasCurrentSessionGeneration } from '@/lib/session-generation';
import { updateUser } from './user';

const { state, transaction, runSerialized, runRevocation, assertAdmin } = vi.hoisted(() => {
  const state = { role: 'user', sessionGeneration: 0 };
  const transaction = {
    user: {
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    apiKey: { deleteMany: vi.fn() },
  };

  return {
    state,
    transaction,
    runSerialized: vi.fn(),
    runRevocation: vi.fn(),
    assertAdmin: vi.fn(),
  };
});

vi.mock('@/lib/prisma', () => ({ default: { client: {} } }));
vi.mock('./authorization', () => ({
  assertActorIsAdministrator: assertAdmin,
  runSerializedUserMutation: runSerialized,
  runCredentialRevocationMutation: runRevocation,
}));

beforeEach(() => {
  state.role = 'user';
  state.sessionGeneration = 0;
  transaction.user.findUnique.mockReset().mockImplementation(async () => ({
    role: state.role,
    deletedAt: null,
  }));
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
});

test('a role round trip cannot resurrect an earlier session with the same role', async () => {
  await updateUser('user-1', { role: 'admin' }, 'admin-1');
  expect(state).toEqual({ role: 'admin', sessionGeneration: 1 });
  expect(hasCurrentSessionGeneration(0, state.sessionGeneration)).toBe(false);

  await updateUser('user-1', { role: 'user' }, 'admin-1');
  expect(state).toEqual({ role: 'user', sessionGeneration: 2 });
  expect(hasCurrentSessionGeneration(0, state.sessionGeneration)).toBe(false);
  expect(hasCurrentSessionGeneration(1, state.sessionGeneration)).toBe(false);
  expect(transaction.apiKey.deleteMany).not.toHaveBeenCalled();
});

test('a same-role update preserves current sessions', async () => {
  await updateUser('user-1', { role: 'user', username: 'renamed' }, 'admin-1');

  expect(state.sessionGeneration).toBe(0);
  expect(transaction.user.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: { role: 'user', username: 'renamed' } }),
  );
});

test('Prisma set-form role transitions also revoke earlier sessions', async () => {
  await updateUser('user-1', { role: { set: 'admin' } }, 'admin-1');

  expect(state).toEqual({ role: 'admin', sessionGeneration: 1 });
});

test('combined role and password changes increment once and revoke API keys', async () => {
  await updateUser('user-1', { role: 'admin', password: 'new-hash' }, 'admin-1');

  expect(state).toEqual({ role: 'admin', sessionGeneration: 1 });
  expect(runRevocation).toHaveBeenCalledOnce();
  expect(transaction.apiKey.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
});

test('the last active administrator cannot be demoted', async () => {
  state.role = 'admin';
  transaction.user.count.mockResolvedValue(1);

  await expect(updateUser('user-1', { role: 'user' }, 'admin-1')).rejects.toThrow(
    'LAST_ACTIVE_ADMIN',
  );
  expect(transaction.user.update).not.toHaveBeenCalled();
});
