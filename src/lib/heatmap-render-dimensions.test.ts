import { describe, expect, test } from 'vitest';
import {
  boundHeatmapRenderHeight,
  boundHeatmapRenderWidth,
  isPointWithinHeatmapRender,
} from './heatmap-render-dimensions';

describe('heatmap render dimensions', () => {
  test('preserves ordinary page and viewport sizes', () => {
    expect(boundHeatmapRenderWidth(1920)).toBe(1920);
    expect(boundHeatmapRenderHeight(640)).toBe(640);
    expect(boundHeatmapRenderHeight(4000)).toBe(4000);
  });

  test('bounds attacker-controlled stored dimensions before layout', () => {
    expect(boundHeatmapRenderWidth(10_000_000)).toBe(2048);
    expect(boundHeatmapRenderHeight(10_000_000)).toBe(8192);
    expect(boundHeatmapRenderWidth(16_000_000_000)).toBe(2048);
    expect(boundHeatmapRenderHeight(16_000_000_000)).toBe(8192);
  });

  test('rejects non-finite or non-positive dimensions', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(boundHeatmapRenderWidth(value)).toBe(1);
      expect(boundHeatmapRenderHeight(value)).toBe(1);
    }
  });

  test('does not position dots outside the bounded canvas', () => {
    const width = boundHeatmapRenderWidth(10_000_000);
    const height = boundHeatmapRenderHeight(10_000_000);

    expect(isPointWithinHeatmapRender({ pageX: 1024, pageY: 4000 }, width, height)).toBe(true);
    expect(isPointWithinHeatmapRender({ pageX: 10_000_000, pageY: 4000 }, width, height)).toBe(
      false,
    );
    expect(isPointWithinHeatmapRender({ pageX: 1024, pageY: 10_000_000 }, width, height)).toBe(
      false,
    );
    expect(isPointWithinHeatmapRender({ pageX: Number.NaN, pageY: 4000 }, width, height)).toBe(
      false,
    );
  });
});
