import { beforeEach, expect, test, vi } from 'vitest';
import { ENTITY_TYPE } from '@/lib/constants';
import { getEntity } from '@/lib/entity';
import { parseRequest } from '@/lib/request';
import { getTeamUser, getWebsiteAnnotation, getWebsiteAnnotations } from '@/queries/prisma';
import { GET as getAnnotation } from './[annotationId]/route';
import { GET as listAnnotations } from './route';

vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/lib/entity', () => ({ getEntity: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ default: { client: {} } }));
vi.mock('@/queries/prisma', () => ({
  getTeamUser: vi.fn(),
  getWebsiteAnnotation: vi.fn(),
  getWebsiteAnnotations: vi.fn(),
}));

const params = Promise.resolve({ websiteId: 'website-1', annotationId: 'annotation-1' });
const annotation = { id: 'annotation-1', websiteId: 'website-1', note: 'Synthetic release note' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEntity).mockResolvedValue({ userId: 'owner-1' } as any);
  vi.mocked(getTeamUser).mockResolvedValue(null);
  vi.mocked(getWebsiteAnnotation).mockResolvedValue(annotation as any);
  vi.mocked(getWebsiteAnnotations).mockResolvedValue({ data: [annotation] } as any);
});

const accessCases = [
  { label: 'events-only share', parameters: { events: true, allowFilter: true }, allowed: false },
  { label: 'overview share', parameters: { overview: true, allowFilter: true }, allowed: true },
  { label: 'compare share', parameters: { compare: true, allowFilter: true }, allowed: true },
  {
    label: 'all chart sections disabled',
    parameters: { overview: false, compare: false },
    allowed: false,
  },
  {
    label: 'filter-disabled share',
    parameters: { overview: true, allowFilter: false },
    allowed: false,
  },
  { label: 'legacy sectionless share', parameters: {}, allowed: true },
];

for (const handler of [listAnnotations, getAnnotation]) {
  test.each(accessCases)(
    `${handler === listAnnotations ? 'list' : 'detail'} enforces $label`,
    async ({ parameters, allowed }) => {
      for (const user of [undefined, { id: 'unrelated-user' }]) {
        vi.mocked(parseRequest).mockResolvedValue({
          auth: {
            user,
            shareToken: { shareType: ENTITY_TYPE.website, websiteId: 'website-1', parameters },
          },
          query: {},
        });
        const response = await handler(new Request('http://localhost/fixture'), { params });
        expect(response.status).toBe(allowed ? 200 : 401);
        if (!allowed) {
          expect(getWebsiteAnnotation).not.toHaveBeenCalled();
          expect(getWebsiteAnnotations).not.toHaveBeenCalled();
        }
      }
    },
  );

  test(`${handler === listAnnotations ? 'list' : 'detail'} preserves owner and team access independently of a share`, async () => {
    for (const user of [{ id: 'owner-1' }, { id: 'admin-1', isAdmin: true }, { id: 'member-1' }]) {
      if (user.id === 'member-1') {
        vi.mocked(getEntity).mockResolvedValue({ teamId: 'team-1' } as any);
        vi.mocked(getTeamUser).mockResolvedValue({ userId: user.id, teamId: 'team-1' } as any);
      }
      vi.mocked(parseRequest).mockResolvedValue({
        auth: {
          user,
          shareToken: {
            websiteId: 'website-1',
            parameters: { overview: false, allowFilter: false },
          },
        },
        query: {},
      });
      expect((await handler(new Request('http://localhost/fixture'), { params })).status).toBe(200);
    }
  });

  test(`${handler === listAnnotations ? 'list' : 'detail'} requires an authorized website share`, async () => {
    for (const shareToken of [
      undefined,
      { websiteId: 'other-site', parameters: { overview: true } },
      { shareType: ENTITY_TYPE.board, websiteIds: ['other-site'], parameters: {} },
      {
        shareType: ENTITY_TYPE.board,
        websiteIds: ['website-1'],
        parameters: { overview: true, allowFilter: true },
      },
    ]) {
      vi.mocked(parseRequest).mockResolvedValue({ auth: { shareToken }, query: {} });
      expect((await handler(new Request('http://localhost/fixture'), { params })).status).toBe(401);
    }
    expect(getWebsiteAnnotation).not.toHaveBeenCalled();
    expect(getWebsiteAnnotations).not.toHaveBeenCalled();
  });
}
