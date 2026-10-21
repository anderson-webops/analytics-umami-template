import { isReplayEventFragment } from '@/lib/replay';
import {
  getReplayChargedBytes,
  MAX_REPLAY_BYTES,
  ReplayBudgetExceededError,
} from '@/lib/replay-budget';
import { countReplayStructureUnits, hasBoundedReplayJsonStructure } from '@/lib/replay-structure';

const MAX_PENDING_GROUPS = 64;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
const MAX_GROUPS_PER_VISIT = 2;
export const MAX_FRAGMENT_VALUE_BYTES = 500_000;
export const MAX_FRAGMENT_PARTS = 64;
const PENDING_LIFETIME_MS = 30 * 1000;

export interface ReplayFragmentPart {
  id: string;
  index: number;
  total: number;
  chunkIndex: number;
  timestamp?: number;
}

export interface CompletedReplayFragmentGroup {
  event: unknown;
  parts: ReplayFragmentPart[];
  charges: { chunkIndex: number; bytes: number; events: number }[];
  release: () => void;
}

export interface CompletedReplayFragmentBatch extends CompletedReplayFragmentGroup {
  reservations: { chunkIndex: number; bytes: number; structureUnits: number }[];
}

interface PendingGroup {
  scope: string;
  createdAt: number;
  total: number;
  baseIndex: number;
  timestamp?: number;
  bytes: number;
  chargedBytes: number;
  parts: Map<number, { value: string; chunkIndex: number; chargedBytes: number }>;
}

export class ReplayFragmentBuffer {
  private readonly groups = new Map<string, PendingGroup>();
  private pendingBytes = 0;

  constructor(private readonly requirePrechargedStructure = true) {}

  private remove(key: string, group: PendingGroup) {
    this.groups.delete(key);
    this.pendingBytes -= group.bytes;
  }

  private expire(now: number) {
    for (const [key, group] of this.groups) {
      if (now - group.createdAt >= PENDING_LIFETIME_MS) {
        this.remove(key, group);
      }
    }
  }

  stage({
    websiteId,
    sessionId,
    visitId,
    accountType,
    accountId,
    collectionGeneration,
    chunkIndex,
    event,
  }: {
    websiteId: string;
    sessionId: string;
    visitId: string;
    accountType: string;
    accountId: string;
    collectionGeneration: number;
    chunkIndex: number;
    event: unknown;
  }): CompletedReplayFragmentGroup | null {
    if (!isReplayEventFragment(event)) {
      throw new ReplayBudgetExceededError();
    }

    const { id, index, total, value } = event.data;
    const valueBytes = Buffer.byteLength(value, 'utf8');
    const baseIndex = chunkIndex - index;
    const fragmentUnits = countReplayStructureUnits([event]);

    if (
      !/^[a-z\d._:-]{1,128}$/i.test(id) ||
      fragmentUnits === null ||
      total > MAX_FRAGMENT_PARTS ||
      valueBytes > MAX_FRAGMENT_VALUE_BYTES ||
      !Number.isSafeInteger(baseIndex) ||
      baseIndex < 0
    ) {
      throw new ReplayBudgetExceededError();
    }

    const now = Date.now();
    this.expire(now);
    const scope = JSON.stringify([
      websiteId,
      sessionId,
      visitId,
      accountType,
      accountId,
      collectionGeneration,
    ]);
    const key = JSON.stringify([
      websiteId,
      sessionId,
      visitId,
      accountType,
      accountId,
      collectionGeneration,
      id,
    ]);
    let group = this.groups.get(key);

    if (!group) {
      const visitGroups = [...this.groups.values()].filter(item => item.scope === scope).length;

      if (this.groups.size >= MAX_PENDING_GROUPS || visitGroups >= MAX_GROUPS_PER_VISIT) {
        throw new ReplayBudgetExceededError(60);
      }

      group = {
        scope,
        createdAt: now,
        total,
        baseIndex,
        timestamp: event.timestamp,
        bytes: 0,
        chargedBytes: 0,
        parts: new Map(),
      };
      this.groups.set(key, group);
    }

    if (
      group.total !== total ||
      group.baseIndex !== baseIndex ||
      group.timestamp !== event.timestamp
    ) {
      this.remove(key, group);
      throw new ReplayBudgetExceededError();
    }

    const existing = group.parts.get(index);

    if (existing) {
      if (existing.value !== value || existing.chunkIndex !== chunkIndex) {
        this.remove(key, group);
        throw new ReplayBudgetExceededError();
      }

      return null;
    }

    if (
      group.bytes + valueBytes > MAX_REPLAY_BYTES ||
      this.pendingBytes + valueBytes > MAX_PENDING_BYTES
    ) {
      this.remove(key, group);
      throw new ReplayBudgetExceededError(60);
    }

    const chargedBytes = getReplayChargedBytes(
      Buffer.byteLength(JSON.stringify([event]), 'utf8'),
      fragmentUnits,
    );
    group.parts.set(index, { value, chunkIndex, chargedBytes });
    group.bytes += valueBytes;
    group.chargedBytes += chargedBytes;
    this.pendingBytes += valueBytes;

    if (group.parts.size !== group.total) {
      return null;
    }

    const ordered = Array.from({ length: total }, (_, fragmentIndex) =>
      group.parts.get(fragmentIndex),
    );

    if (ordered.some(part => !part)) {
      this.remove(key, group);
      throw new ReplayBudgetExceededError();
    }

    const serialized = ordered.map(part => part?.value).join('');

    if (!hasBoundedReplayJsonStructure(serialized)) {
      this.remove(key, group);
      throw new ReplayBudgetExceededError();
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(serialized);
    } catch {
      this.remove(key, group);
      throw new ReplayBudgetExceededError();
    }

    const structureUnits = countReplayStructureUnits(parsed);

    if (
      structureUnits === null ||
      (this.requirePrechargedStructure &&
        getReplayChargedBytes(Buffer.byteLength(serialized, 'utf8'), structureUnits) >
          group.chargedBytes)
    ) {
      this.remove(key, group);
      throw new ReplayBudgetExceededError();
    }

    return {
      event: parsed,
      parts: ordered.map((part, fragmentIndex) => ({
        id,
        index: fragmentIndex,
        total,
        chunkIndex: part?.chunkIndex ?? baseIndex + fragmentIndex,
        timestamp: group.timestamp,
      })),
      charges: ordered.map(part => {
        if (!part) throw new ReplayBudgetExceededError();
        return { chunkIndex: part.chunkIndex, bytes: part.chargedBytes, events: 1 };
      }),
      release: () => {
        if (this.groups.get(key) === group) this.remove(key, group);
      },
    };
  }
}

export function reassembleReplayFragmentBatch({
  websiteId,
  sessionId,
  visitId,
  accountType,
  accountId,
  collectionGeneration,
  chunkIndex,
  events,
}: {
  websiteId: string;
  sessionId: string;
  visitId: string;
  accountType: string;
  accountId: string;
  collectionGeneration: number;
  chunkIndex: number;
  events: unknown[];
}): CompletedReplayFragmentBatch {
  if (events.length === 0 || events.length > MAX_FRAGMENT_PARTS) {
    throw new ReplayBudgetExceededError();
  }

  const buffer = new ReplayFragmentBuffer(false);
  let completed: CompletedReplayFragmentGroup | null = null;

  for (const [index, event] of events.entries()) {
    if (
      !isReplayEventFragment(event) ||
      event.data.index !== index ||
      event.data.total !== events.length
    ) {
      throw new ReplayBudgetExceededError();
    }

    completed = buffer.stage({
      websiteId,
      sessionId,
      visitId,
      accountType,
      accountId,
      collectionGeneration,
      chunkIndex: chunkIndex + index,
      event,
    });

    if (index < events.length - 1 && completed) {
      throw new ReplayBudgetExceededError();
    }
  }

  if (!completed) {
    throw new ReplayBudgetExceededError();
  }

  const decodedUnits = countReplayStructureUnits(completed.event);
  if (decodedUnits === null) {
    throw new ReplayBudgetExceededError();
  }
  const reservations = events.map((event, index) => {
    const rawEvents = [event];
    const rawUnits = countReplayStructureUnits(rawEvents);
    if (rawUnits === null) {
      throw new ReplayBudgetExceededError();
    }
    const allocatedUnits =
      Math.floor(decodedUnits / events.length) + (index < decodedUnits % events.length ? 1 : 0);

    return {
      chunkIndex: chunkIndex + index,
      bytes: Buffer.byteLength(JSON.stringify(rawEvents), 'utf8'),
      structureUnits: Math.max(rawUnits, allocatedUnits),
    };
  });

  completed.release();
  return {
    ...completed,
    reservations,
    charges: reservations.map(reservation => ({
      chunkIndex: reservation.chunkIndex,
      bytes: getReplayChargedBytes(reservation.bytes, reservation.structureUnits),
      events: 1,
    })),
  };
}
