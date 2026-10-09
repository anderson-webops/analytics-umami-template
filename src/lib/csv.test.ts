import { describe, expect, test } from 'vitest';
import { isUnsafeSpreadsheetValue, sanitizeCsvData, sanitizeCsvValue } from './csv';

describe('CSV spreadsheet safety', () => {
  test('prefixes direct and whitespace-prefixed formula cells', () => {
    for (const value of [
      '=1+1',
      '+SUM(A1:A2)',
      '-2+3',
      '@command',
      '\t=1+1',
      '  =1+1',
      '\n=1+1',
      '\r\n@command',
      ' \t\n+SUM(A1:A2)',
      '\u00a0=1+1',
      '\u200b=1+1',
      '\u0000=1+1',
    ]) {
      expect(isUnsafeSpreadsheetValue(value)).toBe(true);
      expect(sanitizeCsvValue(value)).toBe(`'${value}`);
    }
  });

  test('keeps ordinary cells and sanitizes object and array rows', () => {
    expect(isUnsafeSpreadsheetValue('ordinary value')).toBe(false);
    expect(sanitizeCsvValue('ordinary value')).toBe('ordinary value');
    expect(sanitizeCsvData([{ label: '=1+1', count: 1 }, ['@command', 'safe']])).toEqual([
      { label: "'=1+1", count: 1 },
      ["'@command", 'safe'],
    ]);
  });
});
