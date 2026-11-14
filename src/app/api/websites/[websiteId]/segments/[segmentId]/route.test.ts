import { beforeEach, expect, test, vi } from 'vitest';
import { parseRequest } from '@/lib/request';
import { canUpdateWebsite } from '@/permissions';
import { getWebsiteSegment, updateSegment } from '@/queries/prisma';
import { POST } from './route';

vi.mock('@/lib/request', () => ({
  parseRequest: vi.fn(),
}));

vi.mock('@/permissions', () => ({
  canDeleteWebsite: vi.fn(),
  canUpdateWebsite: vi.fn(),
  canViewSharedWebsiteFilters: vi.fn(),
}));

vi.mock('@/queries/prisma', () => ({
  deleteSegment: vi.fn(),
  getWebsiteSegment: vi.fn(),
  updateSegment: vi.fn(),
}));

const parseRequestMock = vi.mocked(parseRequest);
const canUpdateWebsiteMock = vi.mocked(canUpdateWebsite);
const getWebsiteSegmentMock = vi.mocked(getWebsiteSegment);
const updateSegmentMock = vi.mocked(updateSegment);

function post(body: Record<string, any>) {
  parseRequestMock.mockImplementation(async (_request, schema) => {
    if (!schema) throw new Error('Missing saved segment request schema');
    const result = schema.safeParse(body);
    return result.success
      ? { auth: { user: { id: 'user-1' } }, body: result.data }
      : { error: () => Response.json({ error: { code: 'bad-request' } }, { status: 400 }) };
  });

  return POST(
    new Request('http://localhost/api/websites/website-1/segments/segment-1', { method: 'POST' }),
    { params: Promise.resolve({ websiteId: 'website-1', segmentId: 'segment-1' }) },
  );
}

beforeEach(() => {
  parseRequestMock.mockReset();
  canUpdateWebsiteMock.mockReset().mockResolvedValue(true);
  getWebsiteSegmentMock.mockReset().mockResolvedValue({ id: 'segment-1' } as any);
  updateSegmentMock.mockReset().mockResolvedValue({ id: 'segment-1' } as any);
});

// Updates follow the same rules as creation, so an edit can't strip what the forms require.
test('requires a name', async () => {
  await post({ type: 'segment', name: 'Everyone', parameters: {} });
  const schema = parseRequestMock.mock.calls[0][1] as {
    safeParse: (value: unknown) => { success: boolean };
  };

  expect(schema.safeParse({ type: 'segment', name: '', parameters: {} }).success).toBe(false);
});

test.each([
  ['no action', { dateRange: '30day' }],
  ['empty action value', { dateRange: '30day', action: { type: 'event', value: '' } }],
  ['no date range', { action: { type: 'event', value: 'signup' } }],
])('rejects a cohort update with %s', async (_label, parameters) => {
  const response = await post({ type: 'cohort', name: 'Signups', parameters });

  expect(response.status).toBe(400);
  expect(updateSegmentMock).not.toHaveBeenCalled();
});

test('updates a complete cohort', async () => {
  const response = await post({
    type: 'cohort',
    name: 'Signups',
    parameters: { dateRange: '30day', action: { type: 'event', value: 'signup' } },
  });

  expect(response.status).toBe(200);
  expect(updateSegmentMock).toHaveBeenCalledTimes(1);
  expect(updateSegmentMock).toHaveBeenCalledWith(
    'website-1',
    'segment-1',
    expect.objectContaining({ type: 'cohort', name: 'Signups' }),
    'user-1',
    expect.objectContaining({ user: expect.objectContaining({ id: 'user-1' }) }),
  );
});

test('cohort updates reject segment-only session properties before mutation', async () => {
  const response = await post({
    type: 'cohort',
    name: 'Signups',
    parameters: {
      dateRange: '30day',
      action: { type: 'event', value: 'signup' },
      sessionPropertyFilters: [],
    },
  });

  expect(response.status).toBe(400);
  expect(updateSegmentMock).not.toHaveBeenCalled();
});
