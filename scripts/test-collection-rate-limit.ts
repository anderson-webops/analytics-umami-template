import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { reserveCollectionClientBudget } from '@/lib/collection-budget';
import { getCollectionClientKeys } from '@/lib/collection-client-key';
import {
  getCollectionIpLimit,
  getCollectionSourceStatus,
  reserveCollectionSourceLimit,
} from '@/lib/collection-rate-limit';
import prisma from '@/lib/prisma';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
assert.ok(process.env.DATABASE_URL);
const address = new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname));
assert.equal(address.pathname, '/postgres');
assert.ok(!process.env.REDIS_URL);

process.env.CLIENT_IP_HEADER = 'x-real-ip';
process.env.COLLECTION_RATE_LIMIT_PER_IP = '10';
process.env.COLLECTION_RATE_LIMIT_PER_SOURCE = '100';

const sourceId = process.env.COLLECTION_RATE_TEST_SOURCE_ID ?? randomUUID();
const ipParts = randomUUID().replaceAll('-', '').slice(0, 24).match(/.{4}/g);
assert.ok(ipParts);
const ip = `2001:db8:${ipParts.join(':')}`;

interface RateCounter {
  subjectKey: string;
  windowStart: Date;
  requests: bigint;
}

const counterKey = (subjectKey: string, windowStart: Date) =>
  `${subjectKey}:${windowStart.toISOString()}`;

async function readRateCounters(): Promise<RateCounter[]> {
  return prisma.client.$queryRaw<RateCounter[]>`
    SELECT subject_key AS "subjectKey", window_start AS "windowStart", requests
    FROM collection_ingest_budget
    WHERE subject_key LIKE 'rate:%'
  `;
}

function reserveSource(id: string) {
  return prisma.transaction(transaction =>
    reserveCollectionSourceLimit(transaction, id, 'backend'),
  );
}

function runChild() {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'scripts/test-collection-rate-limit.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COLLECTION_RATE_TEST_CHILD: '1',
        COLLECTION_RATE_TEST_SOURCE_ID: sourceId,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errorOutput = '';
    child.stderr.on('data', chunk => {
      errorOutput = (errorOutput + String(chunk)).slice(-2_000);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Collection rate-limit worker exited ${code}: ${errorOutput}`));
      }
    });
  });
}

try {
  if (process.env.COLLECTION_RATE_TEST_CHILD === '1') {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await reserveSource(sourceId);
    }
  } else {
    const priorCounters = new Map(
      (await readRateCounters()).map(row => [
        counterKey(row.subjectKey, row.windowStart),
        row.requests,
      ]),
    );
    assert.equal((await getCollectionSourceStatus(sourceId)).blocked, false);
    const rolledBackSourceId = randomUUID();
    await assert.rejects(
      () =>
        prisma.transaction(async transaction => {
          await reserveCollectionSourceLimit(transaction, rolledBackSourceId, 'backend');
          throw new Error('synthetic client budget rejection');
        }),
      /synthetic client budget rejection/,
    );
    assert.equal((await getCollectionSourceStatus(rolledBackSourceId)).blocked, false);
    await Promise.all([runChild(), runChild()]);
    assert.equal((await getCollectionSourceStatus(sourceId)).blocked, true);
    await assert.rejects(() => reserveSource(sourceId), { retryAfter: 60 });

    const accountId = randomUUID();
    const clientKeys = getCollectionClientKeys(
      'website',
      sourceId,
      'user',
      accountId,
      '198.51.100.7',
    );
    await assert.rejects(
      () =>
        prisma.transaction(async transaction => {
          await reserveCollectionClientBudget(
            transaction,
            { sourceType: 'website', sourceId, accountType: 'user', accountId, ...clientKeys },
            'replay',
            { bytes: 1024, rows: 1, requests: 1 },
          );
          await reserveCollectionSourceLimit(transaction, sourceId, 'backend');
        }),
      { retryAfter: 60 },
    );
    assert.equal(
      await prisma.client.collectionIngestBudget.count({
        where: {
          subjectKey: {
            in: [
              `client:replay:${clientKeys.sourceClientHash}`,
              `client:account:${clientKeys.accountClientHash}`,
            ],
          },
        },
      }),
      0,
    );

    const admissions = await Promise.all(
      Array.from({ length: 20 }, () =>
        getCollectionIpLimit(
          new Request('https://analytics.example.com/api/send', {
            headers: { 'x-real-ip': ip },
          }),
        ),
      ),
    );
    assert.equal(admissions.filter(result => !result.blocked).length, 10);
    assert.equal(admissions.filter(result => result.blocked).length, 10);

    const counters = await readRateCounters();
    const newSourceCounters = counters.filter(
      row =>
        row.subjectKey.startsWith('rate:source:') &&
        !priorCounters.has(counterKey(row.subjectKey, row.windowStart)),
    );
    const newIpCounters = counters.filter(
      row =>
        row.subjectKey.startsWith('rate:ip:') &&
        !priorCounters.has(counterKey(row.subjectKey, row.windowStart)),
    );
    assert.equal(newSourceCounters.length, 1);
    assert.equal(newSourceCounters[0].requests, 100n);
    assert.equal(newIpCounters.length, 1);
    assert.equal(newIpCounters[0].requests, 10n);
    const sourceWindowStart = newSourceCounters[0].windowStart;
    const ipWindowStart = newIpCounters[0].windowStart;
    assert.equal(
      counters.find(
        row =>
          row.subjectKey === 'rate:pool:source' &&
          row.windowStart.getTime() === sourceWindowStart.getTime(),
      )?.requests,
      (priorCounters.get(counterKey('rate:pool:source', sourceWindowStart)) ?? 0n) + 1n,
    );
    assert.equal(
      counters.find(
        row =>
          row.subjectKey === 'rate:pool:ip' &&
          row.windowStart.getTime() === ipWindowStart.getTime(),
      )?.requests,
      (priorCounters.get(counterKey('rate:pool:ip', ipWindowStart)) ?? 0n) + 1n,
    );

    const anonymousSourceId = randomUUID();
    await Promise.all(
      Array.from({ length: 25 }, () =>
        prisma.transaction(transaction =>
          reserveCollectionSourceLimit(transaction, anonymousSourceId, 'anonymous'),
        ),
      ),
    );
    await assert.rejects(
      () =>
        prisma.transaction(transaction =>
          reserveCollectionSourceLimit(transaction, anonymousSourceId, 'anonymous'),
        ),
      { retryAfter: 60 },
    );
    assert.equal((await getCollectionSourceStatus(anonymousSourceId)).blocked, false);
    await prisma.transaction(transaction =>
      reserveCollectionSourceLimit(transaction, anonymousSourceId, 'recorder'),
    );
    assert.equal((await getCollectionSourceStatus(anonymousSourceId)).blocked, false);
    const laterCounters = await readRateCounters();
    const newAnonymousSourceCounters = laterCounters.filter(
      row =>
        row.subjectKey.startsWith('rate:source:') &&
        !counters.some(
          prior =>
            counterKey(prior.subjectKey, prior.windowStart) ===
            counterKey(row.subjectKey, row.windowStart),
        ),
    );
    assert.deepEqual(
      newAnonymousSourceCounters
        .map(row => row.requests)
        .sort((left, right) => Number(left - right)),
      [25n, 26n],
    );
    const anonymousWindowStart = newAnonymousSourceCounters.find(
      row => row.requests === 26n,
    )?.windowStart;
    assert.ok(anonymousWindowStart);
    const sourcePool = laterCounters.find(
      row =>
        row.subjectKey === 'rate:pool:source' &&
        row.windowStart.getTime() === anonymousWindowStart.getTime(),
    );
    assert.equal(
      sourcePool?.requests,
      (priorCounters.get(counterKey('rate:pool:source', anonymousWindowStart)) ?? 0n) +
        (anonymousWindowStart.getTime() === sourceWindowStart.getTime() ? 2n : 1n),
    );

    console.log('Shared PostgreSQL collection rate-limit regression passed.');
  }
} finally {
  await prisma.client.$disconnect();
}
