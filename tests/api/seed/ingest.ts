import type { ApiClient } from '../client';
import { CACHE_HEADER } from '../helpers/constants';
import { getTestBackendCollectionHeaders } from './collection-keys';
import type { Dataset, RecordPayload, SendPayload } from './dataset';

const BATCH_LIMIT = 20;

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

async function send(api: ApiClient, event: SendPayload, cache?: string) {
  const userAgent = event.payload.userAgent;
  const response = await api.post('/api/send', event, {
    headers: {
      ...(cache ? { [CACHE_HEADER]: cache } : {}),
      ...(typeof userAgent === 'string' ? { 'user-agent': userAgent } : {}),
    },
  });

  if (response.status !== 200) {
    throw new Error(`POST /api/send failed (${response.status}): ${response.text}`);
  }

  if (response.body?.beep) {
    throw new Error(
      'POST /api/send classified the request as a bot. Start the server with DISABLE_BOT_CHECK=1.',
    );
  }

  if (!response.body?.cache) {
    throw new Error(`POST /api/send returned no cache token: ${response.text}`);
  }

  return response.body as { cache: string };
}

async function record(api: ApiClient, payload: RecordPayload, cache: string, origin: string) {
  const websiteId = payload.payload.website as string;
  const permitted = await api.post(
    '/api/collection-permit',
    { website: websiteId, feature: payload.type, origin, consent: true },
    {
      headers: {
        ...getTestBackendCollectionHeaders(websiteId),
        [CACHE_HEADER]: cache,
      },
    },
  );

  if (permitted.status !== 200 || typeof permitted.body?.permit !== 'string') {
    throw new Error(`POST /api/collection-permit (${payload.type}) failed (${permitted.status}).`);
  }

  const response = await api.post('/api/record', payload, {
    headers: {
      [CACHE_HEADER]: cache,
      'x-umami-permit': permitted.body.permit,
      origin,
    },
  });

  if (response.status !== 200 || response.body?.ok !== true) {
    throw new Error(
      `POST /api/record (${payload.type}) failed (${response.status}): ${response.text}`,
    );
  }
}

export async function ingestDataset(api: ApiClient, dataset: Dataset): Promise<void> {
  if (dataset.legacyRevenue.length) {
    throw new Error('Historical revenue fixtures must be seeded outside the public collector.');
  }

  for (const visit of dataset.visits) {
    let cache: string | undefined;

    for (const event of visit.events) {
      cache = (await send(api, event, cache)).cache;
    }
  }

  const publicBatch: SendPayload[] = [];
  const backendBatches = new Map<string, SendPayload[]>();

  for (const event of dataset.batch) {
    const websiteId = event.payload.website;
    const needsBackend =
      event.type === 'identify' ||
      (event.type === 'event' &&
        (event.payload.name !== undefined || event.payload.id !== undefined));

    if (!needsBackend) {
      publicBatch.push(event);
    } else if (typeof websiteId === 'string') {
      const items = backendBatches.get(websiteId) ?? [];
      items.push(event);
      backendBatches.set(websiteId, items);
    } else {
      throw new Error('Advanced fixture event has no website.');
    }
  }

  async function sendBatch(items: SendPayload[], websiteId?: string) {
    const userAgent = items[0]?.payload.userAgent;
    const response = await api.post('/api/batch', items, {
      headers: {
        ...(websiteId ? getTestBackendCollectionHeaders(websiteId) : {}),
        ...(typeof userAgent === 'string' ? { 'user-agent': userAgent } : {}),
      },
    });

    if (response.status !== 200) {
      throw new Error(`POST /api/batch failed (${response.status}): ${response.text}`);
    }

    if (response.body?.errors) {
      throw new Error(
        `POST /api/batch reported ${response.body.errors} error(s): ${JSON.stringify(
          response.body.details?.slice(0, 3),
        )}`,
      );
    }
  }

  for (const items of chunk(publicBatch, BATCH_LIMIT)) {
    await sendBatch(items);
  }

  for (const [websiteId, events] of backendBatches) {
    for (const items of chunk(events, BATCH_LIMIT)) {
      await sendBatch(items, websiteId);
    }
  }

  const live = await send(api, dataset.replay.pageview);
  const hostname = dataset.replay.pageview.payload.hostname;

  if (typeof hostname !== 'string') {
    throw new Error('Recorded fixture has no approved hostname.');
  }

  const origin = `https://${hostname}`;

  await record(api, dataset.replay.record, live.cache, origin);
  await record(api, dataset.replay.heatmap, live.cache, origin);

  for (const event of dataset.realtime) {
    await send(api, event);
  }
}
