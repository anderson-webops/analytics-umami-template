import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PERMISSIONS, ROLES } from '@/lib/constants';
import prisma from '@/lib/prisma';
import {
  assertActorCanMutateEntity,
  lockActorRoleForMutation,
  runSerializable,
} from '@/queries/prisma/authorization';
import { createUser, deleteUser, updateUser } from '@/queries/prisma/user';
import { updateWebsite } from '@/queries/prisma/website';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const address = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname));
assert.equal(address.pathname, '/postgres');

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(release => {
    resolve = release;
  });
  return { promise, resolve };
}

async function waitForLock(queryFragment: string, waitEvent?: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [{ waiting }] = await prisma.client.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query LIKE ${`%${queryFragment}%`}
        AND (${waitEvent ?? null}::text IS NULL OR wait_event = ${waitEvent ?? null})
    `;

    if (waiting > 0) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 25));
  }

  throw new Error(`The expected ${queryFragment} query did not wait for the role lock.`);
}

const administratorId = randomUUID();
const actorId = randomUUID();
const otherOwnerId = randomUUID();
const createdUserId = randomUUID();
const actorWebsiteId = randomUUID();
const otherWebsiteId = randomUUID();
const teamId = randomUUID();
const memberId = randomUUID();
const delegatedTeamId = randomUUID();
const releaseActorMutation = deferred();
const actorAuthorized = deferred();
const releaseDemotion = deferred();
const demotionReady = deferred();
const releaseAdminDemotion = deferred();
const adminDemotionReady = deferred();
const releaseMemberRemoval = deferred();
const memberRemovalReady = deferred();
const releaseDelegatedCreation = deferred();
const delegatedCreationReady = deferred();
let actorMutation: Promise<unknown> | undefined;
let demotion: Promise<unknown> | undefined;
let contestedMutation: Promise<unknown> | undefined;
let adminDemotion: Promise<unknown> | undefined;
let contestedCreate: Promise<unknown> | undefined;
let memberRemoval: Promise<unknown> | undefined;
let accountDeletion: Promise<unknown> | undefined;
let delegatedCreation: Promise<unknown> | undefined;
let delegatedDemotion: Promise<unknown> | undefined;

async function mutateWebsite(websiteId: string, name: string) {
  return runSerializable(async transaction => {
    await assertActorCanMutateEntity(
      transaction,
      actorId,
      'website',
      websiteId,
      PERMISSIONS.websiteUpdate,
    );
    return transaction.website.update({ where: { id: websiteId }, data: { name } });
  });
}

try {
  await prisma.client.user.createMany({
    data: [
      {
        id: administratorId,
        username: `role-admin-${administratorId}`,
        password: 'x'.repeat(60),
        role: ROLES.admin,
      },
      {
        id: actorId,
        username: `role-actor-${actorId}`,
        password: 'x'.repeat(60),
        role: ROLES.user,
      },
      {
        id: otherOwnerId,
        username: `role-owner-${otherOwnerId}`,
        password: 'x'.repeat(60),
        role: ROLES.user,
      },
    ],
  });
  await prisma.client.website.createMany({
    data: [
      { id: actorWebsiteId, name: 'Actor website', userId: actorId },
      { id: otherWebsiteId, name: 'Other website', userId: otherOwnerId },
    ],
  });

  actorMutation = runSerializable(async transaction => {
    await assertActorCanMutateEntity(
      transaction,
      actorId,
      'website',
      actorWebsiteId,
      PERMISSIONS.websiteUpdate,
    );
    actorAuthorized.resolve();
    await releaseActorMutation.promise;
    return transaction.website.update({
      where: { id: actorWebsiteId },
      data: { name: 'Committed before demotion' },
    });
  });
  await actorAuthorized.promise;
  demotion = updateUser(actorId, { role: ROLES.viewOnly }, administratorId);
  await waitForLock('UPDATE', 'transactionid');
  releaseActorMutation.resolve();
  await actorMutation;
  await demotion;
  assert.equal(
    (await prisma.client.user.findUniqueOrThrow({ where: { id: actorId } })).role,
    ROLES.viewOnly,
  );
  assert.equal(
    (await prisma.client.website.findUniqueOrThrow({ where: { id: actorWebsiteId } })).name,
    'Committed before demotion',
  );

  await updateUser(actorId, { role: ROLES.user }, administratorId);
  demotion = prisma.transaction(
    async transaction => {
      await transaction.user.update({ where: { id: actorId }, data: { role: ROLES.viewOnly } });
      demotionReady.resolve();
      await releaseDemotion.promise;
    },
    { isolationLevel: 'Serializable', timeout: 15_000 },
  );
  await demotionReady.promise;
  contestedMutation = mutateWebsite(actorWebsiteId, 'Must not commit').then(
    () => 'allowed',
    error => error,
  );
  await waitForLock('FOR SHARE', 'transactionid');
  releaseDemotion.resolve();
  await demotion;
  const deniedOwnerMutation = await contestedMutation;
  assert.ok(deniedOwnerMutation instanceof Error);
  assert.equal(deniedOwnerMutation.message, 'ENTITY_ACTOR_NOT_AUTHORIZED');
  assert.equal(
    (await prisma.client.website.findUniqueOrThrow({ where: { id: actorWebsiteId } })).name,
    'Committed before demotion',
  );

  await updateUser(actorId, { role: ROLES.admin }, administratorId);
  await updateWebsite(otherWebsiteId, { name: 'Administrator update' }, actorId);
  await updateUser(actorId, { role: ROLES.user }, administratorId);
  await assert.rejects(
    updateWebsite(otherWebsiteId, { name: 'Must not commit' }, actorId),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  assert.equal(
    (await prisma.client.website.findUniqueOrThrow({ where: { id: otherWebsiteId } })).name,
    'Administrator update',
  );

  await updateUser(actorId, { role: ROLES.admin }, administratorId);
  adminDemotion = prisma.transaction(
    async transaction => {
      await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'umami:user-mutations'}))::text`;
      await transaction.user.update({ where: { id: actorId }, data: { role: ROLES.user } });
      adminDemotionReady.resolve();
      await releaseAdminDemotion.promise;
    },
    { isolationLevel: 'Serializable', timeout: 15_000 },
  );
  await adminDemotionReady.promise;
  contestedCreate = createUser(
    {
      id: createdUserId,
      username: `role-created-${createdUserId}`,
      password: 'x'.repeat(60),
      role: ROLES.user,
    },
    actorId,
  ).then(
    () => 'allowed',
    error => error,
  );
  await waitForLock('pg_advisory_xact_lock', 'advisory');
  releaseAdminDemotion.resolve();
  await adminDemotion;
  const deniedCreation = await contestedCreate;
  assert.ok(deniedCreation instanceof Error);
  assert.equal(deniedCreation.message, 'ADMIN_AUTHORIZATION_CHANGED');
  assert.equal(await prisma.client.user.findUnique({ where: { id: createdUserId } }), null);

  await updateUser(actorId, { role: ROLES.admin }, administratorId);
  delegatedCreation = runSerializable(async transaction => {
    await lockActorRoleForMutation(transaction, actorId);
    delegatedCreationReady.resolve();
    await releaseDelegatedCreation.promise;
    await transaction.team.create({
      data: { id: delegatedTeamId, name: 'Delegated role-race team' },
    });
    await transaction.teamUser.create({
      data: {
        id: randomUUID(),
        teamId: delegatedTeamId,
        userId: administratorId,
        role: ROLES.teamOwner,
      },
    });
  });
  await delegatedCreationReady.promise;
  delegatedDemotion = updateUser(actorId, { role: ROLES.user }, administratorId);
  await waitForLock('UPDATE', 'transactionid');
  releaseDelegatedCreation.resolve();
  await delegatedCreation;
  await delegatedDemotion;
  assert.equal(
    (await prisma.client.user.findUniqueOrThrow({ where: { id: actorId } })).role,
    ROLES.user,
  );
  assert.equal(await prisma.client.teamUser.count({ where: { teamId: delegatedTeamId } }), 1);

  await prisma.client.website.delete({ where: { id: actorWebsiteId } });
  await prisma.client.team.create({ data: { id: teamId, name: 'Synthetic role-race team' } });
  await prisma.client.teamUser.createMany({
    data: [
      { id: randomUUID(), teamId, userId: otherOwnerId, role: ROLES.teamOwner },
      { id: memberId, teamId, userId: actorId, role: ROLES.teamMember },
    ],
  });
  memberRemoval = runSerializable(async transaction => {
    await lockActorRoleForMutation(transaction, actorId);
    memberRemovalReady.resolve();
    await releaseMemberRemoval.promise;
    return transaction.teamUser.delete({ where: { id: memberId } });
  });
  await memberRemovalReady.promise;
  accountDeletion = deleteUser(actorId, administratorId);
  await waitForLock('FOR UPDATE', 'transactionid');
  releaseMemberRemoval.resolve();
  releaseDelegatedCreation.resolve();
  await memberRemoval;
  await accountDeletion;
  assert.equal(await prisma.client.user.findUnique({ where: { id: actorId } }), null);
  assert.equal(await prisma.client.teamUser.findUnique({ where: { id: memberId } }), null);

  console.log('PostgreSQL role-revocation ordering and stale-administrator writes passed.');
} finally {
  releaseActorMutation.resolve();
  releaseDemotion.resolve();
  releaseAdminDemotion.resolve();
  releaseMemberRemoval.resolve();
  await Promise.allSettled(
    [
      actorMutation,
      demotion,
      contestedMutation,
      adminDemotion,
      contestedCreate,
      memberRemoval,
      accountDeletion,
      delegatedCreation,
      delegatedDemotion,
    ].filter((operation): operation is Promise<unknown> => operation !== undefined),
  );
  await prisma.client.teamUser.deleteMany({ where: { teamId: { in: [teamId, delegatedTeamId] } } });
  await prisma.client.team.deleteMany({ where: { id: { in: [teamId, delegatedTeamId] } } });
  await prisma.client.website.deleteMany({
    where: { id: { in: [actorWebsiteId, otherWebsiteId] } },
  });
  await prisma.client.user.deleteMany({
    where: { id: { in: [administratorId, actorId, otherOwnerId, createdUserId] } },
  });
  await prisma.client.$disconnect();
}
