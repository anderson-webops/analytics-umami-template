import { beforeEach, expect, test, vi } from 'vitest';
import { parseRequest } from '@/lib/request';
import {
  canUpdateBoard,
  canViewBoard,
  canViewBoardEntities,
  hasValidBoardReports,
} from '@/permissions';
import { getBoard, updateBoard } from '@/queries/prisma';
import { GET, POST } from './route';

const boardId = '508ad3c6-1993-41aa-a07c-44ff09a64686';
const allowedWebsite = '7b2728e9-f4b2-4a2a-9827-697b24bbf78a';
const deniedWebsite = '2f6c32dc-c181-42d6-8b26-99b709b38c22';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ default: { client: {} } }));
vi.mock('@/permissions', () => ({
  canDeleteBoard: vi.fn(),
  canUpdateBoard: vi.fn(),
  canViewBoard: vi.fn(),
  canViewBoardEntities: vi.fn(),
  hasValidBoardReports: vi.fn(),
}));
vi.mock('@/queries/prisma', () => ({
  deleteBoard: vi.fn(),
  getBoard: vi.fn(),
  getLink: vi.fn(),
  getPixel: vi.fn(),
  getWebsite: vi.fn(),
  updateBoard: vi.fn(),
}));

const request = new Request(`https://analytics.example/api/boards/${boardId}`);
const params = { params: Promise.resolve({ boardId }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBoard).mockResolvedValue({
    id: boardId,
    type: 'mixed',
    name: 'Public board',
    description: '',
    userId: 'owner',
    teamId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    parameters: {
      websiteId: deniedWebsite,
      rows: [
        {
          id: boardId,
          columns: [
            { id: allowedWebsite, component: { type: 'WebsiteChart', websiteId: allowedWebsite } },
            { id: deniedWebsite, component: { type: 'WebsiteChart', websiteId: deniedWebsite } },
            {
              id: '41bd03bd-3aaf-46ea-ae95-1f60567b3680',
              component: {
                type: 'MetricsTable',
                websiteId: allowedWebsite,
                props: { type: 'country', params: { websiteId: deniedWebsite } },
              },
            },
          ],
        },
      ],
    },
  } as Awaited<ReturnType<typeof getBoard>>);
});

test('a public board response does not disclose ungranted references in parameters', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { shareToken: { boardId, websiteIds: [allowedWebsite] } },
  } as Awaited<ReturnType<typeof parseRequest>>);
  vi.mocked(canViewBoard).mockImplementation(async auth => auth.shareToken?.boardId === boardId);

  const response = await GET(request, params);
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.parameters.websiteId).toBeUndefined();
  expect(body.parameters.rows[0].columns).toHaveLength(1);
  expect(body.parameters.rows[0].columns[0].component.websiteId).toBe(allowedWebsite);
  expect(JSON.stringify(body)).not.toContain(deniedWebsite);
});

test('an authenticated board owner retains the complete private board response', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { user: { id: 'owner' } },
  } as Awaited<ReturnType<typeof parseRequest>>);
  vi.mocked(canViewBoard).mockResolvedValue(true);

  const response = await GET(request, params);
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.parameters.websiteId).toBe(deniedWebsite);
  expect(body.parameters.rows[0].columns).toHaveLength(3);
  expect(body.parameters.rows[0].columns[2].component.props.params.websiteId).toBe(deniedWebsite);
});

test('a board update passes API-key identity to the shared-board transaction', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { authType: 'api-key', user: { id: 'owner', role: 'user', isAdmin: false } },
    body: { parameters: { websiteId: allowedWebsite } },
  } as Awaited<ReturnType<typeof parseRequest>>);
  vi.mocked(canUpdateBoard).mockResolvedValue(true);
  vi.mocked(canViewBoardEntities).mockResolvedValue(true);
  vi.mocked(hasValidBoardReports).mockResolvedValue(true);
  vi.mocked(updateBoard).mockRejectedValue(new Error('SHARED_BOARD_REQUIRES_SESSION'));

  const response = await POST(new Request(request.url, { method: 'POST' }), params);

  expect(response.status).toBe(401);
  expect(updateBoard).toHaveBeenCalledWith(
    boardId,
    {
      type: undefined,
      name: undefined,
      description: undefined,
      parameters: { websiteId: allowedWebsite },
    },
    'owner',
    'api-key',
  );
});
