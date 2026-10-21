import { beforeEach, expect, test, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { WebsiteReplaySettings } from './WebsiteReplaySettings';

const { mockUseWebsite, mockMutateAsync } = vi.hoisted(() => ({
  mockUseWebsite: vi.fn(),
  mockMutateAsync: vi.fn(async () => null),
}));

vi.mock('@/components/hooks', () => ({
  useWebsite: () => mockUseWebsite(),
  useSubscription: () => ({ hasFeature: () => true, cloudMode: false, isLoading: false }),
  useUpdateQuery: () => ({
    mutateAsync: mockMutateAsync,
    touch: vi.fn(),
    toast: vi.fn(),
    isPending: false,
  }),
  useMessages: () => ({
    t: (value: string) => value,
    labels: {
      replays: 'Replays',
      heatmaps: 'Heatmaps',
      recorderCode: 'Recorder code',
      sampleRate: 'Sample rate',
      maskLevel: 'Mask level',
      maxDuration: 'Maximum duration',
      blockSelector: 'Block selector',
      save: 'Save',
    },
    messages: { saved: 'Saved', trackingCode: 'Tracking code' },
  }),
}));

beforeEach(() => {
  mockUseWebsite.mockReset();
  mockMutateAsync.mockClear();
});

test('does not offer inert recorder code before the site endpoint is configured', () => {
  mockUseWebsite.mockReturnValue({
    teamId: null,
    replayConfig: { replayEnabled: true, maskLevel: 'strict' },
  });

  render(<WebsiteReplaySettings websiteId="synthetic-website" />);

  expect(screen.getByRole('textbox', { name: 'Site consent endpoint path' })).toHaveValue('');
  expect(screen.queryByDisplayValue(/data-permit-endpoint/)).not.toBeInTheDocument();
});

test('offers recorder code containing the configured site endpoint', () => {
  mockUseWebsite.mockReturnValue({
    teamId: null,
    replayConfig: {
      replayEnabled: true,
      maskLevel: 'strict',
      permitEndpoint: '/analytics-permit',
    },
  });

  render(<WebsiteReplaySettings websiteId="synthetic-website" />);

  expect(screen.getByDisplayValue(/data-permit-endpoint="\/analytics-permit"/)).toBeInTheDocument();
  expect(screen.getByDisplayValue(/data-website-id="synthetic-website"/)).toBeInTheDocument();
});

test('withholds replay code while the saved mask level is not strict', () => {
  mockUseWebsite.mockReturnValue({
    teamId: null,
    replayConfig: {
      replayEnabled: true,
      maskLevel: 'moderate',
      permitEndpoint: '/analytics-permit',
    },
  });

  render(<WebsiteReplaySettings websiteId="synthetic-website" />);

  expect(screen.queryByDisplayValue(/data-permit-endpoint/)).not.toBeInTheDocument();
  expect(
    screen.getByText('Select strict masking and save before using replay code.'),
  ).toBeInTheDocument();
});

test('typing and saving a site endpoint produces the copyable code', async () => {
  mockUseWebsite.mockReturnValue({
    teamId: null,
    replayConfig: { replayEnabled: true, maskLevel: 'strict' },
  });

  const { user } = render(<WebsiteReplaySettings websiteId="synthetic-website" />);
  await user.type(
    screen.getByRole('textbox', { name: 'Site consent endpoint path' }),
    '/analytics-permit',
  );

  expect(screen.getByDisplayValue(/data-permit-endpoint="\/analytics-permit"/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(mockMutateAsync).toHaveBeenCalledWith(
    { replayConfig: expect.objectContaining({ permitEndpoint: '/analytics-permit' }) },
    expect.anything(),
  );
});

test('clearing the site endpoint sends an explicit removal and hides recorder code', async () => {
  mockUseWebsite.mockReturnValue({
    teamId: null,
    replayConfig: {
      replayEnabled: true,
      maskLevel: 'strict',
      permitEndpoint: '/analytics-permit',
    },
  });

  const { user } = render(<WebsiteReplaySettings websiteId="synthetic-website" />);
  await user.clear(screen.getByRole('textbox', { name: 'Site consent endpoint path' }));

  expect(screen.queryByDisplayValue(/data-permit-endpoint/)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(mockMutateAsync).toHaveBeenCalledWith(
    { replayConfig: expect.objectContaining({ permitEndpoint: null }) },
    expect.anything(),
  );
});
