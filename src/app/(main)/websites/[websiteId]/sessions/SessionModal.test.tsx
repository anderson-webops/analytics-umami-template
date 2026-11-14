import { beforeEach, expect, test, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { SessionModal } from './SessionModal';

const state = vi.hoisted(() => ({
  session: 'session-1' as string | undefined,
  pathname: '/share/private/website',
  share: { parameters: { sessions: true } },
  replace: vi.fn(),
  profile: vi.fn(),
}));
vi.mock('@/components/hooks', () => ({
  useMessages: () => ({ t: (value: string) => value, labels: { session: 'Session' } }),
  useMobile: () => ({ isMobile: false }),
  useNavigation: () => ({
    pathname: state.pathname,
    query: { session: state.session },
    router: { replace: state.replace },
    updateParams: () => '/without-session',
  }),
  useShare: () => state.share,
}));
vi.mock('@/app/(main)/websites/[websiteId]/sessions/SessionProfile', () => ({
  SessionProfile: (props: any) => {
    state.profile(props);
    return (
      <div data-test="session-profile" data-replays={String(props.showReplays)}>
        {props.sessionId}
      </div>
    );
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.session = 'session-1';
  state.pathname = '/share/private/website';
  state.share = { parameters: { sessions: true } };
});

test('a share without Sessions never mounts the private profile, including forwarded open props', () => {
  state.share.parameters.sessions = false;
  render(<SessionModal websiteId="website-1" isOpen />);
  expect(state.profile).not.toHaveBeenCalled();
  expect(screen.queryByTestId('session-profile')).not.toBeInTheDocument();
});

test('an enabled share can open its profile while replay controls remain hidden', () => {
  render(<SessionModal websiteId="website-1" />);
  expect(screen.getByTestId('session-profile')).toHaveAttribute('data-replays', 'false');
  expect(state.profile).toHaveBeenCalledWith(
    expect.objectContaining({ websiteId: 'website-1', sessionId: 'session-1' }),
  );
});

test('ordinary site navigation retains replay controls and missing session ids stay closed', () => {
  state.pathname = '/websites/website-1';
  const view = render(<SessionModal websiteId="website-1" />);
  expect(screen.getByTestId('session-profile')).toHaveAttribute('data-replays', 'true');
  view.unmount();
  state.profile.mockClear();
  state.session = undefined;
  render(<SessionModal websiteId="website-1" isOpen />);
  expect(state.profile).not.toHaveBeenCalled();
});
