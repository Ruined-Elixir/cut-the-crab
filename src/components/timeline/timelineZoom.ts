export const MIN_TIMELINE_ZOOM = 0.05;
export const MAX_TIMELINE_ZOOM = 12;
export const TIMELINE_ZOOM_STEP = 0.25;

export function clampTimelineZoom(value: number) {
  return Math.max(MIN_TIMELINE_ZOOM, Math.min(MAX_TIMELINE_ZOOM, value));
}
