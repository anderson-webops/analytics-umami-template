import { beforeEach, expect, test, vi } from 'vitest';
import { consumeOtp } from './replay-prevention';

const queryRaw = vi.hoisted(() => vi.fn());

vi.mock('@/lib/crypto', () => ({ uuid: () => 'otp-use-id' }));
vi.mock('@/lib/prisma', () => ({ default: { client: { $queryRaw: queryRaw } } }));

beforeEach(() => {
  queryRaw.mockReset();
});

test('atomically consumes a previously unused or expired OTP', async () => {
  queryRaw.mockResolvedValue([{ id: 'otp-use-id' }]);

  await expect(consumeOtp('00000000-0000-4000-8000-000000000001', '123456')).resolves.toBe(true);

  const sql = queryRaw.mock.calls[0][0].join(' ');
  expect(sql).toContain('ON CONFLICT ("user_id", "otp")');
  expect(sql).toContain('WHERE "two_factor_otp_used"."expires_at" <= CURRENT_TIMESTAMP');
  expect(sql).toContain('RETURNING "id"');
});

test('rejects a concurrent replay when the conditional upsert returns no row', async () => {
  queryRaw.mockResolvedValue([]);

  await expect(consumeOtp('00000000-0000-4000-8000-000000000001', '123456')).resolves.toBe(false);
});

test('uses an existing transaction when the OTP protects another state change', async () => {
  const transactionQuery = vi.fn().mockResolvedValue([{ id: 'otp-use-id' }]);

  await expect(
    consumeOtp('00000000-0000-4000-8000-000000000001', '123456', {
      $queryRaw: transactionQuery,
    } as any),
  ).resolves.toBe(true);
  expect(transactionQuery).toHaveBeenCalledOnce();
  expect(queryRaw).not.toHaveBeenCalled();
});
