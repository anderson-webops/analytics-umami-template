import { describe, expect, test } from 'vitest';
import { getRecorderConfig } from './recorder';

describe('getRecorderConfig', () => {
  test('accepts supported replay settings', () => {
    expect(
      getRecorderConfig({
        replayEnabled: true,
        heatmapEnabled: true,
        sampleRate: 0.5,
        heatmapSampleRate: 0.25,
        maskLevel: 'strict',
        maxDuration: 1_200_000,
        blockSelector: '.private',
      }),
    ).toEqual({
      replayEnabled: true,
      heatmapEnabled: true,
      sampleRate: 0.5,
      heatmapSampleRate: 0.25,
      maskLevel: 'strict',
      maxDuration: 1_200_000,
      blockSelector: '.private',
    });
  });

  test('drops out-of-range or oversized legacy settings', () => {
    expect(
      getRecorderConfig({
        sampleRate: 2,
        heatmapSampleRate: Number.NaN,
        maxDuration: 30_000,
        blockSelector: 'x'.repeat(1_001),
      }),
    ).toEqual({});
  });
});
