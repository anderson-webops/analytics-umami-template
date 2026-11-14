import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ENTITY_TYPE } from '@/lib/constants';
import { getBillingAccess, getWebsiteBillingScope } from '@/lib/load';
import { getWebsite } from '@/queries/prisma';
import { canDeleteReport, canUpdateReport, canViewReport, getReportSection } from './report';
import { canViewWebsiteSection } from './share';
import { canDeleteWebsite, canUpdateWebsite, canViewWebsite } from './website';

vi.mock('./share', () => ({
  canViewWebsiteSection: vi.fn(),
}));

vi.mock('./website', () => ({
  canDeleteWebsite: vi.fn(),
  canUpdateWebsite: vi.fn(),
  canViewWebsite: vi.fn(),
}));

vi.mock('@/lib/load', () => ({
  getBillingAccess: vi.fn(),
  getWebsiteBillingScope: vi.fn(),
}));
vi.mock('@/queries/prisma', () => ({ getWebsite: vi.fn() }));

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(getBillingAccess)
    .mockReset()
    .mockResolvedValue({ isPastDue: false } as any);
  vi.mocked(getWebsiteBillingScope)
    .mockReset()
    .mockResolvedValue('scope-1' as any);
  vi.mocked(getWebsite)
    .mockReset()
    .mockResolvedValue({ id: 'website-1' } as any);
  vi.mocked(canViewWebsiteSection).mockReset();
  vi.mocked(canDeleteWebsite).mockReset();
  vi.mocked(canUpdateWebsite).mockReset();
  vi.mocked(canViewWebsite).mockReset();
});

test('canViewReport requires current section access for its author', async () => {
  const auth = { user: { id: 'author-1', username: 'author', role: 'user', isAdmin: false } };
  const report = {
    id: 'report-1',
    userId: 'author-1',
    websiteId: 'website-1',
    type: 'goal',
  } as any;

  vi.mocked(canViewWebsiteSection).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

  await expect(canViewReport(auth, report)).resolves.toBe(false);
  await expect(canViewReport(auth, report)).resolves.toBe(true);
  expect(canViewWebsiteSection).toHaveBeenCalledWith(auth, 'website-1', 'goals');
});

test('canViewReport requires current website access for an unsectioned author report', async () => {
  const auth = { user: { id: 'author-1', username: 'author', role: 'user', isAdmin: false } };
  const report = {
    id: 'report-1',
    userId: 'author-1',
    websiteId: 'website-1',
    type: 'heatmap',
  } as any;

  vi.mocked(canViewWebsite).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

  await expect(canViewReport(auth, report)).resolves.toBe(false);
  await expect(canViewReport(auth, report)).resolves.toBe(true);
  expect(canViewWebsite).toHaveBeenCalledWith({ user: auth.user }, 'website-1');
});

test('canUpdateReport requires current website access even for its author', async () => {
  const auth = { user: { id: 'author-1', username: 'author', role: 'user', isAdmin: false } };
  const report = { id: 'report-1', userId: 'author-1', websiteId: 'website-1' } as any;

  vi.mocked(canViewWebsite).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

  await expect(canUpdateReport(auth, report)).resolves.toBe(false);
  await expect(canUpdateReport(auth, report)).resolves.toBe(true);
  expect(canViewWebsite).toHaveBeenCalledWith({ user: auth.user }, 'website-1');
  expect(canUpdateWebsite).not.toHaveBeenCalled();
});

test('canDeleteReport requires current delete permission even for its author', async () => {
  const auth = { user: { id: 'author-1', username: 'author', role: 'user', isAdmin: false } };
  const report = { id: 'report-1', userId: 'author-1', websiteId: 'website-1' } as any;

  vi.mocked(canDeleteWebsite).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

  await expect(canDeleteReport(auth, report)).resolves.toBe(false);
  await expect(canDeleteReport(auth, report)).resolves.toBe(true);
  await expect(
    canDeleteReport({ user: { ...auth.user, role: 'view-only' } }, report),
  ).resolves.toBe(false);
  expect(canDeleteWebsite).toHaveBeenCalledWith(auth, 'website-1');
  expect(canViewWebsite).not.toHaveBeenCalled();
});

test('a globally view-only report author cannot mutate despite website access', async () => {
  const auth = {
    user: { id: 'author-1', username: 'author', role: 'view-only', isAdmin: false },
  };
  const report = { id: 'report-1', userId: 'author-1', websiteId: 'website-1' } as any;
  vi.mocked(canViewWebsite).mockResolvedValue(true);
  vi.mocked(canUpdateWebsite).mockResolvedValue(true);
  vi.mocked(canDeleteWebsite).mockResolvedValue(true);

  await expect(canUpdateReport(auth, report)).resolves.toBe(false);
  await expect(canDeleteReport(auth, report)).resolves.toBe(false);
  expect(canViewWebsite).not.toHaveBeenCalled();
  expect(canUpdateWebsite).not.toHaveBeenCalled();
  expect(canDeleteWebsite).not.toHaveBeenCalled();
});

test('getReportSection maps saved report types to share sections', () => {
  expect(getReportSection('goal')).toBe('goals');
  expect(getReportSection('funnel')).toBe('funnels');
  expect(getReportSection('journey')).toBe('journeys');
  expect(getReportSection('revenue')).toBe('revenue');
  expect(getReportSection('heatmap')).toBe(null);
});

test('canViewReport allows board shares to fetch included saved goal reports', async () => {
  vi.mocked(canViewWebsiteSection).mockResolvedValue(true);

  await expect(
    canViewReport(
      {
        shareToken: {
          shareType: ENTITY_TYPE.board,
          websiteIds: ['website-1'],
          parameters: {},
        },
      },
      {
        id: 'report-1',
        userId: 'owner-1',
        websiteId: 'website-1',
        type: 'goal',
      } as any,
    ),
  ).resolves.toBe(true);
});

test('canViewReport respects share section flags for saved funnel and goal reports', async () => {
  vi.mocked(canViewWebsiteSection).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

  await expect(
    canViewReport(
      {
        shareToken: {
          shareType: ENTITY_TYPE.website,
          websiteId: 'website-1',
          parameters: {
            overview: true,
            funnels: false,
            goals: false,
          },
        },
      },
      {
        id: 'report-1',
        userId: 'owner-1',
        websiteId: 'website-1',
        type: 'funnel',
      } as any,
    ),
  ).resolves.toBe(false);

  await expect(
    canViewReport(
      {
        shareToken: {
          shareType: ENTITY_TYPE.website,
          websiteId: 'website-1',
          parameters: {
            overview: true,
            funnels: false,
            goals: true,
          },
        },
      },
      {
        id: 'report-2',
        userId: 'owner-1',
        websiteId: 'website-1',
        type: 'goal',
      } as any,
    ),
  ).resolves.toBe(true);
});

test('canViewReport denies share-token access to report types without a share section', async () => {
  await expect(
    canViewReport(
      {
        shareToken: {
          shareType: ENTITY_TYPE.website,
          websiteId: 'website-1',
          parameters: {},
        },
      },
      {
        id: 'report-1',
        userId: 'owner-1',
        websiteId: 'website-1',
        type: 'heatmap',
      } as any,
    ),
  ).resolves.toBe(false);
});

test('canViewReport falls back to website access for authenticated users', async () => {
  vi.mocked(canViewWebsite).mockResolvedValue(true);

  await expect(
    canViewReport(
      {
        user: {
          id: 'user-1',
          username: 'user',
          role: 'user',
          isAdmin: false,
        },
      },
      {
        id: 'report-1',
        userId: 'owner-1',
        websiteId: 'website-1',
        type: 'heatmap',
      } as any,
    ),
  ).resolves.toBe(true);
});

test('canViewReport does not upgrade a share into authenticated report access', async () => {
  vi.mocked(canViewWebsite).mockImplementation(async auth => !!auth.shareToken?.websiteId);

  const user = {
    id: 'unrelated-user',
    username: 'unrelated',
    role: 'user',
    isAdmin: false,
  };

  await expect(
    canViewReport(
      {
        user,
        shareToken: {
          shareType: ENTITY_TYPE.website,
          websiteId: 'website-1',
          parameters: {},
        },
      },
      {
        id: 'report-1',
        userId: 'owner-1',
        websiteId: 'website-1',
        type: 'heatmap',
      } as any,
    ),
  ).resolves.toBe(false);
  expect(canViewWebsite).toHaveBeenCalledWith({ user }, 'website-1');
});

test.each(['read', 'update', 'delete'])(
  'report authors retain current permissions and billing checks for %s',
  async operation => {
    vi.stubEnv('CLOUD_MODE', '1');
    vi.mocked(getBillingAccess).mockResolvedValue({ isPastDue: true } as any);
    vi.mocked(canViewWebsiteSection).mockResolvedValue(true);
    vi.mocked(canViewWebsite).mockResolvedValue(true);
    vi.mocked(canDeleteWebsite).mockResolvedValue(true);
    const auth = { user: { id: 'author-1', username: 'author', role: 'user', isAdmin: false } };
    const report = {
      id: 'report-1',
      userId: 'author-1',
      websiteId: 'website-1',
      type: 'goal',
    } as any;
    const permission =
      operation === 'read'
        ? canViewReport
        : operation === 'update'
          ? canUpdateReport
          : canDeleteReport;
    await expect(permission(auth, report)).resolves.toBe(false);
    vi.mocked(getBillingAccess).mockResolvedValue({ isPastDue: false } as any);
    await expect(permission(auth, report)).resolves.toBe(true);
  },
);

test('a paid account cannot recover revoked website access through report authorship', async () => {
  vi.stubEnv('CLOUD_MODE', '1');
  vi.mocked(canViewWebsiteSection).mockResolvedValue(false);
  vi.mocked(canViewWebsite).mockResolvedValue(false);
  vi.mocked(canDeleteWebsite).mockResolvedValue(false);
  const auth = { user: { id: 'author-1', username: 'author', role: 'user', isAdmin: false } };
  const report = {
    id: 'report-1',
    userId: 'author-1',
    websiteId: 'website-1',
    type: 'goal',
  } as any;
  await expect(canViewReport(auth, report)).resolves.toBe(false);
  await expect(canUpdateReport(auth, report)).resolves.toBe(false);
  await expect(canDeleteReport(auth, report)).resolves.toBe(false);
  expect(getBillingAccess).not.toHaveBeenCalled();
});
