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
    auth: { user: { id: 'user-1', username: 'user', role: 'user', isAdmin: false } },
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
    { name: 'Changed', description: undefined, parameters: {} },
    'user-1',
  );
});
