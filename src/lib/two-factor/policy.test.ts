import { beforeEach, expect, test, vi } from 'vitest';
import { getTwoFactorRequiredReason } from './policy';

const mocks = vi.hoisted(() => ({ requirement: vi.fn() }));

vi.mock('./requirement', () => ({ getTwoFactorRequirement: mocks.requirement }));

beforeEach(() => {
  mocks.requirement.mockReset();
});

test.each(['global', 'user', 'team', null])(
  'the upstream policy interface preserves the current %s requirement',
  async reason => {
    mocks.requirement.mockResolvedValue({ reason, globalRequired: reason === 'global' });

    expect(await getTwoFactorRequiredReason('user-1')).toBe(reason);
    expect(mocks.requirement).toHaveBeenCalledExactlyOnceWith('user-1', undefined);
  },
);

test('the upstream interface retains the supplied mutation transaction', async () => {
  const transaction = {} as never;
  mocks.requirement.mockResolvedValue({ reason: 'team', globalRequired: false });

  expect(await getTwoFactorRequiredReason('user-1', transaction)).toBe('team');
  expect(mocks.requirement).toHaveBeenCalledExactlyOnceWith('user-1', transaction);
});
