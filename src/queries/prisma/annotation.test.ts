import { beforeEach, expect, test, vi } from 'vitest';
import { PERMISSIONS } from '@/lib/constants';
import { createAnnotation, deleteAnnotation, updateAnnotation } from './annotation';
import { assertActorCanMutateEntity, runSerializable } from './authorization';

const transaction = vi.hoisted(() => ({
  annotation: {
    create: vi.fn(),
    delete: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('@/lib/prisma', () => ({ default: { client: { annotation: {} } } }));
vi.mock('./authorization', () => ({
  assertActorCanMutateEntity: vi.fn(),
  runSerializable: vi.fn(async operation => operation(transaction)),
}));

beforeEach(() => {
  vi.clearAllMocks();
  transaction.annotation.findFirst.mockResolvedValue({ id: 'annotation-1' });
});

test('creation rechecks website update permission in the write transaction', async () => {
  const data = {
    id: 'annotation-1',
    websiteId: 'website-1',
    userId: 'user-1',
    date: new Date('2026-09-21T00:00:00.000Z'),
    allDay: true,
    note: 'Release',
  };

  await createAnnotation(data, 'user-1');

  expect(runSerializable).toHaveBeenCalledOnce();
  expect(assertActorCanMutateEntity).toHaveBeenCalledWith(
    transaction,
    'user-1',
    'website',
    'website-1',
    PERMISSIONS.websiteUpdate,
  );
  expect(transaction.annotation.create).toHaveBeenCalledWith({ data });
});

test('update scopes the annotation to the authorized website before writing', async () => {
  const data = { note: 'Updated' };

  await updateAnnotation('website-1', 'annotation-1', data, 'user-1');

  expect(assertActorCanMutateEntity).toHaveBeenCalledWith(
    transaction,
    'user-1',
    'website',
    'website-1',
    PERMISSIONS.websiteUpdate,
  );
  expect(transaction.annotation.findFirst).toHaveBeenCalledWith({
    where: { id: 'annotation-1', websiteId: 'website-1' },
    select: { id: true },
  });
  expect(transaction.annotation.update).toHaveBeenCalledWith({
    where: { id: 'annotation-1' },
    data,
  });
});

test('delete fails closed when the annotation is not in the authorized website', async () => {
  transaction.annotation.findFirst.mockResolvedValue(null);

  await expect(deleteAnnotation('website-1', 'annotation-2', 'user-1')).rejects.toThrow(
    'ANNOTATION_NOT_FOUND',
  );

  expect(assertActorCanMutateEntity).toHaveBeenCalledWith(
    transaction,
    'user-1',
    'website',
    'website-1',
    PERMISSIONS.websiteUpdate,
  );
  expect(transaction.annotation.delete).not.toHaveBeenCalled();
});
