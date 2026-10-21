import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hash } from '@/lib/crypto';
import { hashPassword } from '@/lib/password';
import prisma from '@/lib/prisma';
import type { Auth } from '@/lib/types';
import { lockCollectionSources, withActiveCollectionSource } from '@/queries/prisma/collection';
import { deleteTeam } from '@/queries/prisma/team';
import { deleteUser } from '@/queries/prisma/user';
import {
  createWebsite,
  deleteWebsite,
  resetWebsite,
  updateWebsite,
} from '@/queries/prisma/website';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
assert.equal(process.env.CLOUD_MODE ?? '', '');
const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname));
assert.equal(databaseUrl.pathname, '/postgres');

const administratorId = randomUUID();
const administratorUsername = `collection-lifecycle-${administratorId}`;
const administratorPassword = await hashPassword('synthetic-collection-lifecycle-password-000000');
const provisionedWebsiteId = randomUUID();
const domainWebsiteId = randomUUID();
const teamId = randomUUID();
const teamWebsiteId = randomUUID();
const deletedUserId = randomUUID();
const userWebsiteId = randomUUID();
const auth: Auth = {
  authType: 'session',
  user: {
    id: administratorId,
    username: administratorUsername,
    role: 'admin',
    isAdmin: true,
  },
  passwordFingerprint: hash(administratorPassword),
  sessionGeneration: 0,
};
const oldRequest = (ownerType: 'user' | 'team', ownerId: string) => ({
  keyDigest: 'a'.repeat(64),
  ownerType,
  ownerId,
  generation: 0,
  requestId: randomUUID(),
});

try {
  await prisma.client.user.create({
    data: {
      id: administratorId,
      username: administratorUsername,
      password: administratorPassword,
      role: 'admin',
    },
  });

  const domainWebsite = await createWebsite(
    {
      id: domainWebsiteId,
      name: 'Domain lifecycle',
      domain: 'first.example.test',
      userId: administratorId,
    },
    administratorId,
    { auth },
  );
  assert.equal(domainWebsite.website.collectionGeneration, 0);
  const originalDomainProof = oldRequest('user', administratorId);
  assert.equal(
    await withActiveCollectionSource(
      'website',
      domainWebsiteId,
      async () => 'original domain credential admitted',
      originalDomainProof,
    ),
    'original domain credential admitted',
  );
  const changedDomain = await updateWebsite(
    domainWebsiteId,
    { domain: 'second.example.test' },
    administratorId,
    { auth },
  );
  assert.equal(changedDomain.website.collectionGeneration, 1);
  const restoredDomain = await updateWebsite(
    domainWebsiteId,
    { domain: 'first.example.test' },
    administratorId,
    { auth },
  );
  assert.equal(restoredDomain.website.collectionGeneration, 2);
  const unchangedDomain = await updateWebsite(
    domainWebsiteId,
    { domain: 'first.example.test' },
    administratorId,
    { auth },
  );
  assert.equal(unchangedDomain.website.collectionGeneration, 2);
  const renamedWebsite = await updateWebsite(
    domainWebsiteId,
    { name: 'Renamed domain lifecycle' },
    administratorId,
    { auth },
  );
  assert.equal(renamedWebsite.website.collectionGeneration, 2);
  await assert.rejects(
    () =>
      withActiveCollectionSource(
        'website',
        domainWebsiteId,
        async () => 'stale domain credential',
        originalDomainProof,
      ),
    /COLLECTION_KEY_OWNER_CHANGED/,
  );
  assert.equal(
    await withActiveCollectionSource(
      'website',
      domainWebsiteId,
      async () => 'new domain credential admitted',
      { ...oldRequest('user', administratorId), generation: 2 },
    ),
    'new domain credential admitted',
  );
  const preResetProof = { ...oldRequest('user', administratorId), generation: 2 };
  const reset = await resetWebsite(domainWebsiteId, administratorId, auth);
  assert.equal(reset.collectionGeneration, 3);
  await assert.rejects(
    () =>
      withActiveCollectionSource(
        'website',
        domainWebsiteId,
        async () => 'stale reset credential',
        preResetProof,
      ),
    /COLLECTION_KEY_OWNER_CHANGED/,
  );
  assert.equal(
    await withActiveCollectionSource(
      'website',
      domainWebsiteId,
      async () => 'new reset credential admitted',
      { ...oldRequest('user', administratorId), generation: 3 },
    ),
    'new reset credential admitted',
  );

  const initial = await createWebsite(
    { id: provisionedWebsiteId, name: 'Provisioning lifecycle', userId: administratorId },
    administratorId,
    { auth },
  );
  assert.equal(initial.website.collectionGeneration, 0);
  const provisionProof = oldRequest('user', administratorId);
  let releaseCollection: () => void = () => {};
  const collectionRelease = new Promise<void>(resolve => {
    releaseCollection = resolve;
  });
  let markCollectionEntered: () => void = () => {};
  const collectionEntered = new Promise<void>(resolve => {
    markCollectionEntered = resolve;
  });
  const inFlightCollection = withActiveCollectionSource(
    'website',
    provisionedWebsiteId,
    async () => {
      markCollectionEntered();
      await collectionRelease;
      return 'admitted before deletion';
    },
    provisionProof,
  );
  await collectionEntered;
  let upperCaseLockAcquired = false;
  let markUpperCaseLockStarted: () => void = () => {};
  const upperCaseLockStarted = new Promise<void>(resolve => {
    markUpperCaseLockStarted = resolve;
  });
  const upperCaseLock = prisma.transaction(async transaction => {
    markUpperCaseLockStarted();
    await lockCollectionSources(transaction, [provisionedWebsiteId.toUpperCase()]);
    upperCaseLockAcquired = true;
  });
  await upperCaseLockStarted;
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(upperCaseLockAcquired, false);
  } finally {
    releaseCollection();
  }
  assert.equal(await inFlightCollection, 'admitted before deletion');
  await upperCaseLock;
  assert.equal(upperCaseLockAcquired, true);
  await deleteWebsite(provisionedWebsiteId.toUpperCase(), administratorId, auth);

  const provision = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/provision-site.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DOTENV_CONFIG_PATH: '/dev/null',
      UMAMI_ADMIN_USERNAME: administratorUsername,
      UMAMI_ADMIN_PASSWORD: '',
      UMAMI_WEBSITE_ID: provisionedWebsiteId.toUpperCase(),
      UMAMI_WEBSITE_NAME: 'Provisioning lifecycle',
      UMAMI_WEBSITE_DOMAIN: `${provisionedWebsiteId}.example.test`,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(provision.error);
  assert.equal(provision.status, 0, `${provision.stdout}\n${provision.stderr}`);
  assert.equal(
    (await prisma.client.website.findUniqueOrThrow({ where: { id: provisionedWebsiteId } }))
      .collectionGeneration,
    1,
  );
  await assert.rejects(
    () =>
      withActiveCollectionSource(
        'website',
        provisionedWebsiteId,
        async () => 'stale provisioning credential',
        provisionProof,
      ),
    /COLLECTION_KEY_OWNER_CHANGED/,
  );

  await prisma.client.team.create({ data: { id: teamId, name: 'Synthetic lifecycle team' } });
  await prisma.client.website.create({
    data: { id: teamWebsiteId, name: 'Team lifecycle', teamId, createdBy: administratorId },
  });
  await prisma.client.sessionLink.create({
    data: {
      websiteId: teamWebsiteId,
      sessionId: randomUUID(),
      distinctId: 'retired-team-identity',
      trustTier: 1,
    },
  });
  const teamProof = oldRequest('team', teamId);
  await deleteTeam(teamId, administratorId, auth);
  assert.equal(await prisma.client.sessionLink.count({ where: { websiteId: teamWebsiteId } }), 0);
  assert.equal(
    (
      await prisma.client.websiteCollectionTombstone.findUniqueOrThrow({
        where: { websiteId: teamWebsiteId },
      })
    ).nextGeneration,
    1,
  );
  await prisma.client.team.create({ data: { id: teamId, name: 'Recreated lifecycle team' } });
  const recreatedTeamWebsite = await createWebsite(
    { id: teamWebsiteId, name: 'Recreated team lifecycle', teamId },
    administratorId,
    { auth },
  );
  assert.equal(recreatedTeamWebsite.website.collectionGeneration, 1);
  assert.equal(await prisma.client.sessionLink.count({ where: { websiteId: teamWebsiteId } }), 0);
  await assert.rejects(
    () =>
      withActiveCollectionSource(
        'website',
        teamWebsiteId,
        async () => 'stale team credential',
        teamProof,
      ),
    /COLLECTION_KEY_OWNER_CHANGED/,
  );

  await prisma.client.user.create({
    data: {
      id: deletedUserId,
      username: `collection-deleted-${deletedUserId}`,
      password: 'x'.repeat(60),
      role: 'user',
    },
  });
  await prisma.client.website.create({
    data: {
      id: userWebsiteId,
      name: 'Inactive user lifecycle',
      userId: deletedUserId,
      deletedAt: new Date(),
    },
  });
  await prisma.client.sessionLink.create({
    data: {
      websiteId: userWebsiteId,
      sessionId: randomUUID(),
      distinctId: 'retired-user-identity',
      trustTier: 1,
    },
  });
  const userProof = oldRequest('user', deletedUserId);
  await deleteUser(deletedUserId, administratorId, auth);
  assert.equal(await prisma.client.sessionLink.count({ where: { websiteId: userWebsiteId } }), 0);
  assert.equal(
    (
      await prisma.client.websiteCollectionTombstone.findUniqueOrThrow({
        where: { websiteId: userWebsiteId },
      })
    ).nextGeneration,
    1,
  );
  await prisma.client.user.create({
    data: {
      id: deletedUserId,
      username: `collection-recreated-${deletedUserId}`,
      password: 'x'.repeat(60),
      role: 'user',
    },
  });
  const recreatedUserWebsite = await createWebsite(
    { id: userWebsiteId, name: 'Recreated user lifecycle', userId: deletedUserId },
    administratorId,
    { auth },
  );
  assert.equal(recreatedUserWebsite.website.collectionGeneration, 1);
  assert.equal(await prisma.client.sessionLink.count({ where: { websiteId: userWebsiteId } }), 0);
  await assert.rejects(
    () =>
      withActiveCollectionSource(
        'website',
        userWebsiteId,
        async () => 'stale user credential',
        userProof,
      ),
    /COLLECTION_KEY_OWNER_CHANGED/,
  );

  console.log(
    'Collection generation lifecycle passed domain edits, reset, provisioning, team, and user deletion.',
  );
} finally {
  await prisma.client.website.deleteMany({
    where: { id: { in: [provisionedWebsiteId, domainWebsiteId, teamWebsiteId, userWebsiteId] } },
  });
  await prisma.client.websiteCollectionTombstone.deleteMany({
    where: { websiteId: { in: [provisionedWebsiteId, teamWebsiteId, userWebsiteId] } },
  });
  await prisma.client.team.deleteMany({ where: { id: teamId } });
  await prisma.client.user.deleteMany({ where: { id: { in: [administratorId, deletedUserId] } } });
  await prisma.client.$disconnect();
}
