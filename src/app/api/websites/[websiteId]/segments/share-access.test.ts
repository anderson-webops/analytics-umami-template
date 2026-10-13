import { beforeEach, expect, test, vi } from 'vitest';
import { ENTITY_TYPE } from '@/lib/constants';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { canDeleteWebsite, canUpdateWebsite, canViewSavedWebsiteSegments } from '@/permissions';
import { canViewSavedWebsiteSegments as checkSavedWebsiteSegments } from '@/permissions/share';
import {
  createSegment,
  deleteSegment,
  getWebsiteSegment,
  getWebsiteSegments,
  updateSegment,
} from '@/queries/prisma';
import {
  DELETE as deleteSavedSegment,
  GET as getSegment,
  POST as updateSavedSegment,
} from './[segmentId]/route';
import { POST as createSavedSegment, GET as getSegments } from './route';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://synthetic:synthetic@127.0.0.1:5432/synthetic';
});

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn(), getQueryFilters: vi.fn() }));
vi.mock('@/permissions', () => ({
  canViewSavedWebsiteSegments: vi.fn(),
  canUpdateWebsite: vi.fn(),
  canDeleteWebsite: vi.fn(),
}));
vi.mock('@/queries/prisma', () => ({
  getWebsiteSegments: vi.fn(),
  getWebsiteSegment: vi.fn(),
  createSegment: vi.fn(),
  updateSegment: vi.fn(),
  deleteSegment: vi.fn(),
}));

const websiteId = 'website-1';
const segmentId = 'segment-1';
const listContext = { params: Promise.resolve({ websiteId }) };
const itemContext = { params: Promise.resolve({ websiteId, segmentId }) };
const baseUrl = `https://analytics.example/api/websites/${websiteId}/segments`;
const shareAuth = {
  shareToken: {
    shareType: ENTITY_TYPE.website,
    websiteId,
    parameters: { overview: true, events: false, allowFilter: true },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseRequest).mockResolvedValue({
    auth: shareAuth,
    query: { type: 'segment' },
    body: { type: 'segment', name: 'Synthetic segment', parameters: {} },
  } as never);
  vi.mocked(getQueryFilters).mockResolvedValue({} as never);
  vi.mocked(canViewSavedWebsiteSegments).mockResolvedValue(false);
  vi.mocked(canUpdateWebsite).mockResolvedValue(false);
  vi.mocked(canDeleteWebsite).mockResolvedValue(false);
  vi.mocked(getWebsiteSegments).mockResolvedValue({ data: [{ id: segmentId }] } as never);
  vi.mocked(getWebsiteSegment).mockResolvedValue({ id: segmentId } as never);
});

test.each(['segment', 'cohort'])('restricted shares cannot list %s definitions', async type => {
  const response = await getSegments(new Request(`${baseUrl}?type=${type}`), listContext);
  expect(response.status).toBe(401);
  expect(canViewSavedWebsiteSegments).toHaveBeenCalledWith(shareAuth, websiteId);
  expect(getWebsiteSegments).not.toHaveBeenCalled();
});

test('restricted shares cannot fetch saved definitions by ID', async () => {
  const response = await getSegment(new Request(`${baseUrl}/${segmentId}`), itemContext);
  expect(response.status).toBe(401);
  expect(getWebsiteSegment).not.toHaveBeenCalled();
});

test('the real share policy rejects a restricted segment read before querying', async () => {
  vi.mocked(canViewSavedWebsiteSegments).mockImplementation(checkSavedWebsiteSegments);

  const response = await getSegments(new Request(`${baseUrl}?type=segment`), listContext);
  expect(response.status).toBe(401);
  expect(getWebsiteSegments).not.toHaveBeenCalled();
});

test('authorized reads retain list, item and not-found behavior', async () => {
  vi.mocked(canViewSavedWebsiteSegments).mockResolvedValue(true);

  expect((await getSegments(new Request(`${baseUrl}?type=segment`), listContext)).status).toBe(200);
  expect(getWebsiteSegments).toHaveBeenCalledWith(websiteId, 'segment', {});
  expect((await getSegment(new Request(`${baseUrl}/${segmentId}`), itemContext)).status).toBe(200);

  vi.mocked(getWebsiteSegment).mockResolvedValue(null);
  expect((await getSegment(new Request(`${baseUrl}/${segmentId}`), itemContext)).status).toBe(404);
});

test('share tokens do not gain mutation access from the saved-read guard', async () => {
  const createResponse = await createSavedSegment(
    new Request(baseUrl, { method: 'POST' }),
    listContext,
  );
  const updateResponse = await updateSavedSegment(
    new Request(`${baseUrl}/${segmentId}`, { method: 'POST' }),
    itemContext,
  );
  const deleteResponse = await deleteSavedSegment(
    new Request(`${baseUrl}/${segmentId}`, { method: 'DELETE' }),
    itemContext,
  );

  expect(createResponse.status).toBe(401);
  expect(updateResponse.status).toBe(401);
  expect(deleteResponse.status).toBe(401);
  expect(createSegment).not.toHaveBeenCalled();
  expect(updateSegment).not.toHaveBeenCalled();
  expect(deleteSegment).not.toHaveBeenCalled();
});
