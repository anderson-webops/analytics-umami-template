import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { ROLES } from '@/lib/constants';
import prisma from '@/lib/prisma';
import { joinTeamByAccessCode } from '@/queries/prisma/teamUser';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const address = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname));
assert.equal(address.pathname, '/postgres');

const ownerId = randomUUID();
const memberId = randomUUID();
const viewerId = randomUUID();
const racingId = randomUUID();
const teamId = randomUUID();
const accessCode = `team_${randomBytes(8).toString('hex')}`;
let releaseDemotion = () => {};
let signalLocked = () => {};
const demotionGate = new Promise<void>(resolve => {
  releaseDemotion = resolve;
});
const locked = new Promise<void>(resolve => {
  signalLocked = resolve;
});

try {
  for (const [id, role] of [
    [ownerId, ROLES.admin],
    [memberId, ROLES.user],
    [viewerId, ROLES.viewOnly],
    [racingId, ROLES.user],
  ]) {
    await prisma.client.user.create({
      data: { id, username: `team-join-${id}`, password: 'x'.repeat(60), role },
    });
  }
  await prisma.client.team.create({ data: { id: teamId, name: 'Synthetic team', accessCode } });
  await prisma.client.teamUser.create({
    data: { id: randomUUID(), teamId, userId: ownerId, role: ROLES.teamOwner },
  });

  await assert.rejects(joinTeamByAccessCode(viewerId, accessCode), /TEAM_ACTOR_NOT_AUTHORIZED/);
  assert.equal(await prisma.client.teamUser.count({ where: { teamId, userId: viewerId } }), 0);

  const joined = await joinTeamByAccessCode(memberId, accessCode);
  assert.equal(joined.role, ROLES.teamMember);
  await assert.rejects(joinTeamByAccessCode(memberId, accessCode), /TEAM_USER_EXISTS/);

  const demotion = prisma.transaction(
    async transaction => {
      await transaction.$queryRaw`
        SELECT user_id FROM "user" WHERE user_id = ${racingId}::uuid FOR UPDATE
      `;
      signalLocked();
      await demotionGate;
      await transaction.user.update({
        where: { id: racingId },
        data: { role: ROLES.viewOnly, sessionGeneration: { increment: 1 } },
      });
    },
    { isolationLevel: 'Serializable', timeout: 10_000 },
  );
  await locked;
  const attemptedJoin = joinTeamByAccessCode(racingId, accessCode);
  await new Promise(resolve => setTimeout(resolve, 50));
  releaseDemotion();
  await demotion;
  await assert.rejects(attemptedJoin, /TEAM_ACTOR_NOT_AUTHORIZED/);
  assert.equal(await prisma.client.teamUser.count({ where: { teamId, userId: racingId } }), 0);

  await prisma.client.user.update({ where: { id: memberId }, data: { role: ROLES.viewOnly } });
  assert.equal(await prisma.client.teamUser.count({ where: { teamId, userId: memberId } }), 1);
  await assert.rejects(joinTeamByAccessCode(memberId, accessCode), /TEAM_ACTOR_NOT_AUTHORIZED/);
} finally {
  releaseDemotion();
  await prisma.client.teamUser.deleteMany({ where: { teamId } });
  await prisma.client.team.deleteMany({ where: { id: teamId } });
  await prisma.client.user.deleteMany({
    where: { id: { in: [ownerId, memberId, viewerId, racingId] } },
  });
  await prisma.client.$disconnect();
}
