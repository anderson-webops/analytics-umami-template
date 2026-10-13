export const SEED_MARKER = 'umami-disposable-seed-v1';
export const MAX_SEED_DAYS = 90;

export const SEED_WEBSITES = [
  {
    id: '00000000-0000-4000-8000-000000000101',
    name: 'Demo Blog',
    domain: 'blog.example.com',
  },
  {
    id: '00000000-0000-4000-8000-000000000102',
    name: 'Demo SaaS',
    domain: 'app.example.com',
  },
] as const;

export interface SeedConfig {
  days: number;
  clear: boolean;
  verbose: boolean;
  allowDisposableSeed: boolean;
  confirmClear: boolean;
}

export class SeedSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedSafetyError';
  }
}

export function parseSeedTarget(
  config: SeedConfig,
  environment: Record<string, string | undefined>,
): { connectionString: string; schema: string } {
  if (!config.allowDisposableSeed) {
    throw new SeedSafetyError('Explicit --allow-disposable-seed consent is required.');
  }

  if (config.clear && !config.confirmClear) {
    throw new SeedSafetyError('--clear also requires --confirm-clear.');
  }

  if (!config.clear && config.confirmClear) {
    throw new SeedSafetyError('--confirm-clear requires --clear.');
  }

  if (!Number.isSafeInteger(config.days) || config.days < 1 || config.days > MAX_SEED_DAYS) {
    throw new SeedSafetyError(`--days must be an integer between 1 and ${MAX_SEED_DAYS}.`);
  }

  if (
    !['development', 'test'].includes(environment.NODE_ENV ?? '') ||
    environment.VERCEL ||
    environment.VERCEL_ENV ||
    environment.NETLIFY ||
    environment.RAILWAY_ENVIRONMENT
  ) {
    throw new SeedSafetyError('db:seed is limited to explicit local development or test mode.');
  }

  const connectionString = environment.DATABASE_URL;
  if (!connectionString) {
    throw new SeedSafetyError(
      'DATABASE_URL environment variable is not set.\n' +
        'Please set DATABASE_URL in your .env file or environment.\n' +
        'Example: DATABASE_URL=postgresql://user:password@host:port/database',
    );
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new SeedSafetyError(
      'DATABASE_URL is not a valid URL.\n' +
        'Expected format: postgresql://user:password@host:port/database',
    );
  }

  if (
    !['postgresql:', 'postgres:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname.length < 2 ||
    url.hash ||
    [...url.searchParams.keys()].some(key => key !== 'schema') ||
    url.searchParams.getAll('schema').length > 1
  ) {
    throw new SeedSafetyError('DATABASE_URL must target a loopback PostgreSQL database.');
  }

  const schema = url.searchParams.get('schema') ?? 'public';
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) {
    throw new SeedSafetyError('DATABASE_URL schema must be a simple PostgreSQL identifier.');
  }

  return { connectionString, schema };
}

export function verifySeedMarker(
  rows: Array<{ marker: string; schema: string }>,
  expectedSchema: string,
): void {
  if (rows.length !== 1 || rows[0].marker !== SEED_MARKER || rows[0].schema !== expectedSchema) {
    throw new SeedSafetyError('Database is not attested as a disposable seed target.');
  }
}

export function verifySeedWebsiteIdentity(
  website: {
    id: string;
    name: string;
    domain: string | null;
    userId: string | null;
    createdBy: string | null;
    teamId: string | null;
    deletedAt: Date | null;
  },
  adminUserId: string,
): void {
  const expected = SEED_WEBSITES.find(seedWebsite => seedWebsite.id === website.id);
  if (
    !expected ||
    website.name !== expected.name ||
    website.domain !== expected.domain ||
    website.userId !== adminUserId ||
    website.createdBy !== adminUserId ||
    website.teamId !== null ||
    website.deletedAt !== null
  ) {
    throw new SeedSafetyError('Seed-owned website identity changed; refusing to clear it.');
  }
}
