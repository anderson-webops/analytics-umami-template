import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CollectionBudgetExceededError,
  reserveCollectionClientBudget,
} from '@/lib/collection-budget';
import { getCollectionClientKeys } from '@/lib/collection-client-key';
import { hasCollectionPermit } from '@/lib/collection-permit';
import {
  getCollectionIpLimit,
  getCollectionSourceStatus,
  reserveCollectionSourceLimit,
} from '@/lib/collection-rate-limit';
import { hash } from '@/lib/crypto';
import { getClientInfo, hasBlockedIp } from '@/lib/detect';
import { HeatmapBudgetExceededError, reserveHeatmapBudget } from '@/lib/heatmap-budget';
import { parseToken } from '@/lib/jwt';
import {
  getReplayChargedBytes,
  markAcknowledgedReplayChunk,
  markUnstoredReplayChunkRetryable,
  ReplayWritePendingError,
  reserveReplayBudget,
} from '@/lib/replay-budget';
import { parseRequest } from '@/lib/request';
import { getWebsite, withActiveCollectionSource } from '@/queries/prisma';
import { saveReassembledRecordingFragments, saveRecording } from '@/queries/sql';
import { saveHeatmapEvents } from '@/queries/sql/heatmap/saveHeatmapEvents';
import { OPTIONS, POST } from './route';

const clickhouseState = vi.hoisted(() => ({ enabled: false }));

vi.mock('@/lib/clickhouse', () => ({
  default: {
    get enabled() {
      return clickhouseState.enabled;
    },
  },
}));

vi.mock('@/lib/collection-budget', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/collection-budget')>()),
  reserveCollectionClientBudget: vi.fn(),
}));

vi.mock('@/lib/collection-permit', () => ({ hasCollectionPermit: vi.fn(() => true) }));

vi.mock('@/lib/collection-rate-limit', () => ({
  getCollectionIpLimit: vi.fn(),
  getCollectionSourceStatus: vi.fn(),
  reserveCollectionSourceLimit: vi.fn(),
}));

vi.mock('@/lib/detect', () => ({
  getClientInfo: vi.fn(),
  hasBlockedIp: vi.fn(),
}));

vi.mock('@/lib/jwt', () => ({
  parseToken: vi.fn(),
}));

vi.mock('@/lib/heatmap-budget', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/heatmap-budget')>()),
  reserveHeatmapBudget: vi.fn(),
}));

vi.mock('@/lib/replay-budget', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/replay-budget')>()),
  markAcknowledgedReplayChunk: vi.fn(),
  markUnstoredReplayChunkRetryable: vi.fn(),
  reserveReplayBudget: vi.fn(),
}));

vi.mock('@/lib/request', () => ({
  parseRequest: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: { client: {} } }));

vi.mock('@/queries/prisma', () => ({
  getWebsite: vi.fn(),
  withActiveCollectionSource: vi.fn(),
}));

vi.mock('@/queries/sql', () => ({
  saveRecording: vi.fn(),
  saveReassembledRecordingFragments: vi.fn(),
}));

vi.mock('@/queries/sql/heatmap/saveHeatmapEvents', () => ({
  saveHeatmapEvents: vi.fn(),
}));

const parseRequestMock = vi.mocked(parseRequest);
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hasCollectionPermit).mockReturnValue(true);
  clickhouseState.enabled = false;
  vi.mocked(getCollectionIpLimit).mockResolvedValue({ blocked: false, retryAfter: 60 });
  vi.mocked(reserveCollectionSourceLimit).mockResolvedValue(undefined);
  vi.mocked(getCollectionSourceStatus).mockResolvedValue({ blocked: false, retryAfter: 60 });
});

test('recording blocks a saturated IP before parsing and preserves CORS headers', async () => {
  vi.mocked(getCollectionIpLimit).mockResolvedValueOnce({ blocked: true, retryAfter: 60 });

  const response = await POST(new Request('http://localhost/api/record', { method: 'POST' }));

  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('60');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(parseRequestMock).not.toHaveBeenCalled();
  expect(getCollectionSourceStatus).not.toHaveBeenCalled();
});

test('recording charges malformed bodies before parsing', async () => {
  parseRequestMock.mockResolvedValue({
    body: undefined,
    error: () => Response.json({ error: 'bad request' }, { status: 400 }),
  });

  const response = await POST(new Request('http://localhost/api/record', { method: 'POST' }));

  expect(response.status).toBe(400);
  expect(getCollectionIpLimit).toHaveBeenCalledOnce();
  expect(vi.mocked(getCollectionIpLimit).mock.invocationCallOrder[0]).toBeLessThan(
    parseRequestMock.mock.invocationCallOrder[0],
  );
  expect(getCollectionSourceStatus).not.toHaveBeenCalled();
});

test.each(['record', 'heatmap'])('%s preflight rejects oversized event arrays', async type => {
  parseRequestMock.mockResolvedValue({
    error: () => Response.json({ error: 'bad request' }, { status: 400 }),
  });

  expect((await POST(new Request('http://localhost/api/record', { method: 'POST' }))).status).toBe(
    400,
  );

  const preflight = parseRequestMock.mock.calls[0][2]?.bodyPreflight;
  const body = (events: unknown[]) => ({ type, payload: { website: 'website-1', events } });

  expect(preflight?.(body(Array(200).fill({ type: 'click', url: '/' })))).toBe(true);
  expect(preflight?.(body(Array(201).fill(null)))).toBe(false);
  expect(preflight?.(body(Array(10_000).fill(null)))).toBe(false);
  expect(preflight?.(Array(10_000).fill(null))).toBe(false);
  if (type === 'heatmap') {
    expect(preflight?.(body([{ type: 'click', url: '/' }]))).toBe(true);
    expect(
      preflight?.(
        body([
          Object.fromEntries(
            Array.from({ length: 1000 }, (_, index) => [`unexpected_${index}`, true]),
          ),
        ]),
      ),
    ).toBe(false);
    expect(preflight?.(body([{ type: 'click', url: '/', ['x'.repeat(1000)]: 1 }]))).toBe(false);
  }
  expect(getCollectionSourceStatus).not.toHaveBeenCalled();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function prepareHeatmapRequest(visitId = '33333333-3333-4333-8333-333333333333') {
  const websiteId = '11111111-1111-4111-8111-111111111111';
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const transaction = {
    website: {
      findFirst: vi.fn().mockResolvedValue({
        recorderEnabled: true,
        replayConfig: { heatmapEnabled: true, replayEnabled: true, maskLevel: 'strict' },
        domain: 'example.com',
        userId: ACCOUNT_ID,
        teamId: null,
        collectionGeneration: 0,
      }),
    },
  };

  vi.stubEnv('APP_SECRET', 'synthetic-test-secret-00000000000000000');
  vi.mocked(getClientInfo).mockResolvedValue({ ip: '127.0.0.1' } as any);
  vi.mocked(hasBlockedIp).mockReturnValue(false);
  vi.mocked(parseToken).mockReturnValue({
    type: 'cache',
    version: 2,
    websiteId,
    sessionId,
    visitId,
    iat: Math.floor(Date.now() / 1000),
    identityHash: hash(''),
    sessionSalt: hash('synthetic-month'),
  } as any);
  vi.mocked(getWebsite).mockResolvedValue({ recorderEnabled: true } as any);
  vi.mocked(withActiveCollectionSource).mockImplementation((_, __, operation) =>
    operation(transaction as any),
  );
  parseRequestMock.mockResolvedValue({
    body: {
      type: 'heatmap',
      payload: {
        website: websiteId,
        events: [{ type: 'click', url: '/', x: 1, y: 2 }],
      },
    },
    error: undefined,
  });

  return { websiteId, visitId, transaction };
}

function prepareReplayRequest(visitId?: string) {
  const { websiteId, transaction } = prepareHeatmapRequest(visitId);
  vi.mocked(reserveReplayBudget).mockResolvedValue(true);
  parseRequestMock.mockResolvedValue({
    body: {
      type: 'record',
      payload: {
        website: websiteId,
        timestamp: Math.floor(Date.now() / 1000),
        events: [{ type: 4, timestamp: Date.now(), data: { href: 'https://example.com/' } }],
      },
    },
    error: undefined,
  });

  return { websiteId, visitId: visitId ?? '33333333-3333-4333-8333-333333333333', transaction };
}

test.each(['record', 'heatmap'])(
  '%s requires recorder admission before accepting an empty event batch',
  async type => {
    const { websiteId } = type === 'record' ? prepareReplayRequest() : prepareHeatmapRequest();
    const body = { type, payload: { website: websiteId, events: [] } };
    parseRequestMock.mockResolvedValue({ body, error: undefined });

    const request = () =>
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token', 'x-umami-permit': 'signed-permit' },
      });

    vi.mocked(hasCollectionPermit).mockReturnValueOnce(false);
    const denied = await POST(request());
    expect(denied.status).toBe(403);
    expect(withActiveCollectionSource).not.toHaveBeenCalled();

    const accepted = await POST(request());
    const schema = parseRequestMock.mock.calls[0][1];
    const preflight = parseRequestMock.mock.calls[0][2]?.bodyPreflight;
    expect(preflight?.(body)).toBe(true);
    expect(schema.safeParse(body).success).toBe(true);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true });
    expect(hasCollectionPermit).toHaveBeenCalledTimes(3);
    expect(withActiveCollectionSource).toHaveBeenCalledOnce();
    expect(reserveCollectionClientBudget).not.toHaveBeenCalled();
    expect(saveRecording).not.toHaveBeenCalled();
    expect(saveHeatmapEvents).not.toHaveBeenCalled();
  },
);

test('a permit from the prior owner cannot reserve recorder budget after transfer', async () => {
  prepareHeatmapRequest();
  vi.mocked(hasCollectionPermit).mockImplementation(
    (_token, _cache, _feature, _origin, currentWebsite) => !currentWebsite,
  );

  const response = await POST(
    new Request('http://localhost/api/record', {
      method: 'POST',
      headers: { 'x-umami-cache': 'signed-token', 'x-umami-permit': 'signed-permit' },
    }),
  );

  expect(response.status).toBe(403);
  expect(reserveCollectionClientBudget).not.toHaveBeenCalled();
  expect(reserveHeatmapBudget).not.toHaveBeenCalled();
  expect(saveHeatmapEvents).not.toHaveBeenCalled();
});

test('a permit from the prior domain cannot reserve recorder budget after a domain change', async () => {
  const { transaction } = prepareHeatmapRequest();
  transaction.website.findFirst.mockResolvedValueOnce({
    recorderEnabled: true,
    replayConfig: { heatmapEnabled: true, maskLevel: 'strict' },
    domain: 'other.example.com',
    userId: ACCOUNT_ID,
    teamId: null,
  });
  vi.mocked(hasCollectionPermit).mockImplementation(
    (_token, _cache, _feature, origin, currentWebsite) =>
      !currentWebsite ||
      (currentWebsite.domain === 'example.com' && origin === 'https://example.com'),
  );

  const response = await POST(
    new Request('http://localhost/api/record', {
      method: 'POST',
      headers: {
        origin: 'https://example.com',
        'x-umami-cache': 'signed-token',
        'x-umami-permit': 'signed-permit',
      },
    }),
  );

  expect(response.status).toBe(403);
  expect(transaction.website.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ select: expect.objectContaining({ domain: true }) }),
  );
  expect(reserveHeatmapBudget).not.toHaveBeenCalled();
  expect(saveHeatmapEvents).not.toHaveBeenCalled();
});

test('a domain change before an external replay write cannot recredit the old generation', async () => {
  const { websiteId, transaction } = prepareReplayRequest();
  clickhouseState.enabled = true;
  vi.mocked(hasCollectionPermit).mockImplementation(
    (_token, _cache, _feature, _origin, currentWebsite) =>
      !currentWebsite || currentWebsite.domain === 'example.com',
  );
  transaction.website.findFirst
    .mockResolvedValueOnce({
      recorderEnabled: true,
      replayConfig: { replayEnabled: true, maskLevel: 'strict' },
      domain: 'example.com',
      userId: ACCOUNT_ID,
      teamId: null,
      collectionGeneration: 0,
    })
    .mockResolvedValueOnce({
      recorderEnabled: true,
      replayConfig: { replayEnabled: true, maskLevel: 'strict' },
      domain: 'other.example.com',
      userId: ACCOUNT_ID,
      teamId: null,
      collectionGeneration: 1,
    })
    .mockResolvedValueOnce({
      recorderEnabled: true,
      replayConfig: { replayEnabled: true, maskLevel: 'strict' },
      domain: 'other.example.com',
      userId: ACCOUNT_ID,
      teamId: null,
      collectionGeneration: 1,
    });

  expect(
    (
      await POST(
        new Request('http://localhost/api/record', {
          method: 'POST',
          headers: { 'x-umami-cache': 'signed-token', 'x-umami-permit': 'signed-permit' },
        }),
      )
    ).status,
  ).toBe(403);
  expect(transaction.website.findFirst).toHaveBeenCalledTimes(3);
  expect(markUnstoredReplayChunkRetryable).not.toHaveBeenCalled();
  expect(saveRecording).not.toHaveBeenCalled();
  expect(reserveReplayBudget).toHaveBeenCalledOnce();
  expect(withActiveCollectionSource).toHaveBeenCalledWith(
    'website',
    websiteId,
    expect.any(Function),
  );
});

test('a recreated same-domain website cannot recredit a prior generation', async () => {
  const { transaction } = prepareReplayRequest();
  clickhouseState.enabled = true;
  const currentWebsite = {
    recorderEnabled: true,
    replayConfig: { replayEnabled: true, maskLevel: 'strict' },
    domain: 'example.com',
    userId: ACCOUNT_ID,
    teamId: null,
  };
  transaction.website.findFirst
    .mockResolvedValueOnce({ ...currentWebsite, collectionGeneration: 0 })
    .mockResolvedValueOnce({ ...currentWebsite, collectionGeneration: 1 })
    .mockResolvedValueOnce({ ...currentWebsite, collectionGeneration: 1 });
  vi.mocked(hasCollectionPermit).mockImplementation(
    (_token, _cache, _feature, _origin, current) => !current || current.collectionGeneration === 0,
  );

  const response = await POST(
    new Request('http://localhost/api/record', {
      method: 'POST',
      headers: { 'x-umami-cache': 'signed-token', 'x-umami-permit': 'signed-permit' },
    }),
  );

  expect(response.status).toBe(403);
  expect(markUnstoredReplayChunkRetryable).not.toHaveBeenCalled();
  expect(saveRecording).not.toHaveBeenCalled();
});

test('a same-generation pre-sink rejection leaves its chunk retryable', async () => {
  const { websiteId, transaction } = prepareReplayRequest();
  clickhouseState.enabled = true;
  let reserved = false;
  let currentPermitChecks = 0;
  vi.mocked(reserveReplayBudget).mockImplementation(async () => {
    if (reserved) return false;
    reserved = true;
    return true;
  });
  vi.mocked(markUnstoredReplayChunkRetryable).mockImplementation(async () => {
    reserved = false;
  });
  vi.mocked(hasCollectionPermit).mockImplementation(
    (_token, _cache, _feature, _origin, current) => {
      if (!current) return true;
      currentPermitChecks += 1;
      return currentPermitChecks !== 2;
    },
  );
  const request = () =>
    new Request('http://localhost/api/record', {
      method: 'POST',
      headers: { 'x-umami-cache': 'signed-token', 'x-umami-permit': 'signed-permit' },
    });

  expect((await POST(request())).status).toBe(403);
  expect(markUnstoredReplayChunkRetryable).toHaveBeenCalledWith(
    transaction,
    websiteId,
    expect.any(String),
    expect.any(Number),
    { bytes: expect.any(Number), events: expect.any(Number) },
  );
  expect(saveRecording).not.toHaveBeenCalled();

  expect((await POST(request())).status).toBe(200);
  expect(reserveReplayBudget).toHaveBeenCalledTimes(2);
  expect(saveRecording).toHaveBeenCalledOnce();
});

test('an uncertain external replay write never becomes automatically retryable', async () => {
  prepareReplayRequest();
  clickhouseState.enabled = true;
  vi.mocked(saveRecording).mockRejectedValueOnce(new Error('Synthetic external sink failure'));

  const response = await POST(
    new Request('http://localhost/api/record', {
      method: 'POST',
      headers: { 'x-umami-cache': 'signed-token', 'x-umami-permit': 'signed-permit' },
    }),
  );

  expect(response.status).toBe(500);
  expect(saveRecording).toHaveBeenCalledOnce();
  expect(markUnstoredReplayChunkRetryable).not.toHaveBeenCalled();
});

test('failed marker confirmation after sink acknowledgement remains uncertain', async () => {
  prepareReplayRequest();
  clickhouseState.enabled = true;
  vi.mocked(markAcknowledgedReplayChunk).mockRejectedValueOnce(
    new Error('Synthetic confirmation failure'),
  );

  const response = await POST(
    new Request('http://localhost/api/record', {
      method: 'POST',
      headers: { 'x-umami-cache': 'signed-token', 'x-umami-permit': 'signed-permit' },
    }),
  );

  expect(response.status).toBe(500);
  expect(saveRecording).toHaveBeenCalledOnce();
  expect(markUnstoredReplayChunkRetryable).not.toHaveBeenCalled();
});

test('a concurrent retry cannot report success before the external sink acknowledges', async () => {
  prepareReplayRequest();
  clickhouseState.enabled = true;
  let releaseSink!: () => void;
  let signalSinkStarted!: () => void;
  const sinkStarted = new Promise<void>(resolve => {
    signalSinkStarted = resolve;
  });
  const sinkReleased = new Promise<void>(resolve => {
    releaseSink = resolve;
  });
  vi.mocked(saveRecording).mockImplementationOnce(async () => {
    signalSinkStarted();
    await sinkReleased;
  });
  let reserved = false;
  vi.mocked(reserveReplayBudget).mockImplementation(async () => {
    if (reserved) throw new ReplayWritePendingError();
    reserved = true;
    return true;
  });
  const request = () =>
    new Request('http://localhost/api/record', {
      method: 'POST',
      headers: { 'x-umami-cache': 'signed-token', 'x-umami-permit': 'signed-permit' },
    });

  const first = POST(request());
  await sinkStarted;
  expect((await POST(request())).status).toBe(409);
  expect(markAcknowledgedReplayChunk).not.toHaveBeenCalled();
  releaseSink();
  expect((await first).status).toBe(200);
  expect(markAcknowledgedReplayChunk).toHaveBeenCalledOnce();
  expect(saveRecording).toHaveBeenCalledOnce();
});

test('a definitely unsent oversized Kafka replay releases its pending reservation', async () => {
  prepareReplayRequest();
  clickhouseState.enabled = true;
  vi.mocked(saveRecording).mockRejectedValueOnce(
    Object.assign(new Error('Synthetic transport preflight rejection'), {
      code: 'KAFKA_MESSAGE_TOO_LARGE',
    }),
  );

  const response = await POST(
    new Request('http://localhost/api/record', {
      method: 'POST',
      headers: { 'x-umami-cache': 'signed-token', 'x-umami-permit': 'signed-permit' },
    }),
  );

  expect(response.status).toBe(413);
  expect(markUnstoredReplayChunkRetryable).toHaveBeenCalledOnce();
  expect(markAcknowledgedReplayChunk).not.toHaveBeenCalled();
});

describe('heatmap intake budget', () => {
  test('does not count an unverified source when the IP limit is reached', async () => {
    prepareHeatmapRequest();
    vi.mocked(getCollectionIpLimit).mockResolvedValueOnce({ blocked: true, retryAfter: 60 });

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(429);
    expect(parseToken).not.toHaveBeenCalled();
    expect(getCollectionSourceStatus).not.toHaveBeenCalled();
    expect(reserveCollectionSourceLimit).not.toHaveBeenCalled();
  });

  test('does not repeat a website lookup for an already throttled source', async () => {
    prepareHeatmapRequest();
    vi.mocked(getCollectionSourceStatus).mockResolvedValueOnce({ blocked: true, retryAfter: 60 });

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(429);
    expect(getWebsite).not.toHaveBeenCalled();
    expect(reserveCollectionSourceLimit).not.toHaveBeenCalled();
  });

  test('does not count a source without a matching session token', async () => {
    prepareHeatmapRequest();
    vi.mocked(parseToken).mockReturnValueOnce(null);

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(400);
    expect(getCollectionSourceStatus).not.toHaveBeenCalled();
    expect(reserveCollectionSourceLimit).not.toHaveBeenCalled();
  });

  test('rejects a pre-fix cache token before replay or heatmap persistence', async () => {
    prepareHeatmapRequest();
    vi.mocked(parseToken).mockReturnValueOnce({
      type: 'cache',
      websiteId: '11111111-1111-4111-8111-111111111111',
      sessionId: 'old-shared-session',
      visitId: 'old-visit',
      iat: Math.floor(Date.now() / 1000),
    } as any);

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(400);
    expect(getWebsite).not.toHaveBeenCalled();
    expect(saveHeatmapEvents).not.toHaveBeenCalled();
    expect(saveRecording).not.toHaveBeenCalled();
  });

  test('does not count a source after its website is deleted', async () => {
    prepareHeatmapRequest();
    vi.mocked(getWebsite).mockResolvedValueOnce(null);

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(400);
    expect(reserveCollectionSourceLimit).not.toHaveBeenCalled();
  });

  test('does not count a source when the client IP is blocked', async () => {
    prepareHeatmapRequest();
    vi.mocked(hasBlockedIp).mockReturnValueOnce(true);

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(204);
    expect(reserveCollectionSourceLimit).not.toHaveBeenCalled();
  });

  test('reserves capacity before a relational write', async () => {
    const { websiteId, visitId } = prepareHeatmapRequest();
    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(200);
    expect(reserveHeatmapBudget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        websiteId,
        visitId,
        events: 1,
        accountType: 'user',
        accountId: ACCOUNT_ID,
      }),
    );
    expect(reserveCollectionClientBudget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceId: websiteId,
        accountId: ACCOUNT_ID,
        ...getCollectionClientKeys('website', websiteId, 'user', ACCOUNT_ID, 'unknown'),
      }),
      'heatmap',
      expect.objectContaining({ rows: 1, requests: 1 }),
    );
    expect(saveHeatmapEvents).toHaveBeenCalledOnce();
    expect(reserveCollectionSourceLimit).toHaveBeenCalledWith(expect.anything(), websiteId);
    expect(getCollectionSourceStatus).toHaveBeenCalledWith(websiteId);
    expect(vi.mocked(getCollectionIpLimit).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(reserveCollectionSourceLimit).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(reserveHeatmapBudget).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(reserveCollectionClientBudget).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(reserveCollectionClientBudget).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(reserveCollectionSourceLimit).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(reserveCollectionSourceLimit).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(saveHeatmapEvents).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(reserveCollectionClientBudget).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(saveHeatmapEvents).mock.invocationCallOrder[0],
    );
  });

  test('charges the team owner of a team-owned website', async () => {
    const { transaction } = prepareHeatmapRequest();
    const teamId = '55555555-5555-4555-8555-555555555555';
    transaction.website.findFirst.mockResolvedValue({
      recorderEnabled: true,
      replayConfig: { heatmapEnabled: true },
      userId: null,
      teamId,
    });

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(200);
    expect(reserveHeatmapBudget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accountType: 'team', accountId: teamId }),
    );
  });

  test('does not write when a website has no owner', async () => {
    const { transaction } = prepareHeatmapRequest();
    transaction.website.findFirst.mockResolvedValue({
      recorderEnabled: true,
      replayConfig: { heatmapEnabled: true },
      userId: null,
      teamId: null,
    });

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(500);
    expect(reserveHeatmapBudget).not.toHaveBeenCalled();
    expect(saveHeatmapEvents).not.toHaveBeenCalled();
  });

  test('normalizes recorder website UUIDs before token and source checks', async () => {
    prepareHeatmapRequest();
    await POST(new Request('http://localhost/api/record', { method: 'POST' }));
    const schema = parseRequestMock.mock.calls[0][1];
    const mixedCaseId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    const parsed = schema.parse({
      type: 'record',
      payload: { website: mixedCaseId, events: [] },
    });

    expect(parsed.payload.website).toBe(mixedCaseId.toLowerCase());
  });

  test('accepts an existing cache token with an alternate UUID spelling', async () => {
    const { websiteId } = prepareHeatmapRequest();
    vi.mocked(parseToken).mockReturnValueOnce({
      type: 'cache',
      version: 2,
      websiteId: websiteId.toUpperCase(),
      sessionId: '22222222-2222-4222-8222-222222222222',
      visitId: '33333333-3333-4333-8333-333333333333',
      iat: Math.floor(Date.now() / 1000),
      identityHash: hash(''),
      sessionSalt: hash('synthetic-month'),
    } as any);

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(200);
    expect(reserveCollectionSourceLimit).toHaveBeenCalledWith(expect.anything(), websiteId);
  });

  test('does not write when a visit or source budget is exhausted', async () => {
    prepareHeatmapRequest();
    vi.mocked(reserveHeatmapBudget).mockRejectedValueOnce(new HeatmapBudgetExceededError());
    const request = () =>
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      });

    expect((await POST(request())).status).toBe(413);
    expect(saveHeatmapEvents).not.toHaveBeenCalled();

    vi.mocked(reserveHeatmapBudget).mockRejectedValueOnce(new HeatmapBudgetExceededError(60));
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(saveHeatmapEvents).not.toHaveBeenCalled();
  });

  test('does not write heatmaps when the shared owner budget is exhausted', async () => {
    prepareHeatmapRequest();
    vi.mocked(reserveHeatmapBudget).mockRejectedValueOnce(new CollectionBudgetExceededError(60));

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(saveHeatmapEvents).not.toHaveBeenCalled();
  });

  test('a saturated client cannot persist heatmaps in either sink', async () => {
    prepareHeatmapRequest();
    clickhouseState.enabled = true;
    vi.mocked(reserveCollectionClientBudget).mockRejectedValueOnce(
      new CollectionBudgetExceededError(60),
    );

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(reserveCollectionSourceLimit).not.toHaveBeenCalled();
    expect(saveHeatmapEvents).not.toHaveBeenCalled();
  });

  test('commits the budget before an external ClickHouse or Kafka write', async () => {
    prepareHeatmapRequest();
    clickhouseState.enabled = true;
    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(200);
    expect(withActiveCollectionSource).toHaveBeenCalledTimes(2);
    expect(reserveHeatmapBudget).toHaveBeenCalledOnce();
    expect(saveHeatmapEvents).toHaveBeenCalledWith(expect.any(Array));
    expect(vi.mocked(withActiveCollectionSource).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(saveHeatmapEvents).mock.invocationCallOrder[0],
    );
  });

  test('does not write to an external sink when the budget transaction fails to commit', async () => {
    prepareHeatmapRequest();
    clickhouseState.enabled = true;
    vi.mocked(withActiveCollectionSource).mockImplementationOnce(async (_, __, operation) => {
      await operation({
        website: {
          findFirst: vi.fn().mockResolvedValue({
            recorderEnabled: true,
            replayConfig: { heatmapEnabled: true },
            userId: ACCOUNT_ID,
          }),
        },
      } as any);
      throw new Error('Synthetic transaction commit failure');
    });

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(500);
    expect(reserveHeatmapBudget).toHaveBeenCalledOnce();
    expect(saveHeatmapEvents).not.toHaveBeenCalled();
  });

  test('does not write to an external sink after heatmap collection is disabled', async () => {
    prepareHeatmapRequest();
    clickhouseState.enabled = true;
    vi.mocked(withActiveCollectionSource).mockImplementationOnce((_, __, operation) =>
      operation({
        website: {
          findFirst: vi.fn().mockResolvedValue({
            recorderEnabled: true,
            replayConfig: { heatmapEnabled: true },
            userId: ACCOUNT_ID,
          }),
        },
      } as any),
    );
    vi.mocked(withActiveCollectionSource).mockImplementationOnce((_, __, operation) =>
      operation({
        website: {
          findFirst: vi.fn().mockResolvedValue({
            recorderEnabled: true,
            replayConfig: { heatmapEnabled: false },
            userId: ACCOUNT_ID,
          }),
        },
      } as any),
    );

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: 'heatmap_disabled' });
    expect(saveHeatmapEvents).not.toHaveBeenCalled();
  });

  test('does not write to an external sink after website ownership changes', async () => {
    prepareHeatmapRequest();
    clickhouseState.enabled = true;
    let lookup = 0;
    vi.mocked(withActiveCollectionSource).mockImplementation((_, __, operation) =>
      operation({
        website: {
          findFirst: vi.fn().mockImplementation(async () => {
            lookup += 1;
            return {
              recorderEnabled: true,
              replayConfig: { heatmapEnabled: true },
              userId: lookup === 1 ? ACCOUNT_ID : null,
              teamId: lookup === 1 ? null : '55555555-5555-4555-8555-555555555555',
            };
          }),
        },
      } as any),
    );

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(409);
    expect(reserveHeatmapBudget).toHaveBeenCalledOnce();
    expect(saveHeatmapEvents).not.toHaveBeenCalled();
  });
});

describe('external replay budget commit', () => {
  const request = () =>
    new Request('http://localhost/api/record', {
      method: 'POST',
      headers: { 'x-umami-cache': 'signed-token' },
    });
  const fragmentRequest = () =>
    new Request('http://localhost/api/record', {
      method: 'POST',
      headers: {
        'x-umami-cache': 'signed-token',
        'x-umami-permit': 'signed-permit',
        'x-umami-record-batch': '1',
      },
    });

  test('commits the budget before an external replay write', async () => {
    prepareReplayRequest();
    clickhouseState.enabled = true;

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(reserveReplayBudget).toHaveBeenCalledOnce();
    expect(reserveReplayBudget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accountType: 'user', accountId: ACCOUNT_ID }),
    );
    expect(reserveCollectionClientBudget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        ...getCollectionClientKeys(
          'website',
          '11111111-1111-4111-8111-111111111111',
          'user',
          ACCOUNT_ID,
          'unknown',
        ),
      }),
      'replay',
      expect.objectContaining({ rows: 1, requests: 1 }),
    );
    expect(vi.mocked(reserveCollectionClientBudget).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(reserveCollectionSourceLimit).mock.invocationCallOrder[0],
    );
    expect(withActiveCollectionSource).toHaveBeenCalledTimes(2);
    expect(saveRecording).toHaveBeenCalledWith(expect.objectContaining({ eventCount: 1 }));
    expect(vi.mocked(withActiveCollectionSource).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(saveRecording).mock.invocationCallOrder[0],
    );
  });

  test('rejects cumulative compact replay nodes before reserving or writing', async () => {
    const { websiteId } = prepareReplayRequest();
    const nodes = Array.from({ length: 30_000 }, () => ({}));
    parseRequestMock.mockResolvedValue({
      body: {
        type: 'record',
        payload: {
          website: websiteId,
          events: [
            { type: 2, data: { node: { childNodes: nodes } } },
            { type: 2, data: { node: { childNodes: nodes } } },
          ],
        },
      },
      error: undefined,
    });

    const response = await POST(request());

    expect(response.status).toBe(413);
    expect(reserveReplayBudget).not.toHaveBeenCalled();
    expect(saveRecording).not.toHaveBeenCalled();
  });

  test('accepts a replay event at the existing maximum nesting depth', async () => {
    const { websiteId } = prepareReplayRequest();
    let data: unknown = 0;

    for (let depth = 0; depth < 255; depth++) {
      data = [data];
    }

    parseRequestMock.mockResolvedValue({
      body: {
        type: 'record',
        payload: { website: websiteId, events: [{ type: 4, timestamp: Date.now(), data }] },
      },
      error: undefined,
    });

    expect((await POST(request())).status).toBe(200);
    expect(reserveReplayBudget).toHaveBeenCalledOnce();
  });

  test('keeps relational replay writes inside the budget transaction', async () => {
    prepareReplayRequest();

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(withActiveCollectionSource).toHaveBeenCalledOnce();
    expect(saveRecording).toHaveBeenCalledWith(expect.any(Object), expect.any(Object));
  });

  test.each([false, true])(
    'reassembles split snapshots from one charged request (external=%s)',
    async external => {
      const { websiteId, visitId } = prepareReplayRequest();
      clickhouseState.enabled = external;
      const event = {
        type: 2,
        timestamp: Date.now(),
        data: {
          node: {
            type: 0,
            id: 1,
            childNodes: [
              {
                type: 2,
                id: 2,
                tagName: 'img',
                attributes: { src: 'https://assets.example/photo?token=fragment-secret' },
                childNodes: [],
              },
            ],
          },
        },
      };
      const serialized = JSON.stringify(event);
      const boundary = serialized.indexOf('fragment-secret') + 5;
      const chunkIndex = Math.floor(Date.now() / 1000);
      const fragmentId = `route-${external ? 'external' : 'relational'}`;
      const fragments = [serialized.slice(0, boundary), serialized.slice(boundary)].map(
        (value, index) => ({
          type: 'umami:rrweb-event-fragment',
          timestamp: event.timestamp,
          data: { id: fragmentId, index, total: 2, value },
        }),
      );

      parseRequestMock.mockResolvedValueOnce({
        body: {
          type: 'record',
          payload: { website: websiteId, timestamp: chunkIndex, events: fragments },
        },
        error: undefined,
      });

      expect((await POST(fragmentRequest())).status).toBe(200);
      expect(saveRecording).not.toHaveBeenCalled();

      expect(reserveReplayBudget).toHaveBeenCalledTimes(2);
      expect(saveReassembledRecordingFragments).toHaveBeenCalledWith(
        expect.objectContaining({
          event,
          parts: [
            expect.objectContaining({ index: 0, chunkIndex }),
            expect.objectContaining({ index: 1, chunkIndex: chunkIndex + 1 }),
          ],
        }),
        external ? undefined : expect.any(Object),
      );
      expect(withActiveCollectionSource).toHaveBeenCalledTimes(external ? 2 : 1);
      expect(markAcknowledgedReplayChunk).toHaveBeenCalledTimes(2);
      expect(markAcknowledgedReplayChunk).toHaveBeenNthCalledWith(
        1,
        expect.any(Object),
        websiteId,
        visitId,
        chunkIndex,
      );
      expect(markAcknowledgedReplayChunk).toHaveBeenNthCalledWith(
        2,
        expect.any(Object),
        websiteId,
        visitId,
        chunkIndex + 1,
      );
    },
  );

  test('rejects incomplete fragments without a marker and later accepts the whole event', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T10:00:00Z'));

    try {
      const { websiteId } = prepareReplayRequest('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
      const event = {
        type: 2,
        timestamp: Date.now(),
        data: { node: { type: 0, id: 1, childNodes: [] } },
      };
      const serialized = JSON.stringify(event);
      const boundary = Math.ceil(serialized.length / 2);
      const chunkIndex = Math.floor(Date.now() / 1000);
      const fragments = [serialized.slice(0, boundary), serialized.slice(boundary)].map(
        (value, index) => ({
          type: 'umami:rrweb-event-fragment',
          timestamp: event.timestamp,
          data: { id: 'expired-replay', index, total: 2, value },
        }),
      );
      const pending = new Set<number>();
      vi.mocked(reserveReplayBudget).mockImplementation(async (_, options) => {
        if (pending.has(options.chunkIndex)) throw new ReplayWritePendingError();
        pending.add(options.chunkIndex);
        return true;
      });
      const submit = async (events: typeof fragments) => {
        parseRequestMock.mockResolvedValueOnce({
          body: {
            type: 'record',
            payload: {
              website: websiteId,
              timestamp: chunkIndex,
              events,
            },
          },
          error: undefined,
        });
        return POST(fragmentRequest());
      };

      expect((await submit([fragments[0]])).status).toBe(413);
      expect(pending.size).toBe(0);
      vi.advanceTimersByTime(31_000);
      expect((await submit(fragments)).status).toBe(200);
      expect(saveReassembledRecordingFragments).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([
    { external: false, failure: 'save', visitId: '66666666-6666-4666-8666-666666666666' },
    { external: true, failure: 'save', visitId: '77777777-7777-4777-8777-777777777777' },
    {
      external: false,
      failure: 'acknowledge',
      visitId: '88888888-8888-4888-8888-888888888888',
    },
    {
      external: true,
      failure: 'acknowledge',
      visitId: '99999999-9999-4999-8999-999999999999',
    },
    { external: true, failure: 'before-sink', visitId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  ])(
    'a failed fragment batch does not acknowledge an unstored replay (external=$external, failure=$failure)',
    async ({ external, failure, visitId }) => {
      const { websiteId, transaction } = prepareReplayRequest(visitId);
      clickhouseState.enabled = external;
      const event = {
        type: 2,
        timestamp: Date.now(),
        data: { node: { type: 0, id: 1, childNodes: [] } },
      };
      const serialized = JSON.stringify(event);
      const boundary = Math.ceil(serialized.length / 2);
      const chunkIndex = Math.floor(Date.now() / 1000);
      const fragmentId = `route-failure-${failure}-${external}`;
      const fragments = [serialized.slice(0, boundary), serialized.slice(boundary)].map(
        (value, index) => ({
          type: 'umami:rrweb-event-fragment',
          timestamp: event.timestamp,
          data: { id: fragmentId, index, total: 2, value },
        }),
      );
      const markers = new Map<number, 'pending' | 'acknowledged'>();
      const reservedCharges = new Map<number, number>();
      vi.mocked(reserveReplayBudget).mockImplementation(async (_, options) => {
        const marker = markers.get(options.chunkIndex);
        if (marker === 'pending') throw new ReplayWritePendingError();
        if (marker === 'acknowledged') return false;
        reservedCharges.set(
          options.chunkIndex,
          getReplayChargedBytes(options.bytes, options.structureUnits),
        );
        markers.set(options.chunkIndex, options.pendingExternalWrite ? 'pending' : 'acknowledged');
        return true;
      });
      vi.mocked(markAcknowledgedReplayChunk).mockImplementation(async (_, __, ___, index) => {
        expect(markers.get(index)).toBe('pending');
        markers.set(index, 'acknowledged');
      });
      vi.mocked(markUnstoredReplayChunkRetryable).mockImplementation(
        async (_, __, ___, index, charge) => {
          expect(markers.get(index)).toBe('pending');
          expect(charge.events).toBe(1);
          expect(charge.bytes).toBe(reservedCharges.get(index));
          markers.delete(index);
        },
      );
      let transactionCalls = 0;
      vi.mocked(withActiveCollectionSource).mockImplementation(async (_, __, operation) => {
        transactionCalls += 1;
        const snapshot = new Map(markers);
        try {
          if (transactionCalls === 2 && failure === 'before-sink') {
            throw new Error('Synthetic pre-sink failure');
          }
          return await operation(transaction as any);
        } catch (error) {
          markers.clear();
          for (const [index, marker] of snapshot) markers.set(index, marker);
          throw error;
        }
      });
      const submit = async () => {
        parseRequestMock.mockResolvedValueOnce({
          body: {
            type: 'record',
            payload: {
              website: websiteId,
              timestamp: chunkIndex,
              events: fragments,
            },
          },
          error: undefined,
        });
        return POST(fragmentRequest());
      };

      if (failure === 'save') {
        vi.mocked(saveReassembledRecordingFragments).mockRejectedValueOnce(
          new Error('Synthetic fragment sink failure'),
        );
      } else if (failure === 'acknowledge') {
        vi.mocked(markAcknowledgedReplayChunk).mockRejectedValueOnce(
          new Error('Synthetic fragment acknowledgement failure'),
        );
      }
      expect((await submit()).status).toBe(500);
      if (external && failure !== 'before-sink') {
        expect(markers.get(chunkIndex)).toBe('pending');
        expect(markers.get(chunkIndex + 1)).toBe('pending');
        expect(markUnstoredReplayChunkRetryable).not.toHaveBeenCalled();
        expect((await submit()).status).toBe(409);
        expect(saveReassembledRecordingFragments).toHaveBeenCalledOnce();
      } else {
        expect(markers.has(chunkIndex)).toBe(false);
        expect(markers.has(chunkIndex + 1)).toBe(false);
        expect(markUnstoredReplayChunkRetryable).toHaveBeenCalledTimes(external ? 2 : 0);
        expect((await submit()).status).toBe(200);
        expect(saveReassembledRecordingFragments).toHaveBeenCalledTimes(
          failure === 'before-sink' ? 1 : 2,
        );
      }
    },
  );

  test('writes only a sanitized reassembled snapshot through the real relational sink', async () => {
    const { websiteId, transaction } = prepareReplayRequest();
    const create = vi.fn(async (_input: { data: { events: Buffer } }) => ({}));
    Object.assign(transaction, { sessionReplay: { create } });
    const actual = await vi.importActual<typeof import('@/queries/sql/replays/saveRecording')>(
      '@/queries/sql/replays/saveRecording',
    );
    vi.mocked(saveReassembledRecordingFragments).mockImplementation((args, client) =>
      actual.saveReassembledRecordingFragments(args, client),
    );
    const event = {
      type: 2,
      timestamp: Date.now(),
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: 'img',
              attributes: { src: 'https://assets.example/?token=route-secret', alt: 'Photo' },
              childNodes: [],
            },
          ],
        },
      },
    };
    const serialized = JSON.stringify(event);
    const boundary = serialized.indexOf('route-secret') + 5;
    const chunkIndex = Math.floor(Date.now() / 1000);

    const fragments = [serialized.slice(0, boundary), serialized.slice(boundary)].map(
      (value, index) => ({
        type: 'umami:rrweb-event-fragment',
        timestamp: event.timestamp,
        data: { id: 'route-real-sink', index, total: 2, value },
      }),
    );
    parseRequestMock.mockResolvedValueOnce({
      body: {
        type: 'record',
        payload: { website: websiteId, timestamp: chunkIndex, events: fragments },
      },
      error: undefined,
    });

    expect((await POST(fragmentRequest())).status).toBe(200);
    expect(create).toHaveBeenCalledTimes(2);

    const storedEvents = create.mock.calls.flatMap(([input]) =>
      JSON.parse(gunzipSync(input.data.events).toString('utf8')),
    );
    expect(JSON.stringify(storedEvents)).not.toContain('route-secret');
    expect(saveRecording).not.toHaveBeenCalled();
  });

  test('rejects mixed or unindexed fragments before charging a visit', async () => {
    const { websiteId } = prepareReplayRequest();
    const fragment = {
      type: 'umami:rrweb-event-fragment',
      timestamp: Date.now(),
      data: { id: 'route-invalid', index: 0, total: 2, value: '{' },
    };

    for (const payload of [
      { website: websiteId, events: [fragment] },
      { website: websiteId, timestamp: Math.floor(Date.now() / 1000), events: [fragment, {}] },
      {
        website: websiteId,
        timestamp: Math.floor(Date.now() / 1000),
        events: [{ ...fragment, data: { ...fragment.data, total: 0 } }],
      },
    ]) {
      parseRequestMock.mockResolvedValueOnce({
        body: { type: 'record', payload },
        error: undefined,
      });
      expect((await POST(fragmentRequest())).status).toBe(413);
    }

    expect(reserveReplayBudget).not.toHaveBeenCalled();
    expect(saveRecording).not.toHaveBeenCalled();
    expect(saveReassembledRecordingFragments).not.toHaveBeenCalled();
  });

  test('rejects an empty replay batch before reserving capacity', async () => {
    const { websiteId } = prepareReplayRequest();
    parseRequestMock.mockResolvedValueOnce({
      body: { type: 'record', payload: { website: websiteId, events: [] } },
      error: undefined,
    });

    expect((await POST(fragmentRequest())).status).toBe(413);
    expect(reserveReplayBudget).not.toHaveBeenCalled();
  });

  test('rejects a versioned replay header on heatmap data', async () => {
    prepareHeatmapRequest();

    expect((await POST(fragmentRequest())).status).toBe(400);
    expect(reserveHeatmapBudget).not.toHaveBeenCalled();
  });

  test('rejects an unversioned complete fragment group without reserving budget', async () => {
    const { websiteId } = prepareReplayRequest();
    const event = { type: 2, timestamp: Date.now(), data: { node: { type: 0, id: 1 } } };
    const serialized = JSON.stringify(event);
    const boundary = Math.floor(serialized.length / 2);
    const fragments = [serialized.slice(0, boundary), serialized.slice(boundary)].map(
      (value, index) => ({
        type: 'umami:rrweb-event-fragment',
        timestamp: event.timestamp,
        data: { id: 'legacy-group', index, total: 2, value },
      }),
    );
    parseRequestMock.mockResolvedValueOnce({
      body: {
        type: 'record',
        payload: {
          website: websiteId,
          timestamp: Math.floor(Date.now() / 1000),
          events: fragments,
        },
      },
      error: undefined,
    });

    expect((await POST(request())).status).toBe(413);
    expect(reserveReplayBudget).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    'does not report an already reserved fragment group as a fresh write (external=%s)',
    async external => {
      const { websiteId } = prepareReplayRequest();
      clickhouseState.enabled = external;
      const event = {
        type: 2,
        timestamp: Date.now(),
        data: { node: { type: 0, id: 1, childNodes: [] } },
      };
      const serialized = JSON.stringify(event);
      const boundary = Math.floor(serialized.length / 2);
      const fragments = [serialized.slice(0, boundary), serialized.slice(boundary)].map(
        (value, index) => ({
          type: 'umami:rrweb-event-fragment',
          timestamp: event.timestamp,
          data: { id: 'duplicate-group', index, total: 2, value },
        }),
      );
      parseRequestMock.mockResolvedValueOnce({
        body: {
          type: 'record',
          payload: {
            website: websiteId,
            timestamp: Math.floor(Date.now() / 1000),
            events: fragments,
          },
        },
        error: undefined,
      });
      vi.mocked(reserveReplayBudget).mockResolvedValue(false);

      expect((await POST(fragmentRequest())).status).toBe(409);
      expect(reserveCollectionClientBudget).not.toHaveBeenCalled();
      expect(saveReassembledRecordingFragments).not.toHaveBeenCalled();
    },
  );

  test('rejects a fragment group with mixed new and old chunk markers', async () => {
    const { websiteId } = prepareReplayRequest();
    const event = {
      type: 2,
      timestamp: Date.now(),
      data: { node: { type: 0, id: 1, childNodes: [] } },
    };
    const serialized = JSON.stringify(event);
    const boundary = Math.floor(serialized.length / 2);
    const fragments = [serialized.slice(0, boundary), serialized.slice(boundary)].map(
      (value, index) => ({
        type: 'umami:rrweb-event-fragment',
        timestamp: event.timestamp,
        data: { id: 'mixed-markers', index, total: 2, value },
      }),
    );
    parseRequestMock.mockResolvedValueOnce({
      body: {
        type: 'record',
        payload: {
          website: websiteId,
          timestamp: Math.floor(Date.now() / 1000),
          events: fragments,
        },
      },
      error: undefined,
    });
    vi.mocked(reserveReplayBudget).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect((await POST(fragmentRequest())).status).toBe(409);
    expect(reserveCollectionClientBudget).not.toHaveBeenCalled();
    expect(saveReassembledRecordingFragments).not.toHaveBeenCalled();
  });

  test('admits large bodies only with a valid versioned recording permit', async () => {
    prepareReplayRequest();
    await POST(request());
    expect(parseRequestMock.mock.calls[0][2]?.maxBodyBytes).toBe(1024 * 1024);

    await POST(fragmentRequest());
    expect(parseRequestMock.mock.calls[1][2]?.maxBodyBytes).toBe(10 * 1024 * 1024);

    vi.mocked(hasCollectionPermit).mockReturnValue(false);
    await POST(fragmentRequest());
    expect(parseRequestMock.mock.calls[2][2]?.maxBodyBytes).toBe(1024 * 1024);
  });

  test('parses a complete large batch only when its version and permit are valid', async () => {
    const { websiteId } = prepareReplayRequest();
    const actualRequest = await vi.importActual<typeof import('@/lib/request')>('@/lib/request');
    parseRequestMock.mockImplementation((...args) => actualRequest.parseRequest(...args));
    const event = {
      type: 2,
      timestamp: Date.now(),
      data: {
        node: { type: 0, id: 1, textContent: 'x'.repeat(600_000), childNodes: [] },
        text: 'y'.repeat(600_000),
      },
    };
    const serialized = JSON.stringify(event);
    const values = Array.from({ length: Math.ceil(serialized.length / 400_000) }, (_, index) =>
      serialized.slice(index * 400_000, (index + 1) * 400_000),
    );
    const body = JSON.stringify({
      type: 'record',
      payload: {
        website: websiteId,
        timestamp: Math.floor(Date.now() / 1000),
        events: values.map((value, index) => ({
          type: 'umami:rrweb-event-fragment',
          timestamp: event.timestamp,
          data: { id: 'large-batch', index, total: values.length, value },
        })),
      },
    });
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(1024 * 1024);

    const send = (versioned: boolean) =>
      POST(
        new Request('http://localhost/api/record', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-umami-cache': 'signed-token',
            'x-umami-permit': 'signed-permit',
            ...(versioned ? { 'x-umami-record-batch': '1' } : {}),
          },
          body,
        }),
      );

    expect((await send(false)).status).toBe(413);
    expect(reserveReplayBudget).not.toHaveBeenCalled();
    expect((await send(true)).status).toBe(200);
    expect(reserveReplayBudget).toHaveBeenCalledTimes(values.length);
    expect(saveReassembledRecordingFragments).toHaveBeenCalledOnce();
  });

  test('bounds concurrent versioned replay uploads and releases their slots', async () => {
    prepareReplayRequest();
    let releaseBodies!: () => void;
    const pendingBodies = new Promise<void>(resolve => {
      releaseBodies = resolve;
    });
    parseRequestMock.mockImplementation(async () => {
      await pendingBodies;
      return {
        body: undefined,
        error: () => Response.json({ error: 'bad request' }, { status: 400 }),
      };
    });

    const active = Array.from({ length: 4 }, () => POST(fragmentRequest()));
    await vi.waitFor(() => expect(parseRequestMock).toHaveBeenCalledTimes(4));
    const saturated = await POST(fragmentRequest());
    expect(saturated.status).toBe(429);
    expect(saturated.headers.get('Retry-After')).toBe('1');
    releaseBodies();
    expect((await Promise.all(active)).map(response => response.status)).toEqual([
      400, 400, 400, 400,
    ]);
    expect((await POST(fragmentRequest())).status).toBe(400);
  });

  test('does not write replays when the shared owner budget is exhausted', async () => {
    prepareReplayRequest();
    vi.mocked(reserveReplayBudget).mockRejectedValueOnce(new CollectionBudgetExceededError(86_400));

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('86400');
    expect(saveRecording).not.toHaveBeenCalled();
  });

  test('an idempotent replay retry does not charge the client again', async () => {
    prepareReplayRequest();
    vi.mocked(reserveReplayBudget).mockResolvedValueOnce(false);

    expect((await POST(request())).status).toBe(200);
    expect(getCollectionIpLimit).toHaveBeenCalledOnce();
    expect(reserveCollectionClientBudget).not.toHaveBeenCalled();
    expect(reserveCollectionSourceLimit).not.toHaveBeenCalled();
    expect(saveRecording).not.toHaveBeenCalled();
  });

  test('a saturated client cannot persist replay in either sink', async () => {
    prepareReplayRequest();
    clickhouseState.enabled = true;
    vi.mocked(reserveCollectionClientBudget).mockRejectedValueOnce(
      new CollectionBudgetExceededError(86_400),
    );

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('86400');
    expect(reserveCollectionSourceLimit).not.toHaveBeenCalled();
    expect(saveRecording).not.toHaveBeenCalled();
  });

  test('never writes to an external sink when the budget transaction rolls back', async () => {
    prepareReplayRequest();
    clickhouseState.enabled = true;
    vi.mocked(withActiveCollectionSource).mockImplementationOnce(async (_, __, operation) => {
      await operation({
        website: {
          findFirst: vi.fn().mockResolvedValue({
            recorderEnabled: true,
            replayConfig: { replayEnabled: true, maskLevel: 'strict' },
            userId: ACCOUNT_ID,
          }),
        },
      } as any);
      throw new Error('Synthetic transaction commit failure');
    });

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: { 'x-umami-cache': 'signed-token' },
      }),
    );

    expect(response.status).toBe(500);
    expect(reserveReplayBudget).toHaveBeenCalledOnce();
    expect(saveRecording).not.toHaveBeenCalled();
  });

  test('does not write to an external sink after replay collection is disabled', async () => {
    prepareReplayRequest();
    clickhouseState.enabled = true;
    vi.mocked(withActiveCollectionSource).mockImplementationOnce((_, __, operation) =>
      operation({
        website: {
          findFirst: vi.fn().mockResolvedValue({
            recorderEnabled: true,
            replayConfig: { replayEnabled: true, maskLevel: 'strict' },
            userId: ACCOUNT_ID,
          }),
        },
      } as any),
    );
    vi.mocked(withActiveCollectionSource).mockImplementationOnce((_, __, operation) =>
      operation({
        website: {
          findFirst: vi.fn().mockResolvedValue({
            recorderEnabled: true,
            replayConfig: { replayEnabled: false },
            userId: ACCOUNT_ID,
          }),
        },
      } as any),
    );

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: 'replay_disabled' });
    expect(saveRecording).not.toHaveBeenCalled();
  });
});

describe('record route CORS', () => {
  test('a public cache token cannot authorize recording from an unrelated origin', async () => {
    prepareHeatmapRequest();
    vi.mocked(hasCollectionPermit).mockReturnValue(false);

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
        headers: {
          Origin: 'https://unrelated.example',
          'x-umami-cache': 'signed-token',
        },
      }),
    );

    expect.soft(response.status).toBeGreaterThanOrEqual(400);
    expect.soft(saveHeatmapEvents).not.toHaveBeenCalled();
  });

  test('handles preflight requests', async () => {
    const response = OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('x-umami-cache');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('x-umami-permit');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  test('includes CORS headers on post responses', async () => {
    parseRequestMock.mockResolvedValue({
      body: {
        type: 'record',
        payload: {
          website: '11111111-1111-4111-8111-111111111111',
          events: [],
        },
      },
      error: undefined,
    });

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
