import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { TwoFactorSetupModal } from './TwoFactorSetupModal';
import { TwoFactorSuccessModal } from './TwoFactorSuccessModal';

const mocks = vi.hoisted(() => ({
  initiate: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@/components/hooks', () => ({
  useMessages: () => ({
    t: (value: string) => value,
    labels: new Proxy({}, { get: (_, key) => String(key) }),
    messages: new Proxy({}, { get: (_, key) => String(key) }),
    getErrorMessage: (error: Error) => error?.message,
  }),
  useUpdateQuery: (path: string) =>
    path.endsWith('/initiate')
      ? { mutateAsync: mocks.initiate, isPending: false }
      : { mutate: vi.fn(), mutateAsync: mocks.confirm, isPending: false },
}));

beforeEach(() => {
  mocks.initiate.mockReset().mockResolvedValue({
    qrCodeDataUrl: 'data:image/png;base64,SYNTHETIC-TOTP-QR',
    manualKey: 'SYNTHETIC-TOTP-KEY',
  });
  mocks.confirm.mockReset().mockResolvedValue({ backupCodes: ['SYNTHETIC-RECOVERY-CODE'] });
});

test('the enrollment dialog blocks its QR image and manual key from replay', async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TwoFactorSetupModal required={true} />
    </QueryClientProvider>,
  );

  expect(mocks.initiate).not.toHaveBeenCalled();
  expect(screen.queryByText('SYNTHETIC-TOTP-KEY')).toBeNull();
  fireEvent.change(screen.getByLabelText('currentPassword'), {
    target: { value: 'current-password' },
  });
  fireEvent.click(screen.getByText('continue'));

  const manualKey = await screen.findByText('SYNTHETIC-TOTP-KEY');
  expect(mocks.initiate).toHaveBeenCalledWith({ password: 'current-password' });
  const privateDialog = manualKey.closest('.rr-block');
  expect(privateDialog).not.toBeNull();
  expect(privateDialog?.querySelector('img')).toHaveAttribute(
    'src',
    'data:image/png;base64,SYNTHETIC-TOTP-QR',
  );
});

test('confirmation rechecks the password used to initiate setup', async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TwoFactorSetupModal required={true} />
    </QueryClientProvider>,
  );

  fireEvent.change(screen.getByLabelText('currentPassword'), {
    target: { value: 'current-password' },
  });
  fireEvent.click(screen.getByText('continue'));
  await screen.findByText('SYNTHETIC-TOTP-KEY');

  fireEvent.paste(screen.getByLabelText('Digit 1'), {
    clipboardData: { getData: () => '123456' },
  });

  await waitFor(() => {
    expect(mocks.confirm).toHaveBeenCalledWith({ token: '123456', password: 'current-password' });
  });
});

test('required enrollment can restart with a current password after confirmation fails', async () => {
  mocks.confirm.mockRejectedValueOnce(new Error('Incorrect password'));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TwoFactorSetupModal required={true} />
    </QueryClientProvider>,
  );

  fireEvent.change(screen.getByLabelText('currentPassword'), {
    target: { value: 'old-password' },
  });
  fireEvent.click(screen.getByText('continue'));
  await screen.findByText('SYNTHETIC-TOTP-KEY');
  fireEvent.paste(screen.getByLabelText('Digit 1'), {
    clipboardData: { getData: () => '123456' },
  });
  await screen.findByText('Incorrect password');

  fireEvent.click(screen.getByText('back'));
  expect(screen.queryByText('SYNTHETIC-TOTP-KEY')).toBeNull();
  fireEvent.change(screen.getByLabelText('currentPassword'), {
    target: { value: 'new-password' },
  });
  fireEvent.click(screen.getByText('continue'));
  await screen.findByText('SYNTHETIC-TOTP-KEY');
  expect(mocks.initiate).toHaveBeenLastCalledWith({ password: 'new-password' });

  fireEvent.paste(screen.getByLabelText('Digit 1'), {
    clipboardData: { getData: () => '654321' },
  });
  await waitFor(() => {
    expect(mocks.confirm).toHaveBeenLastCalledWith({
      token: '654321',
      password: 'new-password',
    });
  });
});

test('the recovery-code dialog blocks displayed codes from replay', () => {
  render(<TwoFactorSuccessModal backupCodes={['SYNTHETIC-RECOVERY-CODE']} onClose={vi.fn()} />);

  expect(screen.getByText('SYNTHETIC-RECOVERY-CODE').closest('.rr-block')).not.toBeNull();
});
