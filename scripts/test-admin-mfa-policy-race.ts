import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import prisma from '@/lib/prisma';
import { runAuthorizedAdministratorMutation } from '@/queries/prisma/authorization';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const address = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname));
assert.equal(address.pathname, '/postgres');

const actorId = randomUUID();
const retainedAdminId = randomUUID();
const settingKey = `synthetic-mfa-race-${actorId}`;
let releaseDemotion: () => void = () => {};
let signalDemotionReady: () => void = () => {};
const demotionGate = new Promise<void>(resolve => {
  releaseDemotion = resolve;
});
const demotionReady = new Promise<void>(resolve => {
  signalDemotionReady = resolve;
});
let demotion: Promise<unknown> | undefined;
let policyOutcome: Promise<unknown> | undefined;

async function waitForBlockedPolicy() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [{ waiting }] = await prisma.client.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
    `;

    if (waiting > 0) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 25));
  }

  throw new Error('The policy mutation did not wait on the administrator lock.');
}

try {
  await prisma.client.user.createMany({
    data: [
      {
        id: actorId,
        username: `mfa-race-actor-${actorId}`,
        password: 'x'.repeat(60),
        role: 'admin',
      },
      {
        id: retainedAdminId,
        username: `mfa-race-retained-${retainedAdminId}`,
        password: 'x'.repeat(60),
        role: 'admin',
      },
    ],
  });

  demotion = prisma.transaction(
    async transaction => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtext(${'umami:user-mutations'}))::text
      `;
      await transaction.user.update({ where: { id: actorId }, data: { role: 'user' } });
      signalDemotionReady();
      await demotionGate;
    },
    { isolationLevel: 'Serializable', timeout: 15_000 },
  );

  await demotionReady;
  policyOutcome = runAuthorizedAdministratorMutation(actorId, transaction =>
    transaction.appSetting.upsert({
      where: { key: settingKey },
      update: { value: 'true' },
      create: { key: settingKey, value: 'true' },
    }),
  ).then(
    () => 'allowed',
    error => error,
  );

  await waitForBlockedPolicy();
  releaseDemotion();
  await demotion;

  const result = await policyOutcome;
  assert.ok(result instanceof Error);
  assert.equal(result.message, 'ENTITY_ADMIN_REQUIRED');
  assert.equal(await prisma.client.appSetting.findUnique({ where: { key: settingKey } }), null);

  console.log('PostgreSQL administrator demotion race rejected the stale MFA policy mutation.');
} finally {
  releaseDemotion();
  await demotion?.catch(() => undefined);
  await policyOutcome?.catch(() => undefined);
  await prisma.client.appSetting.deleteMany({ where: { key: settingKey } });
  await prisma.client.user.deleteMany({ where: { id: { in: [actorId, retainedAdminId] } } });
  await prisma.client.$disconnect();
}
