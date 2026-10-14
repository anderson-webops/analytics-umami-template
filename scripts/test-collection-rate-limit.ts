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

function reserveSource(id: string) {
  return prisma.transaction(transaction => reserveCollectionSourceLimit(transaction, id));
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
    assert.equal((await getCollectionSourceStatus(sourceId)).blocked, false);
    const rolledBackSourceId = randomUUID();
    await assert.rejects(
      () =>
        prisma.transaction(async transaction => {
          await reserveCollectionSourceLimit(transaction, rolledBackSourceId);
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
          await reserveCollectionSourceLimit(transaction, sourceId);
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

    const counters = await prisma.client.$queryRaw<Array<{ subjectKey: string; requests: bigint }>>`
      SELECT subject_key AS "subjectKey", requests
      FROM collection_ingest_budget
      WHERE subject_key LIKE 'rate:%'
      ORDER BY subject_key
    `;
    assert.equal(counters.length, 4);
    assert.equal(counters.find(row => row.subjectKey.startsWith('rate:source:'))?.requests, 100n);
    assert.equal(counters.find(row => row.subjectKey.startsWith('rate:ip:'))?.requests, 10n);
    assert.equal(counters.find(row => row.subjectKey === 'rate:pool:source')?.requests, 1n);
    assert.equal(counters.find(row => row.subjectKey === 'rate:pool:ip')?.requests, 1n);

    console.log('Shared PostgreSQL collection rate-limit regression passed.');
  }
} finally {
  await prisma.client.$disconnect();
}
