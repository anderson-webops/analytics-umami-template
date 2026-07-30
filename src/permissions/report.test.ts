import { beforeEach, expect, test, vi } from 'vitest';
import { canViewReport, getReportShareSection } from './report';
import { canViewWebsiteSection } from './share';
import { canViewWebsite } from './website';

vi.mock('./share', () => ({
  canViewWebsiteSection: vi.fn(),
}));

vi.mock('./website', () => ({
  canDeleteWebsite: vi.fn(),
  canUpdateWebsite: vi.fn(),
  canViewWebsite: vi.fn(),
}));

const report = {
  id: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  websiteId: '00000000-0000-4000-8000-000000000003',
  type: 'goal',
} as any;

beforeEach(() => {
  vi.mocked(canViewWebsite).mockReset();
  vi.mocked(canViewWebsiteSection).mockReset();
});

test('maps saved report types to their public-share sections', () => {
  expect(getReportShareSection('goal')).toBe('goals');
  expect(getReportShareSection('funnel')).toBe('funnels');
  expect(getReportShareSection('journey')).toBe('journeys');
  expect(getReportShareSection('heatmap')).toBeNull();
});

test('requires the matching section for public access to a saved report', async () => {
  vi.mocked(canViewWebsiteSection).mockResolvedValue(false);

  await expect(
    canViewReport(
      {
        shareToken: {
          websiteId: report.websiteId,
          parameters: { overview: true, goals: false },
        },
      } as any,
      report,
    ),
  ).resolves.toBe(false);

  expect(canViewWebsiteSection).toHaveBeenCalledWith(expect.any(Object), report.websiteId, 'goals');
});

test('does not expose authenticated-only saved report types to public shares', async () => {
  await expect(
    canViewReport(
      {
        shareToken: {
          websiteId: report.websiteId,
          parameters: {},
        },
      } as any,
      { ...report, type: 'heatmap' },
    ),
  ).resolves.toBe(false);

  expect(canViewWebsiteSection).not.toHaveBeenCalled();
});

test('retains normal entity authorization for authenticated users', async () => {
  vi.mocked(canViewWebsite).mockResolvedValue(true);

  await expect(
    canViewReport(
      {
        user: {
          id: '00000000-0000-4000-8000-000000000004',
          isAdmin: false,
        },
      } as any,
      report,
    ),
  ).resolves.toBe(true);
});
