import { beforeEach, describe, expect, test, vi } from 'vitest';
import { escapeLikeValue } from '@/lib/search';
import { getValues } from './getValues';

const { state, prismaRawQuery, clickhouseRawQuery, identityLinks, identityEvents } = vi.hoisted(
  () => ({
    state: { mode: 'prisma' as 'prisma' | 'clickhouse' },
    prismaRawQuery: vi.fn(),
    clickhouseRawQuery: vi.fn(),
    identityLinks: vi.fn(),
    identityEvents: vi.fn(),
  }),
);

vi.mock('./sessions/getVerifiedIdentityLinks', () => ({
  getVerifiedIdentityLinks: identityLinks,
}));
vi.mock('./sessions/queryVerifiedIdentityEvents', () => ({
  queryVerifiedIdentityEvents: identityEvents,
}));

vi.mock('@/lib/db', () => ({
  CLICKHOUSE: 'clickhouse',
  PRISMA: 'prisma',
  runQuery: vi.fn((queries: Record<string, () => unknown>) => queries[state.mode]()),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    rawQuery: prismaRawQuery,
    getSearchSQL: (column: string, param = 'search') => `and ${column} ilike {{${param}}}`,
  },
}));

vi.mock('@/lib/clickhouse', () => ({
  default: {
    rawQuery: clickhouseRawQuery,
    getSearchSQL: (column: string, param = 'search') =>
      `and positionCaseInsensitive(${column}, {${param}:String}) > 0`,
  },
}));

const filters = {
  startDate: new Date('2026-05-18T00:00:00.000Z'),
  endDate: new Date('2026-05-19T00:00:00.000Z'),
};

beforeEach(() => {
  prismaRawQuery.mockReset().mockResolvedValue([]);
  clickhouseRawQuery.mockReset().mockResolvedValue([]);
  identityLinks.mockReset().mockResolvedValue([]);
  identityEvents.mockReset().mockResolvedValue([]);
});

// ClickHouse does a literal case-insensitive substring match; Postgres must return the same rows.
describe('getValues postgres branch', () => {
  beforeEach(() => {
    state.mode = 'prisma';
  });

  test('single search term is a literal substring match', async () => {
    await getValues('website-1', 'url_path', { ...filters, search: 'my_page%' });

    const [query, params] = prismaRawQuery.mock.calls[0];
    expect(query).toContain('and website_event.url_path ilike {{search}}');
    expect(params.search).toBe('%my\\_page\\%%');
  });

  // Filter dropdowns load their initial choices with no search term.
  test.each(['url_path', 'browser'])('loads %s choices without a search term', async column => {
    await expect(getValues('website-1', column, filters)).resolves.toEqual([]);

    expect(prismaRawQuery.mock.calls[0][1].search).toBe('%%');
  });

  test('plain single search term is unchanged', async () => {
    await getValues('website-1', 'url_path', { ...filters, search: 'blog' });

    expect(prismaRawQuery.mock.calls[0][1].search).toBe('%blog%');
  });

  // search arrives already URL-decoded; decoding it again threw on a lone %.
  test('a lone % is searched literally instead of throwing', async () => {
    await getValues('website-1', 'url_path', { ...filters, search: '50%' });

    expect(prismaRawQuery.mock.calls[0][1].search).toBe('%50\\%%');
  });

  // Multi-term values used to be passed without %, turning substring search into exact match.
  test('multiple search terms are each a literal substring match', async () => {
    await getValues('website-1', 'browser', { ...filters, search: 'chro,fire_' });

    const [query, params] = prismaRawQuery.mock.calls[0];
    expect(query).toContain(
      'AND (session.browser ilike {{search0}} OR session.browser ilike {{search1}})',
    );
    expect(params).toMatchObject({ search0: '%chro%', search1: '%fire\\_%' });
  });

  test.each(['50%', 'person_name', 'one\\two', undefined])(
    'verified identity search preserves literal characters: %s',
    async search => {
      await getValues('website-1', 'distinct_id', { ...filters, search });

      const [query, params] = prismaRawQuery.mock.calls[0];
      expect(params.search).toBe(`%${escapeLikeValue(search ?? '')}%`);
      expect(query).toContain('verified_link.trust_tier = 1');
      expect(query).toContain('verified_link.distinct_id');
    },
  );
});

describe('getValues clickhouse branch', () => {
  beforeEach(() => {
    state.mode = 'clickhouse';
  });

  test('search terms are passed through unchanged for positionCaseInsensitive', async () => {
    await getValues('website-1', 'browser', { ...filters, search: 'chro,fire_' });

    const [query, params] = clickhouseRawQuery.mock.calls[0];
    expect(query).toContain('positionCaseInsensitive(browser, {search0:String}) > 0');
    expect(params).toMatchObject({ search0: 'chro', search1: 'fire_' });
  });

  test('a lone % is passed through instead of throwing', async () => {
    await getValues('website-1', 'url_path', { ...filters, search: '50%' });

    expect(clickhouseRawQuery.mock.calls[0][1].search).toBe('50%');
  });

  test.each(['person_%', '50%'])(
    'verified identities keep already-decoded %s literal',
    async search => {
      identityEvents.mockResolvedValue([
        { sessionId: 'session-1', count: 3 },
        { sessionId: 'session-2', count: 7 },
      ]);
      identityLinks.mockResolvedValue([
        { sessionId: 'session-1', distinctId: `approved-${search}` },
        { sessionId: 'session-2', distinctId: 'unmatched-identity' },
      ]);

      await expect(getValues('website-1', 'distinct_id', { ...filters, search })).resolves.toEqual([
        { value: `approved-${search}`, count: 3 },
      ]);
      expect(identityLinks).toHaveBeenCalledWith('website-1', ['session-1', 'session-2']);
      expect(identityEvents.mock.calls[0][0]).not.toContain('distinct_id');
    },
  );
});
