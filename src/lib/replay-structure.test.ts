import { expect, test } from 'vitest';
import {
  countReplayStructureUnits,
  hasBoundedReplayJsonStructure,
  MAX_REPLAY_STRUCTURE_UNITS,
} from './replay-structure';

test('counts empty array children and object properties against one budget', () => {
  expect(countReplayStructureUnits({ childNodes: [{}, {}] })).toBe(7);
  expect(
    countReplayStructureUnits({
      childNodes: Array.from({ length: MAX_REPLAY_STRUCTURE_UNITS }, () => ({})),
    }),
  ).toBeNull();
});

test('bounds deeply nested historical replay data without recursive traversal', () => {
  let nested: unknown = {};

  for (let depth = 0; depth < 257; depth++) {
    nested = [nested];
  }

  expect(countReplayStructureUnits(nested)).toBeNull();
});

test('preflight ignores punctuation inside escaped JSON strings but rejects dense structures', () => {
  expect(hasBoundedReplayJsonStructure(JSON.stringify({ text: '{}[],:\\"'.repeat(60_000) }))).toBe(
    true,
  );
  expect(
    hasBoundedReplayJsonStructure(
      JSON.stringify({ childNodes: Array.from({ length: 90_000 }, () => ({})) }),
    ),
  ).toBe(false);
  expect(hasBoundedReplayJsonStructure(`[${'{},'.repeat(MAX_REPLAY_STRUCTURE_UNITS)}{}]`)).toBe(
    false,
  );
});

test('an event at the accepted depth remains valid inside a replay chunk', () => {
  let data: unknown = 0;

  for (let depth = 0; depth < 255; depth++) {
    data = [data];
  }

  const event = { data };
  const chunk = [event];

  expect(countReplayStructureUnits(event)).not.toBeNull();
  expect(countReplayStructureUnits(chunk, MAX_REPLAY_STRUCTURE_UNITS, 257)).not.toBeNull();
  expect(hasBoundedReplayJsonStructure(JSON.stringify(chunk), 257)).toBe(true);
  expect(countReplayStructureUnits(chunk)).toBeNull();
});
