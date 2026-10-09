import { beforeEach, expect, test, vi } from 'vitest';
import { ENTITY_TYPE } from '@/lib/constants';
import {
  canViewAuthenticatedWebsite,
  canViewSharedWebsite,
  canViewSharedWebsiteFilters,
  canViewWebsiteSection,
} from './share';
import { canViewWebsite } from './website';

vi.mock('./board', () => ({
  canDeleteBoard: vi.fn(),
  canUpdateBoard: vi.fn(),
  canViewBoard: vi.fn(),
}));

vi.mock('./link', () => ({
  canDeleteLink: vi.fn(),
  canUpdateLink: vi.fn(),
  canViewLink: vi.fn(),
}));

vi.mock('./pixel', () => ({
  canDeletePixel: vi.fn(),
  canUpdatePixel: vi.fn(),
  canViewPixel: vi.fn(),
}));

vi.mock('./website', () => ({
  canDeleteWebsite: vi.fn(),
  canUpdateWebsite: vi.fn(),
  canViewWebsite: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(canViewWebsite).mockReset();
  vi.mocked(canViewWebsite).mockResolvedValue(true);
});

const unrelatedUser = {
  id: 'unrelated-user',
  username: 'unrelated',
  role: 'user',
  isAdmin: false,
};

test('signed-in share holders cannot bypass section restrictions', async () => {
  vi.mocked(canViewWebsite).mockImplementation(async auth => !!auth.shareToken?.websiteId);

  const auth = {
    user: unrelatedUser,
    shareToken: {
      shareType: ENTITY_TYPE.website,
      websiteId: 'website-1',
      parameters: { overview: true, goals: false },
    },
  };

  await expect(canViewWebsiteSection(auth, 'website-1', 'goals')).resolves.toBe(false);
  await expect(canViewWebsiteSection(auth, 'website-1', 'overview')).resolves.toBe(true);
});

test('a section-restricted share cannot open full sessions through adjacent sections', async () => {
  vi.mocked(canViewWebsite).mockImplementation(async auth => !!auth.shareToken?.websiteId);

  for (const section of ['events', 'realtime', 'revenue'] as const) {
    const auth = {
      shareToken: {
        shareType: ENTITY_TYPE.website,
        websiteId: 'website-1',
        parameters: { sessions: false, [section]: true },
      },
    };

    await expect(canViewWebsiteSection(auth, 'website-1', 'sessions')).resolves.toBe(false);
    await expect(canViewWebsiteSection(auth, 'website-1', section)).resolves.toBe(true);
  }

  await expect(
    canViewWebsiteSection(
      { shareToken: { shareType: ENTITY_TYPE.website, websiteId: 'website-1', parameters: {} } },
      'website-1',
      'sessions',
    ),
  ).resolves.toBe(true);
});

test('independent website access is not limited by a share section', async () => {
  vi.mocked(canViewWebsite).mockImplementation(async auth => auth.user?.id === 'owner-user');

  await expect(
    canViewWebsiteSection(
      {
        user: { ...unrelatedUser, id: 'owner-user' },
        shareToken: {
          shareType: ENTITY_TYPE.website,
          websiteId: 'website-1',
          parameters: { overview: true, goals: false },
        },
      },
      'website-1',
      'goals',
    ),
  ).resolves.toBe(true);
});

test('signed-in share holders cannot bypass filter restrictions or authenticated-only access', async () => {
  vi.mocked(canViewWebsite).mockImplementation(async auth => !!auth.shareToken?.websiteId);

  const auth = {
    user: unrelatedUser,
    shareToken: {
      shareType: ENTITY_TYPE.website,
      websiteId: 'website-1',
      parameters: { allowFilter: false },
    },
  };

  await expect(canViewSharedWebsiteFilters(auth, 'website-1')).resolves.toBe(false);
  await expect(canViewAuthenticatedWebsite(auth, 'website-1')).resolves.toBe(false);
  await expect(
    canViewSharedWebsiteFilters(
      {
        ...auth,
        shareToken: {
          ...auth.shareToken,
          parameters: { allowFilter: true },
        },
      },
      'website-1',
    ),
  ).resolves.toBe(true);
});

test('board website sections require a request-scoped operation grant', async () => {
  const shareToken = {
    shareType: ENTITY_TYPE.board,
    websiteIds: ['website-1'],
    parameters: {},
  };
  await expect(canViewWebsiteSection({ shareToken }, 'website-1', 'goals')).resolves.toBe(false);
  await expect(
    canViewWebsiteSection(
      { shareToken: { ...shareToken, scopedApiAccess: true } },
      'website-1',
      'goals',
    ),
  ).resolves.toBe(true);
  await expect(
    canViewWebsiteSection(
      { shareToken: { ...shareToken, scopedApiAccess: true } },
      'website-2',
      'goals',
    ),
  ).resolves.toBe(false);
});

test('canViewWebsiteSection respects section flags on website shares', async () => {
  await expect(
    canViewWebsiteSection(
      {
        shareToken: {
          shareType: ENTITY_TYPE.website,
          websiteId: 'website-1',
          parameters: {
            overview: true,
            goals: false,
          },
        },
      },
      'website-1',
      'goals',
    ),
  ).resolves.toBe(false);
});

test('canViewWebsiteSection allows any requested enabled section', async () => {
  await expect(
    canViewWebsiteSection(
      {
        shareToken: {
          shareType: ENTITY_TYPE.website,
          websiteId: 'website-1',
          parameters: {
            overview: true,
            compare: false,
          },
        },
      },
      'website-1',
      ['overview', 'compare'],
    ),
  ).resolves.toBe(true);
});

test('canViewSharedWebsite requires a scoped grant for board shares', async () => {
  const shareToken = {
    shareType: ENTITY_TYPE.board,
    websiteIds: ['website-1'],
    parameters: {},
  };
  await expect(canViewSharedWebsite({ shareToken }, 'website-1')).resolves.toBe(false);
  await expect(
    canViewSharedWebsite(
      {
        shareToken: { ...shareToken, scopedApiAccess: true },
      },
      'website-1',
    ),
  ).resolves.toBe(true);
});

test('canViewSharedWebsiteFilters requires allowFilter for share tokens', async () => {
  await expect(
    canViewSharedWebsiteFilters(
      {
        shareToken: {
          shareType: ENTITY_TYPE.website,
          websiteId: 'website-1',
          parameters: {
            allowFilter: false,
          },
        },
      },
      'website-1',
    ),
  ).resolves.toBe(false);

  await expect(
    canViewSharedWebsiteFilters(
      {
        shareToken: {
          shareType: ENTITY_TYPE.website,
          websiteId: 'website-1',
          parameters: {
            allowFilter: true,
          },
        },
      },
      'website-1',
    ),
  ).resolves.toBe(true);
});

test('canViewWebsiteSection allows validated pixel shares for the shared entity id', async () => {
  await expect(
    canViewWebsiteSection(
      {
        shareToken: {
          shareType: ENTITY_TYPE.pixel,
          pixelId: 'pixel-1',
          scopedApiAccess: true,
          parameters: {
            overview: true,
          },
        },
      },
      'pixel-1',
      'overview',
    ),
  ).resolves.toBe(true);
});

test('canViewWebsiteSection allows validated link shares for the shared entity id', async () => {
  await expect(
    canViewWebsiteSection(
      {
        shareToken: {
          shareType: ENTITY_TYPE.link,
          linkId: 'link-1',
          scopedApiAccess: true,
          parameters: {
            overview: true,
          },
        },
      },
      'link-1',
      'overview',
    ),
  ).resolves.toBe(true);
});
