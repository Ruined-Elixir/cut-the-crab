import type { AudioTimelineClip, VideoTimelineClip } from "../types/timelineModel";

export const MIN_VIDEO_PLAYBACK_RATE = 0.25;
export const MAX_VIDEO_PLAYBACK_RATE = 4;
export const DEFAULT_VIDEO_PLAYBACK_RATE = 1;

export type RateAwareTimelineClip = Pick<
  VideoTimelineClip | AudioTimelineClip,
  "sourceIn" | "timelineStart" | "playbackRate"
>;

export function normalizeVideoPlaybackRate(value: number | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_VIDEO_PLAYBACK_RATE;
  return Math.max(
    MIN_VIDEO_PLAYBACK_RATE,
    Math.min(MAX_VIDEO_PLAYBACK_RATE, value ?? DEFAULT_VIDEO_PLAYBACK_RATE),
  );
}

export function videoPlaybackRate(clip: { playbackRate?: number }) {
  return normalizeVideoPlaybackRate(clip.playbackRate);
}

export function timelineDeltaToSourceDelta(
  clip: { playbackRate?: number },
  timelineDelta: number,
) {
  return timelineDelta * videoPlaybackRate(clip);
}

export function sourceDeltaToTimelineDelta(
  clip: { playbackRate?: number },
  sourceDelta: number,
) {
  return sourceDelta / videoPlaybackRate(clip);
}

export function timelineTimeToSourceTime(
  clip: RateAwareTimelineClip,
  timelineTime: number,
) {
  return (
    clip.sourceIn +
    timelineDeltaToSourceDelta(clip, timelineTime - clip.timelineStart)
  );
}

export function sourceTimeToTimelineTime(
  clip: RateAwareTimelineClip,
  sourceTime: number,
) {
  return (
    clip.timelineStart +
    sourceDeltaToTimelineDelta(clip, sourceTime - clip.sourceIn)
  );
}
