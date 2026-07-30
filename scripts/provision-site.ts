/* eslint-disable no-console */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { DOMAIN_REGEX, ROLES } from '../src/lib/constants.js';
import { isUuid, uuid } from '../src/lib/crypto.js';
import { hashPassword, isStrongPassword } from '../src/lib/password.js';

type ParsedArgs = Record<string, string | boolean>;

const VALUE_OPTIONS = new Set(['admin-username', 'website-name', 'website-domain', 'website-id']);
const BOOLEAN_OPTIONS = new Set(['promote-existing-admin', 'update-admin-password']);
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);
const SAFE_SCHEMA = /^[A-Za-z_][A-Za-z0-9_]*$/;

function printHelp() {
  console.log(`Analytics site provisioning

Creates the minimum post-migration records for a fresh analytics site:
- admin user
- website row

Usage:
  pnpm exec tsx scripts/provision-site.ts [options]

Options:
  --admin-username <value>        Admin username (default: admin or UMAMI_ADMIN_USERNAME)
  --promote-existing-admin        Explicitly promote a matching non-admin account
  --update-admin-password         Update the password for an existing admin user
  --website-name <value>          Website display name
  --website-domain <value>        Website domain (example.com or analytics.example.com)
  --website-id <uuid>             Optional explicit website UUID
  --help                          Show this help message

Environment variables:
  DATABASE_URL                    Required Postgres connection string
  UMAMI_ADMIN_USERNAME            Optional admin username
  UMAMI_ADMIN_PASSWORD            Admin password; never pass secrets on the command line
  UMAMI_PROMOTE_EXISTING_ADMIN    Set to true to promote a matching non-admin account
  UMAMI_UPDATE_ADMIN_PASSWORD     Set to true to rotate an existing admin password
  UMAMI_WEBSITE_NAME              Required website name
  UMAMI_WEBSITE_DOMAIN            Required website domain
  UMAMI_WEBSITE_ID                Optional explicit website UUID
`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);

    if (!VALUE_OPTIONS.has(rawKey) && !BOOLEAN_OPTIONS.has(rawKey)) {
      throw new Error(
        rawKey === 'admin-password'
          ? 'Administrator passwords must be provided through UMAMI_ADMIN_PASSWORD, not command-line arguments.'
          : `Unknown option: --${rawKey}`,
      );
    }

    if (inlineValue !== undefined) {
      parsed[rawKey] = inlineValue;
      continue;
    }

    if (BOOLEAN_OPTIONS.has(rawKey)) {
      parsed[rawKey] = true;
      continue;
    }

    const nextValue = argv[i + 1];

    if (!nextValue || nextValue.startsWith('--')) {
      throw new Error(`Option --${rawKey} requires a value.`);
    }

    parsed[rawKey] = nextValue;
    i += 1;
  }

  return parsed;
}

function readStringOption(
  parsed: ParsedArgs,
  optionName: string,
  envName: string,
  defaultValue?: string,
): string | undefined {
  const optionValue = parsed[optionName];

  if (typeof optionValue === 'string') {
    return optionValue.trim();
  }

  const envValue = process.env[envName]?.trim();

  if (envValue) {
    return envValue;
  }

  return defaultValue;
}

function readBooleanOption(parsed: ParsedArgs, optionName: string, envName: string): boolean {
  const optionValue = parsed[optionName];

  if (typeof optionValue === 'boolean') {
    return optionValue;
  }

  const value =
    typeof optionValue === 'string' ? optionValue : (process.env[envName]?.trim() ?? '');
  const normalized = value.toLowerCase();

  if (!normalized) {
    return false;
  }

  if (TRUE_VALUES.has(normalized)) {
    return true;
  }

  if (FALSE_VALUES.has(normalized)) {
    return false;
  }

  throw new Error(`${envName} must be one of 0, 1, false, true, no, yes, off, or on.`);
}

function requireValue(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`${label} is required.`);
  }

  return value;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some(character => {
    const codePoint = character.codePointAt(0) ?? 0;

    return codePoint <= 31 || codePoint === 127;
  });
}

function normalizeDomain(value: string): string {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);

    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      (url.pathname !== '/' && url.pathname !== '') ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }

    const domain = url.host.toLowerCase().replace(/\.$/, '');

    if (
      domain.length > 500 ||
      /\s/u.test(domain) ||
      hasControlCharacters(domain) ||
      !DOMAIN_REGEX.test(domain)
    ) {
      throw new Error();
    }

    return domain;
  } catch {
    throw new Error('website domain must be a hostname without credentials, a path, or a query.');
  }
}

function normalizeUsername(value: string): string {
  const username = value.normalize('NFKC').trim().toLowerCase();

  if (username.length < 1 || username.length > 255 || hasControlCharacters(username)) {
    throw new Error('admin username must contain 1-255 printable characters.');
  }

  return username;
}

function validateDatabaseUrl(value: string): URL {
  try {
    const url = new URL(value);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const schema = url.searchParams.get('schema');

    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !database ||
      database.includes('/') ||
      url.hash ||
      (schema && !SAFE_SCHEMA.test(schema))
    ) {
      throw new Error();
    }

    return url;
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }
}

function assertAdminPassword(password: string, username: string, databaseUrl: URL) {
  if (!isStrongPassword(password)) {
    throw new Error('Admin passwords must be 12-72 UTF-8 bytes and must not be commonplace.');
  }

  if (password.normalize('NFKC').toLowerCase() === username) {
    throw new Error('The administrator password must not match the administrator username.');
  }

  const databasePassword = databaseUrl.password
    ? decodeURIComponent(databaseUrl.password)
    : undefined;
  const deploymentSecrets = [
    process.env.APP_SECRET,
    process.env.INTERNAL_DIAGNOSTICS_KEY,
    databasePassword,
  ].filter(Boolean);

  if (deploymentSecrets.includes(password)) {
    throw new Error('The administrator password must not reuse another deployment secret.');
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  const databaseUrl = validateDatabaseUrl(
    requireValue(process.env.DATABASE_URL?.trim(), 'DATABASE_URL'),
  );
  const adminUsername = normalizeUsername(
    readStringOption(parsed, 'admin-username', 'UMAMI_ADMIN_USERNAME', 'admin') || 'admin',
  );
  const adminPassword = process.env.UMAMI_ADMIN_PASSWORD;
  const promoteExistingAdmin = readBooleanOption(
    parsed,
    'promote-existing-admin',
    'UMAMI_PROMOTE_EXISTING_ADMIN',
  );
  const updateAdminPassword = readBooleanOption(
    parsed,
    'update-admin-password',
    'UMAMI_UPDATE_ADMIN_PASSWORD',
  );
  const websiteName = requireValue(
    readStringOption(parsed, 'website-name', 'UMAMI_WEBSITE_NAME'),
    'website name',
  ).trim();
  const websiteDomain = normalizeDomain(
    requireValue(
      readStringOption(parsed, 'website-domain', 'UMAMI_WEBSITE_DOMAIN'),
      'website domain',
    ),
  );
  const requestedWebsiteId = readStringOption(parsed, 'website-id', 'UMAMI_WEBSITE_ID');

  if (websiteName.length < 1 || websiteName.length > 100) {
    throw new Error('website name must contain 1-100 characters.');
  }

  if (requestedWebsiteId && !isUuid(requestedWebsiteId)) {
    throw new Error('website ID must be a valid UUID.');
  }

  if (updateAdminPassword && !adminPassword) {
    throw new Error('UMAMI_ADMIN_PASSWORD is required when password rotation is requested.');
  }

  if (adminPassword) {
    assertAdminPassword(adminPassword, adminUsername, databaseUrl);
  }

  const passwordHash = adminPassword ? await hashPassword(adminPassword) : undefined;
  const adapter = new PrismaPg(
    { connectionString: databaseUrl.toString() },
    { schema: databaseUrl.searchParams.get('schema') },
  );
  const prisma = new PrismaClient({ adapter });
  const messages: string[] = [];

  try {
    await prisma.$connect();

    await prisma.$transaction(
      async transaction => {
        const existingUser = await transaction.user.findFirst({
          where: {
            username: {
              equals: adminUsername,
              mode: 'insensitive',
            },
          },
          select: { id: true, username: true, role: true, deletedAt: true },
        });

        let adminUserId: string;

        if (!existingUser) {
          if (!passwordHash) {
            throw new Error(
              `UMAMI_ADMIN_PASSWORD is required to create administrator ${adminUsername}.`,
            );
          }

          adminUserId = uuid();

          await transaction.user.create({
            data: {
              id: adminUserId,
              username: adminUsername,
              password: passwordHash,
              role: ROLES.admin,
            },
          });

          messages.push(`Created admin user: ${adminUsername}`);
        } else {
          if (existingUser.deletedAt) {
            throw new Error(
              `The username "${adminUsername}" belongs to a deleted user. Restore or rename that account before provisioning.`,
            );
          }

          adminUserId = existingUser.id;

          if (existingUser.role !== ROLES.admin) {
            if (!promoteExistingAdmin) {
              throw new Error(
                `The account "${existingUser.username}" is not an administrator. Set UMAMI_PROMOTE_EXISTING_ADMIN=true or pass --promote-existing-admin to authorize promotion.`,
              );
            }

            await transaction.user.update({
              where: { id: existingUser.id },
              data: { role: ROLES.admin },
            });

            messages.push(`Promoted existing user to admin: ${existingUser.username}`);
          } else {
            messages.push(`Reusing existing admin user: ${existingUser.username}`);
          }

          if (updateAdminPassword && passwordHash) {
            await transaction.user.update({
              where: { id: existingUser.id },
              data: { password: passwordHash },
            });

            messages.push(`Updated password for admin user: ${existingUser.username}`);
          } else if (adminPassword) {
            messages.push(
              `UMAMI_ADMIN_PASSWORD was provided for ${existingUser.username}, but the password was left unchanged. Set UMAMI_UPDATE_ADMIN_PASSWORD=true or pass --update-admin-password to rotate it.`,
            );
          }
        }

        const matchingWebsites = await transaction.website.findMany({
          where: {
            domain: websiteDomain,
            deletedAt: null,
          },
          take: 2,
          select: {
            id: true,
            name: true,
            userId: true,
            teamId: true,
          },
        });

        if (matchingWebsites.length > 1) {
          throw new Error(
            `Multiple active website rows already use ${websiteDomain}; repair the duplicate ownership before provisioning.`,
          );
        }

        const existingWebsite = matchingWebsites[0];

        if (existingWebsite) {
          if (existingWebsite.userId !== adminUserId || existingWebsite.teamId) {
            throw new Error(
              `The existing website for ${websiteDomain} is owned by another account or team and will not be reused.`,
            );
          }

          if (requestedWebsiteId && existingWebsite.id !== requestedWebsiteId) {
            throw new Error(
              `The existing website for ${websiteDomain} does not match requested ID ${requestedWebsiteId}.`,
            );
          }

          messages.push(
            `Reusing existing website row: ${existingWebsite.name} (${existingWebsite.id}) for ${websiteDomain}`,
          );
          return;
        }

        const websiteId = requestedWebsiteId || uuid();
        const [websiteConflict, linkConflict, pixelConflict, boardConflict] = await Promise.all([
          transaction.website.findUnique({ where: { id: websiteId }, select: { id: true } }),
          transaction.link.findUnique({ where: { id: websiteId }, select: { id: true } }),
          transaction.pixel.findUnique({ where: { id: websiteId }, select: { id: true } }),
          transaction.board.findUnique({ where: { id: websiteId }, select: { id: true } }),
        ]);

        if (websiteConflict || linkConflict || pixelConflict || boardConflict) {
          throw new Error(`Website ID ${websiteId} is already used by another analytics entity.`);
        }

        await transaction.website.create({
          data: {
            id: websiteId,
            name: websiteName,
            domain: websiteDomain,
            userId: adminUserId,
            createdBy: adminUserId,
          },
        });

        messages.push(`Created website row: ${websiteName} (${websiteId}) for ${websiteDomain}`);
      },
      {
        isolationLevel: 'Serializable',
        maxWait: 10_000,
        timeout: 30_000,
      },
    );

    for (const message of messages) {
      console.log(message);
    }

    console.log('Provisioning complete.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
