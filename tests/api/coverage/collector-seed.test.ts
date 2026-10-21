import { describe, expect, test, vi } from 'vitest';
import type { ApiClient } from '../client';
import { CACHE_HEADER } from '../helpers/constants';
import { getTestCollectionCredential } from '../seed/collection-keys';
import { buildDataset, type Dataset } from '../seed/dataset';
import { buildHistoricalRevenueFixture } from '../seed/historical-revenue';
import { SEED_IDS } from '../seed/ids';
import { ingestDataset } from '../seed/ingest';
import { getRecordedReplayIdentity } from '../seed/setup';

describe('collector seed identity', () => {
  test('public pageviews never claim a verified identity', () => {
    const dataset = buildDataset();
    const pageviews = [
      ...dataset.visits.flatMap(visit => visit.events),
      dataset.replay.pageview,
      ...dataset.realtime,
    ];

    expect(pageviews.length).toBeGreaterThan(0);
    expect(pageviews.every(event => event.type === 'event' && event.payload.id === undefined)).toBe(
      true,
    );
    expect(dataset.batch.some(event => event.type === 'identify')).toBe(true);
  });

  test('gets replay identifiers only from one authenticated replay row', () => {
    const replay = {
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
    };

    expect(getRecordedReplayIdentity([replay])).toEqual({
      visitId: replay.id,
      sessionId: replay.sessionId,
    });
    expect(getRecordedReplayIdentity([])).toBeUndefined();
    expect(getRecordedReplayIdentity([replay, replay])).toBeUndefined();
    expect(getRecordedReplayIdentity([{ id: replay.id }])).toBeUndefined();
    expect(getRecordedReplayIdentity([{ ...replay, sessionId: '' }])).toBeUndefined();
  });

  test('records a replay with an opaque collector response', async () => {
    const cache = 'c1.synthetic-token';
    const post = vi.fn(async (path: string, _body: unknown, _options?: unknown) =>
      path === '/api/send'
        ? { status: 200, body: { cache }, text: '' }
        : path === '/api/collection-permit'
          ? { status: 200, body: { permit: 'synthetic-permit' }, text: '' }
          : { status: 200, body: { ok: true }, text: '' },
    );
    const dataset = {
      visits: [],
      batch: [],
      legacyRevenue: [],
      replay: {
        pageview: {
          type: 'event',
          payload: { website: SEED_IDS.website, hostname: 'example.test' },
        },
        record: { type: 'record', payload: { website: SEED_IDS.website, events: [] } },
        heatmap: { type: 'heatmap', payload: { website: SEED_IDS.website, events: [] } },
      },
      realtime: [],
    } as Dataset;

    await expect(ingestDataset({ post } as unknown as ApiClient, dataset)).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledTimes(5);
    expect(post.mock.calls[1][0]).toBe('/api/collection-permit');
    expect(post.mock.calls[1][2]).toMatchObject({
      headers: {
        authorization: `Bearer ${getTestCollectionCredential(SEED_IDS.website)}`,
        'x-umami-request-id': expect.any(String),
        'x-umami-request-timestamp': expect.any(String),
        [CACHE_HEADER]: cache,
      },
    });
    expect(post.mock.calls[2][2]).toEqual({
      headers: {
        [CACHE_HEADER]: cache,
        'x-umami-permit': 'synthetic-permit',
        origin: 'https://example.test',
      },
    });
    expect(post.mock.calls[3][1]).toMatchObject({ feature: 'heatmap', consent: true });
  });

  test('batches advanced fixtures by website and never sends historical revenue', async () => {
    const post = vi.fn(async (path: string) => {
      if (path === '/api/send') {
        return { status: 200, body: { cache: 'c1.synthetic-token' }, text: '' };
      }

      if (path === '/api/collection-permit') {
        return { status: 200, body: { permit: 'synthetic-permit' }, text: '' };
      }

      return path === '/api/batch'
        ? { status: 200, body: { errors: 0 }, text: '' }
        : { status: 200, body: { ok: true }, text: '' };
    });
    const dataset = buildDataset();
    dataset.batch.push({
      type: 'event',
      payload: {
        website: SEED_IDS.website2,
        hostname: 'user.example.test',
        url: '/',
        name: 'download',
        data: { file: 'test-guide.pdf' },
      },
    });

    await expect(ingestDataset({ post } as unknown as ApiClient, dataset)).rejects.toThrow(
      'Historical revenue fixtures must be seeded outside the public collector.',
    );
    expect(post).not.toHaveBeenCalled();

    await ingestDataset({ post } as unknown as ApiClient, { ...dataset, legacyRevenue: [] });

    const batches = post.mock.calls.filter(call => call[0] === '/api/batch');
    const authorized = batches.filter(call => call[2]?.headers?.authorization);
    const publicBatches = batches.filter(call => !call[2]?.headers?.authorization);

    expect(authorized).toHaveLength(3);
    expect(new Set(authorized.map(call => call[2]?.headers?.['x-umami-request-id'])).size).toBe(
      authorized.length,
    );
    expect(
      authorized.every(call => /^\d{10}$/.test(call[2]?.headers?.['x-umami-request-timestamp'])),
    ).toBe(true);
    expect(
      authorized.filter(
        call =>
          call[2]?.headers?.authorization ===
          `Bearer ${getTestCollectionCredential(SEED_IDS.website)}`,
      ),
    ).toHaveLength(2);
    expect(
      authorized.filter(
        call =>
          call[2]?.headers?.authorization ===
          `Bearer ${getTestCollectionCredential(SEED_IDS.website2)}`,
      ),
    ).toHaveLength(1);
    expect(publicBatches.length).toBeGreaterThan(0);
    expect(authorized.flatMap(call => call[1]).some(event => event.type === 'identify')).toBe(true);
    expect(
      batches.flatMap(call => call[1]).some(event => event.payload.data?.revenue !== undefined),
    ).toBe(false);
  });

  test('separates historical revenue rows from authorized purchase properties', () => {
    const dataset = buildDataset();
    const fixture = buildHistoricalRevenueFixture(dataset);
    const primary = fixture.revenue.filter(row => row.websiteId === SEED_IDS.website);
    const secondary = fixture.revenue.filter(row => row.websiteId === SEED_IDS.website2);
    const purchases = dataset.batch.filter(event => event.payload.name === 'purchase');

    expect(fixture.sessions).toHaveLength(4);
    expect(primary).toHaveLength(9);
    expect(secondary).toHaveLength(1);
    expect(purchases).toHaveLength(10);
    expect(purchases.every(event => event.payload.data?.revenue === undefined)).toBe(true);
    expect(new Set(primary.map(row => row.sessionId)).size).toBe(3);
    expect(primary.reduce((sum, row) => sum + row.revenue, 0)).toBeCloseTo(535.5, 5);
    expect(new Set(fixture.sessions.map(session => session.referrerDomain))).toEqual(
      new Set(['google.com', 't.co', null]),
    );
    expect(
      fixture.revenue.every(row =>
        fixture.sessions.some(
          session => session.websiteId === row.websiteId && session.sessionId === row.sessionId,
        ),
      ),
    ).toBe(true);
    expect(fixture.sessions.every(session => session.createdAt < dataset.range.endAt)).toBe(true);
  });
});
