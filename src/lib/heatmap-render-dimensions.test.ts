import { describe, expect, test } from 'vitest';
import {
  boundHeatmapRenderHeight,
  boundHeatmapRenderWidth,
  getHeatmapPageHeight,
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

test('click canvas ignores uncommon taller page sizes but preserves deeper clicks', () => {
  const points = [
    { pageH: 900, pageY: 865, count: 3 },
    { pageH: 900, pageY: 450, count: 1 },
    { pageH: 2239, pageY: 449, count: 1 },
  ];
  expect(getHeatmapPageHeight(points)).toBe(900);
  expect(getHeatmapPageHeight([...points, { pageH: 900, pageY: 1500.4, count: 1 }])).toBe(1501);
});

test('page-height weighting handles ties, empty input and invalid stored values', () => {
  expect(getHeatmapPageHeight([])).toBe(0);
  expect(
    getHeatmapPageHeight([
      { pageH: 900, pageY: 100, count: 2 },
      { pageH: 1200, pageY: 100, count: 2 },
      { pageH: NaN, pageY: 100, count: 10 },
      { pageH: 1000000, pageY: NaN, count: 10 },
    ]),
  ).toBe(1200);
  expect(
    boundHeatmapRenderHeight(getHeatmapPageHeight([{ pageH: 1000000, pageY: 999999, count: 1 }])),
  ).toBe(8192);
});
