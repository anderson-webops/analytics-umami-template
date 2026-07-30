/* eslint-disable no-console */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import chalk from 'chalk';
import { PrismaClient } from '../generated/prisma/client.js';

const MIN_VERSION = '15.0';
const MIN_VERSION_NUM = 150_000;
const VALID_USER_ROLES = new Set(['admin', 'user', 'view-only']);
const VALID_TEAM_ROLES = ['team-owner', 'team-manager', 'team-member', 'team-view-only'];
const isEnabled = value => ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');

let prisma;

function success(message) {
  console.log(chalk.greenBright(`✓ ${message}`));
}

function warning(message) {
  console.log(chalk.yellowBright(`! ${message}`));
}

function failure(message) {
  console.log(chalk.redBright(`✗ ${message}`));
}

function requireDatabaseUrl() {
  const value = process.env.DATABASE_URL;

  if (!value) {
    throw new Error('DATABASE_URL is not defined.');
  }

  try {
    const url = new URL(value);

    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.pathname.replace(/^\//, '')
    ) {
      throw new Error();
    }

    return url;
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }
}

async function initialize() {
  if (isEnabled(process.env.SKIP_DB_CHECK)) {
    console.log('Skipping database check.');
    process.exit(0);
  }

  const url = requireDatabaseUrl();
  const adapter = new PrismaPg(
    { connectionString: url.toString() },
    { schema: url.searchParams.get('schema') },
  );

  prisma = new PrismaClient({ adapter });
  success('DATABASE_URL is defined.');

  if (process.env.REDIS_URL) {
    success('REDIS_URL is defined.');
  }
}

async function checkConnection() {
  try {
    await prisma.$connect();
    success('Database connection successful.');
  } catch (error) {
    throw new Error(`Unable to connect to the database: ${error.message}`);
  }
}

async function checkDatabaseVersion() {
  const result =
    await prisma.$queryRaw`SELECT current_setting('server_version_num') AS version_num`;
  const version = Number(result[0]?.version_num);

  if (!Number.isFinite(version)) {
    throw new Error('Unable to determine the PostgreSQL version.');
  }

  if (version < MIN_VERSION_NUM) {
    throw new Error(
      `PostgreSQL ${MIN_VERSION} or newer is required; this server reports ${result[0]?.version_num}.`,
    );
  }

  success('Database version check successful.');
}

async function applyMigration() {
  if (isEnabled(process.env.SKIP_DB_MIGRATION)) {
    warning('Database migration was explicitly skipped.');
    return;
  }

  const prismaCli = fileURLToPath(
    new URL('../node_modules/prisma/build/index.js', import.meta.url),
  );
  const directUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;

  try {
    const output = execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: directUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (output.trim()) {
      console.log(output.trim());
    }
  } catch (error) {
    const detail =
      error?.stderr?.toString().trim() ||
      error?.stdout?.toString().trim() ||
      error?.message ||
      'unknown migration error';

    throw new Error(`Unable to apply database migrations: ${detail}`);
  }

  success('Database is up to date.');
}

async function checkUsers() {
  const activeUsers = await prisma.user.findMany({
    where: {
      deletedAt: null,
    },
    select: {
      username: true,
      password: true,
      role: true,
    },
  });
  const admins = activeUsers.filter(user => user.role === 'admin');

  if (admins.length === 0) {
    throw new Error('No active administrator exists.');
  }

  const normalizedUsernames = new Set();

  for (const user of activeUsers) {
    const normalizedUsername = user.username.trim().toLowerCase();

    if (!normalizedUsername) {
      throw new Error('An active user has an empty normalized username.');
    }

    if (normalizedUsernames.has(normalizedUsername)) {
      throw new Error(
        'Multiple active users normalize to the same username. Resolve the account ambiguity before starting the service.',
      );
    }

    normalizedUsernames.add(normalizedUsername);

    if (!VALID_USER_ROLES.has(user.role)) {
      throw new Error('An active user has an unsupported global role.');
    }

    let rounds;

    try {
      rounds = bcrypt.getRounds(user.password);
    } catch {
      throw new Error('An active user has an invalid password hash.');
    }

    if (!rounds) {
      throw new Error('An active user has an invalid password hash.');
    }

    if (await bcrypt.compare('umami', user.password)) {
      throw new Error(
        'An active user still uses the known default password. Rotate it before starting the service.',
      );
    }

    if (rounds < 12) {
      warning(
        'An active user uses an older password work factor and will be upgraded after the next successful login.',
      );
    }
  }
}

async function checkTeams() {
  const teams = await prisma.team.findMany({
    where: {
      deletedAt: null,
    },
    select: {
      members: {
        where: {
          role: 'team-owner',
          user: {
            deletedAt: null,
          },
        },
        select: {
          id: true,
        },
      },
    },
  });
  const invalidTeams = teams.filter(team => team.members.length !== 1);

  if (invalidTeams.length > 0) {
    throw new Error(
      `Team ownership invariant failed for ${invalidTeams.length} team(s). Each active team must have exactly one active owner.`,
    );
  }

  const invalidTeamRoles = await prisma.teamUser.count({
    where: {
      role: {
        notIn: VALID_TEAM_ROLES,
      },
    },
  });

  if (invalidTeamRoles > 0) {
    throw new Error(
      `${invalidTeamRoles} team membership(s) use unsupported roles. Repair them before starting the service.`,
    );
  }
}

async function checkUniquenessAndOwnership() {
  const duplicateMemberships = await prisma.$queryRaw`
    SELECT team_id, user_id
    FROM team_user
    GROUP BY team_id, user_id
    HAVING COUNT(*) > 1
    LIMIT 1
  `;

  if (duplicateMemberships.length > 0) {
    throw new Error('Duplicate memberships exist for the same user and team.');
  }

  const duplicateSessionData = await prisma.$queryRaw`
    SELECT session_id, data_key
    FROM session_data
    GROUP BY session_id, data_key
    HAVING COUNT(*) > 1
    LIMIT 1
  `;

  if (duplicateSessionData.length > 0) {
    throw new Error('Duplicate session-data keys exist for the same session.');
  }

  const duplicateEntityIds = await prisma.$queryRaw`
    SELECT entity_id
    FROM (
      SELECT website_id::text AS entity_id FROM website WHERE deleted_at IS NULL
      UNION ALL
      SELECT link_id::text AS entity_id FROM link WHERE deleted_at IS NULL
      UNION ALL
      SELECT pixel_id::text AS entity_id FROM pixel WHERE deleted_at IS NULL
      UNION ALL
      SELECT board_id::text AS entity_id FROM board
    ) entities
    GROUP BY entity_id
    HAVING COUNT(*) > 1
    LIMIT 1
  `;

  if (duplicateEntityIds.length > 0) {
    throw new Error(
      'An active website, link, pixel, or board shares an entity ID with another entity type.',
    );
  }

  const invalidEntityOwnership = await prisma.$queryRaw`
    SELECT entity_type, entity_id
    FROM (
      SELECT 'website' AS entity_type, website_id::text AS entity_id, user_id, team_id
      FROM website
      UNION ALL
      SELECT 'link' AS entity_type, link_id::text AS entity_id, user_id, team_id
      FROM link
      UNION ALL
      SELECT 'pixel' AS entity_type, pixel_id::text AS entity_id, user_id, team_id
      FROM pixel
      UNION ALL
      SELECT 'board' AS entity_type, board_id::text AS entity_id, user_id, team_id
      FROM board
    ) entities
    WHERE (user_id IS NULL) = (team_id IS NULL)
    LIMIT 1
  `;

  if (invalidEntityOwnership.length > 0) {
    throw new Error(
      'A website, link, pixel, or board does not have exactly one user or team owner.',
    );
  }

  const invalidShareTypes = await prisma.share.count({
    where: {
      shareType: {
        notIn: [1, 2, 3, 4],
      },
    },
  });

  if (invalidShareTypes > 0) {
    throw new Error(`${invalidShareTypes} share(s) use unsupported entity types.`);
  }
}

async function checkRelationshipIntegrity() {
  const brokenReferences = await prisma.$queryRaw`
    SELECT issue
    FROM (
      SELECT 'team-membership' AS issue
      FROM team_user tu
      LEFT JOIN team t ON t.team_id = tu.team_id
      LEFT JOIN "user" u ON u.user_id = tu.user_id
      WHERE
        t.team_id IS NULL
        OR t.deleted_at IS NOT NULL
        OR u.user_id IS NULL
        OR u.deleted_at IS NOT NULL

      UNION ALL

      SELECT 'active-website-owner'
      FROM website e
      LEFT JOIN "user" u ON u.user_id = e.user_id
      LEFT JOIN team t ON t.team_id = e.team_id
      WHERE e.deleted_at IS NULL
        AND (
          (e.user_id IS NOT NULL AND (u.user_id IS NULL OR u.deleted_at IS NOT NULL))
          OR
          (e.team_id IS NOT NULL AND (t.team_id IS NULL OR t.deleted_at IS NOT NULL))
        )

      UNION ALL

      SELECT 'active-link-owner'
      FROM link e
      LEFT JOIN "user" u ON u.user_id = e.user_id
      LEFT JOIN team t ON t.team_id = e.team_id
      WHERE e.deleted_at IS NULL
        AND (
          (e.user_id IS NOT NULL AND (u.user_id IS NULL OR u.deleted_at IS NOT NULL))
          OR
          (e.team_id IS NOT NULL AND (t.team_id IS NULL OR t.deleted_at IS NOT NULL))
        )

      UNION ALL

      SELECT 'active-pixel-owner'
      FROM pixel e
      LEFT JOIN "user" u ON u.user_id = e.user_id
      LEFT JOIN team t ON t.team_id = e.team_id
      WHERE e.deleted_at IS NULL
        AND (
          (e.user_id IS NOT NULL AND (u.user_id IS NULL OR u.deleted_at IS NOT NULL))
          OR
          (e.team_id IS NOT NULL AND (t.team_id IS NULL OR t.deleted_at IS NOT NULL))
        )

      UNION ALL

      SELECT 'board-owner'
      FROM board e
      LEFT JOIN "user" u ON u.user_id = e.user_id
      LEFT JOIN team t ON t.team_id = e.team_id
      WHERE
        (e.user_id IS NOT NULL AND (u.user_id IS NULL OR u.deleted_at IS NOT NULL))
        OR
        (e.team_id IS NOT NULL AND (t.team_id IS NULL OR t.deleted_at IS NOT NULL))

      UNION ALL

      SELECT 'report-owner'
      FROM report r
      LEFT JOIN "user" u ON u.user_id = r.user_id AND u.deleted_at IS NULL
      LEFT JOIN website w ON w.website_id = r.website_id AND w.deleted_at IS NULL
      WHERE u.user_id IS NULL OR w.website_id IS NULL

      UNION ALL

      SELECT 'segment-website'
      FROM segment s
      LEFT JOIN website w ON w.website_id = s.website_id AND w.deleted_at IS NULL
      WHERE w.website_id IS NULL

      UNION ALL

      SELECT 'session-source'
      FROM "session" s
      LEFT JOIN website w ON w.website_id = s.website_id AND w.deleted_at IS NULL
      LEFT JOIN link l ON l.link_id = s.website_id AND l.deleted_at IS NULL
      LEFT JOIN pixel p ON p.pixel_id = s.website_id AND p.deleted_at IS NULL
      WHERE w.website_id IS NULL AND l.link_id IS NULL AND p.pixel_id IS NULL

      UNION ALL

      SELECT 'event-session'
      FROM website_event e
      LEFT JOIN "session" s ON s.session_id = e.session_id
      WHERE s.session_id IS NULL OR s.website_id <> e.website_id

      UNION ALL

      SELECT 'event-data'
      FROM event_data d
      LEFT JOIN website_event e ON e.event_id = d.website_event_id
      WHERE e.event_id IS NULL OR e.website_id <> d.website_id

      UNION ALL

      SELECT 'session-data'
      FROM session_data d
      LEFT JOIN "session" s ON s.session_id = d.session_id
      WHERE s.session_id IS NULL OR s.website_id <> d.website_id

      UNION ALL

      SELECT 'revenue-event'
      FROM revenue r
      LEFT JOIN "session" s ON s.session_id = r.session_id
      LEFT JOIN website_event e ON e.event_id = r.event_id
      WHERE
        s.session_id IS NULL
        OR e.event_id IS NULL
        OR s.website_id <> r.website_id
        OR e.website_id <> r.website_id
        OR e.session_id <> r.session_id

      UNION ALL

      SELECT 'replay-session'
      FROM session_replay r
      LEFT JOIN website w ON w.website_id = r.website_id AND w.deleted_at IS NULL
      LEFT JOIN "session" s ON s.session_id = r.session_id
      WHERE
        w.website_id IS NULL
        OR s.session_id IS NULL
        OR s.website_id <> r.website_id

      UNION ALL

      SELECT 'saved-replay-website'
      FROM session_replay_saved r
      LEFT JOIN website w ON w.website_id = r.website_id AND w.deleted_at IS NULL
      WHERE w.website_id IS NULL

      UNION ALL

      SELECT 'heatmap-session'
      FROM heatmap_event h
      LEFT JOIN website w ON w.website_id = h.website_id AND w.deleted_at IS NULL
      LEFT JOIN "session" s ON s.session_id = h.session_id
      WHERE
        w.website_id IS NULL
        OR s.session_id IS NULL
        OR s.website_id <> h.website_id

      UNION ALL

      SELECT 'share-entity'
      FROM share s
      LEFT JOIN website w
        ON s.share_type = 1 AND w.website_id = s.entity_id AND w.deleted_at IS NULL
      LEFT JOIN link l
        ON s.share_type = 2 AND l.link_id = s.entity_id AND l.deleted_at IS NULL
      LEFT JOIN pixel p
        ON s.share_type = 3 AND p.pixel_id = s.entity_id AND p.deleted_at IS NULL
      LEFT JOIN board b ON s.share_type = 4 AND b.board_id = s.entity_id
      WHERE
        (s.share_type = 1 AND w.website_id IS NULL)
        OR (s.share_type = 2 AND l.link_id IS NULL)
        OR (s.share_type = 3 AND p.pixel_id IS NULL)
        OR (s.share_type = 4 AND b.board_id IS NULL)
    ) integrity_issues
    LIMIT 1
  `;

  if (brokenReferences.length > 0) {
    throw new Error(
      `Database relationship integrity failed (${brokenReferences[0].issue}). Repair the affected records before starting the service.`,
    );
  }
}

async function checkSecurityState() {
  await checkUsers();
  await checkTeams();
  await checkUniquenessAndOwnership();
  await checkRelationshipIntegrity();
  success('Authentication, authorization, ownership, and data-integrity checks passed.');
}

async function run() {
  const checks = [
    initialize,
    checkConnection,
    checkDatabaseVersion,
    applyMigration,
    checkSecurityState,
  ];

  try {
    for (const check of checks) {
      await check();
    }
  } catch (error) {
    failure(error instanceof Error ? error.message : 'Database check failed.');
    process.exitCode = 1;
  } finally {
    await prisma?.$disconnect();
  }
}

run();
