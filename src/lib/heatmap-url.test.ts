import { describe, expect, test } from 'vitest';
import { buildHeatmapPageUrl, getHeatmapUrlPath } from './heatmap-url';

describe('heatmap page URLs', () => {
  test('keeps snapshots on the configured website origin', () => {
    expect(buildHeatmapPageUrl('example.com', '/products/item')).toBe(
      'https://example.com/products/item',
    );
    expect(buildHeatmapPageUrl('localhost:3001', '/preview')).toBe('http://localhost:3001/preview');
  });

  test('rejects cross-origin and ambiguous snapshot paths', () => {
    expect(buildHeatmapPageUrl('example.com', '//attacker.example/path')).toBeNull();
    expect(buildHeatmapPageUrl('example.com', 'https://attacker.example/path')).toBeNull();
    expect(buildHeatmapPageUrl('https://user:password@example.com', '/path')).toBeNull();
    expect(buildHeatmapPageUrl('example.com/path', '/path')).toBeNull();
  });

  test('normalizes collected URLs to a path before storage', () => {
    expect(getHeatmapUrlPath('https://example.com/path?secret=value')).toBe('/path');
    expect(getHeatmapUrlPath('//attacker.example/path')).toBe('/path');
    expect(getHeatmapUrlPath('javascript:alert(1)')).toBe('/');
  });
});
