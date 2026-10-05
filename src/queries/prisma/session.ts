import type { Prisma } from '@/generated/prisma/client';
import { PERMISSIONS } from '@/lib/constants';
import { assertActorCanMutateEntity, runSerializable } from './authorization';

async function lockSessionDeleteAuthorization(
  transaction: Prisma.TransactionClient,
  actorUserId: string,
  websiteId: string,
) {
  await transaction.$queryRaw`
    SELECT user_id FROM "user" WHERE user_id = ${actorUserId}::uuid FOR SHARE
  `;

  const websites = await transaction.$queryRaw<{ team_id: string | null }[]>`
    SELECT team_id FROM website WHERE website_id = ${websiteId}::uuid FOR SHARE
  `;
  const teamId = websites[0]?.team_id;

  if (teamId) {
    await transaction.$queryRaw`
      SELECT team_id FROM team WHERE team_id = ${teamId}::uuid FOR SHARE
    `;
    await transaction.$queryRaw`
      SELECT team_user_id FROM team_user
      WHERE team_id = ${teamId}::uuid AND user_id = ${actorUserId}::uuid FOR SHARE
    `;
  }
}

export async function deleteSession(
  websiteId: string,
  sessionId: string,
  actorUserId: string,
): Promise<{ id: string } | null> {
  return runSerializable(async tx => {
    await lockSessionDeleteAuthorization(tx, actorUserId, websiteId);
    await assertActorCanMutateEntity(
      tx,
      actorUserId,
      'website',
      websiteId,
      PERMISSIONS.websiteDelete,
    );

    const session = await tx.session.findFirst({
      where: {
        id: sessionId,
        websiteId,
      },
      select: {
        id: true,
      },
    });

    if (!session) {
      return null;
    }

    const websiteEvents = await tx.websiteEvent.findMany({
      where: {
        websiteId,
        sessionId,
      },
      select: {
        id: true,
        visitId: true,
      },
    });

    const sessionReplays = await tx.sessionReplay.findMany({
      where: {
        websiteId,
        sessionId,
      },
      select: {
        visitId: true,
      },
    });

    const eventIds = websiteEvents.map(({ id }) => id);
    const visitIds = Array.from(
      new Set([...websiteEvents, ...sessionReplays].map(({ visitId }) => visitId)),
    );

    if (eventIds.length) {
      await tx.eventData.deleteMany({
        where: {
          websiteEventId: {
            in: eventIds,
          },
        },
      });
    }

    if (visitIds.length) {
      await tx.sessionReplaySaved.deleteMany({
        where: {
          websiteId,
          visitId: {
            in: visitIds,
          },
        },
      });
    }

    await tx.sessionReplay.deleteMany({
      where: {
        websiteId,
        sessionId,
      },
    });

    await tx.heatmapEvent.deleteMany({
      where: {
        websiteId,
        sessionId,
      },
    });

    await tx.revenue.deleteMany({
      where: {
        websiteId,
        sessionId,
      },
    });

    await tx.sessionData.deleteMany({
      where: {
        websiteId,
        sessionId,
      },
    });

    await tx.sessionLink.deleteMany({
      where: {
        websiteId,
        sessionId,
      },
    });

    await tx.websiteEvent.deleteMany({
      where: {
        websiteId,
        sessionId,
      },
    });

    await tx.session.delete({
      where: {
        id: sessionId,
      },
    });

    return session;
  });
}
