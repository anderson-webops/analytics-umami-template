export const MAX_DATE_SERIES_POINTS = 10_000;
export const DATE_SERIES_QUERY_TIMEOUT_MS = 10_000;
export const DATE_SERIES_QUERY_ROW_LIMIT = MAX_DATE_SERIES_POINTS + 1;
export const DATE_SERIES_MAX_ROWS_TO_READ = 262_144;

export class DateSeriesLimitError extends Error {
  constructor() {
    super('The requested date series exceeds the allowed size.');
  }
}

export function requireCompleteDateSeries<SeriesPoint>(rows: SeriesPoint[]): SeriesPoint[] {
  if (rows.length > MAX_DATE_SERIES_POINTS) {
    throw new DateSeriesLimitError();
  }

  return rows;
}
