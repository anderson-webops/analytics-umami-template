import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ENTITY_TYPE } from '@/lib/constants';
import { deleteWebsite, resetWebsite, transferWebsiteByActor } from './website';

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
}));

function createDeleteTx(calls: string[]) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
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
        return { id: 'website-1' };
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
    transactionMock.mockReset();
    redisDelMock.mockReset();
    redisSetMock.mockReset();
    delete process.env.CLOUD_MODE;
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/umami?schema=public';
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
    ]);
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
    expect(tx.$executeRawUnsafe).toHaveBeenNthCalledWith(1, 'SET search_path TO "public";');
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
      data: { userId: null, teamId: 'team-2' },
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
