/* eslint-disable no-console */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { type Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { getSessionCountForDay } from './distributions/temporal.js';
import {
  type EventData,
  type EventDataEntry,
  generateEventsForSession,
} from './generators/events.js';
import {
  generateRevenueForEvents,
  type RevenueConfig,
  type RevenueData,
} from './generators/revenue.js';
import { createSessions, type SessionData } from './generators/sessions.js';
import {
  parseSeedTarget,
  SEED_WEBSITES,
  type SeedConfig,
  SeedSafetyError,
  verifySeedMarker,
  verifySeedWebsiteIdentity,
} from './safety.js';
import {
  BLOG_SESSIONS_PER_DAY,
  BLOG_WEBSITE_DOMAIN,
  BLOG_WEBSITE_NAME,
  getBlogJourney,
  getBlogSiteConfig,
} from './sites/blog.js';
import {
  getSaasJourney,
  getSaasSiteConfig,
  SAAS_SESSIONS_PER_DAY,
  SAAS_WEBSITE_DOMAIN,
  SAAS_WEBSITE_NAME,
  saasRevenueConfigs,
} from './sites/saas.js';
import { formatNumber, generateDatesBetween, progressBar, subDays } from './utils.js';

export type { SeedConfig } from './safety.js';

const BATCH_SIZE = 1000;

type SessionCreateInput = Prisma.SessionCreateManyInput;
type WebsiteEventCreateInput = Prisma.WebsiteEventCreateManyInput;
type EventDataCreateInput = Prisma.EventDataCreateManyInput;
type RevenueCreateInput = Prisma.RevenueCreateManyInput;

export interface SeedResult {
  websites: number;
  sessions: number;
  events: number;
  eventData: number;
  revenue: number;
}

async function batchInsertSessions(
  prisma: PrismaClient,
  data: SessionCreateInput[],
  verbose: boolean,
): Promise<void> {
  for (let i = 0; i < data.length; i += BATCH_SIZE) {
    const batch = data.slice(i, i + BATCH_SIZE);
    await prisma.session.createMany({ data: batch, skipDuplicates: true });
    if (verbose) {
      console.log(
        `  Inserted ${Math.min(i + BATCH_SIZE, data.length)}/${data.length} session records`,
      );
    }
  }
}

async function batchInsertEvents(
  prisma: PrismaClient,
  data: WebsiteEventCreateInput[],
  verbose: boolean,
): Promise<void> {
  for (let i = 0; i < data.length; i += BATCH_SIZE) {
    const batch = data.slice(i, i + BATCH_SIZE);
    await prisma.websiteEvent.createMany({ data: batch, skipDuplicates: true });
    if (verbose) {
      console.log(
        `  Inserted ${Math.min(i + BATCH_SIZE, data.length)}/${data.length} event records`,
      );
    }
  }
}

async function batchInsertEventData(
  prisma: PrismaClient,
  data: EventDataCreateInput[],
  verbose: boolean,
): Promise<void> {
  for (let i = 0; i < data.length; i += BATCH_SIZE) {
    const batch = data.slice(i, i + BATCH_SIZE);
    await prisma.eventData.createMany({ data: batch, skipDuplicates: true });
    if (verbose) {
      console.log(
        `  Inserted ${Math.min(i + BATCH_SIZE, data.length)}/${data.length} eventData records`,
      );
    }
  }
}

async function batchInsertRevenue(
  prisma: PrismaClient,
  data: RevenueCreateInput[],
  verbose: boolean,
): Promise<void> {
  for (let i = 0; i < data.length; i += BATCH_SIZE) {
    const batch = data.slice(i, i + BATCH_SIZE);
    await prisma.revenue.createMany({ data: batch, skipDuplicates: true });
    if (verbose) {
      console.log(
        `  Inserted ${Math.min(i + BATCH_SIZE, data.length)}/${data.length} revenue records`,
      );
    }
  }
}

async function findAdminUser(prisma: PrismaClient): Promise<string> {
  const adminUser = await prisma.user.findFirst({
    where: { role: 'admin' },
    select: { id: true },
  });

  if (!adminUser) {
    throw new Error(
      'No admin user found in the database.\n' +
        'Please ensure you have run the initial setup and created an admin user.\n' +
        'The default admin user is created during first build (username: admin, password: umami).',
    );
  }

  return adminUser.id;
}

async function createWebsite(
  prisma: PrismaClient,
  websiteId: string,
  name: string,
  domain: string,
  adminUserId: string,
): Promise<string> {
  await prisma.website.create({
    data: {
      id: websiteId,
      name,
      domain,
      userId: adminUserId,
      createdBy: adminUserId,
    },
  });

  return websiteId;
}

async function clearDemoData(prisma: PrismaClient, adminUserId: string): Promise<void> {
  console.log('Clearing existing demo data...');

  await prisma.$transaction(
    async transaction => {
      const demoWebsites = await transaction.website.findMany({
        where: { id: { in: SEED_WEBSITES.map(website => website.id) } },
        select: {
          id: true,
          name: true,
          domain: true,
          userId: true,
          createdBy: true,
          teamId: true,
          deletedAt: true,
        },
      });

      for (const website of demoWebsites) {
        verifySeedWebsiteIdentity(website, adminUserId);
      }

      const websiteIds = demoWebsites.map(website => website.id);
      if (websiteIds.length === 0) {
        return;
      }

      await transaction.revenue.deleteMany({ where: { websiteId: { in: websiteIds } } });
      await transaction.eventData.deleteMany({ where: { websiteId: { in: websiteIds } } });
      await transaction.sessionData.deleteMany({ where: { websiteId: { in: websiteIds } } });
      await transaction.websiteEvent.deleteMany({ where: { websiteId: { in: websiteIds } } });
      await transaction.session.deleteMany({ where: { websiteId: { in: websiteIds } } });
      await transaction.segment.deleteMany({ where: { websiteId: { in: websiteIds } } });
      await transaction.report.deleteMany({ where: { websiteId: { in: websiteIds } } });
      await transaction.website.deleteMany({ where: { id: { in: websiteIds } } });
    },
    { isolationLevel: 'Serializable', timeout: 120_000 },
  );

  console.log('  Cleared existing demo data');
}

interface SiteGeneratorConfig {
  websiteId: string;
  name: string;
  domain: string;
  sessionsPerDay: number;
  getSiteConfig: () => ReturnType<typeof getBlogSiteConfig>;
  getJourney: () => string[];
  revenueConfigs?: RevenueConfig[];
}

async function generateSiteData(
  prisma: PrismaClient,
  config: SiteGeneratorConfig,
  days: Date[],
  adminUserId: string,
  verbose: boolean,
): Promise<{ sessions: number; events: number; eventData: number; revenue: number }> {
  console.log(`\nGenerating data for ${config.name}...`);

  const websiteId = await createWebsite(
    prisma,
    config.websiteId,
    config.name,
    config.domain,
    adminUserId,
  );
  console.log(`  Created website: ${config.name} (${websiteId})`);

  const siteConfig = config.getSiteConfig();

  const allSessions: SessionData[] = [];
  const allEvents: EventData[] = [];
  const allEventData: EventDataEntry[] = [];
  const allRevenue: RevenueData[] = [];

  for (let dayIndex = 0; dayIndex < days.length; dayIndex++) {
    const day = days[dayIndex];
    const sessionCount = getSessionCountForDay(config.sessionsPerDay, day);
    const sessions = createSessions(websiteId, day, sessionCount);

    for (const session of sessions) {
      const journey = config.getJourney();
      const { events, eventDataEntries } = generateEventsForSession(session, siteConfig, journey);

      allSessions.push(session);
      allEvents.push(...events);
      allEventData.push(...eventDataEntries);

      if (config.revenueConfigs) {
        const revenueEntries = generateRevenueForEvents(events, config.revenueConfigs);
        allRevenue.push(...revenueEntries);
      }
    }

    // Show progress (every day in verbose mode, otherwise every 2 days)
    const shouldShowProgress = verbose || dayIndex % 2 === 0 || dayIndex === days.length - 1;
    if (shouldShowProgress) {
      process.stdout.write(
        `\r  ${progressBar(dayIndex + 1, days.length)} Day ${dayIndex + 1}/${days.length}`,
      );
    }
  }

  console.log(''); // New line after progress bar

  // Batch insert all data
  console.log(`  Inserting ${formatNumber(allSessions.length)} sessions...`);
  await batchInsertSessions(prisma, allSessions as SessionCreateInput[], verbose);

  console.log(`  Inserting ${formatNumber(allEvents.length)} events...`);
  await batchInsertEvents(prisma, allEvents as WebsiteEventCreateInput[], verbose);

  if (allEventData.length > 0) {
    console.log(`  Inserting ${formatNumber(allEventData.length)} event data entries...`);
    await batchInsertEventData(prisma, allEventData as EventDataCreateInput[], verbose);
  }

  if (allRevenue.length > 0) {
    console.log(`  Inserting ${formatNumber(allRevenue.length)} revenue entries...`);
    await batchInsertRevenue(prisma, allRevenue as RevenueCreateInput[], verbose);
  }

  return {
    sessions: allSessions.length,
    events: allEvents.length,
    eventData: allEventData.length,
    revenue: allRevenue.length,
  };
}

function createPrismaClient(connectionString: string, schema: string): PrismaClient {
  const options = [new URL(connectionString).searchParams.get('options'), '-c TimeZone=UTC']
    .filter(Boolean)
    .join(' ');
  const adapter = new PrismaPg({ connectionString, options }, { schema });

  return new PrismaClient({
    adapter,
    errorFormat: 'pretty',
  });
}

export async function seed(config: SeedConfig): Promise<SeedResult> {
  const target = parseSeedTarget(config, process.env);
  const prisma = createPrismaClient(target.connectionString, target.schema);

  try {
    let markerRows: Array<{ marker: string; schema: string }>;
    try {
      markerRows = await prisma.$queryRaw<Array<{ marker: string; schema: string }>>`
        SELECT marker, current_schema()::text AS schema
        FROM umami_seed_disposable_guard
        LIMIT 2
      `;
    } catch {
      throw new SeedSafetyError('Database is not attested as a disposable seed target.');
    }
    verifySeedMarker(markerRows, target.schema);

    if (
      SEED_WEBSITES[0].name !== BLOG_WEBSITE_NAME ||
      SEED_WEBSITES[0].domain !== BLOG_WEBSITE_DOMAIN ||
      SEED_WEBSITES[1].name !== SAAS_WEBSITE_NAME ||
      SEED_WEBSITES[1].domain !== SAAS_WEBSITE_DOMAIN
    ) {
      throw new SeedSafetyError('Seed website identity no longer matches the generator.');
    }

    const endDate = new Date();
    const startDate = subDays(endDate, config.days);
    const days = generateDatesBetween(startDate, endDate);

    console.log(`\nSeed Configuration:`);
    console.log(
      `  Date range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`,
    );
    console.log(`  Days: ${days.length}`);
    console.log(`  Clear existing: ${config.clear}`);

    const adminUserId = await findAdminUser(prisma);
    if (config.clear) {
      await clearDemoData(prisma, adminUserId);
    }

    const existingSeedWebsite = await prisma.website.findFirst({
      where: { id: { in: SEED_WEBSITES.map(website => website.id) } },
      select: { id: true },
    });
    if (existingSeedWebsite) {
      throw new SeedSafetyError('Seed-owned websites already exist; use --clear --confirm-clear.');
    }

    console.log(`  Using admin user: ${adminUserId}`);

    // Generate Blog site (low traffic)
    const blogResults = await generateSiteData(
      prisma,
      {
        websiteId: SEED_WEBSITES[0].id,
        name: BLOG_WEBSITE_NAME,
        domain: BLOG_WEBSITE_DOMAIN,
        sessionsPerDay: BLOG_SESSIONS_PER_DAY,
        getSiteConfig: getBlogSiteConfig,
        getJourney: getBlogJourney,
      },
      days,
      adminUserId,
      config.verbose,
    );

    // Generate SaaS site (high traffic)
    const saasResults = await generateSiteData(
      prisma,
      {
        websiteId: SEED_WEBSITES[1].id,
        name: SAAS_WEBSITE_NAME,
        domain: SAAS_WEBSITE_DOMAIN,
        sessionsPerDay: SAAS_SESSIONS_PER_DAY,
        getSiteConfig: getSaasSiteConfig,
        getJourney: getSaasJourney,
        revenueConfigs: saasRevenueConfigs,
      },
      days,
      adminUserId,
      config.verbose,
    );

    const result: SeedResult = {
      websites: 2,
      sessions: blogResults.sessions + saasResults.sessions,
      events: blogResults.events + saasResults.events,
      eventData: blogResults.eventData + saasResults.eventData,
      revenue: blogResults.revenue + saasResults.revenue,
    };

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Seed Complete!`);
    console.log(`${'─'.repeat(50)}`);
    console.log(`  Websites:   ${formatNumber(result.websites)}`);
    console.log(`  Sessions:   ${formatNumber(result.sessions)}`);
    console.log(`  Events:     ${formatNumber(result.events)}`);
    console.log(`  Event Data: ${formatNumber(result.eventData)}`);
    console.log(`  Revenue:    ${formatNumber(result.revenue)}`);
    console.log(`${'─'.repeat(50)}\n`);

    return result;
  } finally {
    await prisma.$disconnect();
  }
}
