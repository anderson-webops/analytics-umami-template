import { beforeEach, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { PasswordEditForm } from './PasswordEditForm';

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), change: vi.fn() }));
const codes = Array.from({ length: 8 }, (_, index) => `UR-${(index + 1).toString(16).repeat(64)}`);

vi.mock('@/components/hooks', () => ({
  useMessages: () => ({
    t: (value: string) => value,
    labels: {
      currentPassword: 'Current password',
      newPassword: 'New password',
      confirmPassword: 'Confirm password',
      required: 'Required',
      save: 'Save',
      cancel: 'Cancel',
    },
    messages: { noMatchPassword: 'Passwords must match', minPasswordLength: 'Password too short' },
    getErrorMessage: () => undefined,
  }),
  useUpdateQuery: (url: string) => ({
    mutateAsync: url === '/me/password' ? mocks.change : mocks.prepare,
    error: null,
    isPending: false,
  }),
}));

beforeEach(() => {
  mocks.prepare.mockReset().mockResolvedValue({ recoveryCodes: codes });
  mocks.change.mockReset().mockImplementation(async (_body, options) => {
    await options.onSuccess();
    return { id: 'owner' };
  });
});

async function prepare(user: ReturnType<typeof render>['user']) {
  await user.type(screen.getByLabelText('Current password'), 'synthetic-current-password');
  await user.type(screen.getByLabelText('New password'), 'synthetic-new-password-1');
  await user.type(screen.getByLabelText('Confirm password'), 'synthetic-new-password-1');
  await user.click(screen.getByRole('button', { name: 'Prepare recovery codes' }));
  await waitFor(() => expect(screen.getByText(codes[0])).toBeVisible());
}

test('password replacement waits for preparation and saved-copy proof, with replay masking', async () => {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const { user } = render(<PasswordEditForm onSave={onSave} onClose={onClose} />);
  await prepare(user);
  expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith({
    action: 'prepare',
    password: 'synthetic-current-password',
  });
  expect(mocks.change).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(screen.getByText(codes[0]).closest('form')).toHaveClass('rr-block');
  await user.click(screen.getByRole('checkbox', { name: 'I saved these codes' }));
  await user.type(screen.getByLabelText('Code from your saved copy'), codes[0]);
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  expect(onClose).toHaveBeenCalledOnce();
  expect(mocks.change).toHaveBeenCalledWith(
    {
      currentPassword: 'synthetic-current-password',
      newPassword: 'synthetic-new-password-1',
      recoveryCode: codes[0],
      saved: true,
    },
    expect.any(Object),
  );
});

test('cancelling a prepared change leaves password activation to the server', async () => {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const { user } = render(<PasswordEditForm onSave={onSave} onClose={onClose} />);
  await prepare(user);
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(onSave).not.toHaveBeenCalled();
  expect(mocks.change).not.toHaveBeenCalled();
});

test('a rejected proof keeps the saved codes visible without reporting success', async () => {
  mocks.change.mockRejectedValue(new Error('Synthetic expired preparation'));
  const onSave = vi.fn();
  const onClose = vi.fn();
  const { user } = render(<PasswordEditForm onSave={onSave} onClose={onClose} />);
  await prepare(user);
  await user.click(screen.getByRole('checkbox', { name: 'I saved these codes' }));
  await user.type(screen.getByLabelText('Code from your saved copy'), codes[0]);
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(mocks.change).toHaveBeenCalledOnce());
  expect(screen.getByText(codes[0])).toBeVisible();
  expect(onSave).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});
