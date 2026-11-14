const MAX_RENDER_WIDTH = 2048;
const MAX_RENDER_HEIGHT = 8192;

function boundDimension(value: number, maximum: number) {
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.round(value), maximum)) : 1;
}

export function boundHeatmapRenderWidth(value: number) {
  return boundDimension(value, MAX_RENDER_WIDTH);
}

export function boundHeatmapRenderHeight(value: number) {
  return boundDimension(value, MAX_RENDER_HEIGHT);
}

export function isPointWithinHeatmapRender(
  point: { pageX: number; pageY: number },
  width: number,
  height: number,
) {
  return (
    Number.isFinite(point.pageX) &&
    Number.isFinite(point.pageY) &&
    point.pageX >= 0 &&
    point.pageX <= width &&
    point.pageY >= 0 &&
    point.pageY <= height
  );
}

export function getHeatmapPageHeight(
  points: readonly { pageH: number; pageY: number; count: number }[],
) {
  const counts = new Map<number, number>();
  let maxClickY = 0;
  let commonHeight = 0;
  let commonCount = 0;

  for (const point of points) {
    if (
      !Number.isFinite(point.pageH) ||
      point.pageH <= 0 ||
      !Number.isFinite(point.pageY) ||
      point.pageY < 0 ||
      !Number.isFinite(point.count) ||
      point.count <= 0
    )
      continue;
    maxClickY = Math.max(maxClickY, point.pageY);
    counts.set(point.pageH, (counts.get(point.pageH) ?? 0) + point.count);
  }

  for (const [height, count] of counts) {
    if (count > commonCount || (count === commonCount && height > commonHeight)) {
      commonHeight = height;
      commonCount = count;
    }
  }

  return Math.max(commonHeight, Math.ceil(maxClickY));
}
