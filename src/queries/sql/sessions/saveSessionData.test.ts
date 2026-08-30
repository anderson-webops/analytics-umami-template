import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DATA_TYPE } from '@/lib/constants';
import { relationalQuery } from './saveSessionData';

const { upsertMock } = vi.hoisted(() => ({
  upsertMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      sessionData: {
        upsert: upsertMock,
      },
    },
  },
}));

describe('relationalQuery', () => {
  beforeEach(() => {
    upsertMock.mockReset();
    upsertMock.mockResolvedValue(undefined);
  });

  test('writes session data with a Prisma upsert keyed by sessionId and dataKey', async () => {
    const createdAt = new Date('2026-07-30T10:00:00.000Z');

    await relationalQuery({
      websiteId: 'website-1',
      sessionId: 'session-1',
      sessionData: { plan: 'pro' },
      distinctId: 'distinct-1',
      createdAt,
    });

    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledWith({
      where: {
        sessionId_dataKey: {
          sessionId: 'session-1',
          dataKey: 'plan',
        },
      },
      create: {
        id: expect.any(String),
        websiteId: 'website-1',
        sessionId: 'session-1',
        dataKey: 'plan',
        stringValue: 'pro',
        numberValue: null,
        dateValue: null,
        dataType: DATA_TYPE.string,
        distinctId: 'distinct-1',
        createdAt,
      },
      update: {
        websiteId: 'website-1',
        stringValue: 'pro',
        numberValue: null,
        dateValue: null,
        dataType: DATA_TYPE.string,
        distinctId: 'distinct-1',
        createdAt,
      },
    });
  });

  test('preserves default and existing createdAt behavior when createdAt is omitted', async () => {
    await relationalQuery({
      websiteId: 'website-1',
      sessionId: 'session-1',
      sessionData: { plan: 'pro' },
      distinctId: 'distinct-1',
    });

    const [{ create, update }] = upsertMock.mock.calls[0];

    expect(create.createdAt).toBeUndefined();
    expect(update.createdAt).toBeUndefined();
  });
});
