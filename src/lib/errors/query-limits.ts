export const MAX_ERROR_STATUS_ISSUES = 5000;

export class ErrorQueryLimitError extends Error {
  constructor() {
    super('The error status filter matches too many issues. Narrow the date range or search.');
  }
}
