/* eslint-disable no-console */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { ROLES } from '../src/lib/constants.js';
import { uuid } from '../src/lib/crypto.js';
import { hashPassword } from '../src/lib/password.js';

type ParsedArgs = Record<string, string | boolean>;

function printHelp() {
  console.log(`Analytics site provisioning

Creates the minimum post-migration records for a fresh analytics site:
- admin user
- website row

Usage:
  pnpm exec tsx scripts/provision-site.ts [options]

Options:
  --admin-username <value>        Admin username (default: admin or UMAMI_ADMIN_USERNAME)
  --admin-password <value>        Admin password (required when creating the admin user)
  --update-admin-password         Update the password for an existing admin user
  --website-name <value>          Website display name
  --website-domain <value>        Website domain (example.com or analytics.example.com)
  --website-id <uuid>             Optional explicit website UUID
  --help                          Show this help message

Environment variables:
  DATABASE_URL                    Required Postgres connection string
  UMAMI_ADMIN_USERNAME            Optional admin username
  UMAMI_ADMIN_PASSWORD            Optional admin password
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

    if (inlineValue !== undefined) {
      parsed[rawKey] = inlineValue;
      continue;
    }

    const nextValue = argv[i + 1];

    if (!nextValue || nextValue.startsWith('--')) {
      parsed[rawKey] = true;
      continue;
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

  if (typeof optionValue === 'string') {
    return optionValue === 'true';
  }

  return process.env[envName] === 'true';
}

function requireValue(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`${label} is required.`);
  }

  return value;
}

function normalizeDomain(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  const databaseUrl = requireValue(process.env.DATABASE_URL?.trim(), 'DATABASE_URL');
  const adminUsername =
    readStringOption(parsed, 'admin-username', 'UMAMI_ADMIN_USERNAME', 'admin') || 'admin';
  const adminPassword = readStringOption(parsed, 'admin-password', 'UMAMI_ADMIN_PASSWORD');
  const updateAdminPassword = readBooleanOption(
    parsed,
    'update-admin-password',
    'UMAMI_UPDATE_ADMIN_PASSWORD',
  );
  const websiteName = requireValue(
    readStringOption(parsed, 'website-name', 'UMAMI_WEBSITE_NAME'),
    'website name',
  );
  const websiteDomain = normalizeDomain(
    requireValue(
      readStringOption(parsed, 'website-domain', 'UMAMI_WEBSITE_DOMAIN'),
      'website domain',
    ),
  );
  const requestedWebsiteId = readStringOption(parsed, 'website-id', 'UMAMI_WEBSITE_ID');

  const url = new URL(databaseUrl);
  const adapter = new PrismaPg(
    { connectionString: url.toString() },
    { schema: url.searchParams.get('schema') },
  );
  const prisma = new PrismaClient({ adapter });

  try {
    await prisma.$connect();

    const existingUser = await prisma.user.findUnique({
      where: { username: adminUsername },
      select: { id: true, username: true, role: true, deletedAt: true },
    });

    let adminUserId = existingUser?.id;

    if (!existingUser) {
      const password = requireValue(
        adminPassword,
        `admin password (pass --admin-password or set UMAMI_ADMIN_PASSWORD to create ${adminUsername})`,
      );

      adminUserId = uuid();

      await prisma.user.create({
        data: {
          id: adminUserId,
          username: adminUsername,
          password: hashPassword(password),
          role: ROLES.admin,
        },
      });

      console.log(`Created admin user: ${adminUsername}`);
    } else {
      if (existingUser.deletedAt) {
        throw new Error(
          `The username "${adminUsername}" already exists on a deleted user. Restore or rename that user before provisioning.`,
        );
      }

      if (existingUser.role !== ROLES.admin) {
        await prisma.user.update({
          where: { id: existingUser.id },
          data: { role: ROLES.admin },
        });

        console.log(`Promoted existing user to admin: ${adminUsername}`);
      } else {
        console.log(`Reusing existing admin user: ${adminUsername}`);
      }

      if (adminPassword && updateAdminPassword) {
        await prisma.user.update({
          where: { id: existingUser.id },
          data: { password: hashPassword(adminPassword) },
        });

        console.log(`Updated password for admin user: ${adminUsername}`);
      } else if (adminPassword && !updateAdminPassword) {
        console.log(
          `Admin password provided for existing user ${adminUsername}, but left unchanged. Use --update-admin-password to rotate it.`,
        );
      }
    }

    const existingWebsite = await prisma.website.findFirst({
      where: {
        domain: websiteDomain,
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        userId: true,
        teamId: true,
      },
    });

    if (existingWebsite) {
      console.log(
        `Reusing existing website row: ${existingWebsite.name} (${existingWebsite.id}) for ${websiteDomain}`,
      );
    } else {
      const websiteId = requestedWebsiteId || uuid();

      await prisma.website.create({
        data: {
          id: websiteId,
          name: websiteName,
          domain: websiteDomain,
          userId: adminUserId,
          createdBy: adminUserId,
        },
      });

      console.log(`Created website row: ${websiteName} (${websiteId}) for ${websiteDomain}`);
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
