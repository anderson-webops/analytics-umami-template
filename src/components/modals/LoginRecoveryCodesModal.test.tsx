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

test('preparation alone does not confirm readiness; saved-copy proof is confirmed by the server', async () => {
  const recoveryCode = `UR-${'A'.repeat(64)}`;
  const onClose = vi.fn();
  const onRotated = vi.fn();
  mocks.mutateAsync
    .mockReset()
    .mockResolvedValueOnce({ recoveryCodes: [recoveryCode] })
    .mockResolvedValueOnce({ confirmed: true });
  const { user } = render(<LoginRecoveryCodesModal onClose={onClose} onRotated={onRotated} />);

  await user.click(screen.getByRole('button', { name: 'Generate codes' }));
  expect(mocks.mutateAsync).not.toHaveBeenCalled();

  await user.type(screen.getByLabelText('Current password'), 'synthetic-password');
  await user.click(screen.getByRole('button', { name: 'Generate codes' }));

  await waitFor(() =>
    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      action: 'prepare',
      password: 'synthetic-password',
    }),
  );
  expect(onRotated).not.toHaveBeenCalled();
  expect(screen.getByText(recoveryCode)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Confirm codes' })).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: 'I saved these codes' }));
  expect(onRotated).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText('Current password'), 'synthetic-password');
  await user.type(screen.getByLabelText('Code from your saved copy'), recoveryCode);
  await user.click(screen.getByRole('button', { name: 'Confirm codes' }));
  await waitFor(() =>
    expect(mocks.mutateAsync).toHaveBeenLastCalledWith({
      action: 'confirm',
      password: 'synthetic-password',
      recoveryCode,
      saved: true,
    }),
  );
  expect(onRotated).toHaveBeenCalledOnce();
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
      action: 'prepare',
      password: 'synthetic-admin-password',
      userId: '00000000-0000-4000-8000-000000000002',
    }),
  );
  expect(screen.getByText(/Give these to alice privately/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Confirm codes' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: 'I delivered these codes' }));
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledOnce();
});

test('an owner can confirm privately received codes without generating another batch', async () => {
  const recoveryCode = `UR-${'C'.repeat(64)}`;
  const onClose = vi.fn();
  mocks.mutateAsync.mockReset().mockResolvedValue({ confirmed: true });
  const { user } = render(<LoginRecoveryCodesModal onClose={onClose} />);
  await user.click(screen.getByRole('button', { name: 'Confirm received codes' }));
  expect(mocks.mutateAsync).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText('Current password'), 'owner-password');
  await user.type(screen.getByLabelText('Code from your saved copy'), recoveryCode);
  await user.click(screen.getByRole('checkbox', { name: 'I saved these codes' }));
  await user.click(screen.getByRole('button', { name: 'Confirm codes' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.mutateAsync).toHaveBeenCalledExactlyOnceWith({
    action: 'confirm',
    password: 'owner-password',
    recoveryCode,
    saved: true,
  });
});

test('failed confirmation retains the visible codes and never announces activation', async () => {
  const recoveryCode = `UR-${'D'.repeat(64)}`;
  const onClose = vi.fn();
  const onRotated = vi.fn();
  mocks.mutateAsync
    .mockReset()
    .mockResolvedValueOnce({ recoveryCodes: [recoveryCode] })
    .mockRejectedValueOnce(new Error('unavailable'));
  const { user } = render(<LoginRecoveryCodesModal onClose={onClose} onRotated={onRotated} />);
  await user.type(screen.getByLabelText('Current password'), 'owner-password');
  await user.click(screen.getByRole('button', { name: 'Generate codes' }));
  await screen.findByText(recoveryCode);
  await user.type(screen.getByLabelText('Current password'), 'owner-password');
  await user.type(screen.getByLabelText('Code from your saved copy'), recoveryCode);
  await user.click(screen.getByRole('checkbox', { name: 'I saved these codes' }));
  await user.click(screen.getByRole('button', { name: 'Confirm codes' }));
  await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(2));
  expect(onClose).not.toHaveBeenCalled();
  expect(onRotated).not.toHaveBeenCalled();
  expect(screen.getByText(recoveryCode)).toBeVisible();
});
