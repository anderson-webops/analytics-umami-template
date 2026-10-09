const FORMULA_TRIGGER = /^[\s\p{Cc}\p{Cf}]*[=+\-@]/u;
const CONTROL_PREFIX = /^\p{Cc}/u;

export function isUnsafeSpreadsheetValue(value: unknown): value is string {
  return typeof value === 'string' && (FORMULA_TRIGGER.test(value) || CONTROL_PREFIX.test(value));
}

export function sanitizeCsvValue(value: unknown): unknown {
  return isUnsafeSpreadsheetValue(value) ? `'${value}` : value;
}

export function sanitizeCsvData(data: unknown): unknown {
  if (!Array.isArray(data)) {
    return data;
  }

  return data.map(row => {
    if (Array.isArray(row)) {
      return row.map(sanitizeCsvValue);
    }

    if (row && typeof row === 'object') {
      return Object.fromEntries(
        Object.entries(row as Record<string, unknown>).map(([key, value]) => [
          key,
          sanitizeCsvValue(value),
        ]),
      );
    }

    return sanitizeCsvValue(row);
  });
}
