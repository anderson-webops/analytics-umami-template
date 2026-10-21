import { createHash, randomUUID } from 'node:crypto';
import { ADMIN_USER } from '../helpers/constants';
import { SEED_IDS, SEED_USERS } from './ids';

const WEBSITE_IDS = [SEED_IDS.website, SEED_IDS.website2] as const;
const SCOPES = ['event', 'identity', 'recorder'] as const;

export function getTestCollectionCredential(websiteId: string) {
  if (!WEBSITE_IDS.some(id => id === websiteId)) {
    throw new Error('Unknown disposable API test website.');
  }

  return createHash('sha256')
    .update('disposable-umami-api-collection-v1:')
    .update(websiteId)
    .digest('base64url');
}

export function getTestBackendCollectionHeaders(websiteId: string) {
  return {
    authorization: `Bearer ${getTestCollectionCredential(websiteId)}`,
    'x-umami-request-id': randomUUID(),
    'x-umami-request-timestamp': String(Math.floor(Date.now() / 1000)),
  };
}

export function getTestCollectionServerKeysJson() {
  return JSON.stringify(
    Object.fromEntries(
      WEBSITE_IDS.map(websiteId => [
        websiteId,
        [
          {
            sha256: createHash('sha256')
              .update(getTestCollectionCredential(websiteId))
              .digest('hex'),
            scopes: SCOPES,
            ownerType: 'user',
            ownerId: websiteId === SEED_IDS.website ? ADMIN_USER.id : SEED_USERS.user.id,
            generation: websiteId === SEED_IDS.website ? 0 : 1,
          },
        ],
      ]),
    ),
  );
}
