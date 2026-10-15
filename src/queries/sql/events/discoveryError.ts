export class DiscoveryRangeTooBroadError extends Error {
  constructor() {
    super('Narrow the date range or filters to discover properties.');
  }
}
