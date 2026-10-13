import { expect, test } from 'vitest';
import {
  parseSeedTarget,
  SEED_MARKER,
  SEED_WEBSITES,
  type SeedConfig,
  SeedSafetyError,
  verifySeedMarker,
  verifySeedWebsiteIdentity,
} from '../../scripts/seed/safety';

const config: SeedConfig = {
  days: 30,
  clear: false,
  verbose: false,
  allowDisposableSeed: true,
  confirmClear: false,
};

const environment = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://dev:synthetic@127.0.0.1:5432/umami_seed?schema=public',
};

test('explicit local seed target retains its selected schema', () => {
  expect(parseSeedTarget(config, environment)).toEqual({
    connectionString: environment.DATABASE_URL,
    schema: 'public',
  });
});

test.each([
  { ...environment, NODE_ENV: undefined },
  { ...environment, NODE_ENV: 'production' },
  { ...environment, VERCEL: '1' },
])('seed rejects unsafe environment %#', unsafeEnvironment => {
  expect(() => parseSeedTarget(config, unsafeEnvironment)).toThrow(SeedSafetyError);
});

test.each([
  'postgresql://dev:secret@db.example.com:5432/umami_seed',
  'postgresql://dev:secret@127.0.0.1:5432/umami_seed?host=db.example.com',
  'postgresql://dev:secret@127.0.0.1:5432/umami_seed?schema=public&schema=other',
  'postgresql://dev:secret@127.0.0.1:5432/umami_seed?schema=public%3Bdrop',
  'file:///tmp/umami_seed',
])('seed rejects unsafe database URL %s without echoing it', databaseUrl => {
  try {
    parseSeedTarget(config, { ...environment, DATABASE_URL: databaseUrl });
    throw new Error('Unsafe URL was accepted');
  } catch (error) {
    expect(error).toBeInstanceOf(SeedSafetyError);
    expect(String(error)).not.toContain('secret');
  }
});

test('clear requires separate consent and a bounded day count', () => {
  expect(() => parseSeedTarget({ ...config, clear: true }, environment)).toThrow('--confirm-clear');
  expect(() => parseSeedTarget({ ...config, days: 91 }, environment)).toThrow('--days');
});

test.each(
  [
    [],
    [{ marker: SEED_MARKER, schema: 'other' }],
    [{ marker: 'wrong', schema: 'public' }],
    [
      { marker: SEED_MARKER, schema: 'public' },
      { marker: SEED_MARKER, schema: 'public' },
    ],
  ].map(rows => [rows]),
)('seed refuses missing or ambiguous disposable marker %#', rows => {
  expect(() => verifySeedMarker(rows, 'public')).toThrow(SeedSafetyError);
});

test('exact disposable marker and two distinct owned IDs are accepted', () => {
  expect(() =>
    verifySeedMarker([{ marker: SEED_MARKER, schema: 'public' }], 'public'),
  ).not.toThrow();
  expect(new Set(SEED_WEBSITES.map(website => website.id)).size).toBe(2);
});

test('clear identity verification rejects a same-name decoy and changed ownership', () => {
  const owned = {
    ...SEED_WEBSITES[0],
    userId: 'admin-id',
    createdBy: 'admin-id',
    teamId: null,
    deletedAt: null,
  };

  expect(() => verifySeedWebsiteIdentity(owned, 'admin-id')).not.toThrow();
  expect(() =>
    verifySeedWebsiteIdentity({ ...owned, id: '00000000-0000-4000-8000-000000000999' }, 'admin-id'),
  ).toThrow(SeedSafetyError);
  expect(() =>
    verifySeedWebsiteIdentity({ ...owned, createdBy: 'other-admin' }, 'admin-id'),
  ).toThrow(SeedSafetyError);
  expect(() => verifySeedWebsiteIdentity({ ...owned, teamId: 'team-id' }, 'admin-id')).toThrow(
    SeedSafetyError,
  );
});
