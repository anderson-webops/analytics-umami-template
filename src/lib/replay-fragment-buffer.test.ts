import { afterEach, expect, test, vi } from 'vitest';
import { getReplayChargedBytes, MAX_REPLAY_BYTES } from './replay-budget';
import { ReplayFragmentBuffer, reassembleReplayFragmentBatch } from './replay-fragment-buffer';
import { countReplayStructureUnits } from './replay-structure';

const websiteId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const visitId = '33333333-3333-4333-8333-333333333333';
const accountId = '44444444-4444-4444-8444-444444444444';

const snapshot = {
  type: 2,
  timestamp: 1_781_553_116_151,
  data: {
    node: {
      type: 0,
      id: 1,
      childNodes: [
        {
          type: 2,
          id: 2,
          tagName: 'img',
          attributes: { src: 'https://assets.example/photo?signature=split-secret' },
          childNodes: [],
        },
      ],
    },
  },
};

function fragment(id: string, index: number, total: number, value: string) {
  return {
    type: 'umami:rrweb-event-fragment',
    timestamp: snapshot.timestamp,
    data: { id, index, total, value },
  };
}

function stage(
  buffer: ReplayFragmentBuffer,
  event: ReturnType<typeof fragment>,
  chunkIndex: number,
  scope: { websiteId: string; sessionId: string; visitId: string } = {
    websiteId,
    sessionId,
    visitId,
  },
  collectionGeneration = 0,
) {
  return buffer.stage({
    ...scope,
    accountType: 'user',
    accountId,
    collectionGeneration,
    chunkIndex,
    event,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

test('reassembles a URL split across separately received chunks without storing partial events', () => {
  const buffer = new ReplayFragmentBuffer();
  const serialized = JSON.stringify(snapshot);
  const boundary = serialized.indexOf('split-secret') + 4;

  expect(
    stage(buffer, fragment('snapshot-1', 0, 2, serialized.slice(0, boundary)), 100),
  ).toBeNull();
  const completed = stage(buffer, fragment('snapshot-1', 1, 2, serialized.slice(boundary)), 101);
  expect(completed).toMatchObject({
    event: snapshot,
    parts: [
      { id: 'snapshot-1', index: 0, total: 2, chunkIndex: 100, timestamp: snapshot.timestamp },
      { id: 'snapshot-1', index: 1, total: 2, chunkIndex: 101, timestamp: snapshot.timestamp },
    ],
  });
  completed?.release();
});

test('charges decoded structure for a large snapshot sent in one batch', () => {
  const event = {
    type: 2,
    timestamp: snapshot.timestamp,
    data: {
      node: {
        type: 0,
        id: 1,
        childNodes: Array.from({ length: 7_500 }, (_, index) => ({
          type: 2,
          id: index + 2,
          tagName: 'div',
          attributes: {},
          childNodes: [],
        })),
      },
    },
  };
  const serialized = JSON.stringify(event);
  expect(Buffer.byteLength(serialized, 'utf8')).toBeGreaterThan(500_000);
  const boundary = Math.floor(serialized.length / 2);
  const events = [serialized.slice(0, boundary), serialized.slice(boundary)].map((value, index) =>
    fragment('dense-snapshot', index, 2, value),
  );

  const completed = reassembleReplayFragmentBatch({
    websiteId,
    sessionId,
    visitId,
    accountType: 'user',
    accountId,
    collectionGeneration: 0,
    chunkIndex: 1000,
    events,
  });
  const structureUnits = countReplayStructureUnits(event);
  if (structureUnits === null) throw new Error('Expected bounded snapshot structure.');
  const chargedBytes = completed.charges.reduce((total, charge) => total + charge.bytes, 0);

  expect(completed.event).toEqual(event);
  expect(chargedBytes).toBeGreaterThanOrEqual(
    getReplayChargedBytes(Buffer.byteLength(serialized, 'utf8'), structureUnits),
  );
  expect(chargedBytes).toBeLessThanOrEqual(MAX_REPLAY_BYTES);
});

test('accepts out-of-order fragments but does not mix visits or sessions', () => {
  const buffer = new ReplayFragmentBuffer();
  const serialized = JSON.stringify(snapshot);
  const boundary = Math.floor(serialized.length / 2);
  const first = fragment('snapshot-2', 0, 2, serialized.slice(0, boundary));
  const last = fragment('snapshot-2', 1, 2, serialized.slice(boundary));

  expect(stage(buffer, last, 201)).toBeNull();
  expect(stage(buffer, first, 200, { websiteId, sessionId, visitId: 'other-visit' })).toBeNull();
  expect(stage(buffer, first, 200)?.event).toEqual(snapshot);
  expect(stage(buffer, last, 201, { websiteId, sessionId, visitId: 'other-visit' })?.event).toEqual(
    snapshot,
  );
});

test('keeps a completed group until the caller releases it', () => {
  const buffer = new ReplayFragmentBuffer();
  const serialized = JSON.stringify(snapshot);
  const boundary = Math.floor(serialized.length / 2);
  const first = fragment('retained', 0, 2, serialized.slice(0, boundary));
  const last = fragment('retained', 1, 2, serialized.slice(boundary));

  expect(stage(buffer, first, 220)).toBeNull();
  const completed = stage(buffer, last, 221);
  expect(completed?.event).toEqual(snapshot);
  expect(stage(buffer, last, 221)).toBeNull();

  completed?.release();
  expect(stage(buffer, first, 220)).toBeNull();
  expect(stage(buffer, last, 221)?.event).toEqual(snapshot);
});

test('does not combine fragments across a website ownership change', () => {
  const buffer = new ReplayFragmentBuffer();
  const serialized = JSON.stringify(snapshot);
  const boundary = Math.floor(serialized.length / 2);
  const first = fragment('owner-change', 0, 2, serialized.slice(0, boundary));
  const last = fragment('owner-change', 1, 2, serialized.slice(boundary));

  expect(stage(buffer, first, 250)).toBeNull();
  expect(
    buffer.stage({
      websiteId,
      sessionId,
      visitId,
      accountType: 'team',
      accountId: '55555555-5555-4555-8555-555555555555',
      collectionGeneration: 0,
      chunkIndex: 251,
      event: last,
    }),
  ).toBeNull();
  expect(stage(buffer, last, 251)?.event).toEqual(snapshot);
});

test('does not combine pending fragments across a deleted and recreated website', () => {
  const buffer = new ReplayFragmentBuffer();
  const first = fragment('recreated', 0, 2, '{"old":');
  const replacement = fragment('recreated', 0, 2, '{"new":');
  const last = fragment('recreated', 1, 2, 'true}');

  expect(stage(buffer, first, 260)).toBeNull();
  expect(stage(buffer, last, 261, { websiteId, sessionId, visitId }, 1)).toBeNull();
  expect(stage(buffer, replacement, 260, { websiteId, sessionId, visitId }, 1)?.event).toEqual({
    new: true,
  });
});

test('rejects conflicting fragments and permits a fresh group after rejection', () => {
  const buffer = new ReplayFragmentBuffer();
  expect(stage(buffer, fragment('conflict', 0, 2, '{'), 300)).toBeNull();
  expect(() => stage(buffer, fragment('conflict', 1, 3, '}'), 301)).toThrow();
  expect(stage(buffer, fragment('conflict', 0, 2, '{'), 300)).toBeNull();
  expect(stage(buffer, fragment('conflict', 1, 2, '}'), 301)?.event).toEqual({});
});

test('bounds active groups and expires incomplete fragments', () => {
  vi.useFakeTimers();
  const buffer = new ReplayFragmentBuffer();

  for (let index = 0; index < 64; index += 1) {
    expect(
      stage(buffer, fragment(`pending-${index}`, 0, 2, '{'), 400 + index, {
        websiteId,
        sessionId,
        visitId: `visit-${index}`,
      }),
    ).toBeNull();
  }

  expect(() =>
    stage(buffer, fragment('pending-over-cap', 0, 2, '{'), 500, {
      websiteId,
      sessionId,
      visitId: 'visit-over-cap',
    }),
  ).toThrow();

  vi.advanceTimersByTime(30 * 1000);
  expect(stage(buffer, fragment('pending-over-cap', 0, 2, '{'), 500)).toBeNull();
  expect(stage(buffer, fragment('pending-over-cap', 1, 2, '}'), 501)?.event).toEqual({});
});

test('rejects oversized fragment values before retaining them', () => {
  const buffer = new ReplayFragmentBuffer();
  expect(() => stage(buffer, fragment('oversized', 0, 2, 'x'.repeat(500_001)), 600)).toThrow();
  expect(() => stage(buffer, fragment('too-many', 0, 65, '{'), 601)).toThrow();
});

test('rejects compact reconstructed structures that escaped per-fragment work charges', () => {
  const buffer = new ReplayFragmentBuffer();
  const serialized = JSON.stringify({
    type: 2,
    data: { nodes: Array.from({ length: 2000 }, () => ({})) },
  });
  const boundary = Math.floor(serialized.length / 2);

  expect(stage(buffer, fragment('compact', 0, 2, serialized.slice(0, boundary)), 700)).toBeNull();
  expect(() => stage(buffer, fragment('compact', 1, 2, serialized.slice(boundary)), 701)).toThrow();
});
