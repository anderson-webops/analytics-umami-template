import { z } from 'zod';
import * as send from '@/app/api/send/route';
import { getCollectionIpLimit, transferCollectionIpLimit } from '@/lib/collection-rate-limit';
import { corsPreflight, withTrackingOrigin } from '@/lib/cors';
import { parseRequest } from '@/lib/request';
import { json, serverError, tooManyRequests } from '@/lib/response';
import { anyObjectParam } from '@/lib/schema';

const schema = z.array(anyObjectParam).min(1).max(20);

export function OPTIONS() {
  return corsPreflight({
    'Access-Control-Allow-Headers':
      'Content-Type, X-Umami-Cache, X-Umami-Hostname, X-Umami-Website-Id',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  });
}

export async function POST(request: Request) {
  try {
    const collectionLimit = await getCollectionIpLimit(request);

    if (collectionLimit.blocked) {
      return tooManyRequests(collectionLimit.retryAfter);
    }

    const { body, error } = await parseRequest(request, schema, {
      skipAuth: true,
      maxBodyBytes: 1024 * 1024,
    });

    if (error) {
      return error();
    }

    const errors = [];

    let index = 0;
    let cache = null;
    let cacheOrigin: string | null = null;
    let linkOrPixelOnly = true;
    for (const data of body) {
      const payload = data.payload;

      if (
        !payload ||
        typeof payload !== 'object' ||
        'website' in payload ||
        (!('link' in payload) && !('pixel' in payload))
      ) {
        linkOrPixelOnly = false;
      }

      // Recreate a fresh Request since `new Request(request)` will have the following error:
      // > Cannot read private member #state from an object whose class did not declare it

      // Copy headers we received, ensure JSON content type, and avoid conflicting content-length
      const headers = new Headers(request.headers);
      headers.set('content-type', 'application/json');
      headers.delete('content-length');

      const newRequest = new Request(request.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(data),
      });

      if (index === 0) {
        transferCollectionIpLimit(request, newRequest);
      }

      const response = await send.POST(newRequest);
      const responseJson = await response.json();

      if (!response.ok) {
        errors.push({ index, response: responseJson });
      } else {
        if (!cache && responseJson.cache) {
          cache = responseJson.cache;
          cacheOrigin = response.headers.get('Access-Control-Allow-Origin');
        }
      }

      index++;
    }

    return withTrackingOrigin(
      json({
        size: body.length,
        processed: body.length - errors.length,
        errors: errors.length,
        details: errors,
        cache,
      }),
      linkOrPixelOnly ? '*' : cacheOrigin,
    );
  } catch (e) {
    return serverError(e);
  }
}
