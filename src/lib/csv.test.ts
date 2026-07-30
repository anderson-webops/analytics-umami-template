import { describe, expect, test } from 'vitest';
import { sanitizeCsvData, sanitizeCsvValue } from './csv';

describe('CSV spreadsheet safety', () => {
  test('prefixes direct and whitespace-prefixed formula cells', () => {
    for (const value of ['=1+1', '+SUM(A1:A2)', '-2+3', '@command', '\t=1+1', '  =1+1']) {
      expect(sanitizeCsvValue(value)).toBe(`'${value}`);
    }
  });

  test('keeps ordinary cells and sanitizes object and array rows', () => {
    expect(sanitizeCsvValue('ordinary value')).toBe('ordinary value');
    expect(sanitizeCsvData([{ label: '=1+1', count: 1 }, ['@command', 'safe']])).toEqual([
      { label: "'=1+1", count: 1 },
      ["'@command", 'safe'],
    ]);
  });
});
