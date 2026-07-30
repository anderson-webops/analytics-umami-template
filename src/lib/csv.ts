const FORMULA_TRIGGER = /^[\t\r ]*[=+\-@]/;

export function sanitizeCsvValue(value: unknown): unknown {
  return typeof value === 'string' && FORMULA_TRIGGER.test(value) ? `'${value}` : value;
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
