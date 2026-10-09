import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fetchAccount } from '@/lib/load';
import { parseRequest } from '@/lib/request';
import { canCreateTeam } from '@/permissions';
import { createTeam } from '@/queries/prisma';
import { POST } from './route';

vi.mock('@/lib/load', () => ({ fetchAccount: vi.fn() }));
vi.mock('@/lib/redis', () => ({ default: { enabled: false } }));
vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/permissions', () => ({ canCreateTeam: vi.fn() }));
vi.mock('@/queries/prisma', () => ({ createTeam: vi.fn() }));

const parseRequestMock = vi.mocked(parseRequest);
const fetchAccountMock = vi.mocked(fetchAccount);
const canCreateTeamMock = vi.mocked(canCreateTeam);
const createTeamMock = vi.mocked(createTeam);
const ownerId = '1085fb06-4dd8-4fc8-b94a-c79146fa8947';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CLOUD_MODE', '1');
  parseRequestMock.mockResolvedValue({
    auth: { user: { id: ownerId, role: 'user', isAdmin: false } },
    body: { name: 'Analytics' },
  });
  canCreateTeamMock.mockResolvedValue(true);
  fetchAccountMock.mockResolvedValue({ hasSubscription: true, isPro: true });
  createTeamMock.mockImplementation(async data => data as any);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test('cloud creation passes the authoritative quota to the insertion transaction', async () => {
  const response = await POST(new Request('http://localhost/api/teams', { method: 'POST' }));

  expect(response.status).toBe(200);
  expect(fetchAccountMock).toHaveBeenCalledWith(ownerId);
  expect(createTeamMock).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'Analytics' }),
    ownerId,
    ownerId,
    10,
  );
});

test('a filled quota preserves the existing denial response', async () => {
  createTeamMock.mockRejectedValueOnce(new Error('TEAM_LIMIT_REACHED'));

  const response = await POST(new Request('http://localhost/api/teams', { method: 'POST' }));

  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    error: { message: 'Team limit reached.' },
  });
});

test('unlimited cloud and self-hosted creation keep unrestricted behavior', async () => {
  fetchAccountMock.mockResolvedValueOnce({ hasSubscription: true, isBusiness: true });

  const unlimited = await POST(new Request('http://localhost/api/teams', { method: 'POST' }));
  expect(unlimited.status).toBe(200);
  expect(createTeamMock).toHaveBeenLastCalledWith(expect.anything(), ownerId, ownerId, null);

  vi.stubEnv('CLOUD_MODE', '');
  const selfHosted = await POST(new Request('http://localhost/api/teams', { method: 'POST' }));
  expect(selfHosted.status).toBe(200);
  expect(fetchAccountMock).toHaveBeenCalledTimes(1);
  expect(createTeamMock).toHaveBeenLastCalledWith(expect.anything(), ownerId, ownerId, null);
});
