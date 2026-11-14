import { beforeEach, expect, test, vi } from 'vitest';
import { updateWebsiteRequestSchema } from '@/app/api/websites/request-schema';
import { render, screen, waitFor } from '@/test/render';
import { WebsiteEditForm } from './WebsiteEditForm';

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  touch: vi.fn(),
  toast: vi.fn(),
  useUpdateQuery: vi.fn(),
  useWebsite: vi.fn(),
}));

vi.mock('@/components/hooks', () => ({
  useWebsite: () => mocks.useWebsite(),
  useUpdateQuery: (endpoint: string) => {
    mocks.useUpdateQuery(endpoint);
    return { mutateAsync: mocks.mutateAsync, touch: mocks.touch, toast: mocks.toast };
  },
  useMessages: () => ({
    t: (message: string) => message,
    labels: {
      websiteId: 'Website ID',
      name: 'Name',
      domain: 'Domain',
      save: 'Save',
      required: 'Required',
    },
    messages: { saved: 'Saved', invalidDomain: 'Invalid domain' },
    getErrorMessage: () => '',
  }),
}));

const website = {
  id: '5e094f67-660c-48e3-9cde-995a230bcfa1',
  name: 'Original website',
  domain: 'original.example',
  shareId: 'existing-public-share',
  teamId: '7ac5fe6c-91c0-432e-aab0-41c9c407f860',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  resetAt: null,
  replayConfig: { replayEnabled: true, maskLevel: 'strict' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useWebsite.mockReturnValue({ ...website });
  mocks.mutateAsync.mockImplementation(async (_payload, callbacks) => {
    await callbacks.onSuccess();
    return null;
  });
});

test('submits only editable fields and preserves share and replay policy', async () => {
  const onSave = vi.fn();
  const { user } = render(<WebsiteEditForm websiteId={website.id} onSave={onSave} />);
  const name = screen.getByTestId('input-name').querySelector('input') as HTMLInputElement;
  const domain = screen.getByTestId('input-domain').querySelector('input') as HTMLInputElement;
  await user.clear(name);
  await user.type(name, 'Updated website');
  await user.clear(domain);
  await user.type(domain, 'updated.example');
  await user.click(screen.getByTestId('button-submit'));

  await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledOnce());
  const [payload] = mocks.mutateAsync.mock.calls[0];
  expect(payload).toEqual({ name: 'Updated website', domain: 'updated.example' });
  expect(updateWebsiteRequestSchema.safeParse(payload).success).toBe(true);
  expect(mocks.useUpdateQuery).toHaveBeenCalledWith(`/websites/${website.id}`);
  expect(mocks.toast).toHaveBeenCalledWith('Saved');
  expect(mocks.touch).toHaveBeenCalledWith('websites');
  expect(mocks.touch).toHaveBeenCalledWith(`website:${website.id}`);
  expect(onSave).toHaveBeenCalledOnce();
});

test.each([
  { field: 'name', value: '', error: 'Required' },
  { field: 'domain', value: '<invalid>', error: 'Invalid domain' },
])('retains validation for $field', async ({ field, value, error }) => {
  const { user } = render(<WebsiteEditForm websiteId={website.id} />);
  const input = screen.getByTestId(`input-${field}`).querySelector('input') as HTMLInputElement;
  await user.clear(input);
  if (value) await user.type(input, value);
  await user.click(screen.getByTestId('button-submit'));

  await waitFor(() => expect(screen.getByText(error)).toBeInTheDocument());
  expect(mocks.mutateAsync).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
});
