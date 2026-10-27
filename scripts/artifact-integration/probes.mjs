import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function totp(secret, timestamp = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of secret.toUpperCase().replace(/=+$/, '')) {
    const value = alphabet.indexOf(character);
    assert(value >= 0, 'Invalid fixture TOTP secret');
    bits += value.toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g).map(byte => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timestamp / 30000)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  return ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}

export function collectionHeaders(credential, requestId = randomUUID(), timestamp = Date.now()) {
  return {
    authorization: `Bearer ${credential}`,
    'x-umami-request-id': requestId,
    'x-umami-request-timestamp': String(Math.floor(timestamp / 1000)),
  };
}

export async function exerciseIntegration({
  base,
  origin,
  client,
  fixture,
  runJob,
  record,
  signal,
}) {
  const {
    website,
    otherWebsite,
    owner,
    otherOwner,
    username,
    password,
    credential,
    eventCredential,
  } = fixture;
  async function request(route, method = 'GET', body, headers = {}, status = 200) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: route === '/api/send' ? 'https://fixture.invalid' : origin,
        'user-agent': 'Mozilla/5.0 ArtifactFixture/1.0',
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
    assert.equal(response.status, status, `Unexpected status for ${method} ${route}`);
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
  }
  async function count(table, where, values) {
    const result = await client.query(
      `SELECT count(*)::integer AS count FROM ${table} WHERE ${where}`,
      values,
    );
    return result.rows[0].count;
  }
  const payload = { website, hostname: 'fixture.invalid', url: '/integration' };
  const event = {
    type: 'event',
    payload: { ...payload, name: 'fixture-authorized', data: { sample: 'verified' } },
  };
  const movement = {
    website,
    source: 'artifact_fixture',
    sourceMovementId: randomUUID(),
    orderId: randomUUID(),
    customerId: null,
    kind: 'capture',
    amount: '12.3400',
    currency: 'USD',
    occurredAt: new Date().toISOString(),
  };

  await record('anonymous-and-authorized-collection', async () => {
    await request('/api/send', 'POST', { type: 'event', payload });
    await request('/api/send', 'POST', event, {}, 403);
    await request('/api/send', 'POST', event, collectionHeaders('invalid-credential'), 403);
    await request(
      '/api/send',
      'POST',
      event,
      collectionHeaders(credential, randomUUID(), Date.now() - 600000),
      403,
    );
    const nonce = randomUUID();
    await request('/api/send', 'POST', event, collectionHeaders(eventCredential, nonce));
    await request('/api/send', 'POST', event, collectionHeaders(eventCredential, nonce), 409);
    await request(
      '/api/send',
      'POST',
      { ...event, payload: { ...event.payload, website: otherWebsite } },
      collectionHeaders(credential),
      403,
    );
    await request(
      '/api/send',
      'POST',
      { type: 'identify', payload: { ...payload, id: 'fixture-person', data: { role: 'member' } } },
      collectionHeaders(eventCredential),
      403,
    );
    await request(
      '/api/send',
      'POST',
      { type: 'identify', payload: { ...payload, id: 'fixture-person', data: { role: 'member' } } },
      collectionHeaders(credential),
    );
    assert.equal(await count('website_event', 'website_id=$1 AND trust_tier=0', [website]), 1);
    assert.equal(
      await count('website_event', 'website_id=$1 AND trust_tier=1 AND event_name=$2', [
        website,
        'fixture-authorized',
      ]),
      1,
    );
    assert((await count('session_data', 'website_id=$1 AND trust_tier=1', [website])) > 0);
    assert.equal(
      await count('session_link', 'website_id=$1 AND trust_tier=1 AND distinct_id=$2', [
        website,
        'fixture-person',
      ]),
      1,
    );
    assert.equal(await count('website_event', 'website_id=$1', [otherWebsite]), 0);
  });

  await record('attested-revenue-idempotence-and-conflicts', async () => {
    await request('/api/revenue/movements', 'POST', movement, {}, 403);
    await request(
      '/api/revenue/movements',
      'POST',
      movement,
      collectionHeaders(eventCredential),
      403,
    );
    const nonce = randomUUID();
    const created = await request(
      '/api/revenue/movements',
      'POST',
      movement,
      collectionHeaders(credential, nonce),
      201,
    );
    assert.equal(created.body.provenance, 'backend_attested');
    await request(
      '/api/revenue/movements',
      'POST',
      movement,
      collectionHeaders(credential, nonce),
      409,
    );
    const duplicate = await request(
      '/api/revenue/movements',
      'POST',
      movement,
      collectionHeaders(credential),
    );
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.movementId, created.body.movementId);
    await request(
      '/api/revenue/movements',
      'POST',
      { ...movement, amount: '99.0000' },
      collectionHeaders(credential),
      409,
    );
    assert.equal(
      await count('attested_revenue_movement', 'website_id=$1 AND source_movement_id=$2', [
        website,
        movement.sourceMovementId,
      ]),
      1,
    );
    assert.equal(await count('revenue', 'website_id=$1', [website]), 0);
    await request(
      '/api/send',
      'POST',
      { ...event, payload: { ...event.payload, data: { revenue: 100, currency: 'USD' } } },
      collectionHeaders(credential),
      403,
    );
    assert.equal(await count('revenue', 'website_id=$1', [website]), 0);
  });

  let cookie;
  await record('captcha-and-real-mfa-session', async () => {
    const login = { username, password };
    await request('/api/auth/login', 'POST', login, {}, 401);
    for (const captchaToken of ['fixture-invalid', 'fixture-wrong-action', 'fixture-wrong-host']) {
      await request('/api/auth/login', 'POST', { ...login, captchaToken }, {}, 401);
    }
    await request(
      '/api/auth/login',
      'POST',
      { ...login, captchaToken: 'fixture-unavailable' },
      {},
      503,
    );
    const captchaToken = `fixture-valid-${randomUUID()}`;
    const loggedIn = await request('/api/auth/login', 'POST', { ...login, captchaToken });
    assert.equal(typeof loggedIn.body.token, 'string');
    await request('/api/auth/login', 'POST', { ...login, captchaToken }, {}, 401);
    const enrollment = { authorization: `Bearer ${loggedIn.body.token}` };
    await request(
      `/api/websites/${website}/events?startAt=${Date.now() - 3600000}&endAt=${Date.now() + 60000}`,
      'GET',
      undefined,
      enrollment,
      401,
    );
    const setup = await request('/api/2fa/setup/initiate', 'POST', { password }, enrollment);
    assert.equal(typeof setup.body.manualKey, 'string');
    if (Date.now() % 30000 > 25000) await delay(31000 - (Date.now() % 30000));
    const confirmed = await request(
      '/api/2fa/setup/confirm',
      'POST',
      { password, token: totp(setup.body.manualKey) },
      enrollment,
    );
    const sessionCookie = confirmed.response.headers
      .getSetCookie()
      .find(value => value.startsWith('__Host-analytics-session='));
    assert(sessionCookie, 'MFA confirmation did not issue a full session');
    cookie = sessionCookie.split(';')[0];
    const repeatLogin = await request('/api/auth/login', 'POST', {
      ...login,
      captchaToken: `fixture-valid-${randomUUID()}`,
    });
    assert.equal(repeatLogin.body.requiresTwoFactor, true);
    assert.equal(repeatLogin.body.token, undefined);
    const adjacentCodes = new Set(
      Array.from({ length: 21 }, (_, index) =>
        totp(setup.body.manualKey, Date.now() + (index - 10) * 30000),
      ),
    );
    let wrongCode = 0;
    while (adjacentCodes.has(String(wrongCode).padStart(6, '0'))) wrongCode += 1;
    await request(
      '/api/2fa/verify',
      'POST',
      { token: String(wrongCode).padStart(6, '0') },
      { authorization: `Bearer ${repeatLogin.body.partialToken}` },
      401,
    );
    assert.equal(await count('two_factor_auth', 'user_id=$1 AND is_enabled=true', [owner]), 1);
  });

  await record('authenticated-trust-tier-reporting-and-isolation', async () => {
    const range = `startAt=${Date.now() - 3600000}&endAt=${Date.now() + 60000}`;
    const route = `/api/websites/${website}/events?${range}`;
    await request(route, 'GET', undefined, {}, 401);
    const events = await request(route, 'GET', undefined, { cookie });
    assert(events.body.data.some(eventRow => eventRow.trustTier === 0));
    assert(
      events.body.data.some(
        eventRow => eventRow.eventName === 'fixture-authorized' && eventRow.trustTier === 1,
      ),
    );
    await request(
      `/api/websites/${otherWebsite}/events?${range}`,
      'GET',
      undefined,
      { cookie },
      401,
    );
  });

  await record('bounded-retention-and-retry', async () => {
    const replaySession = randomUUID();
    const tables = [
      [
        'session_replay',
        'replay_id',
        '(replay_id,website_id,session_id,visit_id,chunk_index,events,event_count,started_at,ended_at,retention_expires_at)',
        "gen_random_uuid(),$1::uuid,$2::uuid,gen_random_uuid(),0,'\\x00'::bytea,1,now(),now()",
      ],
      [
        'session_replay_saved',
        'saved_replay_id',
        '(saved_replay_id,name,website_id,visit_id,updated_at,retention_expires_at)',
        "gen_random_uuid(),'fixture',$1::uuid,gen_random_uuid(),now()",
      ],
      [
        'heatmap_event',
        'heatmap_event_id',
        '(heatmap_event_id,website_id,session_id,visit_id,url_path,event_type,retention_expires_at)',
        "gen_random_uuid(),$1::uuid,$2::uuid,gen_random_uuid(),'/fixture',1",
      ],
    ];
    const controls = new Map();
    for (const [table, id, columns, values] of tables) {
      const parameters = values.includes('$2') ? [website, replaySession] : [website];
      await client.query(
        `INSERT INTO ${table} ${columns} SELECT ${values},now()-interval '1 day' FROM generate_series(1,401)`,
        parameters,
      );
      await client.query(
        `INSERT INTO ${table} ${columns} SELECT ${values},expiry FROM (VALUES (NULL::timestamptz),(now()+interval '1 day')) AS fixture(expiry)`,
        parameters,
      );
      controls.set(
        table,
        (
          await client.query(
            `SELECT ${id},to_jsonb(record) AS row FROM ${table} AS record WHERE retention_expires_at IS NULL OR retention_expires_at>now() ORDER BY ${id}`,
          )
        ).rows,
      );
    }
    await client.query(
      "INSERT INTO replay_ingest_budget(website_id,scope,scope_key,expires_at) VALUES ($1,'visit','fixture-unmarked',NULL),($1,'visit','fixture-future',now()+interval '1 day')",
      [website],
    );
    const budgets = (
      await client.query(
        'SELECT * FROM replay_ingest_budget WHERE website_id=$1 ORDER BY scope_key',
        [website],
      )
    ).rows;
    for (let iteration = 0; iteration < 3; iteration += 1) {
      await runJob('prune-expired-session-replays.mjs', iteration === 0 ? 2 : 0);
      await runJob('prune-expired-heatmap-events.mjs', iteration === 0 ? 2 : 0);
      for (const [table, id] of tables) {
        assert.equal(
          await count(table, 'retention_expires_at<=now()', []),
          iteration === 0 ? 1 : 0,
        );
        assert.deepEqual(
          (
            await client.query(
              `SELECT ${id},to_jsonb(record) AS row FROM ${table} AS record WHERE retention_expires_at IS NULL OR retention_expires_at>now() ORDER BY ${id}`,
            )
          ).rows,
          controls.get(table),
        );
      }
    }
    assert.deepEqual(
      (
        await client.query(
          'SELECT * FROM replay_ingest_budget WHERE website_id=$1 ORDER BY scope_key',
          [website],
        )
      ).rows,
      budgets,
    );
  });

  await record('owner-generation-and-deletion-tombstones', async () => {
    await client.query('UPDATE website SET user_id=$2 WHERE website_id=$1', [website, otherOwner]);
    await request('/api/send', 'POST', event, collectionHeaders(credential), 403);
    await request(
      '/api/revenue/movements',
      'POST',
      { ...movement, sourceMovementId: randomUUID() },
      collectionHeaders(credential),
      403,
    );
    await client.query(
      'UPDATE website SET user_id=$2,collection_generation=collection_generation+1 WHERE website_id=$1',
      [website, owner],
    );
    await request('/api/send', 'POST', event, collectionHeaders(credential), 403);
    await request(
      '/api/revenue/movements',
      'POST',
      { ...movement, sourceMovementId: randomUUID() },
      collectionHeaders(credential),
      403,
    );
    await request(`/api/websites/${website}`, 'DELETE', undefined, { cookie });
    assert.equal(await count('website', 'website_id=$1', [website]), 0);
    assert.equal(await count('attested_revenue_movement', 'website_id=$1', [website]), 0);
    const tombstone = await client.query(
      'SELECT next_generation FROM website_collection_tombstone WHERE website_id=$1',
      [website],
    );
    assert(tombstone.rows[0]?.next_generation >= 2, 'Deletion lost collection generation');
    await request('/api/revenue/movements', 'POST', movement, collectionHeaders(credential), 403);
    await client.query(
      "INSERT INTO website(website_id,name,domain,user_id,created_by,updated_at,collection_generation) VALUES ($1,'Recreated fixture','fixture.invalid',$2,$2,now(),$3)",
      [website, owner, tombstone.rows[0].next_generation],
    );
    await request('/api/send', 'POST', event, collectionHeaders(credential), 403);
    await request('/api/revenue/movements', 'POST', movement, collectionHeaders(credential), 403);
    assert.equal(await count('attested_revenue_movement', 'website_id=$1', [website]), 0);
  });
}
