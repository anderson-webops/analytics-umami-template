import { beforeEach, expect, test, vi } from 'vitest';
import { findBoard, getBoard, getTeamBoards } from './board';

const { pagedQuery, primaryFindUnique, replicaFindUnique } = vi.hoisted(() => ({
  pagedQuery: vi.fn(),
  primaryFindUnique: vi.fn(),
  replicaFindUnique: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    getSearchParameters: vi.fn(() => ({})),
    pagedQuery,
    client: {
      $primary: () => ({ board: { findUnique: primaryFindUnique } }),
      board: { findUnique: replicaFindUnique },
    },
  },
}));

beforeEach(() => {
  pagedQuery.mockReset();
  primaryFindUnique.mockReset();
  replicaFindUnique.mockReset();
});

test('team board lists use current primary rows and count', async () => {
  await getTeamBoards('team-1');

  expect(pagedQuery).toHaveBeenCalledWith(
    'board',
    expect.objectContaining({ where: expect.objectContaining({ teamId: 'team-1' }) }),
    expect.anything(),
    { usePrimary: true },
  );
});

test('board share read uses current primary parameters instead of stale replica membership', async () => {
  const boardId = '508ad3c6-1993-41aa-a07c-44ff09a64686';
  const criteria = { where: { id: boardId } };
  replicaFindUnique.mockResolvedValue({ id: boardId, parameters: { rows: ['removed'] } });
  primaryFindUnique.mockResolvedValue({ id: boardId, parameters: { rows: [] } });

  await expect(getBoard(boardId)).resolves.toMatchObject({ parameters: { rows: [] } });
  expect(primaryFindUnique).toHaveBeenCalledWith(criteria);
  expect(replicaFindUnique).not.toHaveBeenCalled();
});

test('board lookup retains requested criteria and missing-board behavior', async () => {
  const criteria = { where: { id: 'missing-board' } };
  primaryFindUnique.mockResolvedValue(null);

  await expect(findBoard(criteria)).resolves.toBeNull();
  expect(primaryFindUnique).toHaveBeenCalledWith(criteria);
  expect(replicaFindUnique).not.toHaveBeenCalled();
});
