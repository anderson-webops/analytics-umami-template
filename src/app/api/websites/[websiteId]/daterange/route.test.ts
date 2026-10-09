import { beforeEach, expect, test, vi } from 'vitest';
import { ENTITY_TYPE } from '@/lib/constants';
import { parseRequest } from '@/lib/request';
import { canViewShareSection, SHARE_SECTIONS } from '@/lib/share';
import { canViewSharedWebsite, canViewWebsiteSection } from '@/permissions';
import { getWebsiteDateRange } from '@/queries/sql';
import { GET } from './route';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/permissions', () => ({ canViewSharedWebsite: vi.fn(), canViewWebsiteSection: vi.fn() }));
vi.mock('@/queries/sql', () => ({ getWebsiteDateRange: vi.fn() }));

const websiteId = 'website-1';
const request = new Request(`https://analytics.example/api/websites/${websiteId}/daterange`);
const context = { params: Promise.resolve({ websiteId }) };

function setAuth(auth: Record<string, unknown>) {
  vi.mocked(parseRequest).mockResolvedValue({ auth } as never);
}

async function getDateRange() {
  return GET(request, context);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(canViewSharedWebsite).mockResolvedValue(true);
  vi.mocked(canViewWebsiteSection).mockImplementation(async (auth, _websiteId, sections) =>
    auth?.user ? true : canViewShareSection(auth?.shareToken?.parameters, sections),
  );
  vi.mocked(getWebsiteDateRange).mockResolvedValue(null);
});

test('denies a website share with every analytics section disabled before querying', async () => {
  setAuth({
    shareToken: {
      shareType: ENTITY_TYPE.website,
      websiteId,
      parameters: Object.fromEntries(SHARE_SECTIONS.map(section => [section, false])),
    },
  });

  expect((await getDateRange()).status).toBe(401);
  expect(getWebsiteDateRange).not.toHaveBeenCalled();
});

test('allows website shares with an enabled section or legacy sectionless parameters', async () => {
  for (const parameters of [{ events: true }, {}]) {
    setAuth({ shareToken: { shareType: ENTITY_TYPE.website, websiteId, parameters } });
    expect((await getDateRange()).status).toBe(200);
  }

  expect(getWebsiteDateRange).toHaveBeenCalledTimes(2);
});

test('preserves board, link, and pixel grants already checked during token parsing', async () => {
  for (const shareType of [ENTITY_TYPE.board, ENTITY_TYPE.link, ENTITY_TYPE.pixel]) {
    setAuth({
      shareToken: {
        shareType,
        websiteId,
        parameters: Object.fromEntries(SHARE_SECTIONS.map(section => [section, false])),
      },
    });
    expect((await getDateRange()).status).toBe(200);
  }

  expect(canViewWebsiteSection).not.toHaveBeenCalled();
  expect(getWebsiteDateRange).toHaveBeenCalledTimes(3);
});

test('preserves independent website access and rejects absent entity permission', async () => {
  setAuth({
    user: { id: 'owner' },
    shareToken: {
      shareType: ENTITY_TYPE.website,
      websiteId,
      parameters: { overview: false },
    },
  });
  expect((await getDateRange()).status).toBe(200);

  vi.mocked(canViewSharedWebsite).mockResolvedValue(false);
  expect((await getDateRange()).status).toBe(401);
  expect(getWebsiteDateRange).toHaveBeenCalledTimes(1);
});
