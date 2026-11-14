import { beforeEach, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { LinkEditForm } from './LinkEditForm';

const mocks = vi.hoisted(() => ({ save: vi.fn(), touch: vi.fn(), toast: vi.fn() }));

vi.mock('@/components/hooks', () => ({
  useConfig: () => ({ cloudMode: false, linksUrl: 'https://short.example' }),
  useLinkQuery: () => ({ data: undefined, isLoading: false }),
  useMessages: () => ({
    t: (message: string) => message,
    labels: {
      name: 'Name',
      destinationUrl: 'Destination URL',
      slug: 'Slug',
      link: 'Link',
      save: 'Save',
      required: 'Required',
      invalidUrl: 'Invalid URL',
    },
    messages: { saved: 'Saved' },
    getErrorMessage: () => undefined,
  }),
}));

vi.mock('@/components/hooks/queries/useUpdateQuery', () => ({
  useUpdateQuery: () => ({
    mutateAsync: mocks.save,
    touch: mocks.touch,
    toast: mocks.toast,
    isPending: false,
  }),
}));

beforeEach(() => {
  mocks.save.mockReset().mockImplementation(async (_data, options) => options.onSuccess());
  mocks.touch.mockReset();
  mocks.toast.mockReset();
});

async function fillForm(user: ReturnType<typeof render>['user'], url: string) {
  await user.type(screen.getByLabelText('Name'), 'Synthetic link');
  await user.type(screen.getByLabelText('Destination URL'), url);
  await user.clear(screen.getByLabelText('Slug'));
  await user.type(screen.getByLabelText('Slug'), 'synthetic-slug');
  await user.click(screen.getByRole('button', { name: 'Save' }));
}

test('link submissions normalize the same HTTP destination accepted by the API', async () => {
  const onSave = vi.fn();
  const { user } = render(<LinkEditForm onSave={onSave} />);
  await fillForm(user, ' https://example.com/docs ');

  await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
  expect(mocks.save).toHaveBeenCalledWith(
    expect.objectContaining({ url: 'https://example.com/docs', slug: 'synthetic-slug' }),
    expect.any(Object),
  );
  expect(onSave).toHaveBeenCalledOnce();
});

test.each([
  'mailto:hi@example.com',
  'myapp://open',
  'javascript:alert(1)',
  'https://user:password@example.com',
])('link forms retain the API protocol and credential boundary for %s', async url => {
  const { user } = render(<LinkEditForm />);
  await fillForm(user, url);

  expect(await screen.findByText('Invalid URL')).toBeInTheDocument();
  expect(mocks.save).not.toHaveBeenCalled();
});

test('surrounding whitespace cannot bypass the existing self-redirect check', async () => {
  const { user } = render(<LinkEditForm />);
  await fillForm(user, ' https://short.example/synthetic-slug ');

  expect(await screen.findByText('Invalid URL')).toBeInTheDocument();
  expect(mocks.save).not.toHaveBeenCalled();
});
