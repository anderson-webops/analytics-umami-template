import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, test, vi } from 'vitest';
import { Heatmap } from './Heatmap';

const useHeatmapQuery = vi.hoisted(() => vi.fn());

vi.mock('@umami/react-zen', () => ({
  Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  Column: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Dialog: () => null,
  Grid: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Heading: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  Icon: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  ListItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Loading: () => null,
  Modal: () => null,
  Row: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@/components/common/ControlledDialog', () => ({ ControlledDialog: () => null }));
vi.mock('@/components/common/IconLabel', () => ({ IconLabel: () => null }));
vi.mock('@/components/common/LoadingPanel', () => ({
  LoadingPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/hooks', () => ({
  useMobile: () => ({ isPhone: true }),
  useHeatmapQuery,
}));

test.each(['click', 'scroll'] as const)(
  '%s heatmap renders recorded data without requesting the tenant origin',
  mode => {
    useHeatmapQuery.mockImplementation(({ urlPath }: { urlPath?: string }) => ({
      data: urlPath
        ? {
            points: [
              {
                x: 12,
                y: 24,
                pageX: 12,
                pageY: 24,
                pageW: 1024,
                pageH: 2048,
                viewportW: 1024,
                viewportH: 768,
                count: 1,
              },
            ],
            scroll: {
              buckets: [
                {
                  depth: 20,
                  sessions: 1,
                  pageW: 1024,
                  pageH: 2048,
                  viewportW: 1024,
                  viewportH: 768,
                },
              ],
              totalSessions: 1,
              pageW: 1024,
              pageH: 2048,
              viewportW: 1024,
              viewportH: 768,
            },
            snapshot: {
              kind: 'iframe',
              id: 'unsafe',
              url: 'http://127.0.0.1:3001/private',
              pageW: 1024,
              pageH: 2048,
              viewportW: 1024,
              viewportH: 768,
            },
          }
        : { pages: [{ urlPath: '/', count: 1, sessions: 1 }] },
      isLoading: false,
      isFetching: false,
    }));

    const { container } = render(
      <Heatmap websiteId="website-1" urlPath="/" onUrlPathChange={vi.fn()} mode={mode} search="" />,
    );

    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByText('1024 px')).toBeInTheDocument();
    expect(
      container.querySelector(mode === 'click' ? '[title="1 click"]' : '[title*="depth"]'),
    ).toBeTruthy();
  },
);
