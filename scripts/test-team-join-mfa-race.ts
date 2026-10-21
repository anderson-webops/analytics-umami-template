import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { hashApiKey } from '@/lib/api-key';
import { checkAuth } from '@/lib/auth';
import { ENTITY_TYPE, ROLES, SEGMENT_TYPES } from '@/lib/constants';
import { hash, secret } from '@/lib/crypto';
import { createSecureToken } from '@/lib/jwt';
import prisma from '@/lib/prisma';
import { getTwoFactorRequirement } from '@/lib/two-factor/requirement';
import { createAnnotation, deleteAnnotation, updateAnnotation } from '@/queries/prisma/annotation';
import { createApiKey } from '@/queries/prisma/apiKey';
import { runAuthorizedAdministratorMutation } from '@/queries/prisma/authorization';
import { createBoard, deleteBoard, updateBoard } from '@/queries/prisma/board';
import { createLink, deleteLink, updateLink } from '@/queries/prisma/link';
import { createPixel, deletePixel, updatePixel } from '@/queries/prisma/pixel';
import { createSegment, deleteSegment, updateSegment } from '@/queries/prisma/segment';
import { deleteSession } from '@/queries/prisma/session';
import { setReplaySavedByActor } from '@/queries/prisma/sessionReplay';
import { createShare, deleteShare, updateShare } from '@/queries/prisma/share';
import { createTeam, deleteTeam, updateTeam } from '@/queries/prisma/team';
import {
  addTeamUserByActor,
  deleteTeamUserByActor,
  joinTeamByAccessCode,
  transferTeamOwnership,
  updateTeamUserRoleByActor,
} from '@/queries/prisma/teamUser';
import {
  createWebsite,
  deleteWebsite,
  resetWebsite,
  transferWebsiteByActor,
  updateWebsite,
} from '@/queries/prisma/website';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const address = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname));
assert.equal(address.pathname, '/postgres');

const actorId = randomUUID();
const adminId = randomUUID();
const targetUserId = randomUUID();
const requiredTeamId = randomUUID();
const ordinaryTeamId = randomUUID();
const extraTeamId = randomUUID();
const createdTeamId = randomUUID();
const requiredWebsiteId = randomUUID();
const racingWebsiteId = randomUUID();
const ordinaryWebsiteId = randomUUID();
const protectedLinkId = randomUUID();
const protectedPixelId = randomUUID();
const protectedBoardId = randomUUID();
const protectedShareId = randomUUID();
const protectedAnnotationId = randomUUID();
const protectedSessionId = randomUUID();
const protectedVisitId = randomUUID();
const protectedSegmentId = randomUUID();
const protectedApiKeyId = randomUUID();
const adminSettingKey = `synthetic-team-mfa-admin-${adminId}`;
const apiKeyWebsiteId = randomUUID();
const revokedApiKeyWebsiteId = randomUUID();
const requiredCode = `team_${randomBytes(8).toString('hex')}`;
const ordinaryCode = `team_${randomBytes(8).toString('hex')}`;
const extraCode = `team_${randomBytes(8).toString('hex')}`;
const blocker = new Client({ connectionString: address.toString() });
const inspector = new Client({ connectionString: address.toString() });
let pendingJoin: Promise<unknown> | null = null;
let pendingMutation: Promise<unknown> | null = null;
let blockerConnected = false;

async function waitForBlockedTransactions(expected: number) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await inspector.query<{ blocked: number }>(`
      SELECT count(*)::int AS blocked FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND pid <> pg_backend_pid()
    `);
    if (result.rows[0].blocked >= expected) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Expected ${expected} blocked synthetic transactions`);
}

try {
  await prisma.client.user.create({
    data: {
      id: actorId,
      username: `team-mfa-${actorId}`,
      password: 'x'.repeat(60),
      role: ROLES.user,
    },
  });
  await prisma.client.user.create({
    data: {
      id: targetUserId,
      username: `team-mfa-target-${targetUserId}`,
      password: 'x'.repeat(60),
      role: ROLES.user,
    },
  });
  await prisma.client.user.create({
    data: {
      id: adminId,
      username: `team-mfa-admin-${adminId}`,
      password: 'x'.repeat(60),
      role: ROLES.admin,
    },
  });
  await prisma.client.team.createMany({
    data: [
      {
        id: requiredTeamId,
        name: 'Synthetic protected team',
        accessCode: requiredCode,
        twoFactorRequired: true,
      },
      { id: ordinaryTeamId, name: 'Synthetic ordinary team', accessCode: ordinaryCode },
      { id: extraTeamId, name: 'Synthetic extra team', accessCode: extraCode },
    ],
  });

  assert.equal((await getTwoFactorRequirement(actorId)).reason, null);
  const preJoinToken = await createSecureToken(
    {
      userId: actorId,
      role: ROLES.user,
      pwd: hash('x'.repeat(60)),
      sessionGeneration: 0,
    },
    secret(),
    { expiresIn: 300 },
  );
  const preJoinRequest = new Request('https://analytics.example.test/api/websites', {
    method: 'POST',
    headers: { authorization: `Bearer ${preJoinToken}` },
  });
  const preJoinAuth = await checkAuth(preJoinRequest);
  assert.ok(preJoinAuth?.authType === 'session');
  assert.equal(preJoinAuth?.mfaVerified, false);
  await joinTeamByAccessCode(actorId, ordinaryCode, preJoinAuth);
  const ordinaryWebsite = await createWebsite(
    {
      id: ordinaryWebsiteId,
      name: 'Ordinary synthetic website',
      domain: 'ordinary.example.test',
      teamId: ordinaryTeamId,
      createdBy: actorId,
    },
    actorId,
    { auth: preJoinAuth },
  );
  assert.equal(ordinaryWebsite.website.id, ordinaryWebsiteId);

  await blocker.connect();
  blockerConnected = true;
  await inspector.connect();
  await blocker.query('BEGIN');
  await blocker.query('LOCK TABLE team_user IN SHARE MODE');
  pendingJoin = joinTeamByAccessCode(actorId, requiredCode, preJoinAuth);
  void pendingJoin.catch(() => {});
  await waitForBlockedTransactions(1);
  pendingMutation = createWebsite(
    {
      id: racingWebsiteId,
      name: 'Racing synthetic website',
      domain: 'racing.example.test',
      teamId: ordinaryTeamId,
      createdBy: actorId,
    },
    actorId,
    { auth: preJoinAuth },
  );
  void pendingMutation.catch(() => {});
  await waitForBlockedTransactions(2);
  await blocker.query('COMMIT');
  await pendingJoin;
  pendingJoin = null;
  await assert.rejects(pendingMutation, /ENTITY_ACTOR_NOT_AUTHORIZED/);
  pendingMutation = null;

  assert.equal((await getTwoFactorRequirement(actorId)).reason, 'team');

  await assert.rejects(
    createApiKey(
      {
        id: protectedApiKeyId,
        userId: actorId,
        name: 'Stale synthetic key',
        keyHash: 'a'.repeat(128),
        keyPrefix: 'umami_synthetic',
      },
      0,
      'x'.repeat(60),
    ),
    /API_KEY_AUTHORIZATION_CHANGED/,
  );
  assert.equal(await prisma.client.apiKey.count({ where: { id: protectedApiKeyId } }), 0);

  await assert.rejects(
    createWebsite(
      {
        id: requiredWebsiteId,
        name: 'Protected synthetic website',
        domain: 'protected.example.test',
        teamId: requiredTeamId,
        createdBy: actorId,
      },
      actorId,
      { auth: preJoinAuth },
    ),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );

  const factor = await prisma.client.twoFactorAuth.create({
    data: { userId: actorId, secret: 'synthetic-factor', isEnabled: true },
  });
  await prisma.client.user.update({
    where: { id: actorId },
    data: { sessionGeneration: { increment: 1 } },
  });
  assert.equal(await checkAuth(preJoinRequest), null);
  await assert.rejects(
    createWebsite(
      {
        id: requiredWebsiteId,
        name: 'Stale-session synthetic website',
        domain: 'stale.example.test',
        teamId: requiredTeamId,
        createdBy: actorId,
      },
      actorId,
      { auth: preJoinAuth },
    ),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );

  const verifiedToken = await createSecureToken(
    {
      userId: actorId,
      role: ROLES.user,
      pwd: hash('x'.repeat(60)),
      sessionGeneration: 1,
      mfa: true,
      mfaId: factor.id,
    },
    secret(),
    { expiresIn: 300 },
  );
  const verifiedAuth = await checkAuth(
    new Request('https://analytics.example.test/api/websites', {
      method: 'POST',
      headers: { authorization: `Bearer ${verifiedToken}` },
    }),
  );
  assert.ok(verifiedAuth?.authType === 'session');
  assert.equal(verifiedAuth.mfaVerified, true);
  const verifiedWebsite = await createWebsite(
    {
      id: requiredWebsiteId,
      name: 'Verified synthetic website',
      domain: 'verified.example.test',
      teamId: requiredTeamId,
      createdBy: actorId,
    },
    actorId,
    { auth: verifiedAuth },
  );
  assert.equal(verifiedWebsite.website.id, requiredWebsiteId);

  const apiKeyToken = `umami_${randomBytes(16).toString('hex')}`;
  await prisma.client.apiKey.create({
    data: {
      id: protectedApiKeyId,
      userId: actorId,
      name: 'Synthetic active key',
      keyHash: hashApiKey(apiKeyToken),
      keyPrefix: apiKeyToken.slice(0, 14),
    },
  });
  const apiKeyAuth = await checkAuth(
    new Request('https://analytics.example.test/api/websites', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKeyToken}` },
    }),
  );
  assert.ok(apiKeyAuth?.authType === 'api-key');
  const apiKeyWebsite = await createWebsite(
    {
      id: apiKeyWebsiteId,
      name: 'Authorized synthetic API-key website',
      domain: 'api-key.example.test',
      teamId: requiredTeamId,
      createdBy: actorId,
    },
    actorId,
    { auth: apiKeyAuth },
  );
  assert.equal(apiKeyWebsite.website.id, apiKeyWebsiteId);
  await prisma.client.apiKey.delete({ where: { id: protectedApiKeyId } });
  await assert.rejects(
    createWebsite(
      {
        id: revokedApiKeyWebsiteId,
        name: 'Revoked synthetic API-key website',
        domain: 'revoked-api-key.example.test',
        teamId: requiredTeamId,
        createdBy: actorId,
      },
      actorId,
      { auth: apiKeyAuth },
    ),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );

  await assert.rejects(
    createLink(
      {
        id: protectedLinkId,
        name: 'Stale-session synthetic link',
        url: 'https://example.test/',
        slug: `stale-${protectedLinkId}`,
        teamId: requiredTeamId,
      },
      actorId,
      { auth: preJoinAuth },
    ),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    createPixel(
      {
        id: protectedPixelId,
        name: 'Stale-session synthetic pixel',
        slug: `stale-${protectedPixelId}`,
        teamId: requiredTeamId,
      },
      actorId,
      { auth: preJoinAuth },
    ),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    createBoard(
      {
        id: protectedBoardId,
        name: 'Stale-session synthetic board',
        description: '',
        type: 'website',
        parameters: {},
        teamId: requiredTeamId,
      },
      actorId,
      { auth: preJoinAuth },
    ),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );

  const verifiedLink = await createLink(
    {
      id: protectedLinkId,
      name: 'Verified synthetic link',
      url: 'https://example.test/',
      slug: `verified-${protectedLinkId}`,
      teamId: requiredTeamId,
    },
    actorId,
    { auth: verifiedAuth },
  );
  assert.equal(verifiedLink.id, protectedLinkId);
  const verifiedPixel = await createPixel(
    {
      id: protectedPixelId,
      name: 'Verified synthetic pixel',
      slug: `verified-${protectedPixelId}`,
      teamId: requiredTeamId,
    },
    actorId,
    { auth: verifiedAuth },
  );
  assert.equal(verifiedPixel.id, protectedPixelId);
  const verifiedBoard = await createBoard(
    {
      id: protectedBoardId,
      name: 'Verified synthetic board',
      description: '',
      type: 'website',
      parameters: {},
      teamId: requiredTeamId,
    },
    actorId,
    { auth: verifiedAuth },
  );
  assert.equal(verifiedBoard.id, protectedBoardId);

  await assert.rejects(
    updateLink(protectedLinkId, { name: 'Stale edit' }, actorId, preJoinAuth),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    deleteLink(protectedLinkId, actorId, preJoinAuth),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    updatePixel(protectedPixelId, { name: 'Stale edit' }, actorId, preJoinAuth),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    deletePixel(protectedPixelId, actorId, preJoinAuth),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    updateBoard(protectedBoardId, { name: 'Stale edit' }, actorId, preJoinAuth),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    deleteBoard(protectedBoardId, actorId, preJoinAuth),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  assert.equal(
    (await updateLink(protectedLinkId, { name: 'Verified edit' }, actorId, verifiedAuth)).name,
    'Verified edit',
  );
  assert.equal(
    (await updatePixel(protectedPixelId, { name: 'Verified edit' }, actorId, verifiedAuth)).name,
    'Verified edit',
  );
  assert.equal(
    (await updateBoard(protectedBoardId, { name: 'Verified edit' }, actorId, verifiedAuth)).name,
    'Verified edit',
  );
  await assert.rejects(
    updateWebsite(requiredWebsiteId, { name: 'Stale edit' }, actorId, {
      auth: preJoinAuth,
    }),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    resetWebsite(requiredWebsiteId, actorId, preJoinAuth),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    deleteWebsite(requiredWebsiteId, actorId, preJoinAuth),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    transferWebsiteByActor(requiredWebsiteId, { userId: actorId }, actorId, preJoinAuth),
    /WEBSITE_TRANSFER_NOT_AUTHORIZED/,
  );
  assert.equal(
    (
      await updateWebsite(requiredWebsiteId, { name: 'Verified edit' }, actorId, {
        auth: verifiedAuth,
      })
    ).website.name,
    'Verified edit',
  );
  const verifiedShare = await createShare(
    {
      id: protectedShareId,
      entityId: requiredWebsiteId,
      shareType: ENTITY_TYPE.website,
      name: 'Verified synthetic share',
      slug: randomBytes(18).toString('base64url'),
      parameters: {},
    },
    actorId,
    verifiedAuth,
  );
  assert.equal(verifiedShare.id, protectedShareId);
  await assert.rejects(
    updateShare(
      protectedShareId,
      { name: 'Stale edit', slug: verifiedShare.slug, parameters: {} },
      actorId,
      preJoinAuth,
    ),
    /SHARE_ACTOR_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    deleteShare(protectedShareId, actorId, preJoinAuth),
    /SHARE_ACTOR_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    createAnnotation(
      {
        id: protectedAnnotationId,
        websiteId: requiredWebsiteId,
        userId: actorId,
        date: new Date(),
        allDay: true,
        note: 'Stale note',
      },
      actorId,
      preJoinAuth,
    ),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  const verifiedAnnotation = await createAnnotation(
    {
      id: protectedAnnotationId,
      websiteId: requiredWebsiteId,
      userId: actorId,
      date: new Date(),
      allDay: true,
      note: 'Verified note',
    },
    actorId,
    verifiedAuth,
  );
  assert.equal(verifiedAnnotation.id, protectedAnnotationId);
  await assert.rejects(
    updateAnnotation(
      requiredWebsiteId,
      protectedAnnotationId,
      { note: 'Stale edit' },
      actorId,
      preJoinAuth,
    ),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    deleteAnnotation(requiredWebsiteId, protectedAnnotationId, actorId, preJoinAuth),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  assert.equal(
    (
      await updateAnnotation(
        requiredWebsiteId,
        protectedAnnotationId,
        { note: 'Verified edit' },
        actorId,
        verifiedAuth,
      )
    ).note,
    'Verified edit',
  );
  await assert.rejects(
    createSegment(
      {
        id: protectedSegmentId,
        websiteId: requiredWebsiteId,
        type: SEGMENT_TYPES.segment,
        name: 'Stale segment',
        parameters: {},
      },
      actorId,
      preJoinAuth,
    ),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  const verifiedSegment = await createSegment(
    {
      id: protectedSegmentId,
      websiteId: requiredWebsiteId,
      type: SEGMENT_TYPES.segment,
      name: 'Verified segment',
      parameters: {},
    },
    actorId,
    verifiedAuth,
  );
  assert.equal(verifiedSegment.id, protectedSegmentId);
  await assert.rejects(
    updateSegment(
      requiredWebsiteId,
      protectedSegmentId,
      { name: 'Stale edit' },
      actorId,
      preJoinAuth,
    ),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    deleteSegment(requiredWebsiteId, protectedSegmentId, actorId, preJoinAuth),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  assert.equal(
    (
      await updateSegment(
        requiredWebsiteId,
        protectedSegmentId,
        { name: 'Verified edit' },
        actorId,
        verifiedAuth,
      )
    ).name,
    'Verified edit',
  );
  await assert.rejects(
    setReplaySavedByActor(requiredWebsiteId, protectedVisitId, false, '', actorId, preJoinAuth),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  assert.equal(
    await setReplaySavedByActor(
      requiredWebsiteId,
      protectedVisitId,
      false,
      '',
      actorId,
      verifiedAuth,
    ),
    false,
  );
  await prisma.client.session.create({
    data: { id: protectedSessionId, websiteId: requiredWebsiteId },
  });
  await assert.rejects(
    deleteSession(requiredWebsiteId, protectedSessionId, actorId, preJoinAuth),
    /ENTITY_ACTOR_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    deleteSession(requiredWebsiteId, protectedSessionId, actorId, verifiedAuth),
    /KAFKA_HISTORY_REVIEW_REQUIRED/,
  );
  assert.equal(process.env.KAFKA_URL, '');
  assert.equal(process.env.KAFKA_BROKER ?? '', '');
  assert.equal(process.env.CLICKHOUSE_URL, '');
  const priorKafkaAttestation = process.env.KAFKA_HISTORY_ATTESTED_CLEAN;
  const priorClickhouseAttestation = process.env.CLICKHOUSE_HISTORY_ATTESTED_CLEAN;
  try {
    process.env.KAFKA_HISTORY_ATTESTED_CLEAN = 'true';
    process.env.CLICKHOUSE_HISTORY_ATTESTED_CLEAN = 'true';
    assert.equal(
      (await deleteSession(requiredWebsiteId, protectedSessionId, actorId, verifiedAuth))?.id,
      protectedSessionId,
    );
  } finally {
    if (priorKafkaAttestation === undefined) {
      delete process.env.KAFKA_HISTORY_ATTESTED_CLEAN;
    } else {
      process.env.KAFKA_HISTORY_ATTESTED_CLEAN = priorKafkaAttestation;
    }
    if (priorClickhouseAttestation === undefined) {
      delete process.env.CLICKHOUSE_HISTORY_ATTESTED_CLEAN;
    } else {
      process.env.CLICKHOUSE_HISTORY_ATTESTED_CLEAN = priorClickhouseAttestation;
    }
  }
  await assert.rejects(
    createTeam({ id: createdTeamId, name: 'Stale team' }, actorId, actorId, null, preJoinAuth),
    /TEAM_ACTOR_NOT_AUTHORIZED/,
  );
  assert.equal(
    (
      await createTeam(
        { id: createdTeamId, name: 'Verified team' },
        actorId,
        actorId,
        null,
        verifiedAuth,
      )
    ).id,
    createdTeamId,
  );
  await assert.rejects(
    joinTeamByAccessCode(actorId, extraCode, preJoinAuth),
    /TEAM_ACTOR_NOT_AUTHORIZED/,
  );
  assert.equal((await joinTeamByAccessCode(actorId, extraCode, verifiedAuth)).teamId, extraTeamId);
  await prisma.client.teamUser.updateMany({
    where: { teamId: requiredTeamId, userId: actorId },
    data: { role: ROLES.teamOwner },
  });
  await assert.rejects(
    updateTeam(requiredTeamId, { name: 'Stale team edit' }, actorId, preJoinAuth),
    /TEAM_ACTOR_NOT_AUTHORIZED/,
  );
  assert.equal(
    (await updateTeam(requiredTeamId, { name: 'Verified team edit' }, actorId, verifiedAuth)).name,
    'Verified team edit',
  );
  await assert.rejects(
    addTeamUserByActor(requiredTeamId, targetUserId, ROLES.teamMember, actorId, preJoinAuth),
    /TEAM_ACTOR_NOT_AUTHORIZED/,
  );
  assert.equal(
    (
      await addTeamUserByActor(
        requiredTeamId,
        targetUserId,
        ROLES.teamMember,
        actorId,
        verifiedAuth,
      )
    ).userId,
    targetUserId,
  );
  await assert.rejects(
    updateTeamUserRoleByActor(
      requiredTeamId,
      targetUserId,
      ROLES.teamViewOnly,
      actorId,
      preJoinAuth,
    ),
    /TEAM_ACTOR_NOT_AUTHORIZED/,
  );
  assert.equal(
    (
      await updateTeamUserRoleByActor(
        requiredTeamId,
        targetUserId,
        ROLES.teamViewOnly,
        actorId,
        verifiedAuth,
      )
    ).role,
    ROLES.teamViewOnly,
  );
  await assert.rejects(
    deleteTeamUserByActor(requiredTeamId, targetUserId, actorId, preJoinAuth),
    /TEAM_ACTOR_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    transferTeamOwnership(requiredTeamId, targetUserId, actorId, preJoinAuth),
    /TEAM_ACTOR_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    deleteTeam(createdTeamId, actorId, preJoinAuth),
    /TEAM_ACTOR_NOT_AUTHORIZED/,
  );
  assert.equal(
    (await deleteTeamUserByActor(requiredTeamId, targetUserId, actorId, verifiedAuth)).userId,
    targetUserId,
  );

  const preJoinAdminToken = await createSecureToken(
    {
      userId: adminId,
      role: ROLES.admin,
      pwd: hash('x'.repeat(60)),
      sessionGeneration: 0,
    },
    secret(),
    { expiresIn: 300 },
  );
  const preJoinAdminAuth = await checkAuth(
    new Request('https://analytics.example.test/api/admin/2fa/global', {
      method: 'POST',
      headers: { authorization: `Bearer ${preJoinAdminToken}` },
    }),
  );
  assert.ok(preJoinAdminAuth?.authType === 'session');
  await joinTeamByAccessCode(adminId, requiredCode, preJoinAdminAuth);
  await assert.rejects(
    runAuthorizedAdministratorMutation(adminId, preJoinAdminAuth, transaction =>
      transaction.appSetting.create({ data: { key: adminSettingKey, value: 'true' } }),
    ),
    /ENTITY_ADMIN_REQUIRED/,
  );
  assert.equal(
    await prisma.client.appSetting.findUnique({ where: { key: adminSettingKey } }),
    null,
  );

  const adminFactor = await prisma.client.twoFactorAuth.create({
    data: { userId: adminId, secret: 'synthetic-admin-factor', isEnabled: true },
  });
  await prisma.client.user.update({
    where: { id: adminId },
    data: { sessionGeneration: { increment: 1 } },
  });
  const verifiedAdminToken = await createSecureToken(
    {
      userId: adminId,
      role: ROLES.admin,
      pwd: hash('x'.repeat(60)),
      sessionGeneration: 1,
      mfa: true,
      mfaId: adminFactor.id,
    },
    secret(),
    { expiresIn: 300 },
  );
  const verifiedAdminAuth = await checkAuth(
    new Request('https://analytics.example.test/api/admin/2fa/global', {
      method: 'POST',
      headers: { authorization: `Bearer ${verifiedAdminToken}` },
    }),
  );
  assert.ok(verifiedAdminAuth?.authType === 'session');
  assert.equal(
    (
      await runAuthorizedAdministratorMutation(adminId, verifiedAdminAuth, transaction =>
        transaction.appSetting.create({ data: { key: adminSettingKey, value: 'true' } }),
      )
    ).value,
    'true',
  );
  console.log(
    'PostgreSQL team-join MFA race, stale-session, administrator, and API-key controls passed.',
  );
} finally {
  if (blockerConnected) {
    await blocker.query('ROLLBACK').catch(() => {});
  }
  await Promise.allSettled(
    [pendingJoin, pendingMutation].filter(
      (promise): promise is Promise<unknown> => promise !== null,
    ),
  );
  await Promise.allSettled([blocker.end(), inspector.end()]);
  await prisma.client.share.deleteMany({ where: { id: protectedShareId } });
  await prisma.client.annotation.deleteMany({ where: { id: protectedAnnotationId } });
  await prisma.client.segment.deleteMany({ where: { id: protectedSegmentId } });
  await prisma.client.session.deleteMany({ where: { id: protectedSessionId } });
  await prisma.client.website.deleteMany({
    where: {
      id: {
        in: [requiredWebsiteId, racingWebsiteId, ordinaryWebsiteId, apiKeyWebsiteId],
      },
    },
  });
  await prisma.client.apiKey.deleteMany({ where: { id: protectedApiKeyId } });
  await prisma.client.board.deleteMany({ where: { id: protectedBoardId } });
  await prisma.client.link.deleteMany({ where: { id: protectedLinkId } });
  await prisma.client.pixel.deleteMany({ where: { id: protectedPixelId } });
  await prisma.client.teamUser.deleteMany({
    where: { teamId: { in: [requiredTeamId, ordinaryTeamId, extraTeamId, createdTeamId] } },
  });
  await prisma.client.team.deleteMany({
    where: { id: { in: [requiredTeamId, ordinaryTeamId, extraTeamId, createdTeamId] } },
  });
  await prisma.client.twoFactorAuth.deleteMany({ where: { userId: { in: [actorId, adminId] } } });
  await prisma.client.appSetting.deleteMany({ where: { key: adminSettingKey } });
  await prisma.client.user.deleteMany({ where: { id: { in: [actorId, adminId, targetUserId] } } });
  await prisma.client.$disconnect();
}
