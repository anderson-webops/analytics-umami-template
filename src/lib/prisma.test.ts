import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/umami?schema=public';
delete process.env.DATABASE_REPLICA_URL;

vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: class PrismaPg {},
}));

vi.mock('@prisma/extension-read-replicas', () => ({
  readReplicas: () => () => ({}),
}));

vi.mock('@/generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {
    $executeRawUnsafe = vi.fn();
    $queryRawUnsafe = vi.fn();
    $transaction = vi.fn();
    $on = vi.fn();
    $extends() {
      return this;
    }
  },
}));

let getRawQueryClient!: typeof import('./prisma').getRawQueryClient;
let getSchema!: typeof import('./prisma').getSchema;
let prisma!: typeof import('./prisma').default;

beforeAll(async () => {
  ({ getRawQueryClient, getSchema, default: prisma } = await import('./prisma'));
});

interface RawQueryClient {
  $executeRawUnsafe: (query: string, ...params: any[]) => unknown;
  $queryRawUnsafe: (query: string, ...params: any[]) => unknown;
  $primary?: () => unknown;
  $replica?: () => unknown;
}

function createClient(): RawQueryClient {
  return {
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  };
}

describe('getRawQueryClient', () => {
  test('uses a replica client for read queries when replicas are enabled', () => {
    const replica = createClient();
    const client = {
      ...createClient(),
      $replica: vi.fn(() => replica),
    };

    expect(getRawQueryClient(client, { useReplica: true })).toBe(replica);
  });

  test('keeps read queries on the primary client when replicas are disabled', () => {
    const client = {
      ...createClient(),
      $replica: vi.fn(() => createClient()),
    };

    expect(getRawQueryClient(client, { useReplica: false })).toBe(client);
  });

  test('uses the primary client for raw writes when available', () => {
    const primary = createClient();
    const client = {
      ...createClient(),
      $primary: vi.fn(() => primary),
      $replica: vi.fn(() => createClient()),
    };

    expect(getRawQueryClient(client, { useReplica: true, write: true })).toBe(primary);
  });

  test('falls back to the current client for raw writes without a primary helper', () => {
    const client = createClient();

    expect(getRawQueryClient(client, { write: true })).toBe(client);
  });
});

describe('pagedQuery authority', () => {
  const client = () => prisma.client as any;

  afterEach(() => {
    delete client().team;
    delete client().$primary;
  });

  test('uses primary for both protected list rows and count', async () => {
    const replica = {
      findMany: vi.fn().mockResolvedValue([{ id: 'revoked' }]),
      count: vi.fn().mockResolvedValue(1),
    };
    const primary = {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    };
    client().team = replica;
    client().$primary = vi.fn(() => ({ team: primary }));
    const criteria = { where: { members: { some: { userId: 'former-member' } } } };

    await expect(
      prisma.pagedQuery('team', criteria, { page: 1, pageSize: 20 }, { usePrimary: true }),
    ).resolves.toMatchObject({ data: [], count: 0 });
    expect(primary.findMany).toHaveBeenCalledWith(expect.objectContaining(criteria));
    expect(primary.count).toHaveBeenCalledWith({ where: criteria.where });
    expect(replica.findMany).not.toHaveBeenCalled();
    expect(replica.count).not.toHaveBeenCalled();
  });

  test('retains replica reads by default and single-client fallback', async () => {
    const replica = {
      findMany: vi.fn().mockResolvedValue([{ id: 'listed' }]),
      count: vi.fn().mockResolvedValue(1),
    };
    const primary = {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    };
    client().team = replica;
    client().$primary = vi.fn(() => ({ team: primary }));

    await expect(prisma.pagedQuery('team', { where: {} })).resolves.toMatchObject({ count: 1 });
    expect(primary.findMany).not.toHaveBeenCalled();

    delete client().$primary;
    await expect(
      prisma.pagedQuery('team', { where: {} }, {}, { usePrimary: true }),
    ).resolves.toMatchObject({ count: 1 });
    expect(replica.findMany).toHaveBeenCalledTimes(2);
  });
});

describe('report filter SQL', () => {
  test('does not interpolate untrusted structured filter metadata', () => {
    const filters = prisma.parseFilters({
      path1: {
        name: 'path',
        operator: 'eq',
        value: ['/articles'],
        prefix: "url_path = ANY(ARRAY['x']) OR TRUE OR website_event.",
        paramName: 'path}} OR TRUE --',
      },
    });

    expect(filters.filterQuery).toBe('and website_event.url_path = ANY({{path1}})');
    expect(filters.queryParams).toMatchObject({ path1: ['/articles'] });
  });
});

describe('bounded raw regex queries', () => {
  const client = () => prisma.client as any;

  afterEach(() => {
    vi.mocked(client().$transaction).mockReset();
    vi.mocked(client().$queryRawUnsafe).mockReset();
    delete client().$replica;
    vi.unstubAllEnvs();
  });

  test.each([
    ['~*', '0', '2000ms'],
    ['!~*', '500', '500ms'],
  ])(
    'runs %s inside a bounded transaction without weakening host limits',
    async (operator, setting, timeout) => {
      const transaction = {
        $executeRawUnsafe: vi.fn(),
        $queryRawUnsafe: vi
          .fn()
          .mockResolvedValueOnce([{ setting, unit: 'ms' }])
          .mockResolvedValueOnce([{ matched: true }]),
      };
      vi.mocked(client().$transaction).mockImplementation(async action => action(transaction));

      const result = await prisma.rawQuery(`select 'value' ${operator} {{pattern}} as matched`, {
        pattern: '^value$',
      });

      expect(result).toEqual([{ matched: true }]);
      expect(transaction.$queryRawUnsafe).toHaveBeenNthCalledWith(
        1,
        "SELECT setting, unit FROM pg_settings WHERE name = 'statement_timeout'",
      );
      expect(transaction.$executeRawUnsafe).toHaveBeenNthCalledWith(
        1,
        `SET LOCAL statement_timeout = '${timeout}'`,
      );
      const schema = getSchema();
      if (schema) {
        expect(transaction.$executeRawUnsafe).toHaveBeenNthCalledWith(
          2,
          `SET LOCAL search_path TO "${schema}";`,
        );
      } else {
        expect(transaction.$executeRawUnsafe).toHaveBeenCalledTimes(1);
      }
      expect(transaction.$queryRawUnsafe).toHaveBeenNthCalledWith(
        2,
        `select 'value' ${operator} $1 as matched`,
        '^value$',
      );
      expect(client().$queryRawUnsafe).not.toHaveBeenCalled();
      expect(client().$transaction).toHaveBeenCalledWith(expect.any(Function), {
        maxWait: 2_000,
        timeout: 3_000,
      });

      transaction.$queryRawUnsafe
        .mockResolvedValueOnce([{ setting: '0', unit: 'ms' }])
        .mockResolvedValueOnce([{ ordinary: true }]);
      await expect(prisma.rawQuery('select 1 as ordinary', {})).resolves.toEqual([
        { ordinary: true },
      ]);
      expect(client().$transaction).toHaveBeenCalledTimes(2);
      expect(transaction.$executeRawUnsafe).toHaveBeenCalledWith(
        "SET LOCAL statement_timeout = '30000ms'",
      );
    },
  );

  test('refuses a regex query if its timeout cannot be verified', async () => {
    const transaction = {
      $executeRawUnsafe: vi.fn(),
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ setting: 'unverified', unit: 'ms' }]),
    };
    vi.mocked(client().$transaction).mockImplementation(async action => action(transaction));

    await expect(prisma.rawQuery('select value ~* {{pattern}}', { pattern: '.*' })).rejects.toThrow(
      'Database statement timeout could not be verified.',
    );
    expect(transaction.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(transaction.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  test('applies an explicit timeout without weakening a stricter database setting', async () => {
    const transaction = {
      $executeRawUnsafe: vi.fn(),
      $queryRawUnsafe: vi
        .fn()
        .mockResolvedValueOnce([{ setting: '750', unit: 'ms' }])
        .mockResolvedValueOnce([{ x: 'event' }]),
    };
    vi.mocked(client().$transaction).mockImplementation(async action => action(transaction));

    await expect(
      prisma.rawQuery('select {{name}} as x', { name: 'event' }, 'getEventStats', 10_000),
    ).resolves.toEqual([{ x: 'event' }]);
    expect(transaction.$executeRawUnsafe).toHaveBeenCalledWith(
      "SET LOCAL statement_timeout = '750ms'",
    );
    expect(transaction.$queryRawUnsafe).toHaveBeenLastCalledWith('select $1 as x', 'event');
    expect(client().$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 2_000,
      timeout: 11_000,
    });
  });

  test('does not bypass the timeout when the selected replica has no transaction', async () => {
    const replica = {
      $executeRawUnsafe: vi.fn(),
      $queryRawUnsafe: vi.fn(),
    };
    client().$replica = vi.fn(() => replica);
    vi.stubEnv('DATABASE_REPLICA_URL', 'postgresql://replica:synthetic@localhost:5432/umami');

    await expect(prisma.rawQuery('select value ~* {{pattern}}', { pattern: '.*' })).rejects.toThrow(
      'Regex queries require a transactional database client.',
    );
    expect(replica.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(client().$transaction).not.toHaveBeenCalled();
  });

  test('applies the same timeout on the selected read replica', async () => {
    const transaction = {
      $executeRawUnsafe: vi.fn(),
      $queryRawUnsafe: vi
        .fn()
        .mockResolvedValueOnce([{ setting: '0', unit: 'ms' }])
        .mockResolvedValueOnce([{ matched: true }]),
    };
    const replica = {
      $executeRawUnsafe: vi.fn(),
      $queryRawUnsafe: vi.fn(),
      $transaction: vi.fn(async action => action(transaction)),
    };
    client().$replica = vi.fn(() => replica);
    vi.stubEnv('DATABASE_REPLICA_URL', 'postgresql://replica:synthetic@localhost:5432/umami');

    await expect(
      prisma.rawQuery('select value ~* {{pattern}}', { pattern: '.*' }),
    ).resolves.toEqual([{ matched: true }]);
    expect(replica.$transaction).toHaveBeenCalledTimes(1);
    expect(client().$transaction).not.toHaveBeenCalled();
  });
});

describe('getDateSQL timezone formatting', () => {
  test('formats UTC (default) buckets with an explicit zone and a Z marker', () => {
    // Never rely on the DB session's ambient timezone.
    expect(prisma.getDateSQL('website_event.created_at', 'hour')).toBe(
      `to_char(date_trunc('hour', website_event.created_at at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:00:00"Z"')`,
    );
    expect(prisma.getDateSQL('website_event.created_at', 'hour', 'UTC')).toBe(
      `to_char(date_trunc('hour', website_event.created_at at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:00:00"Z"')`,
    );
  });

  test('formats non-UTC buckets with the same explicit Z marker, not a bare timestamp', () => {
    // Bare timestamps get misparsed as local-to-the-runtime, not the source zone.
    expect(prisma.getDateSQL('website_event.created_at', 'hour', 'Asia/Tehran')).toBe(
      `to_char(date_trunc('hour', website_event.created_at at time zone 'Asia/Tehran'), 'YYYY-MM-DD"T"HH24:00:00"Z"')`,
    );
  });
});

describe('getDateStringSQL timezone formatting', () => {
  test('formats non-UTC second-precision values with an explicit Z marker', () => {
    expect(prisma.getDateStringSQL('event_data.date_value', 'second', 'Asia/Tehran')).toBe(
      `to_char(event_data.date_value at time zone 'Asia/Tehran', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
    );
  });

  test('defaults to explicit UTC formatting regardless of unit when no timezone is given', () => {
    expect(prisma.getDateStringSQL('event_data.date_value')).toBe(
      `to_char(event_data.date_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
    );
  });
});

describe('getDateWeeklySQL timezone formatting', () => {
  test('falls back to UTC instead of producing invalid SQL when no timezone is given', () => {
    // Regression test: this used to interpolate `undefined` straight into `at time zone`.
    expect(prisma.getDateWeeklySQL('website_event.created_at')).toBe(
      `concat(extract(dow from (website_event.created_at at time zone 'UTC')), ':', to_char((website_event.created_at at time zone 'UTC'), 'HH24'))`,
    );
  });

  test('uses the given timezone when one is provided', () => {
    expect(prisma.getDateWeeklySQL('website_event.created_at', 'Asia/Tehran')).toBe(
      `concat(extract(dow from (website_event.created_at at time zone 'Asia/Tehran')), ':', to_char((website_event.created_at at time zone 'Asia/Tehran'), 'HH24'))`,
    );
  });
});

describe('pagedRawQuery default ordering', () => {
  function mockQueries(count = '4') {
    const queryRaw = vi.mocked((prisma.client as any).$queryRawUnsafe);
    queryRaw.mockClear();
    vi.mocked((prisma.client as any).$transaction).mockClear();
    queryRaw.mockImplementation(async (sql: string) =>
      sql.includes('count(*) as num') ? [{ num: count }] : [{ id: 1 }],
    );
    const transaction = {
      $executeRawUnsafe: vi.fn(),
      $queryRawUnsafe: vi.fn(async (sql: string, ...params: any[]) =>
        sql.includes('pg_settings') ? [{ setting: '0', unit: 'ms' }] : queryRaw(sql, ...params),
      ),
    };
    vi.mocked((prisma.client as any).$transaction).mockImplementation(async action =>
      action(transaction),
    );
    return queryRaw;
  }

  test.each([undefined, 5])(
    'applies trusted default order only to the page query with cap %s',
    async maxResults => {
      const queryRaw = mockQueries('5');
      const result = await prisma.pagedRawQuery(
        'select * from thing',
        {},
        { page: 2, pageSize: 2, maxResults },
        'test',
        'max(created_at) desc, session_id',
      );

      expect(queryRaw).toHaveBeenCalledTimes(2);
      expect(queryRaw.mock.calls[0][0]).not.toContain('order by max(created_at) desc');
      expect(queryRaw.mock.calls[1][0]).toContain('order by max(created_at) desc, session_id');
      expect(queryRaw.mock.calls[1][0]).toContain('limit 2 offset 2');
      expect(result).toEqual({
        data: [{ id: 1 }],
        count: 5,
        page: 2,
        pageSize: 2,
        isCapped: !!maxResults,
        orderBy: undefined,
      });
      expect((prisma.client as any).$transaction).toHaveBeenCalledTimes(2);
    },
  );

  test('keeps explicit ordering and legacy no-order behavior', async () => {
    const queryRaw = mockQueries();
    const result = await prisma.pagedRawQuery(
      'select * from thing',
      {},
      { page: 1, pageSize: 2, orderBy: 'name', sortDescending: true },
      undefined,
      'max(created_at) desc, session_id',
    );
    expect(queryRaw.mock.calls[1][0]).toContain('order by name desc');
    expect(queryRaw.mock.calls[1][0]).not.toContain('order by max(created_at) desc, session_id');
    expect(result.orderBy).toBe('name');
    queryRaw.mockClear();
    await prisma.pagedRawQuery('select * from thing', {}, { page: 1, pageSize: 2 });
    expect(queryRaw.mock.calls[1][0]).not.toMatch(/order by/);
  });
});
