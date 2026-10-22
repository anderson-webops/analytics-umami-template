import { expect, test, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { UserRecoverySettings } from './UserRecoverySettings';

const mocks = vi.hoisted(() => ({ actor: vi.fn(), target: vi.fn() }));

vi.mock('@/components/hooks', () => ({
  useLoginQuery: () => ({ user: mocks.actor() }),
  useUser: () => mocks.target(),
}));

vi.mock('@/components/modals/LoginRecoveryCodesModal', () => ({
  LoginRecoveryCodesModal: ({ target }: { target: { username: string } }) => (
    <div>Codes for {target.username}</div>
  ),
}));

test('an administrator can open recovery issuance for another account', async () => {
  mocks.actor.mockReturnValue({ id: 'admin-1', isAdmin: true });
  mocks.target.mockReturnValue({ id: 'user-1', username: 'alice' });

  const { user } = render(<UserRecoverySettings userId="user-1" />);

  await user.click(screen.getByRole('button', { name: 'Issue recovery codes' }));
  expect(screen.getByText('Codes for alice')).toBeInTheDocument();
});

test.each([
  { id: 'admin-1', isAdmin: false },
  { id: 'user-1', isAdmin: true },
])('non-admins and owners cannot use administrator issuance', actor => {
  mocks.actor.mockReturnValue(actor);
  mocks.target.mockReturnValue({ id: 'user-1', username: 'alice' });

  render(<UserRecoverySettings userId="user-1" />);

  expect(screen.queryByRole('button', { name: 'Issue recovery codes' })).not.toBeInTheDocument();
});
