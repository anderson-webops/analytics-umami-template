const SCOPES = new Set(['event', 'identity', 'revenue', 'recorder']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export function parseCollectionServerKeys(configured) {
  if (typeof configured !== 'string' || !configured || configured.length > 16_384) {
    return null;
  }

  let parsed;

  try {
    parsed = JSON.parse(configured);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const entries = Object.entries(parsed);
  const digests = new Set();

  if (entries.length > 100) {
    return null;
  }

  for (const [websiteId, keys] of entries) {
    if (!UUID.test(websiteId) || !Array.isArray(keys) || keys.length > 8) {
      return null;
    }

    for (const key of keys) {
      if (
        !key ||
        typeof key !== 'object' ||
        Array.isArray(key) ||
        Object.keys(key).length !== 5 ||
        typeof key.sha256 !== 'string' ||
        !DIGEST.test(key.sha256) ||
        !['user', 'team'].includes(key.ownerType) ||
        typeof key.ownerId !== 'string' ||
        !UUID.test(key.ownerId) ||
        !Number.isSafeInteger(key.generation) ||
        key.generation < 0 ||
        key.generation > 2_147_483_647 ||
        !Array.isArray(key.scopes) ||
        key.scopes.length === 0 ||
        key.scopes.length > SCOPES.size ||
        !key.scopes.every(scope => typeof scope === 'string' && SCOPES.has(scope)) ||
        new Set(key.scopes).size !== key.scopes.length ||
        digests.has(key.sha256)
      ) {
        return null;
      }

      digests.add(key.sha256);
    }
  }

  return parsed;
}
