import { beforeEach, expect, test, vi } from 'vitest';
import { reserveTwoFactorAttempt, resetRateLimit } from './rate-limit';

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  deleteMany: vi.fn(),
  replicaQueryRaw: vi.fn(),
}));

vi.mock('@/lib/crypto', () => ({ uuid: () => 'synthetic-attempt-id' }));
vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      $queryRaw: mocks.replicaQueryRaw,
      $primary: () => ({
        $queryRaw: mocks.queryRaw,
        twoFactorRateLimit: {
          deleteMany: mocks.deleteMany,
        },
      }),
    },
  },
}));

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
});

test('reserves a verification attempt atomically on the primary', async () => {
  const lockedUntil = new Date('2026-10-03T12:15:00.000Z');
  mocks.queryRaw.mockResolvedValue([{ lockedUntilEpoch: lockedUntil.getTime() / 1000 }]);

  await expect(reserveTwoFactorAttempt('00000000-0000-4000-8000-000000000001')).resolves.toEqual({
    allowed: true,
    lockedUntil,
  });

  const sql = mocks.queryRaw.mock.calls[0][0].join(' ');
  expect(sql).toContain('ON CONFLICT ("user_id") DO UPDATE');
  expect(sql).toContain('"two_factor_rate_limit"."attempts" <');
  expect(sql).toContain('"two_factor_rate_limit"."locked_until" <= clock_timestamp()');
  expect(mocks.replicaQueryRaw).not.toHaveBeenCalled();
  expect(sql).toContain('EXTRACT(EPOCH FROM "locked_until")::float8');
});

test('returns the primary lock state when admission is denied', async () => {
  const lockedUntil = new Date('2026-10-03T12:15:00.000Z');
  mocks.queryRaw
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ lockedUntilEpoch: lockedUntil.getTime() / 1000 }]);

  await expect(reserveTwoFactorAttempt('00000000-0000-4000-8000-000000000001')).resolves.toEqual({
    allowed: false,
    lockedUntil,
  });

  expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
  expect(mocks.queryRaw.mock.calls[1][0].join(' ')).toContain('FROM "two_factor_rate_limit"');
  expect(mocks.replicaQueryRaw).not.toHaveBeenCalled();
});

test('clears successful authentication state on the primary', async () => {
  await resetRateLimit('00000000-0000-4000-8000-000000000001');

  expect(mocks.deleteMany).toHaveBeenCalledWith({
    where: { userId: '00000000-0000-4000-8000-000000000001' },
  });
});
