import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { ENTITY_TYPE, PERMISSIONS, ROLES } from '@/lib/constants';

const transaction = vi.fn();

vi.mock('@/lib/prisma', () => ({
  default: {
    transaction,
  },
}));

const {
  assertActorCanAccessEntities,
  assertActorCanCreateOwnedEntity,
  assertActorCanMutateEntity,
  runAuthorizedAdministratorMutation,
  runSerializable,
  runSerializedUserMutation,
  SERIALIZABLE_RETRY_ATTEMPTS,
} = await import('./authorization');

describe('transactional mutation authorization after role changes', () => {
  const actorId = 'actor-1';
  const entityId = 'website-1';
  const teamId = 'team-1';
  const userFindFirst = vi.fn();
  const websiteFindFirst = vi.fn();
  const teamUserFindFirst = vi.fn();
  const teamUserFindMany = vi.fn();
  const teamFindFirst = vi.fn();
  const client = {
    user: { findFirst: userFindFirst },
    website: { findFirst: websiteFindFirst },
    teamUser: { findFirst: teamUserFindFirst, findMany: teamUserFindMany },
    team: { findFirst: teamFindFirst },
  } as unknown as Prisma.TransactionClient;

  beforeEach(() => {
    vi.clearAllMocks();
    userFindFirst.mockResolvedValue({ role: ROLES.user });
    websiteFindFirst.mockResolvedValue({ id: entityId, userId: actorId, teamId: null });
    teamUserFindFirst.mockResolvedValue({ role: ROLES.teamManager });
    teamUserFindMany.mockResolvedValue([{ teamId, role: ROLES.teamManager }]);
    teamFindFirst.mockResolvedValue({ id: teamId });
  });

  test.each([
    ['owner', { userId: actorId, teamId: null }],
    ['team manager', { userId: 'other-user', teamId }],
  ])('rejects a demoted %s before an entity mutation', async (_, owner) => {
    userFindFirst.mockResolvedValue({ role: ROLES.viewOnly });
    websiteFindFirst.mockResolvedValue({ id: entityId, ...owner });

    await expect(
      assertActorCanMutateEntity(client, actorId, 'website', entityId, PERMISSIONS.websiteUpdate),
    ).rejects.toThrow('ENTITY_ACTOR_NOT_AUTHORIZED');
  });

  test('retains owner, team-manager, and administrator mutations for mutable roles', async () => {
    await expect(
      assertActorCanMutateEntity(client, actorId, 'website', entityId, PERMISSIONS.websiteUpdate),
    ).resolves.toMatchObject({ userId: actorId });

    websiteFindFirst.mockResolvedValue({ id: entityId, userId: 'other-user', teamId });
    await expect(
      assertActorCanMutateEntity(client, actorId, 'website', entityId, PERMISSIONS.websiteUpdate),
    ).resolves.toMatchObject({ teamId });

    userFindFirst.mockResolvedValue({ role: ROLES.admin });
    await expect(
      assertActorCanMutateEntity(client, actorId, 'website', entityId, PERMISSIONS.websiteUpdate),
    ).resolves.toMatchObject({ teamId });
  });

  test('rejects a demoted owner in board and share reference checks', async () => {
    userFindFirst.mockResolvedValue({ role: ROLES.viewOnly });

    await expect(
      assertActorCanAccessEntities(client, actorId, [{ entityType: 'website', entityId }]),
    ).rejects.toThrow('ENTITY_REFERENCE_NOT_AUTHORIZED');
  });

  test('retains reference checks for an ordinary owner', async () => {
    await expect(
      assertActorCanAccessEntities(client, actorId, [{ entityType: 'website', entityId }]),
    ).resolves.toBeUndefined();
  });

  test('rejects a demoted owner even when global create permission is optional', async () => {
    userFindFirst.mockResolvedValue({ role: ROLES.viewOnly });

    await expect(
      assertActorCanCreateOwnedEntity(
        client,
        actorId,
        { userId: actorId },
        {
          requireGlobalCreatePermission: false,
        },
      ),
    ).rejects.toThrow('ENTITY_ACTOR_NOT_AUTHORIZED');
  });

  test('retains optional create permission for an ordinary owner', async () => {
    await expect(
      assertActorCanCreateOwnedEntity(
        client,
        actorId,
        { userId: actorId },
        {
          requireGlobalCreatePermission: false,
        },
      ),
    ).resolves.toBeUndefined();
  });

  test('rejects an unrecognized global role even when the actor owns the entity', async () => {
    userFindFirst.mockResolvedValue({ role: 'team-owner' });

    await expect(
      assertActorCanMutateEntity(client, actorId, 'website', entityId, PERMISSIONS.websiteUpdate),
    ).rejects.toThrow('ENTITY_ACTOR_NOT_AUTHORIZED');
  });
});

describe('share mutation after global role demotion', () => {
  const actorId = 'actor-1';
  const websiteId = 'website-1';
  const shareCreate = vi.fn();
  const userFindFirst = vi.fn();
  const client = {
    user: { findFirst: userFindFirst },
    website: {
      findFirst: vi.fn().mockResolvedValue({ id: websiteId, userId: actorId, teamId: null }),
    },
    share: { create: shareCreate },
  };
  const shareData = {
    id: 'share-1',
    entityId: websiteId,
    shareType: ENTITY_TYPE.website,
    name: 'Example',
    slug: 'example',
    parameters: {},
  } as Prisma.ShareUncheckedCreateInput;

  beforeEach(() => {
    transaction.mockReset();
    transaction.mockImplementation(async callback => callback(client));
    userFindFirst.mockReset();
    userFindFirst.mockResolvedValue({ role: ROLES.user });
    shareCreate.mockReset();
    shareCreate.mockResolvedValue({ id: 'share-1' });
  });

  test('does not write a share after the owner is demoted', async () => {
    const { createShare } = await import('./share');
    userFindFirst.mockResolvedValue({ role: ROLES.viewOnly });

    await expect(createShare(shareData, actorId)).rejects.toThrow('SHARE_ACTOR_NOT_AUTHORIZED');
    expect(shareCreate).not.toHaveBeenCalled();
  });

  test('retains share creation for an ordinary owner', async () => {
    const { createShare } = await import('./share');

    await expect(createShare(shareData, actorId)).resolves.toMatchObject({ id: 'share-1' });
    expect(shareCreate).toHaveBeenCalledOnce();
  });
});

function serializationConflict() {
  return Object.assign(new Error('Transaction write conflict'), { code: 'P2034' });
}

function adapterSerializationConflict() {
  return Object.assign(new Error('Transaction write conflict'), {
    name: 'DriverAdapterError',
    cause: {
      originalCode: '40001',
      originalMessage: 'could not serialize access due to read/write dependencies',
      kind: 'TransactionWriteConflict',
    },
  });
}

function rawQuerySerializationConflict() {
  return Object.assign(new Error('Raw query serialization conflict'), {
    code: 'P2010',
    meta: {
      driverAdapterError: {
        cause: {
          originalCode: '40001',
          kind: 'TransactionWriteConflict',
        },
      },
    },
  });
}

describe('runSerializable', () => {
  beforeEach(() => {
    transaction.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('backs off and retries a serialization conflict', async () => {
    transaction.mockRejectedValueOnce(serializationConflict()).mockResolvedValueOnce('ok');

    const result = runSerializable(async () => 'unused');

    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  test('retries a PostgreSQL adapter serialization conflict', async () => {
    transaction.mockRejectedValueOnce(adapterSerializationConflict()).mockResolvedValueOnce('ok');

    const result = runSerializable(async () => 'unused');

    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  test('retries a nested PostgreSQL raw-query serialization conflict', async () => {
    transaction.mockRejectedValueOnce(rawQuerySerializationConflict()).mockResolvedValueOnce('ok');

    const result = runSerializable(async () => 'unused');

    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  test('does not retry a non-serialization failure', async () => {
    const failure = new Error('Database unavailable');
    transaction.mockRejectedValueOnce(failure);

    await expect(runSerializable(async () => 'unused')).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('stops after the bounded retry limit', async () => {
    const conflict = serializationConflict();
    transaction.mockRejectedValue(conflict);

    const result = runSerializable(async () => 'unused');
    const assertion = expect(result).rejects.toBe(conflict);

    await vi.runAllTimersAsync();
    await assertion;

    expect(transaction).toHaveBeenCalledTimes(SERIALIZABLE_RETRY_ATTEMPTS);
  });
});

describe('runSerializedUserMutation', () => {
  beforeEach(() => {
    transaction.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('takes the transaction-scoped user lock before running the mutation', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ pg_advisory_xact_lock: '' }]);
    const operation = vi.fn().mockResolvedValue('ok');

    transaction.mockImplementationOnce(
      async (
        callback: (client: { $queryRaw: typeof queryRaw }) => Promise<unknown>,
        options: unknown,
      ) => {
        expect(options).toEqual({ isolationLevel: 'Serializable', timeout: 45_000 });

        return callback({ $queryRaw: queryRaw });
      },
    );

    await expect(runSerializedUserMutation(operation, { timeout: 45_000 })).resolves.toBe('ok');
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      operation.mock.invocationCallOrder[0],
    );
  });

  test('retries ownership races without skipping the user-mutation lock', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ pg_advisory_xact_lock: '' }]);
    const operation = vi.fn().mockResolvedValue('ok');

    transaction
      .mockRejectedValueOnce(serializationConflict())
      .mockImplementationOnce(async callback => callback({ $queryRaw: queryRaw }));

    const result = runSerializedUserMutation(operation);

    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledOnce();
  });
});

describe('runAuthorizedAdministratorMutation', () => {
  beforeEach(() => {
    transaction.mockReset();
  });

  test('rechecks the current administrator after taking the user-mutation lock', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ allowed: 1 }]);
    const operation = vi.fn().mockResolvedValue('updated');
    transaction.mockImplementation(async callback => callback({ $queryRaw: queryRaw }));

    await expect(runAuthorizedAdministratorMutation('admin-1', operation)).resolves.toBe('updated');
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(queryRaw.mock.calls[1][0].join('')).toContain('FOR UPDATE');
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(queryRaw.mock.invocationCallOrder[1]);
    expect(queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      operation.mock.invocationCallOrder[0],
    );
  });

  test('does not run the mutation after administrator demotion', async () => {
    const operation = vi.fn();
    transaction.mockImplementation(async callback =>
      callback({
        $queryRaw: vi.fn().mockResolvedValue([]),
      }),
    );

    await expect(runAuthorizedAdministratorMutation('admin-1', operation)).rejects.toThrow(
      'ENTITY_ADMIN_REQUIRED',
    );
    expect(operation).not.toHaveBeenCalled();
  });

  test('rejects a missing actor identifier before querying an administrator', async () => {
    const operation = vi.fn();
    const queryRaw = vi.fn().mockResolvedValue([]);
    transaction.mockImplementation(async callback => callback({ $queryRaw: queryRaw }));

    await expect(runAuthorizedAdministratorMutation('', operation)).rejects.toThrow(
      'ENTITY_ADMIN_REQUIRED',
    );
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(operation).not.toHaveBeenCalled();
  });
});
