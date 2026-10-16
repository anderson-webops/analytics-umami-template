import { beforeEach, expect, test, vi } from 'vitest';
import { parseRequest } from '@/lib/request';
import { canViewBoardEntities, hasValidBoardReports } from '@/permissions';
import { createBoard, getBoard, updateBoard } from '@/queries/prisma';
import { POST } from './route';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/permissions', () => ({
  canViewBoardEntities: vi.fn(),
  hasValidBoardReports: vi.fn(),
}));
vi.mock('@/queries/prisma', () => ({
  createBoard: vi.fn(),
  getBoard: vi.fn(),
  updateBoard: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(parseRequest).mockReset();
  vi.mocked(canViewBoardEntities).mockReset();
  vi.mocked(hasValidBoardReports).mockReset();
  vi.mocked(createBoard).mockReset();
  vi.mocked(getBoard).mockReset();
  vi.mocked(updateBoard).mockReset();
});

test('dashboard writes reject a globally view-only owner before reading or mutating state', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: {
      user: { id: 'user-1', username: 'viewer', role: 'view-only', isAdmin: false },
    },
    body: { name: 'Changed' },
  } as any);

  const response = await POST(
    new Request('https://example.test/api/dashboard', { method: 'POST' }),
  );

  expect(response.status).toBe(401);
  expect(getBoard).not.toHaveBeenCalled();
  expect(createBoard).not.toHaveBeenCalled();
  expect(updateBoard).not.toHaveBeenCalled();
});

test('dashboard writes still allow an ordinary user to update their own board', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: {
      authType: 'session',
      user: { id: 'user-1', username: 'user', role: 'user', isAdmin: false },
    },
    body: { name: 'Changed' },
  } as any);
  vi.mocked(getBoard).mockResolvedValue({
    id: 'user-1',
    userId: 'user-1',
    type: 'dashboard',
  } as any);
  vi.mocked(hasValidBoardReports).mockResolvedValue(true);
  vi.mocked(updateBoard).mockResolvedValue({ id: 'user-1', name: 'Changed' } as any);

  const response = await POST(
    new Request('https://example.test/api/dashboard', { method: 'POST' }),
  );

  expect(response.status).toBe(200);
  expect(updateBoard).toHaveBeenCalledWith(
    'user-1',
    { name: 'Changed', description: undefined },
    'user-1',
    expect.objectContaining({
      authType: 'session',
      user: expect.objectContaining({ id: 'user-1' }),
    }),
  );
});

test('a name-only API-key dashboard edit preserves shared-board references', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { authType: 'api-key', user: { id: 'user-1', role: 'user', isAdmin: false } },
    body: { name: 'Changed' },
  } as any);
  vi.mocked(getBoard).mockResolvedValue({
    id: 'user-1',
    userId: 'user-1',
    type: 'dashboard',
  } as any);
  vi.mocked(hasValidBoardReports).mockResolvedValue(true);
  vi.mocked(updateBoard).mockResolvedValue({ id: 'user-1', name: 'Changed' } as any);

  const response = await POST(
    new Request('https://example.test/api/dashboard', { method: 'POST' }),
  );

  expect(response.status).toBe(200);
  expect(updateBoard).toHaveBeenCalledWith(
    'user-1',
    { name: 'Changed', description: undefined },
    'user-1',
    expect.objectContaining({
      authType: 'api-key',
      user: expect.objectContaining({ id: 'user-1' }),
    }),
  );
});

test('a new dashboard still starts with empty parameters when none are supplied', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { authType: 'session', user: { id: 'user-1', role: 'user', isAdmin: false } },
    body: { name: 'My dashboard' },
  } as any);
  vi.mocked(getBoard).mockResolvedValue(null);
  vi.mocked(hasValidBoardReports).mockResolvedValue(true);
  vi.mocked(createBoard).mockResolvedValue({ id: 'user-1' } as any);

  const response = await POST(
    new Request('https://example.test/api/dashboard', { method: 'POST' }),
  );

  expect(response.status).toBe(200);
  expect(createBoard).toHaveBeenCalledWith(
    {
      id: 'user-1',
      type: 'dashboard',
      userId: 'user-1',
      parameters: {},
      name: 'My dashboard',
      description: undefined,
    },
    'user-1',
    {
      isPersonalDashboard: true,
      auth: expect.objectContaining({
        authType: 'session',
        user: expect.objectContaining({ id: 'user-1' }),
      }),
    },
  );
});

test('dashboard writes pass API-key identity to the shared-board transaction', async () => {
  vi.mocked(parseRequest).mockResolvedValue({
    auth: { authType: 'api-key', user: { id: 'user-1', role: 'user', isAdmin: false } },
    body: { parameters: { websiteId: 'site-1' } },
  } as any);
  vi.mocked(getBoard).mockResolvedValue({
    id: 'user-1',
    userId: 'user-1',
    type: 'dashboard',
  } as any);
  vi.mocked(canViewBoardEntities).mockResolvedValue(true);
  vi.mocked(hasValidBoardReports).mockResolvedValue(true);
  vi.mocked(updateBoard).mockRejectedValue(new Error('SHARED_BOARD_REQUIRES_SESSION'));

  const response = await POST(
    new Request('https://example.test/api/dashboard', { method: 'POST' }),
  );

  expect(response.status).toBe(401);
  expect(updateBoard).toHaveBeenCalledWith(
    'user-1',
    { name: undefined, description: undefined, parameters: { websiteId: 'site-1' } },
    'user-1',
    expect.objectContaining({
      authType: 'api-key',
      user: expect.objectContaining({ id: 'user-1' }),
    }),
  );
});
