import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, request as playwrightRequest, test } from '@playwright/test';
import { ApiClient } from './client';
import { login } from './helpers/auth';
import { ADMIN_USER, SHARE_CONTEXT_HEADER, SHARE_TOKEN_HEADER } from './helpers/constants';
import {
  assertStatus,
  createLink,
  createPixel,
  createWebsite,
  deleteLink,
  deletePixel,
  deleteWebsite,
  uniqueName,
} from './helpers/entities';
import { OPENAPI_FILE } from './paths';

test.beforeAll(async ({ request }) => {
  const response = await request.get('/openapi.json');
  expect(response.status()).toBe(200);
  const document = await response.json();
  expect(document.paths).toBeDefined();
  mkdirSync(path.dirname(OPENAPI_FILE), { recursive: true });
  writeFileSync(OPENAPI_FILE, JSON.stringify(document));
});

const cases = [
  { name: 'overview', parameters: { overview: true }, status: 200 },
  { name: 'compare', parameters: { compare: true }, status: 200 },
  { name: 'legacy sectionless', parameters: {}, status: 200 },
  { name: 'events only', parameters: { events: true }, status: 401 },
  { name: 'disabled sections', parameters: { overview: false, compare: false }, status: 401 },
  { name: 'disabled filtering', parameters: { overview: true, allowFilter: false }, status: 401 },
];

for (const scenario of cases) {
  test(`annotation list and detail respect ${scenario.name} share permissions`, async ({
    request,
  }) => {
    const api = new ApiClient(request);
    const admin = api.bearer(await login(api, ADMIN_USER));
    const website = await createWebsite(admin);
    let shareId: string | undefined;

    try {
      const base = `/api/websites/${website.id}/annotations`;
      const annotation = assertStatus(
        await admin.post(base, { date: '2026-01-15T12:00:00.000Z', note: 'Synthetic note' }),
        200,
        'create synthetic annotation',
      ).body;
      const share = assertStatus(
        await admin.post(`/api/websites/${website.id}/shares`, {
          name: uniqueName('boundary-share'),
          parameters: scenario.parameters,
        }),
        200,
        'create synthetic share',
      ).body;
      shareId = share.id;
      const resolved = assertStatus(
        await api.get(`/api/share/${share.slug}`),
        200,
        'resolve share',
      );
      const shared = api.with({
        [SHARE_TOKEN_HEADER]: resolved.body.token,
        [SHARE_CONTEXT_HEADER]: '1',
      });

      for (const endpoint of [base, `${base}/${annotation.id}`]) {
        expect((await admin.get(endpoint)).status).toBe(200);
        expect((await shared.get(endpoint)).status).toBe(scenario.status);
        expect((await api.get(endpoint)).status).toBe(401);
      }
    } finally {
      if (shareId) {
        assertStatus(await admin.del(`/api/share/id/${shareId}`), 200, 'remove synthetic share');
      }
      await deleteWebsite(admin, website.id);
    }
  });
}

for (const entity of [
  { name: 'website', plural: 'websites', create: createWebsite, remove: deleteWebsite },
  { name: 'link', plural: 'links', create: createLink, remove: deleteLink },
  { name: 'pixel', plural: 'pixels', create: createPixel, remove: deletePixel },
]) {
  test(`${entity.name} list charts honor share sections`, async ({ request }, testInfo) => {
    const api = new ApiClient(request);
    const admin = api.bearer(await login(api, ADMIN_USER));
    const publicContext = await playwrightRequest.newContext({
      baseURL: testInfo.project.use.baseURL,
    });
    const publicApi = new ApiClient(publicContext);
    let created: { id: string } | undefined;
    const shareIds: string[] = [];

    try {
      created = await entity.create(admin);
      const chartPath = `/api/${entity.plural}/charts`;
      const sharePath = `/api/${entity.plural}/${created.id}/shares`;
      expect((await publicApi.get(chartPath, { params: { ids: created.id } })).status).toBe(401);

      for (const scenario of [
        { name: 'restricted', parameters: { events: true, overview: false, compare: false } },
        { name: 'overview', parameters: { overview: true } },
        { name: 'compare', parameters: { compare: true } },
        { name: 'sectionless', parameters: {} },
      ]) {
        const share = assertStatus(
          await admin.post(sharePath, {
            name: uniqueName(`${entity.name}-${scenario.name}-charts`),
            parameters: scenario.parameters,
          }),
          200,
          'create synthetic share',
        ).body;
        shareIds.push(share.id);
        const resolved = assertStatus(
          await publicApi.get(`/api/share/${share.slug}`),
          200,
          'resolve synthetic share',
        );
        const shared = publicApi.with({
          [SHARE_TOKEN_HEADER]: resolved.body.token,
          [SHARE_CONTEXT_HEADER]: '1',
        });
        const response = assertStatus(
          await shared.get(chartPath, { params: { ids: created.id } }),
          200,
          'read shared charts',
        );

        expect(Object.keys(response.body.data)).toEqual(
          scenario.name === 'restricted' ? [] : [created.id],
        );

        if (scenario.name === 'restricted') {
          const ownerWithShare = admin.with({
            [SHARE_TOKEN_HEADER]: resolved.body.token,
            [SHARE_CONTEXT_HEADER]: '1',
          });
          const ownerResponse = assertStatus(
            await ownerWithShare.get(chartPath, { params: { ids: created.id } }),
            200,
            'read owner charts with restricted share',
          );
          expect(Object.keys(ownerResponse.body.data)).toEqual([created.id]);
        }
      }

      const owner = assertStatus(
        await admin.get(chartPath, { params: { ids: created.id } }),
        200,
        'read owner charts',
      );
      expect(Object.keys(owner.body.data)).toEqual([created.id]);
    } finally {
      try {
        for (const shareId of shareIds) {
          assertStatus(await admin.del(`/api/share/id/${shareId}`), 200, 'remove synthetic share');
        }
        if (created) {
          await entity.remove(admin, created.id);
        }
      } finally {
        await publicContext.dispose();
      }
    }
  });
}

test('API keys retain website access but cannot access account management', async ({ request }) => {
  const api = new ApiClient(request);
  const admin = api.bearer(await login(api, ADMIN_USER));
  const created = assertStatus(
    await admin.post('/api/me/api-keys', { name: uniqueName('boundary-key') }),
    200,
    'create synthetic key',
  ).body;

  try {
    const key = api.bearer(created.key);
    expect((await key.get('/api/websites')).status).toBe(200);
    expect((await key.get('/api/me/api-keys')).status).toBe(401);
    expect((await admin.get('/api/me/api-keys')).status).toBe(200);
  } finally {
    assertStatus(await admin.del(`/api/me/api-keys/${created.id}`), 200, 'remove synthetic key');
  }
});
