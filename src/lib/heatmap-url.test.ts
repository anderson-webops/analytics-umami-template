import { describe, expect, test } from 'vitest';
import { getHeatmapUrlPath } from './heatmap-url';

describe('heatmap page URLs', () => {
  test('normalizes collected URLs to a path before storage', () => {
    expect(getHeatmapUrlPath('https://example.com/path?secret=value')).toBe('/path');
    expect(getHeatmapUrlPath('//attacker.example/path')).toBe('/path');
    expect(getHeatmapUrlPath('javascript:alert(1)')).toBe('/');
  });
});
