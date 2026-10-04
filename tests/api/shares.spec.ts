import { expect, test } from './fixtures';
import {
  ENTITY_TYPE,
  SHARE_CONTEXT_HEADER,
  SHARE_TOKEN_HEADER,
  UNKNOWN_UUID,
} from './helpers/constants';
import { dateRange } from './helpers/dates';
import { createWebsite, deleteWebsite, uniqueName, uniqueSlug } from './helpers/entities';

test.describe('Shares', () => {
  test.describe.configure({ mode: 'serial' });

  let websiteId = '';
  let shareId = '';
  let slug = '';
  let websiteShareId = '';
  let gatedShareId = '';
  let gatedSlug = '';

  test.beforeAll(async ({ admin }) => {
    websiteId = (await createWebsite(admin)).id;
  });

  test.afterAll(async ({ admin }) => {
    for (const id of [shareId, websiteShareId, gatedShareId]) {
      if (id) {
        await admin.del(`/api/share/id/${id}`);
      }
    }

    if (websiteId) {
      await deleteWebsite(admin, websiteId);
    }
  });

  test('POST /api/share creates a share for an entity', async ({ admin }) => {
    const name = uniqueName('share');
    slug = uniqueSlug('share');
    const response = await admin.post('/api/share', {
      entityId: websiteId,
      shareType: ENTITY_TYPE.website,
      name,
      slug,
      parameters: { overview: true },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: expect.any(String),
      entityId: websiteId,
      shareType: ENTITY_TYPE.website,
      name,
      slug,
      parameters: { overview: true },
      createdAt: expect.any(String),
    });

    shareId = response.body.id;
  });

  test('POST /api/share generates a slug when omitted', async ({ admin }) => {
    const response = await admin.post('/api/share', {
      entityId: websiteId,
      shareType: ENTITY_TYPE.website,
      name: uniqueName('share'),
      parameters: {},
    });

    expect(response.status).toBe(200);
    expect(response.body.slug).toMatch(/^[A-Za-z0-9]{16}$/);

    await admin.del(`/api/share/id/${response.body.id}`);
  });

  test('POST /api/share validates the body and checks entity access', async ({
    admin,
    user,
    viewer,
    api,
  }) => {
    const missing = await admin.post('/api/share', { entityId: websiteId, name: 'x' });
    const badId = await admin.post('/api/share', {
      entityId: 'nope',
      shareType: ENTITY_TYPE.website,
      name: 'x',
      parameters: {},
    });
    // Non-admin callers cannot share an entity that does not exist (or is not theirs).
    const unknown = await user.post('/api/share', {
      entityId: UNKNOWN_UUID,
      shareType: ENTITY_TYPE.website,
      name: 'x',
      parameters: {},
    });
    const denied = await viewer.post('/api/share', {
      entityId: websiteId,
      shareType: ENTITY_TYPE.website,
      name: 'x',
      parameters: {},
    });
    const anonymous = await api.post('/api/share', {
      entityId: websiteId,
      shareType: ENTITY_TYPE.website,
      name: 'x',
      parameters: {},
    });

    expect(missing.status).toBe(400);
    expect(badId.status).toBe(400);
    expect(unknown.status).toBe(401);
    expect(denied.status).toBe(401);
    expect(anonymous.status).toBe(401);
  });

  test('GET /api/share/{slug} publicly resolves a share to a token', async ({ api, seed }) => {
    const response = await api.get(`/api/share/${slug}`);
    const seeded = await api.get(`/api/share/${seed.share.slug}`);
    const unknown = await api.get('/api/share/no-such-slug');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      shareId,
      shareType: ENTITY_TYPE.website,
      websiteId,
      parameters: { overview: true },
      token: expect.any(String),
    });
    expect(seeded.status).toBe(200);
    expect(seeded.body).toMatchObject({ shareId: seed.share.id, websiteId: seed.website.id });
    expect(unknown.status).toBe(404);
  });

  test('GET /api/share/id/{shareId} returns a share', async ({ admin, viewer, api }) => {
    const response = await admin.get(`/api/share/id/${shareId}`);
    const denied = await viewer.get(`/api/share/id/${shareId}`);
    const anonymous = await api.get(`/api/share/id/${shareId}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: shareId, entityId: websiteId, slug });
    expect(denied.status).toBe(401);
    expect(anonymous.status).toBe(401);
  });

  test('POST /api/share/id/{shareId} updates a share', async ({ admin, viewer }) => {
    const name = uniqueName('renamed');
    slug = uniqueSlug('renamed');
    const response = await admin.post(`/api/share/id/${shareId}`, {
      name,
      slug,
      parameters: { overview: true, events: true },
    });
    const partial = await admin.post(`/api/share/id/${shareId}`, { name });
    const unknown = await admin.post(`/api/share/id/${UNKNOWN_UUID}`, {
      name,
      slug: uniqueSlug('x'),
      parameters: {},
    });
    const denied = await viewer.post(`/api/share/id/${shareId}`, {
      name,
      slug,
      parameters: {},
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: shareId,
      name,
      slug,
      parameters: { overview: true, events: true },
    });
    expect(partial.status).toBe(400);
    expect(unknown.status).toBe(404);
    expect(denied.status).toBe(401);
  });

  test('GET /api/websites/{websiteId}/shares lists website shares', async ({
    admin,
    viewer,
    share,
    seed,
  }) => {
    const response = await admin.get(`/api/websites/${websiteId}/shares`);
    const paged = await admin.get(`/api/websites/${websiteId}/shares`, {
      params: { page: 1, pageSize: 1 },
    });
    const denied = await viewer.get(`/api/websites/${websiteId}/shares`);
    const shared = await (await share()).get(`/api/websites/${seed.website.id}/shares`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      data: expect.any(Array),
      count: expect.any(Number),
      page: 1,
      pageSize: expect.any(Number),
    });
    expect(response.body.data.map((s: any) => s.id)).toContain(shareId);
    expect(paged.status).toBe(200);
    expect(paged.body.data).toHaveLength(1);
    expect(paged.body.pageSize).toBe(1);
    expect(denied.status).toBe(401);
    expect(shared.status).toBe(401);
  });

  test('POST /api/websites/{websiteId}/shares creates a website share', async ({ admin, user }) => {
    const name = uniqueName('site-share');
    const response = await admin.post(`/api/websites/${websiteId}/shares`, { name });
    const invalid = await admin.post(`/api/websites/${websiteId}/shares`, {});
    const denied = await user.post(`/api/websites/${websiteId}/shares`, { name });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      entityId: websiteId,
      shareType: ENTITY_TYPE.website,
      name,
      slug: expect.any(String),
      parameters: {},
    });
    expect(response.body.slug).toHaveLength(16);
    expect(invalid.status).toBe(400);
    expect(denied.status).toBe(401);

    websiteShareId = response.body.id;
  });

  test('share parameters gate which sections a share token may access', async ({
    admin,
    api,
    share,
    seed,
    viewer,
  }) => {
    gatedSlug = uniqueSlug('gated');
    const created = await admin.post('/api/share', {
      entityId: seed.website.id,
      shareType: ENTITY_TYPE.website,
      name: uniqueName('gated'),
      slug: gatedSlug,
      parameters: { overview: true, events: false, allowFilter: false },
    });

    expect(created.status).toBe(200);
    gatedShareId = created.body.id;

    const resolved = await api.get(`/api/share/${gatedSlug}`);

    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      shareId: gatedShareId,
      websiteId: seed.website.id,
      parameters: { overview: true, events: false, allowFilter: false },
    });

    const client = await share(gatedSlug);
    const allowed = await client.get(`/api/websites/${seed.website.id}/active`);
    const denied = await client.get(`/api/websites/${seed.website.id}/events`, {
      params: dateRange(seed),
    });
    const mixedHeaders = {
      [SHARE_TOKEN_HEADER]: resolved.body.token,
      [SHARE_CONTEXT_HEADER]: '1',
    };
    const viewerWithShare = viewer.with(mixedHeaders);
    const adminWithShare = admin.with(mixedHeaders);
    const mixedAllowed = await viewerWithShare.get(`/api/websites/${seed.website.id}/active`);
    const mixedDenied = await viewerWithShare.get(`/api/websites/${seed.website.id}/events`, {
      params: dateRange(seed),
    });
    const filtered = await viewerWithShare.get(`/api/websites/${seed.website.id}/stats`, {
      params: dateRange(seed, { epf0: '1.eq.plan.pro' }),
    });
    const ownerAllowed = await adminWithShare.get(`/api/websites/${seed.website.id}/events`, {
      params: dateRange(seed),
    });

    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(401);
    expect(mixedAllowed.status).toBe(200);
    expect(mixedDenied.status).toBe(401);
    expect(filtered.status).toBe(403);
    expect(filtered.body).toMatchObject({ error: { code: 'share-filters-disabled' } });
    expect(ownerAllowed.status).toBe(200);
  });

  test('public shares bound property-filter fan-out without blocking ordinary statistics', async ({
    admin,
    seed,
    share,
  }) => {
    const sharedSlug = uniqueSlug('bounded-query');
    const created = await admin.post('/api/share', {
      entityId: seed.website.id,
      shareType: ENTITY_TYPE.website,
      name: uniqueName('bounded-query'),
      slug: sharedSlug,
      parameters: { overview: true, allowFilter: true },
    });

    expect(created.status).toBe(200);

    try {
      const client = await share(sharedSlug);
      const path = `/api/websites/${seed.website.id}/stats`;
      const ordinary = await client.get(path, { params: dateRange(seed) });
      const properties = Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [`pf_plan${index}`, '1.eq.pro']),
      );
      const amplified = await client.get(path, {
        params: { ...dateRange(seed), ...properties },
      });

      expect(ordinary.status).toBe(200);
      expect(amplified.status).toBe(400);
      expect(amplified.body).toMatchObject({
        error: { message: 'The public-share query is too complex.' },
      });
    } finally {
      await admin.del(`/api/share/id/${created.body.id}`);
    }
  });

  test('DELETE /api/share/id/{shareId} deletes a share', async ({ admin, viewer, api }) => {
    const denied = await viewer.del(`/api/share/id/${shareId}`);
    const response = await admin.del(`/api/share/id/${shareId}`);
    const gone = await api.get(`/api/share/${slug}`);

    expect(denied.status).toBe(401);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(gone.status).toBe(404);

    shareId = '';
  });
});
