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
}

interface PendingGroup {
  scope: string;
  createdAt: number;
  total: number;
  baseIndex: number;
  timestamp?: number;
  bytes: number;
  chargedBytes: number;
  parts: Map<number, { value: string; chunkIndex: number }>;
}

export class ReplayFragmentBuffer {
  private readonly groups = new Map<string, PendingGroup>();
  private pendingBytes = 0;

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
    chunkIndex,
    event,
  }: {
    websiteId: string;
    sessionId: string;
    visitId: string;
    accountType: string;
    accountId: string;
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
    const scope = JSON.stringify([websiteId, sessionId, visitId, accountType, accountId]);
    const key = JSON.stringify([websiteId, sessionId, visitId, accountType, accountId, id]);
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

    group.parts.set(index, { value, chunkIndex });
    group.bytes += valueBytes;
    group.chargedBytes += getReplayChargedBytes(
      Buffer.byteLength(JSON.stringify([event]), 'utf8'),
      fragmentUnits,
    );
    this.pendingBytes += valueBytes;

    if (group.parts.size !== group.total) {
      return null;
    }

    this.remove(key, group);
    const ordered = Array.from({ length: total }, (_, fragmentIndex) =>
      group.parts.get(fragmentIndex),
    );

    if (ordered.some(part => !part)) {
      throw new ReplayBudgetExceededError();
    }

    const serialized = ordered.map(part => part?.value).join('');

    if (!hasBoundedReplayJsonStructure(serialized)) {
      throw new ReplayBudgetExceededError();
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new ReplayBudgetExceededError();
    }

    const structureUnits = countReplayStructureUnits(parsed);

    if (
      structureUnits === null ||
      getReplayChargedBytes(Buffer.byteLength(serialized, 'utf8'), structureUnits) >
        group.chargedBytes
    ) {
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
    };
  }
}

export const replayFragmentBuffer = new ReplayFragmentBuffer();
