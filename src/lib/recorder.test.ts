import { describe, expect, test } from 'vitest';
import {
  getRecorderCode,
  getRecorderConfig,
  getRecorderEnabled,
  isRecorderPermitEndpoint,
} from './recorder';

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

  test('keeps only a bounded same-origin permit endpoint path', () => {
    expect(getRecorderConfig({ permitEndpoint: '/analytics-permit' })).toEqual({
      permitEndpoint: '/analytics-permit',
    });
    for (const permitEndpoint of [
      '',
      '/',
      '//other.example/permit',
      'https://other.example/permit',
      '/permit?token=secret',
      '/permit#fragment',
      '/permit/../other',
      '/permit\\other',
      '/permit" onload="x',
      `/${'a'.repeat(255)}`,
    ]) {
      expect(isRecorderPermitEndpoint(permitEndpoint)).toBe(false);
      expect(getRecorderConfig({ permitEndpoint })).toEqual({});
    }
  });
});

describe('getRecorderCode', () => {
  test('withholds the snippet until a site-owned permit endpoint is supplied', () => {
    expect(getRecorderCode('https://analytics.example/recorder.js', 'website-id', '')).toBeNull();
    expect(
      getRecorderCode('https://analytics.example/recorder.js', 'website-id', '//other.example'),
    ).toBeNull();
  });

  test('includes the permit endpoint without introducing HTML attributes', () => {
    const code = getRecorderCode(
      'https://analytics.example/recorder.js?x=1&y=2',
      'website-id',
      '/analytics&permit',
    );
    expect(code).not.toBeNull();
    const container = document.createElement('div');
    container.innerHTML = code ?? '';
    const script = container.querySelector('script');

    expect(script?.getAttribute('src')).toBe('https://analytics.example/recorder.js?x=1&y=2');
    expect(script?.getAttribute('data-website-id')).toBe('website-id');
    expect(script?.getAttribute('data-permit-endpoint')).toBe('/analytics&permit');
    expect(script?.attributes).toHaveLength(4);
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
