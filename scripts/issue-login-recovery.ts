import { createInterface } from 'node:readline/promises';
import { isUuid } from '@/lib/crypto';
import { isEnvEnabled } from '@/lib/env';
import {
  generateLoginRecoveryCodes,
  persistLoginRecoveryCodes,
  RecoveryTargetNotFoundError,
} from '@/lib/login-recovery';
import prisma from '@/lib/prisma';
import { runCredentialRevocationMutation } from '@/queries/prisma/authorization';

async function run() {
  const userId = process.argv[3];
  if (
    process.argv.length !== 4 ||
    process.argv[2] !== '--user-id' ||
    !isUuid(userId) ||
    process.platform !== 'linux' ||
    process.arch !== 'arm64' ||
    process.getuid?.() === 0 ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    isEnvEnabled('CLOUD_MODE') ||
    isEnvEnabled('DISABLE_LOGIN')
  ) {
    throw new Error('Recovery issuance requires an interactive authorized Linux ARM64 operator.');
  }

  const target = await prisma.client.user.findUnique({
    where: { id: userId, deletedAt: null },
    select: { username: true, role: true },
  });
  if (!target) {
    throw new RecoveryTargetNotFoundError();
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let confirmation: string;
  try {
    confirmation = await prompt.question(
      `Replace codes for ${target.username} (${target.role})? Type the exact username: `,
    );
  } finally {
    prompt.close();
  }
  if (confirmation !== target.username) {
    throw new Error('The target username was not confirmed.');
  }

  const credentials = generateLoginRecoveryCodes();
  await runCredentialRevocationMutation(async transaction => {
    const current = await transaction.user.findUnique({
      where: { id: userId, deletedAt: null },
      select: { username: true, role: true },
    });
    if (current?.username !== target.username || current.role !== target.role) {
      throw new Error('The target changed before recovery issuance.');
    }
    await persistLoginRecoveryCodes(transaction, userId, credentials);
  });

  process.stdout.write(
    `Codes for ${target.username}. Deliver them privately to that owner and do not retain a terminal transcript:\n${credentials.map(({ code }) => code).join('\n')}\n`,
  );
}

try {
  await run();
} catch {
  process.stderr.write(
    'Recovery issuance did not complete. If output was interrupted, rotate again.\n',
  );
  process.exitCode = 1;
} finally {
  await prisma.client.$disconnect();
}
