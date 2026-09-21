import type {
  AudioTimelineClip,
  VideoTimelineClip,
} from "../types/timelineModel";

export const MIN_VIDEO_PLAYBACK_RATE = 0.25;
export const MAX_VIDEO_PLAYBACK_RATE = 4;
export const DEFAULT_VIDEO_PLAYBACK_RATE = 1;

export type RateAwareTimelineClip = Pick<
  VideoTimelineClip | AudioTimelineClip,
  "sourceIn" | "sourceOut" | "timelineStart" | "playbackRate"
> &
  Partial<
    Pick<VideoTimelineClip, "playbackDirection" | "freezeFrameSourceTime">
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

export function isReverseVideoClip(clip: {
  playbackDirection?: "forward" | "reverse";
}) {
  return clip.playbackDirection === "reverse";
}

export function isFreezeFrameClip(clip: { freezeFrameSourceTime?: number }) {
  return Number.isFinite(clip.freezeFrameSourceTime);
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
  if (isFreezeFrameClip(clip)) {
    return clip.freezeFrameSourceTime!;
  }

  const sourceDelta = timelineDeltaToSourceDelta(
    clip,
    timelineTime - clip.timelineStart,
  );

  return isReverseVideoClip(clip)
    ? clip.sourceOut - sourceDelta
    : clip.sourceIn + sourceDelta;
}

export function sourceTimeToTimelineTime(
  clip: RateAwareTimelineClip,
  sourceTime: number,
) {
  if (isFreezeFrameClip(clip)) {
    return clip.timelineStart;
  }

  const sourceDelta = isReverseVideoClip(clip)
    ? clip.sourceOut - sourceTime
    : sourceTime - clip.sourceIn;

  return clip.timelineStart + sourceDeltaToTimelineDelta(clip, sourceDelta);
}
