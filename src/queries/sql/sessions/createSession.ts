import type { Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';

const FUNCTION_NAME = 'createSession';

export async function createSession(data: Prisma.SessionCreateInput) {
  const { rawQuery } = prisma;

  await rawQuery(
    `
    insert into session (
      session_id,
      website_id,
      browser,
      os,
      device,
      screen,
      language,
      country,
      region,
      city,
      is_bot,
      bot_name,
      bot_category,
      distinct_id,
      created_at
    )
    values (
      {{id}},
      {{websiteId}},
      {{browser}},
      {{os}},
      {{device}},
      {{screen}},
      {{language}},
      {{country}},
      {{region}},
      {{city}},
      {{isBot}},
      {{botName}},
      {{botCategory}},
      {{distinctId}},
      {{createdAt}}
    )
    on conflict (session_id) do nothing
    `,
    data,
    FUNCTION_NAME,
  );
}
