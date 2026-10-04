import { afterEach, describe, expect, test, vi } from 'vitest';
import clickhouse, { CLICKHOUSE_DATE_FORMATS } from './clickhouse';

afterEach(() => {
  vi.doUnmock('@clickhouse/client');
  vi.unstubAllEnvs();
  delete globalThis.clickhouse;
});

describe('bounded queries', () => {
  test('passes event-series time and result limits to ClickHouse', async () => {
    const query = vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue([]) });
    vi.stubEnv('CLICKHOUSE_URL', 'http://umami:synthetic@127.0.0.1:8123/umami');
    vi.doMock('@clickhouse/client', () => ({ createClient: () => ({ query }) }));
    vi.resetModules();

    const { default: client } = await import('./clickhouse');
    await client.rawQuery('select 1', {}, 'getEventStats', {
      maxExecutionTimeSeconds: 10,
      maxResultRows: 50_000,
    });

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        clickhouse_settings: expect.objectContaining({
          max_execution_time: 10,
          timeout_before_checking_execution_speed: 0,
          max_result_rows: '50000',
          result_overflow_mode: 'throw',
        }),
      }),
    );
  });
});

describe('report filter parameters', () => {
  test('keeps structured filter metadata out of ClickHouse queries', () => {
    const filters = clickhouse.parseFilters({
      path1: {
        name: 'referrer',
        operator: 'eq',
        value: ['/articles'],
        prefix: 'OR TRUE OR ',
        paramName: 'path}} OR TRUE --',
      },
    });

    expect(filters.filterQuery).toBe('and is_bot = 0\nand url_path IN {path1:Array(String)}');
    expect(filters.queryParams).toMatchObject({ path1: ['/articles'] });
  });
});

describe('CLICKHOUSE_DATE_FORMATS', () => {
  test('uses date format tokens compatible with ClickHouse 22.8 and newer', () => {
    expect(CLICKHOUSE_DATE_FORMATS).toMatchObject({
      utc: '%Y-%m-%dT%TZ',
      second: '%Y-%m-%dT%T',
      minute: '%Y-%m-%d %R:00',
    });
  });
});

describe('getDateSQL bucket formatting', () => {
  // Regression: getDateSQL used to return a native DateTime whose "iso" serialization
  // is a genuine UTC instant - unlike Postgres's already-shifted-but-Z-labeled value,
  // which the frontend assumes for every backend. formatDateTime makes it match.
  test('formats an explicit "Z" via formatDateTime instead of relying on native DateTime serialization', () => {
    expect(clickhouse.getDateSQL('website_event.created_at', 'hour', 'Asia/Tokyo')).toBe(
      `formatDateTime(date_trunc('hour', website_event.created_at, 'Asia/Tokyo'), '%Y-%m-%dT%H:00:00Z', 'Asia/Tokyo')`,
    );
  });

  test('omits the timezone argument to formatDateTime when no timezone is given', () => {
    expect(clickhouse.getDateSQL('website_event.created_at', 'day')).toBe(
      `formatDateTime(date_trunc('day', website_event.created_at), '%Y-%m-%dT00:00:00Z')`,
    );
  });

  test('covers every bucket unit with an explicit "Z"', () => {
    expect(clickhouse.getDateSQL('created_at', 'minute', 'UTC')).toBe(
      `formatDateTime(date_trunc('minute', created_at, 'UTC'), '%Y-%m-%dT%R:00Z', 'UTC')`,
    );
    expect(clickhouse.getDateSQL('created_at', 'month', 'UTC')).toBe(
      `formatDateTime(date_trunc('month', created_at, 'UTC'), '%Y-%m-01T00:00:00Z', 'UTC')`,
    );
    expect(clickhouse.getDateSQL('created_at', 'year', 'UTC')).toBe(
      `formatDateTime(date_trunc('year', created_at, 'UTC'), '%Y-01-01T00:00:00Z', 'UTC')`,
    );
  });
});
