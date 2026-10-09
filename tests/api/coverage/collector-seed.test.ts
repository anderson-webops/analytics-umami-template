import { describe, expect, test, vi } from 'vitest';
import type { ApiClient } from '../client';
import { CACHE_HEADER } from '../helpers/constants';
import type { Dataset } from '../seed/dataset';
import { ingestDataset } from '../seed/ingest';
import { getRecordedReplayIdentity } from '../seed/setup';

describe('collector seed identity', () => {
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
        : { status: 200, body: { ok: true }, text: '' },
    );
    const dataset = {
      visits: [],
      batch: [],
      replay: {
        pageview: { type: 'event', payload: { website: 'site-id' } },
        record: { type: 'record', payload: { website: 'site-id', events: [] } },
        heatmap: { type: 'heatmap', payload: { website: 'site-id', events: [] } },
      },
      realtime: [],
    } as Dataset;

    await expect(ingestDataset({ post } as unknown as ApiClient, dataset)).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls[1][2]).toEqual({ headers: { [CACHE_HEADER]: cache } });
    expect(post.mock.calls[2][2]).toEqual({ headers: { [CACHE_HEADER]: cache } });
  });
});
