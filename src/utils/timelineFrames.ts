export const TIMELINE_FPS = 30;
export const TIMELINE_FRAME_DURATION = 1 / TIMELINE_FPS;
export const TIMELINE_GAP_BRIDGE_EPSILON = TIMELINE_FRAME_DURATION + 0.001;

export function snapTimelineTimeToFrame(time: number) {
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, Math.round(time * TIMELINE_FPS) / TIMELINE_FPS);
}

export function snapTimelineDeltaToFrame(delta: number) {
  if (!Number.isFinite(delta)) return 0;
  return Math.round(delta * TIMELINE_FPS) / TIMELINE_FPS;
}
