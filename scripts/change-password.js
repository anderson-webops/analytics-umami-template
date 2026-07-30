/* eslint-disable no-console */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '../generated/prisma/client.js';

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_BYTES = 72;
const COMMON_PASSWORDS = new Set([
  '123456789012',
  'adminadminadmin',
  'letmeinletmein',
  'password1234',
  'passwordpassword',
  'qwertyuiop12',
  'umami',
  'umamiumamiumami',
]);

function requireDatabaseUrl() {
  const value = process.env.DATABASE_URL;

  if (!value) {
    throw new Error('DATABASE_URL is required.');
  }

  try {
    const url = new URL(value);

    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.pathname.replace(/^\//, '')
    ) {
      throw new Error();
    }

    return url;
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL.');
  }
}

function getDeploymentSecrets() {
  const secrets = [process.env.APP_SECRET, process.env.INTERNAL_DIAGNOSTICS_KEY];

  for (const name of ['DATABASE_URL', 'DIRECT_DATABASE_URL', 'DATABASE_REPLICA_URL']) {
    const value = process.env[name];

    if (!value) {
      continue;
    }

    try {
      const password = decodeURIComponent(new URL(value).password);

      if (password) {
        secrets.push(password);
      }
    } catch {
      // requireDatabaseUrl reports a useful error for the primary URL. Optional
      // URLs are validated by the normal startup configuration check.
    }
  }

  return secrets.filter(Boolean);
}

function requireStrongPassword(username) {
  const password = process.env.UMAMI_PASSWORD;
  const normalized = password?.normalize('NFKC').toLowerCase();

  if (
    !password ||
    password.length < MIN_PASSWORD_LENGTH ||
    Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES ||
    COMMON_PASSWORDS.has(normalized) ||
    /^(.)\1+$/u.test(normalized) ||
    normalized === username.toLowerCase()
  ) {
    throw new Error(
      `UMAMI_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters and at most ${MAX_PASSWORD_BYTES} UTF-8 bytes, and must not be common, repeated, or equal to the username.`,
    );
  }

  if (getDeploymentSecrets().includes(password)) {
    throw new Error('UMAMI_PASSWORD must not reuse another deployment secret.');
  }

  return password;
}

async function run() {
  const username = process.env.UMAMI_USERNAME?.trim() || 'admin';

  if (!username || username.length > 255) {
    throw new Error('UMAMI_USERNAME must contain 1-255 characters.');
  }

  const password = requireStrongPassword(username);
  const url = requireDatabaseUrl();
  const adapter = new PrismaPg(
    { connectionString: url.toString() },
    { schema: url.searchParams.get('schema') },
  );
  const prisma = new PrismaClient({ adapter });

  try {
    const users = await prisma.user.findMany({
      where: {
        deletedAt: null,
      },
      select: {
        id: true,
        username: true,
      },
    });
    const matches = users.filter(
      user => user.username.trim().toLowerCase() === username.toLowerCase(),
    );

    if (matches.length !== 1) {
      throw new Error(`Expected exactly one active user matching "${username}".`);
    }

    const result = await prisma.user.updateMany({
      where: {
        id: matches[0].id,
        deletedAt: null,
      },
      data: {
        password: await bcrypt.hash(password, 12),
      },
    });

    if (result.count !== 1) {
      throw new Error('The account changed before its password could be updated. Try again.');
    }

    console.log(
      `Password updated for user "${matches[0].username}". Existing sessions are invalid.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

run().catch(error => {
  console.error(error instanceof Error ? error.message : 'Unable to update password.');
  process.exitCode = 1;
});
