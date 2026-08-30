import { describe, expect, test } from 'vitest';
import { getRecorderConfig, getRecorderEnabled } from './recorder';

describe('getRecorderConfig', () => {
  test('returns an empty object for non-object values', () => {
    expect(getRecorderConfig(null)).toEqual({});
    expect(getRecorderConfig(undefined)).toEqual({});
    expect(getRecorderConfig('x')).toEqual({});
    expect(getRecorderConfig([1, 2])).toEqual({});
  });

  test('only keeps boolean enabled flags that are strictly true', () => {
    expect(getRecorderConfig({ replayEnabled: true, heatmapEnabled: false })).toEqual({
      replayEnabled: true,
    });
    expect(getRecorderConfig({ replayEnabled: 'true' })).toEqual({});
  });

  test('keeps numeric sample rates', () => {
    expect(getRecorderConfig({ sampleRate: 0.5, heatmapSampleRate: 1 })).toEqual({
      sampleRate: 0.5,
      heatmapSampleRate: 1,
    });
    expect(getRecorderConfig({ sampleRate: '0.5' })).toEqual({});
  });

  test('only accepts known mask levels', () => {
    expect(getRecorderConfig({ maskLevel: 'strict' })).toEqual({ maskLevel: 'strict' });
    expect(getRecorderConfig({ maskLevel: 'moderate' })).toEqual({ maskLevel: 'moderate' });
    expect(getRecorderConfig({ maskLevel: 'loose' })).toEqual({});
  });

  test('rounds in-range finite maxDuration values and rejects invalid bounds', () => {
    expect(getRecorderConfig({ maxDuration: 60_012.6 })).toEqual({ maxDuration: 60_013 });
    expect(getRecorderConfig({ maxDuration: 59_999 })).toEqual({});
    expect(getRecorderConfig({ maxDuration: 3_600_001 })).toEqual({});
    expect(getRecorderConfig({ maxDuration: Infinity })).toEqual({});
    expect(getRecorderConfig({ maxDuration: NaN })).toEqual({});
  });

  test('keeps a string blockSelector', () => {
    expect(getRecorderConfig({ blockSelector: '.hidden' })).toEqual({ blockSelector: '.hidden' });
    expect(getRecorderConfig({ blockSelector: 5 })).toEqual({});
  });
});

describe('getRecorderEnabled', () => {
  test('is true when replay or heatmap is enabled', () => {
    expect(getRecorderEnabled({ replayEnabled: true })).toBe(true);
    expect(getRecorderEnabled({ heatmapEnabled: true })).toBe(true);
  });

  test('is false otherwise', () => {
    expect(getRecorderEnabled({})).toBe(false);
    expect(getRecorderEnabled(null)).toBe(false);
    expect(getRecorderEnabled({ sampleRate: 1 })).toBe(false);
  });
});
