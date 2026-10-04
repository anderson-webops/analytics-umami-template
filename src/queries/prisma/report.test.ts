import { beforeEach, expect, test, vi } from 'vitest';
import { PERMISSIONS, ROLES } from '@/lib/constants';
import {
  assertActorCanAccessEntities,
  assertActorCanMutateEntity,
  runSerializable,
} from './authorization';
import { deleteReport } from './report';

const transaction = vi.hoisted(() => ({
  user: { findFirst: vi.fn() },
  report: { findUnique: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({ default: { client: { report: {} } } }));
vi.mock('./authorization', () => ({
  assertActorCanAccessEntities: vi.fn(),
  assertActorCanMutateEntity: vi.fn(),
  runSerializable: vi.fn(async operation => operation(transaction)),
}));

beforeEach(() => {
  vi.clearAllMocks();
  transaction.user.findFirst.mockResolvedValue({ role: ROLES.user });
  transaction.report.findUnique.mockResolvedValue({
    userId: 'author-1',
    websiteId: 'website-1',
  });
  transaction.report.delete.mockResolvedValue({ id: 'report-1' });
});

test('deleteReport denies a report author whose website access was revoked', async () => {
  vi.mocked(assertActorCanAccessEntities).mockRejectedValueOnce(
    new Error('ENTITY_REFERENCE_NOT_AUTHORIZED'),
  );

  await expect(deleteReport('report-1', 'author-1')).rejects.toThrow('REPORT_ACTOR_NOT_AUTHORIZED');
  expect(runSerializable).toHaveBeenCalledOnce();
  expect(assertActorCanAccessEntities).toHaveBeenCalledWith(transaction, 'author-1', [
    { entityType: 'website', entityId: 'website-1' },
  ]);
  expect(assertActorCanMutateEntity).not.toHaveBeenCalled();
  expect(transaction.report.delete).not.toHaveBeenCalled();
});

test('deleteReport preserves deletion for an author with current read-only website access', async () => {
  transaction.user.findFirst.mockResolvedValue({ role: ROLES.viewOnly });

  await expect(deleteReport('report-1', 'author-1')).resolves.toEqual({ id: 'report-1' });
  expect(assertActorCanAccessEntities).toHaveBeenCalledWith(transaction, 'author-1', [
    { entityType: 'website', entityId: 'website-1' },
  ]);
  expect(assertActorCanMutateEntity).not.toHaveBeenCalled();
  expect(transaction.report.delete).toHaveBeenCalledWith({ where: { id: 'report-1' } });
});

test('deleteReport preserves website deletion permission for a different author', async () => {
  transaction.report.findUnique.mockResolvedValue({
    userId: 'someone-else',
    websiteId: 'website-1',
  });

  await expect(deleteReport('report-1', 'user-1')).resolves.toEqual({ id: 'report-1' });
  expect(assertActorCanAccessEntities).not.toHaveBeenCalled();
  expect(assertActorCanMutateEntity).toHaveBeenCalledWith(
    transaction,
    'user-1',
    'website',
    'website-1',
    PERMISSIONS.websiteDelete,
  );
});

test('deleteReport preserves administrator deletion', async () => {
  transaction.user.findFirst.mockResolvedValue({ role: ROLES.admin });

  await expect(deleteReport('report-1', 'admin-1')).resolves.toEqual({ id: 'report-1' });
  expect(assertActorCanAccessEntities).not.toHaveBeenCalled();
  expect(assertActorCanMutateEntity).not.toHaveBeenCalled();
  expect(transaction.report.delete).toHaveBeenCalledWith({ where: { id: 'report-1' } });
});
