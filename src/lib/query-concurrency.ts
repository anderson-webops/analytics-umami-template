import { randomUUID } from 'node:crypto';
import debug from 'debug';
import { hash } from '@/lib/crypto';
import redis from '@/lib/redis';

const log = debug('umami:query-concurrency');
const LEASE_MS = 120_000;
const RETRY_AFTER_SECONDS = 2;
const COST_PER_SLOT = 3_000;
const MAX_USER_SLOTS = 8;
const MAX_WEBSITE_SLOTS = 16;
const MAX_MEMORY_KEYS = 20_000;
const MEMORY_LEASES = 'analytics-query-concurrency-leases';

type Release = () => Promise<void>;

interface LeaseEntry {
  expiresAt: number;
  slots: number;
}

function memoryLeases(): Map<string, Map<string, LeaseEntry>> {
  const state = globalThis as typeof globalThis & Record<string, any>;
  state[MEMORY_LEASES] ??= new Map<string, Map<string, LeaseEntry>>();
  return state[MEMORY_LEASES];
}

function reserveLocal(keys: string[], capacities: number[], token: string, slots: number) {
  const leases = memoryLeases();
  const now = Date.now();

  for (const [index, key] of keys.entries()) {
    const active = leases.get(key);
    if (!active) continue;

    let occupied = 0;
    for (const [leaseToken, entry] of active) {
      if (entry.expiresAt <= now) {
        active.delete(leaseToken);
      } else {
        occupied += entry.slots;
      }
    }

    if (active.size === 0) leases.delete(key);
    if (occupied + slots > capacities[index]) return false;
  }

  const newKeys = keys.filter(key => !leases.has(key)).length;
  if (leases.size + newKeys > MAX_MEMORY_KEYS) {
    for (const [key, active] of leases) {
      for (const [leaseToken, entry] of active) {
        if (entry.expiresAt <= now) active.delete(leaseToken);
      }
      if (active.size === 0) leases.delete(key);
    }
    if (leases.size + keys.filter(key => !leases.has(key)).length > MAX_MEMORY_KEYS) return false;
  }

  for (const key of keys) {
    let active = leases.get(key);
    if (!active) {
      active = new Map<string, LeaseEntry>();
      leases.set(key, active);
    }
    active.set(token, { expiresAt: now + LEASE_MS, slots });
  }

  return true;
}

async function reserveDistributed(
  keys: string[],
  capacities: number[],
  token: string,
  slots: number,
) {
  await redis.client.connect(1000);
  const result = await redis.client.client.withAbortSignal(AbortSignal.timeout(1000)).eval(
    `local currentTime = redis.call('TIME')
     local now = currentTime[1] * 1000 + math.floor(currentTime[2] / 1000)
     local slots = tonumber(ARGV[1])
     local deadline = now + tonumber(ARGV[2])
     for index, key in ipairs(KEYS) do
       redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
       if redis.call('ZCARD', key) + slots > tonumber(ARGV[index + 3]) then
         return 0
       end
     end
     for _, key in ipairs(KEYS) do
       for slot = 1, slots do
         redis.call('ZADD', key, deadline, ARGV[3] .. ':' .. slot)
       end
       redis.call('PEXPIRE', key, ARGV[2])
     end
     return 1`,
    {
      keys,
      arguments: [String(slots), String(LEASE_MS), token, ...capacities.map(String)],
    },
  );

  return result === 1;
}

function localRelease(keys: string[], token: string): Release {
  let released = false;

  return async () => {
    if (released) return;
    released = true;

    const leases = memoryLeases();
    for (const key of keys) {
      const active = leases.get(key);
      active?.delete(token);
      if (active?.size === 0) leases.delete(key);
    }
  };
}

function distributedRelease(keys: string[], token: string, slots: number): Release {
  let released = false;

  return async () => {
    if (released) return;
    released = true;

    try {
      await redis.client.connect(1000);
      await redis.client.client.withAbortSignal(AbortSignal.timeout(1000)).eval(
        `for _, key in ipairs(KEYS) do
           for slot = 1, tonumber(ARGV[2]) do
             redis.call('ZREM', key, ARGV[1] .. ':' .. slot)
           end
           if redis.call('ZCARD', key) == 0 then redis.call('DEL', key) end
         end
         return 1`,
        { keys, arguments: [token, String(slots)] },
      );
    } catch {
      log('Could not release a query lease; its bounded expiry remains active.');
    }
  };
}

export async function reserveAuthenticatedQueryLease(
  userId: string,
  tenantId: string | null,
  cost: number,
  fanout = 1,
): Promise<
  { blocked: true; unavailable?: true; retryAfter: number } | { blocked: false; release: Release }
> {
  if (
    !userId ||
    !Number.isSafeInteger(cost) ||
    cost < 1 ||
    !Number.isSafeInteger(fanout) ||
    fanout < 1
  ) {
    return { blocked: true, retryAfter: RETRY_AFTER_SECONDS };
  }

  const slots = Math.max(Math.ceil(cost / COST_PER_SLOT), fanout);
  if (slots > MAX_USER_SLOTS) {
    return { blocked: true, retryAfter: RETRY_AFTER_SECONDS };
  }

  const keys = [`auth-query-inflight:${hash(userId).slice(0, 32)}`];
  const capacities = [MAX_USER_SLOTS];

  if (tenantId) {
    keys.push(`tenant-query-inflight:${hash(tenantId).slice(0, 32)}`);
    capacities.push(MAX_WEBSITE_SLOTS);
  }

  const token = randomUUID();

  if (redis.enabled) {
    try {
      if (!(await reserveDistributed(keys, capacities, token, slots))) {
        return { blocked: true, retryAfter: RETRY_AFTER_SECONDS };
      }
      return { blocked: false, release: distributedRelease(keys, token, slots) };
    } catch {
      return { blocked: true, unavailable: true, retryAfter: RETRY_AFTER_SECONDS };
    }
  }

  if (!reserveLocal(keys, capacities, token, slots)) {
    return { blocked: true, retryAfter: RETRY_AFTER_SECONDS };
  }

  return { blocked: false, release: localRelease(keys, token) };
}
