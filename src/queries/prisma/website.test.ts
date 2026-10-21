import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ENTITY_TYPE } from '@/lib/constants';
import {
  createWebsite,
  deleteWebsite,
  resetWebsite,
  transferWebsiteByActor,
  updateWebsite,
} from './website';

const actorAuth = {
  authType: 'session' as const,
  user: { id: 'actor-1', username: 'actor', role: 'user', isAdmin: false },
};

const { transactionMock, redisDelMock, redisSetMock } = vi.hoisted(() => ({
  transactionMock: vi.fn(),
  redisDelMock: vi.fn(),
  redisSetMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    transaction: transactionMock,
  },
  getSchema: () => new URL(process.env.DATABASE_URL || '').searchParams.get('schema'),
}));

vi.mock('@/lib/redis', () => ({
  default: {
    client: {
      del: redisDelMock,
      set: redisSetMock,
    },
  },
}));

vi.mock('./authorization', async importOriginal => ({
  ...(await importOriginal<typeof import('./authorization')>()),
  assertCurrentActorAuth: vi.fn(),
  assertActorCanCreateOwnedEntity: vi.fn(),
  assertEntityIdAvailable: vi.fn(),
}));

test.each([
  [[], 0],
  [[{ nextGeneration: 2 }], 2],
])('website creation uses durable deleted-ID generation %s', async (tombstones, generation) => {
  const create = vi.fn(async ({ data }) => data);
  const query = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(tombstones);
  transactionMock.mockImplementation(async callback =>
    callback({ $queryRaw: query, website: { create } }),
  );

  const data = { id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic', userId: 'actor-1' };
  const result = await createWebsite(data, 'actor-1', { auth: actorAuth });

  expect(result.website).toMatchObject({ ...data, collectionGeneration: generation });
  expect(create).toHaveBeenCalledWith({
    data: { ...data, collectionGeneration: generation },
  });
  expect(query).toHaveBeenCalledTimes(2);
});

test('domain changes permanently revoke the prior collection generation', async () => {
  const storedWebsite = {
    id: 'website-1',
    userId: 'actor-1',
    teamId: null,
    domain: 'example.com',
    collectionGeneration: 0,
  };
  const update = vi.fn(async ({ data }) => {
    if (data.domain !== undefined) {
      storedWebsite.domain = data.domain;
    }
    if (data.collectionGeneration) {
      storedWebsite.collectionGeneration += data.collectionGeneration.increment;
    }
    return { ...storedWebsite };
  });
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findFirst: vi.fn().mockResolvedValue({ role: 'user' }) },
    website: {
      findFirst: vi.fn(async () => storedWebsite),
      findUnique: vi.fn(async () => storedWebsite),
      update,
    },
    share: { findMany: vi.fn().mockResolvedValue([]) },
  };
  transactionMock.mockImplementation(async callback => callback(transaction));

  await updateWebsite('website-1', { domain: 'other.example.com' }, 'actor-1', {
    auth: actorAuth,
  });
  expect(storedWebsite.collectionGeneration).toBe(1);

  await updateWebsite('website-1', { domain: 'example.com' }, 'actor-1', { auth: actorAuth });
  expect(storedWebsite.collectionGeneration).toBe(2);

  await updateWebsite('website-1', { domain: 'example.com' }, 'actor-1', { auth: actorAuth });
  await updateWebsite('website-1', { name: 'Renamed' }, 'actor-1', { auth: actorAuth });
  expect(storedWebsite.collectionGeneration).toBe(2);
  expect(update.mock.calls.map(([{ data }]) => data.collectionGeneration)).toEqual([
    { increment: 1 },
    { increment: 1 },
    undefined,
    undefined,
  ]);
  expect(transaction.website.findUnique).toHaveBeenCalledTimes(3);
});

test('clearing a site permit endpoint removes it from merged recorder settings', async () => {
  const storedWebsite = {
    id: 'website-1',
    userId: 'actor-1',
    teamId: null,
    domain: 'example.com',
    replayConfig: {
      replayEnabled: true,
      maskLevel: 'strict',
      permitEndpoint: '/analytics-permit',
    },
  };
  const update = vi.fn(async ({ data }) => ({ ...storedWebsite, ...data }));
  transactionMock.mockImplementation(async callback =>
    callback({
      $queryRaw: vi.fn().mockResolvedValue([]),
      user: { findFirst: vi.fn().mockResolvedValue({ role: 'user' }) },
      website: {
        findFirst: vi.fn(async () => storedWebsite),
        findUnique: vi.fn(async () => storedWebsite),
        update,
      },
      share: { findMany: vi.fn().mockResolvedValue([]) },
    }),
  );

  const result = await updateWebsite('website-1', {}, 'actor-1', {
    auth: actorAuth,
    replayConfig: { permitEndpoint: null },
  });

  expect(update).toHaveBeenCalledWith({
    where: { id: 'website-1' },
    data: {
      replayConfig: { replayEnabled: true, maskLevel: 'strict' },
      recorderEnabled: true,
    },
  });
  expect(result.website.replayConfig).not.toHaveProperty('permitEndpoint');
});

function createDeleteTx(calls: string[]) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn(async () => {
      calls.push('collectionTombstone');
    }),
    user: {
      findFirst: vi.fn(async () => ({ role: 'admin' })),
    },
    sessionReplaySaved: {
      deleteMany: vi.fn(async () => {
        calls.push('sessionReplaySaved');
      }),
    },
    sessionReplay: {
      deleteMany: vi.fn(async () => {
        calls.push('sessionReplay');
      }),
    },
    heatmapEvent: {
      deleteMany: vi.fn(async () => {
        calls.push('heatmapEvent');
      }),
    },
    revenue: {
      deleteMany: vi.fn(async () => {
        calls.push('revenue');
      }),
    },
    attestedRevenueMovement: {
      deleteMany: vi.fn(async () => {
        calls.push('attestedRevenueMovement');
      }),
    },
    eventData: {
      deleteMany: vi.fn(async () => {
        calls.push('eventData');
      }),
    },
    $executeRawUnsafe: vi.fn(async () => {
      calls.push('rawSql');
    }),
    sessionData: {
      deleteMany: vi.fn(async () => {
        calls.push('sessionData');
      }),
    },
    sessionLink: {
      deleteMany: vi.fn(async () => {
        calls.push('sessionLink');
      }),
    },
    websiteEvent: {
      deleteMany: vi.fn(async () => {
        calls.push('websiteEvent');
      }),
    },
    session: {
      deleteMany: vi.fn(async () => {
        calls.push('session');
      }),
    },
    report: {
      deleteMany: vi.fn(async () => {
        calls.push('report');
      }),
    },
    segment: {
      deleteMany: vi.fn(async () => {
        calls.push('segment');
      }),
    },
    annotation: {
      deleteMany: vi.fn(async () => {
        calls.push('annotation');
      }),
    },
    share: {
      deleteMany: vi.fn(async () => {
        calls.push('share');
      }),
    },
    website: {
      findFirst: vi.fn(async () => ({ id: 'website-1', userId: 'actor-1', teamId: null })),
      delete: vi.fn(async () => {
        calls.push('websiteDelete');
        return { id: 'website-1', collectionGeneration: 0 };
      }),
      update: vi.fn(async () => {
        calls.push('websiteUpdate');
        return { id: 'website-1' };
      }),
    },
  };
}

describe('website delete dependencies', () => {
  beforeEach(() => {
    vi.stubEnv('CLICKHOUSE_HISTORY_ATTESTED_CLEAN', 'true');
    transactionMock.mockReset();
    redisDelMock.mockReset();
    redisSetMock.mockReset();
    delete process.env.CLOUD_MODE;
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/umami?schema=public';
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('reset refuses to remove relational rows without protected history attestation', async () => {
    delete process.env.CLICKHOUSE_HISTORY_ATTESTED_CLEAN;
    const calls: string[] = [];
    const tx = createDeleteTx(calls);
    transactionMock.mockImplementation(async callback => callback(tx));

    await expect(resetWebsite('website-1', 'actor-1', actorAuth)).rejects.toThrow(
      'CLICKHOUSE_HISTORY_REVIEW_REQUIRED',
    );
    expect(calls).toEqual([]);
  });

  test('deleteWebsite runs fast event-data cleanup, a relational safety pass, and heatmap cleanup before deleting website events', async () => {
    const calls: string[] = [];
    const tx = createDeleteTx(calls);

    transactionMock.mockImplementation(async callback => callback(tx));

    await deleteWebsite('website-1', 'actor-1', actorAuth);

    expect(tx.eventData.deleteMany).toHaveBeenCalledWith({
      where: { websiteId: 'website-1' },
    });
    expect(tx.heatmapEvent.deleteMany).toHaveBeenCalledWith({
      where: { websiteId: 'website-1' },
    });
    expect(tx.attestedRevenueMovement.deleteMany).toHaveBeenCalledWith({
      where: { websiteId: 'website-1' },
    });
    expect(tx.$executeRawUnsafe).toHaveBeenNthCalledWith(1, 'SET search_path TO "public";');
    expect(tx.$executeRawUnsafe).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('delete from event_data'),
      'website-1',
    );
    expect(tx.$executeRawUnsafe).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('website_event.website_id = $1'),
      'website-1',
    );
    expect(calls).toEqual([
      'sessionReplaySaved',
      'sessionReplay',
      'heatmapEvent',
      'revenue',
      'attestedRevenueMovement',
      'eventData',
      'rawSql',
      'rawSql',
      'sessionData',
      'sessionLink',
      'websiteEvent',
      'session',
      'report',
      'segment',
      'annotation',
      'share',
      'websiteDelete',
      'collectionTombstone',
    ]);
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
  });

  test('resetWebsite uses the same two-pass event-data cleanup before resetting the website', async () => {
    const calls: string[] = [];
    const tx = createDeleteTx(calls);

    transactionMock.mockImplementation(async callback => callback(tx));

    await resetWebsite('website-1', 'actor-1', actorAuth);

    expect(tx.eventData.deleteMany).toHaveBeenCalledWith({
      where: { websiteId: 'website-1' },
    });
    expect(tx.heatmapEvent.deleteMany).toHaveBeenCalledWith({
      where: { websiteId: 'website-1' },
    });
    expect(tx.attestedRevenueMovement.deleteMany).toHaveBeenCalledWith({
      where: { websiteId: 'website-1' },
    });
    expect(tx.$executeRawUnsafe).toHaveBeenNthCalledWith(1, 'SET search_path TO "public";');
    expect(tx.$executeRawUnsafe).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('website_event.website_id = $1'),
      'website-1',
    );
    expect(tx.website.update).toHaveBeenCalledWith({
      where: { id: 'website-1' },
      data: {
        resetAt: expect.any(Date),
        collectionGeneration: { increment: 1 },
      },
    });
    expect(calls).toEqual([
      'sessionReplaySaved',
      'sessionReplay',
      'heatmapEvent',
      'revenue',
      'attestedRevenueMovement',
      'eventData',
      'rawSql',
      'rawSql',
      'sessionData',
      'sessionLink',
      'websiteEvent',
      'session',
      'websiteUpdate',
    ]);
  });
});

describe('website transfer authorization after role changes', () => {
  beforeEach(() => {
    transactionMock.mockReset();
    redisDelMock.mockReset();
  });

  test('a demoted team owner cannot transfer a team website', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'website-1' });
    const deleteShares = vi.fn();
    const actorLookup = vi
      .fn()
      .mockResolvedValueOnce({ role: 'view-only' })
      .mockResolvedValueOnce({ id: 'actor-1' });
    transactionMock.mockImplementation(async callback =>
      callback({
        $queryRaw: vi.fn().mockResolvedValue([]),
        user: { findFirst: actorLookup },
        website: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'website-1',
            userId: null,
            teamId: 'team-1',
          }),
          update,
        },
        share: { deleteMany: deleteShares },
        teamUser: { findFirst: vi.fn().mockResolvedValue({ role: 'team-owner' }) },
      }),
    );

    await expect(
      transferWebsiteByActor('website-1', { userId: 'actor-1' }, 'actor-1', actorAuth),
    ).rejects.toThrow('WEBSITE_TRANSFER_NOT_AUTHORIZED');
    expect(update).not.toHaveBeenCalled();
    expect(deleteShares).not.toHaveBeenCalled();
  });

  test('an ordinary team owner can still transfer a team website to self', async () => {
    const calls: string[] = [];
    const update = vi.fn(async () => {
      calls.push('websiteUpdate');
      return { id: 'website-1', userId: 'actor-1' };
    });
    const deleteShares = vi.fn(async () => {
      calls.push('shareDelete');
      return { count: 1 };
    });
    transactionMock.mockImplementation(async callback =>
      callback({
        $queryRaw: vi.fn().mockResolvedValue([]),
        user: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce({ role: 'user' })
            .mockResolvedValueOnce({ id: 'actor-1' }),
        },
        website: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'website-1',
            userId: null,
            teamId: 'team-1',
          }),
          update,
        },
        share: { deleteMany: deleteShares },
        teamUser: { findFirst: vi.fn().mockResolvedValue({ role: 'team-owner' }) },
      }),
    );

    await expect(
      transferWebsiteByActor('website-1', { userId: 'actor-1' }, 'actor-1', actorAuth),
    ).resolves.toMatchObject({ userId: 'actor-1' });
    expect(update).toHaveBeenCalledOnce();
    expect(deleteShares).toHaveBeenCalledWith({
      where: { entityId: 'website-1', shareType: ENTITY_TYPE.website },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'website-1' },
      data: { userId: 'actor-1', teamId: null, collectionGeneration: { increment: 1 } },
    });
    expect(calls).toEqual(['shareDelete', 'websiteUpdate']);
  });

  test('moving a personal website into a team revokes only direct website shares', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'website-1', teamId: 'team-2' });
    const deleteShares = vi.fn().mockResolvedValue({ count: 2 });
    transactionMock.mockImplementation(async callback =>
      callback({
        $queryRaw: vi.fn().mockResolvedValue([]),
        user: { findFirst: vi.fn().mockResolvedValue({ role: 'user' }) },
        website: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'website-1',
            userId: 'actor-1',
            teamId: null,
          }),
          update,
        },
        team: { findFirst: vi.fn().mockResolvedValue({ id: 'team-2' }) },
        teamUser: { findFirst: vi.fn().mockResolvedValue({ role: 'team-manager' }) },
        share: { deleteMany: deleteShares },
      }),
    );

    await expect(
      transferWebsiteByActor('website-1', { teamId: 'team-2' }, 'actor-1', actorAuth),
    ).resolves.toMatchObject({ teamId: 'team-2' });
    expect(deleteShares).toHaveBeenCalledWith({
      where: { entityId: 'website-1', shareType: ENTITY_TYPE.website },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'website-1' },
      data: { userId: null, teamId: 'team-2', collectionGeneration: { increment: 1 } },
    });
  });

  test('a no-op transfer to the current owner preserves existing shares', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'website-1', userId: 'actor-1' });
    const deleteShares = vi.fn();
    transactionMock.mockImplementation(async callback =>
      callback({
        $queryRaw: vi.fn().mockResolvedValue([]),
        user: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce({ role: 'admin' })
            .mockResolvedValueOnce({ id: 'actor-1' }),
        },
        website: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'website-1',
            userId: 'actor-1',
            teamId: null,
          }),
          update,
        },
        share: { deleteMany: deleteShares },
      }),
    );

    await expect(
      transferWebsiteByActor('website-1', { userId: 'actor-1' }, 'actor-1', actorAuth),
    ).resolves.toMatchObject({ userId: 'actor-1' });
    expect(deleteShares).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({
      where: { id: 'website-1' },
      data: { userId: 'actor-1', teamId: null },
    });
  });

  test('a failed share revocation prevents the ownership update', async () => {
    const update = vi.fn();
    const deleteShares = vi.fn().mockRejectedValue(new Error('SHARE_DELETE_FAILED'));
    transactionMock.mockImplementation(async callback =>
      callback({
        $queryRaw: vi.fn().mockResolvedValue([]),
        user: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce({ role: 'admin' })
            .mockResolvedValueOnce({ id: 'destination' }),
        },
        website: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'website-1',
            userId: 'actor-1',
            teamId: null,
          }),
          update,
        },
        share: { deleteMany: deleteShares },
      }),
    );

    await expect(
      transferWebsiteByActor('website-1', { userId: 'destination' }, 'actor-1', actorAuth),
    ).rejects.toThrow('SHARE_DELETE_FAILED');
    expect(update).not.toHaveBeenCalled();
    expect(redisDelMock).not.toHaveBeenCalled();
  });
});
