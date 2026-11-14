import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { RealtimeLog } from './RealtimeLog';

const state = vi.hoisted(() => ({
  share: { parameters: { sessions: true } },
  rowComponent: null as unknown,
  query: vi.fn(),
}));
vi.mock('@umami/react-zen', () => ({
  Box: ({ children, ...props }: any) => (
    <span role={props.role} aria-label={props['aria-label']} data-testid={props['data-testid']}>
      {children}
    </span>
  ),
  Column: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Heading: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  Row: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SearchField: () => <input aria-label="Search" />,
  StatusLight: () => <span>active</span>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('react-window', () => ({
  List: ({ rowComponent: Component, rowCount, rowProps }: any) => {
    state.rowComponent = Component;
    return (
      <>
        {Array.from({ length: rowCount }, (_, index) => (
          <Component key={index} index={index} style={{}} {...rowProps} />
        ))}
      </>
    );
  },
}));
vi.mock('@/app/(main)/websites/[websiteId]/sessions/SessionModal', () => ({
  SessionModal: () => null,
}));
vi.mock('@/components/common/Avatar', () => ({ Avatar: () => <span>avatar</span> }));
vi.mock('@/components/common/Empty', () => ({ Empty: () => <span>empty</span> }));
vi.mock('@/components/common/IconLabel', () => ({
  IconLabel: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/components/common/Link', () => ({
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));
vi.mock('@/components/input/FilterButtons', () => ({ FilterButtons: () => null }));
vi.mock('@/components/hooks/useFormat', () => ({
  useFormat: () => ({ formatValue: (value: string) => value }),
}));
vi.mock('@/components/hooks', () => ({
  useWebsite: () => ({ id: 'website-1' }),
  useMobile: () => ({ isPhone: true }),
  useShare: () => state.share,
  useLocale: () => ({ locale: 'en-US' }),
  useCountryNames: () => ({ countryNames: { US: 'United States' } }),
  useTimezone: () => ({ formatTimezoneDate: () => '12:00' }),
  useNavigation: () => ({ updateParams: ({ session }: any) => `/sessions/${session}` }),
  useMessages: () => ({
    t: Object.assign((value: string) => value, { rich: () => 'event' }),
    labels: { online: 'Online', activity: 'Activity' },
    messages: {},
  }),
}));
const timestamp = Date.UTC(2026, 10, 14, 12);
const events = [
  {
    sessionId: 'recent',
    createdAt: new Date(timestamp - 60000).toISOString(),
    __type: 'pageview',
    urlPath: '/recent',
    hostname: 'example.test',
  },
  {
    sessionId: 'older',
    createdAt: new Date(timestamp - 600000).toISOString(),
    __type: 'pageview',
    urlPath: '/older',
    hostname: 'example.test',
  },
];
beforeEach(() => {
  state.share = { parameters: { sessions: true } };
  state.rowComponent = null;
});

test('shows online status from the latest session observation and preserves stable virtual rows', () => {
  const view = render(<RealtimeLog data={{ events, timestamp }} />);
  expect(screen.getAllByRole('img', { name: 'Online' })).toHaveLength(1);
  expect(screen.getByRole('img', { name: 'Online' })).toBeInTheDocument();
  const component = state.rowComponent;
  view.rerender(<RealtimeLog data={{ events: [...events], timestamp: timestamp + 600000 }} />);
  expect(state.rowComponent).toBe(component);
  expect(screen.queryByRole('img', { name: 'Online' })).not.toBeInTheDocument();
});

test('a share without Sessions keeps status indicators without adding private session links', () => {
  state.share.parameters.sessions = false;
  const { container } = render(<RealtimeLog data={{ events, timestamp }} />);
  expect(screen.getByRole('img', { name: 'Online' })).toBeInTheDocument();
  expect(container.querySelector('a[href^="/sessions/"]')).toBeNull();
  expect(container.querySelectorAll('a[href^="//example.test"]')).toHaveLength(2);
});
