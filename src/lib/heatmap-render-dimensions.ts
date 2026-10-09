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
