import { expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { LoginRecoveryCodesModal } from './LoginRecoveryCodesModal';

const mocks = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock('@/components/hooks', () => ({
  useMessages: () => ({
    t: (value: string) => value,
    labels: {
      currentPassword: 'Current password',
      required: 'Required',
      cancel: 'Cancel',
      close: 'Close',
    },
    getErrorMessage: () => undefined,
  }),
  useUpdateQuery: () => ({ mutateAsync: mocks.mutateAsync, error: null, isPending: false }),
}));

test('requires the current password and acknowledgement before hiding one-time codes', async () => {
  const recoveryCode = `UR-${'A'.repeat(64)}`;
  const onClose = vi.fn();
  const onRotated = vi.fn();
  mocks.mutateAsync.mockReset().mockResolvedValue({ recoveryCodes: [recoveryCode] });
  const { user } = render(<LoginRecoveryCodesModal onClose={onClose} onRotated={onRotated} />);

  await user.click(screen.getByRole('button', { name: 'Generate codes' }));
  expect(mocks.mutateAsync).not.toHaveBeenCalled();

  await user.type(screen.getByLabelText('Current password'), 'synthetic-password');
  await user.click(screen.getByRole('button', { name: 'Generate codes' }));

  await waitFor(() =>
    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      password: 'synthetic-password',
    }),
  );
  expect(onRotated).toHaveBeenCalledOnce();
  expect(screen.getByText(recoveryCode)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: 'I saved these codes' }));
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledOnce();
});

test('administrator issuance identifies the target and requires delivery acknowledgement', async () => {
  const recoveryCode = `UR-${'B'.repeat(64)}`;
  const onClose = vi.fn();
  mocks.mutateAsync.mockReset().mockResolvedValue({ recoveryCodes: [recoveryCode] });
  const { user } = render(
    <LoginRecoveryCodesModal
      target={{ id: '00000000-0000-4000-8000-000000000002', username: 'alice' }}
      onClose={onClose}
    />,
  );

  await user.type(screen.getByLabelText('Current password'), 'synthetic-admin-password');
  await user.click(screen.getByRole('button', { name: 'Generate codes' }));

  await waitFor(() =>
    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      password: 'synthetic-admin-password',
      userId: '00000000-0000-4000-8000-000000000002',
    }),
  );
  expect(screen.getByText(/Give these to alice through a verified private channel/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: 'I delivered these codes' }));
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledOnce();
});
