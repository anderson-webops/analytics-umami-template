export function getHeatmapUrlPath(value: string): string {
  try {
    const url = new URL(value, 'https://heatmap.invalid');

    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return '/';
    }

    return url.pathname || '/';
  } catch {
    return '/';
  }
}
