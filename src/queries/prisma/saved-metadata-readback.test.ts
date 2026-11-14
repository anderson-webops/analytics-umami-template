import { beforeEach, expect, test, vi } from 'vitest';
import { getAnnotation, getWebsiteAnnotation, getWebsiteAnnotations } from './annotation';
import { getSegment, getWebsiteSegment, getWebsiteSegments } from './segment';

const mocks = vi.hoisted(() => ({
  annotationUnique: vi.fn(),
  annotationFirst: vi.fn(),
  segmentUnique: vi.fn(),
  segmentFirst: vi.fn(),
  replica: vi.fn(),
  paged: vi.fn(),
  search: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      $primary: () => ({
        annotation: { findUnique: mocks.annotationUnique, findFirst: mocks.annotationFirst },
        segment: { findUnique: mocks.segmentUnique, findFirst: mocks.segmentFirst },
      }),
      annotation: { findUnique: mocks.replica, findFirst: mocks.replica },
      segment: { findUnique: mocks.replica, findFirst: mocks.replica },
    },
    pagedQuery: mocks.paged,
    getSearchParameters: mocks.search,
  },
}));

const websiteId = '11111111-1111-4111-8111-111111111111';
const recordId = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.annotationUnique.mockResolvedValue({ id: recordId });
  mocks.annotationFirst.mockResolvedValue({ id: recordId });
  mocks.segmentUnique.mockResolvedValue({ id: recordId });
  mocks.segmentFirst.mockResolvedValue({ id: recordId });
  mocks.paged.mockResolvedValue({ data: [], count: 0 });
  mocks.search.mockReturnValue({});
});

test('annotation reads and site-scoped reads use current primary data', async () => {
  await getAnnotation(recordId);
  await getWebsiteAnnotation(websiteId, recordId);

  expect(mocks.annotationUnique).toHaveBeenCalledWith({ where: { id: recordId } });
  expect(mocks.annotationFirst).toHaveBeenCalledWith({ where: { id: recordId, websiteId } });
  expect(mocks.replica).not.toHaveBeenCalled();
});

test('saved definition reads retain their primary website binding', async () => {
  await getSegment(recordId);
  await getWebsiteSegment(websiteId, recordId);

  expect(mocks.segmentUnique).toHaveBeenCalledWith({ where: { id: recordId } });
  expect(mocks.segmentFirst).toHaveBeenCalledWith({ where: { id: recordId, websiteId } });
  expect(mocks.replica).not.toHaveBeenCalled();
});

test('annotation and saved-definition page/count pairs use the primary', async () => {
  await getWebsiteAnnotations(websiteId, { page: 1, pageSize: 20 });
  await getWebsiteSegments(websiteId, 'segment', { page: 2, pageSize: 20 });

  expect(mocks.paged).toHaveBeenCalledWith(
    'annotation',
    expect.objectContaining({ where: { websiteId } }),
    { page: 1, pageSize: 20 },
    { usePrimary: true },
  );
  expect(mocks.paged).toHaveBeenCalledWith(
    'segment',
    expect.objectContaining({ where: { websiteId, type: 'segment' } }),
    { page: 2, pageSize: 20 },
    { usePrimary: true },
  );
});

test('malformed saved-definition identifiers never reach a primary lookup', async () => {
  expect(await getWebsiteSegment('invalid-id', recordId)).toBeNull();
  expect(mocks.segmentFirst).not.toHaveBeenCalled();
});
