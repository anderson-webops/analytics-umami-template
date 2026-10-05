import { beforeEach, expect, test, vi } from 'vitest';
import prisma from '@/lib/prisma';
import { deleteSession } from './session';

vi.mock('@/lib/prisma', () => ({
  default: { transaction: vi.fn() },
}));

const transaction = vi.mocked(prisma.transaction);
const websiteId = '00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-000000000002';
const actorUserId = '00000000-0000-4000-8000-000000000003';

function transactionClient() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ team_id: null }]),
    user: { findFirst: vi.fn().mockResolvedValue({ role: 'user' }) },
    website: {
      findFirst: vi.fn().mockResolvedValue({ id: websiteId, userId: actorUserId, teamId: null }),
    },
    teamUser: { findFirst: vi.fn().mockResolvedValue(null) },
    session: {
      findFirst: vi.fn().mockResolvedValue({ id: sessionId }),
      delete: vi.fn().mockResolvedValue({ id: sessionId }),
    },
    websiteEvent: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    sessionReplay: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    sessionReplaySaved: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    eventData: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    heatmapEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    revenue: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    sessionData: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    sessionLink: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
}

beforeEach(() => {
  transaction.mockReset();
});

test('deletes a session only after checking the actor inside a serializable transaction', async () => {
  const client = transactionClient();
  transaction.mockImplementation(async (operation: any, options: any) => {
    expect(options).toMatchObject({ isolationLevel: 'Serializable' });
    return operation(client);
  });

  await expect(deleteSession(websiteId, sessionId, actorUserId)).resolves.toEqual({
    id: sessionId,
  });
  expect(client.user.findFirst).toHaveBeenCalledWith({
    where: { id: actorUserId, deletedAt: null },
    select: { role: true },
  });
  expect(client.website.findFirst).toHaveBeenCalledWith({
    where: { id: websiteId, deletedAt: null },
    select: { id: true, userId: true, teamId: true },
  });
  expect(client.session.findFirst).toHaveBeenCalledWith({
    where: { id: sessionId, websiteId },
    select: { id: true },
  });
  expect(client.user.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
    client.session.findFirst.mock.invocationCallOrder[0],
  );
  expect(client.$queryRaw).toHaveBeenCalledTimes(2);
  expect(client.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
    client.user.findFirst.mock.invocationCallOrder[0],
  );
  expect(client.session.delete).toHaveBeenCalledWith({ where: { id: sessionId } });
});

test('preserves session deletion for a team member with website-delete permission', async () => {
  const client = transactionClient();
  client.website.findFirst.mockResolvedValue({
    id: websiteId,
    userId: null,
    teamId: 'team-1',
  });
  client.teamUser.findFirst.mockResolvedValue({ role: 'team-member' });
  client.$queryRaw
    .mockResolvedValueOnce([{ user_id: actorUserId }])
    .mockResolvedValueOnce([{ team_id: 'team-1' }]);
  transaction.mockImplementation(async (operation: any) => operation(client));

  await expect(deleteSession(websiteId, sessionId, actorUserId)).resolves.toEqual({
    id: sessionId,
  });
  expect(client.teamUser.findFirst).toHaveBeenCalledWith({
    where: {
      teamId: 'team-1',
      userId: actorUserId,
      team: { deletedAt: null },
      user: { deletedAt: null },
    },
    select: { role: true },
  });
  expect(client.$queryRaw).toHaveBeenCalledTimes(4);
  expect(client.session.delete).toHaveBeenCalledOnce();
});

test.each(['removed actor', 'ownership transfer', 'team-role downgrade'])(
  'does not read or delete the session after %s',
  async scenario => {
    const client = transactionClient();

    if (scenario === 'removed actor') {
      client.user.findFirst.mockResolvedValue(null);
    } else if (scenario === 'ownership transfer') {
      client.website.findFirst.mockResolvedValue({
        id: websiteId,
        userId: 'another-user',
        teamId: null,
      });
    } else {
      client.website.findFirst.mockResolvedValue({
        id: websiteId,
        userId: 'another-user',
        teamId: 'team-1',
      });
      client.teamUser.findFirst.mockResolvedValue({ role: 'team-view-only' });
      client.$queryRaw
        .mockResolvedValueOnce([{ user_id: actorUserId }])
        .mockResolvedValueOnce([{ team_id: 'team-1' }]);
    }

    transaction.mockImplementation(async (operation: any) => operation(client));

    await expect(deleteSession(websiteId, sessionId, actorUserId)).rejects.toThrow(
      'ENTITY_ACTOR_NOT_AUTHORIZED',
    );
    expect(client.session.findFirst).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
  },
);

test('keeps a session bound to the requested website', async () => {
  const client = transactionClient();
  client.session.findFirst.mockResolvedValue(null);
  transaction.mockImplementation(async (operation: any) => operation(client));

  await expect(deleteSession(websiteId, sessionId, actorUserId)).resolves.toBeNull();
  expect(client.session.findFirst).toHaveBeenCalledWith({
    where: { id: sessionId, websiteId },
    select: { id: true },
  });
  expect(client.session.delete).not.toHaveBeenCalled();
});
