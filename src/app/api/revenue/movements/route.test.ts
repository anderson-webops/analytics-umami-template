import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getCollectionIpLimit } from '@/lib/collection-rate-limit';
import {
  AttestedRevenueConflictError,
  recordAttestedRevenueMovement,
  withActiveCollectionSource,
} from '@/queries/prisma';
import { POST } from './route';

vi.mock('@/lib/collection-rate-limit', () => ({
  getCollectionIpLimit: vi.fn(async () => ({ blocked: false, retryAfter: 60 })),
}));
vi.mock('@/queries/prisma', () => ({
  AttestedRevenueConflictError: class extends Error {},
  recordAttestedRevenueMovement: vi.fn(),
  withActiveCollectionSource: vi.fn(),
}));

const websiteId = '11111111-1111-4111-8111-111111111111';
const otherWebsiteId = '22222222-2222-4222-8222-222222222222';
const ownerId = '33333333-3333-4333-8333-333333333333';
const credential = 'a'.repeat(43);
const digest = createHash('sha256').update(credential).digest('hex');
const movement = {
  website: websiteId,
  source: 'orders',
  sourceMovementId: '44444444-4444-4444-8444-444444444444',
  orderId: '55555555-5555-4555-8555-555555555555',
  customerId: null,
  kind: 'capture',
  amount: '12.3400',
  currency: 'USD',
  occurredAt: '2026-10-19T00:00:00Z',
};

function request(
  body: unknown = movement,
  options: { credential?: string; timestamp?: number } = {},
) {
  return new Request('https://analytics.example/api/revenue/movements', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-umami-request-id': randomUUID(),
      'x-umami-request-timestamp': String(options.timestamp ?? Math.floor(Date.now() / 1000)),
      ...(options.credential === undefined
        ? { Authorization: `Bearer ${credential}` }
        : options.credential
          ? { Authorization: `Bearer ${options.credential}` }
          : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('REVENUE_ATTESTED_INTAKE_ENABLED', '1');
  vi.stubEnv(
    'COLLECTION_SERVER_KEYS_JSON',
    JSON.stringify({
      [websiteId]: [
        { sha256: digest, scopes: ['revenue'], ownerType: 'user', ownerId, generation: 0 },
      ],
    }),
  );
  vi.mocked(withActiveCollectionSource).mockImplementation((_type, _websiteId, operation) =>
    operation({} as never),
  );
  vi.mocked(recordAttestedRevenueMovement).mockResolvedValue({
    movementId: '66666666-6666-4666-8666-666666666666',
    duplicate: false,
  });
});

afterEach(() => vi.unstubAllEnvs());

test('intake is disabled by default, before any rate-limit or database work', async () => {
  vi.stubEnv('REVENUE_ATTESTED_INTAKE_ENABLED', '');
  const response = await POST(request());

  expect(response.status).toBe(403);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(getCollectionIpLimit).not.toHaveBeenCalled();
  expect(recordAttestedRevenueMovement).not.toHaveBeenCalled();
});

test('server credential and fresh request proof are required for exactly the target website', async () => {
  for (const candidate of [
    request(movement, { credential: '' }),
    request(movement, { credential: 'b'.repeat(43) }),
    request({ ...movement, website: otherWebsiteId }),
    request(movement, { timestamp: Math.floor(Date.now() / 1000) - 301 }),
  ]) {
    const response = await POST(candidate);
    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  }
  expect(withActiveCollectionSource).not.toHaveBeenCalled();
  expect(recordAttestedRevenueMovement).not.toHaveBeenCalled();
});

test('strict bounded schema rejects changed shapes and oversized bodies', async () => {
  for (const candidate of [
    { ...movement, extra: 'browser-supplied' },
    { ...movement, amount: -12.34 },
    { ...movement, amount: '0' },
    { ...movement, amount: '1e6' },
    { ...movement, amount: '1.12345' },
    { ...movement, source: '../orders' },
    { ...movement, kind: 'chargeback' },
    { ...movement, kind: 'refund' },
    { ...movement, occurredAt: 'not-a-date' },
    { ...movement, occurredAt: '2026-10-19T00:00:00.123456Z' },
    { ...movement, occurredAt: '2026-10-19T00:00:00.123999Z' },
  ]) {
    expect((await POST(request(candidate))).status).toBe(400);
  }
  expect((await POST(request({ ...movement, source: 'x'.repeat(17_000) }))).status).toBe(413);
  expect(recordAttestedRevenueMovement).not.toHaveBeenCalled();
});

test('millisecond timestamps remain valid and preserve exact duplicate-comparison precision', async () => {
  const response = await POST(request({ ...movement, occurredAt: '2026-10-19T00:00:00.123Z' }));

  expect(response.status).toBe(201);
  expect(recordAttestedRevenueMovement).toHaveBeenCalledWith(
    expect.anything(),
    websiteId,
    expect.anything(),
    expect.objectContaining({ occurredAt: new Date('2026-10-19T00:00:00.123Z') }),
  );
});

test('accepted movement has no CORS, no-store response, and backend-attested provenance', async () => {
  const response = await POST(request());

  expect(response.status).toBe(201);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  expect(await response.json()).toEqual({
    movementId: '66666666-6666-4666-8666-666666666666',
    duplicate: false,
    provenance: 'backend_attested',
  });
  expect(withActiveCollectionSource).toHaveBeenCalledWith(
    'website',
    websiteId,
    expect.any(Function),
    expect.objectContaining({ ownerId, generation: 0 }),
  );
  expect(recordAttestedRevenueMovement).toHaveBeenCalledWith(
    expect.anything(),
    websiteId,
    expect.anything(),
    expect.objectContaining({ amount: '12.3400', occurredAt: new Date(movement.occurredAt) }),
  );
});

test('identical retry returns its existing movement and changed facts conflict', async () => {
  vi.mocked(recordAttestedRevenueMovement).mockResolvedValueOnce({
    movementId: '66666666-6666-4666-8666-666666666666',
    duplicate: true,
  });
  expect((await POST(request())).status).toBe(200);

  vi.mocked(recordAttestedRevenueMovement).mockRejectedValueOnce(
    new AttestedRevenueConflictError(),
  );
  const conflict = await POST(request({ ...movement, amount: '99' }));
  expect(conflict.status).toBe(409);
  expect(conflict.headers.get('Cache-Control')).toBe('no-store');
});

test('rate limits and owner revocation reject intake without a write', async () => {
  vi.mocked(getCollectionIpLimit).mockResolvedValueOnce({ blocked: true, retryAfter: 60 });
  expect((await POST(request())).status).toBe(429);
  expect(withActiveCollectionSource).not.toHaveBeenCalled();

  vi.mocked(withActiveCollectionSource).mockRejectedValueOnce(
    new Error('COLLECTION_KEY_OWNER_CHANGED'),
  );
  expect((await POST(request())).status).toBe(403);
  expect(recordAttestedRevenueMovement).not.toHaveBeenCalled();
});
