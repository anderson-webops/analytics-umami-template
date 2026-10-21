import type { Prisma } from '@/generated/prisma/client';

type WebsiteGeneration = { id: string; collectionGeneration: number };

export async function getNextWebsiteCollectionGeneration(
  transaction: Prisma.TransactionClient,
  websiteId: string,
) {
  const tombstones = await transaction.$queryRaw<Array<{ nextGeneration: number }>>`
    SELECT next_generation AS "nextGeneration"
    FROM website_collection_tombstone
    WHERE website_id = ${websiteId}::uuid
  `;

  return tombstones[0]?.nextGeneration ?? 0;
}

export async function recordDeletedWebsiteCollectionGenerations(
  transaction: Prisma.TransactionClient,
  websites: WebsiteGeneration[],
) {
  if (websites.some(website => website.collectionGeneration >= 2_147_483_647)) {
    throw new Error('COLLECTION_GENERATION_EXHAUSTED');
  }

  for (const website of websites) {
    await transaction.$executeRaw`
      INSERT INTO website_collection_tombstone (website_id, next_generation)
      VALUES (${website.id}::uuid, ${website.collectionGeneration + 1})
      ON CONFLICT (website_id) DO UPDATE
      SET next_generation = GREATEST(
        website_collection_tombstone.next_generation,
        EXCLUDED.next_generation
      )
    `;
  }
}
