import { getSubtitleTrackId, type Subtitle } from "../types/subtitle";
import type { TimelineMarker } from "../types/timeline";
import type {
  AdjustmentLayerClip,
  AudioTimelineClip,
  TimelineTrackSettings,
  VideoTimelineClip,
} from "../types/timelineModel";
import { sliceVideoTransformKeyframes } from "./videoTransformKeyframes";
import {
  normalizedAdjustmentLayer,
  trimAdjustmentLayerKeyframes,
} from "./adjustmentLayers";
import {
  isFreezeFrameClip,
  isReverseVideoClip,
  timelineTimeToSourceTime,
} from "./videoRetime";

export type TimelineRange = {
  start: number;
  end: number;
};

export type TimelineRangeEditMode = "lift" | "extract";

type TimelineRangeEditInput = {
  range: TimelineRange;
  mode: TimelineRangeEditMode;
  videoClips: VideoTimelineClip[];
  audioClips: AudioTimelineClip[];
  adjustmentLayers: AdjustmentLayerClip[];
  subtitles: Subtitle[];
  markers: TimelineMarker[];
  trackSettings: TimelineTrackSettings;
};

export type TimelineRangeEditResult = {
  videoClips: VideoTimelineClip[];
  audioClips: AudioTimelineClip[];
  adjustmentLayers: AdjustmentLayerClip[];
  subtitles: Subtitle[];
  markers: TimelineMarker[];
  changed: boolean;
};

const EPSILON = 0.000001;
const MIN_FRAGMENT_DURATION = 0.001;

function normalizeRange(range: TimelineRange): TimelineRange | null {
  const start = Math.max(0, Math.min(range.start, range.end));
  const end = Math.max(0, Math.max(range.start, range.end));

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }

  if (end - start < MIN_FRAGMENT_DURATION) {
    return null;
  }

  return { start, end };
}

function isTrackLocked(trackId: string, trackSettings: TimelineTrackSettings) {
  return trackSettings[trackId]?.locked === true;
}

function sortVideoClips(clips: VideoTimelineClip[]) {
  return [...clips].sort(
    (a, b) =>
      a.timelineStart - b.timelineStart ||
      a.timelineEnd - b.timelineEnd ||
      a.trackId.localeCompare(b.trackId),
  );
}

function sortSubtitles(subtitles: Subtitle[]) {
  return [...subtitles].sort(
    (a, b) =>
      a.startTime - b.startTime ||
      a.endTime - b.endTime ||
      a.id.localeCompare(b.id),
  );
}

function clampVideoDurations(clip: VideoTimelineClip): VideoTimelineClip {
  const duration = Math.max(
    MIN_FRAGMENT_DURATION,
    clip.timelineEnd - clip.timelineStart,
  );
  const maxTransitionDuration = Math.max(0.1, Math.min(5, duration / 2));

  return {
    ...clip,
    transitionInDuration:
      clip.transitionInDuration === undefined
        ? undefined
        : Math.min(clip.transitionInDuration, maxTransitionDuration),
    transitionOutDuration:
      clip.transitionOutDuration === undefined
        ? undefined
        : Math.min(clip.transitionOutDuration, maxTransitionDuration),
    videoFadeInDuration:
      clip.videoFadeInDuration === undefined
        ? undefined
        : Math.min(clip.videoFadeInDuration, duration),
    videoFadeOutDuration:
      clip.videoFadeOutDuration === undefined
        ? undefined
        : Math.min(clip.videoFadeOutDuration, duration),
    audioFadeInDuration:
      clip.audioFadeInDuration === undefined
        ? undefined
        : Math.min(clip.audioFadeInDuration, duration),
    audioFadeOutDuration:
      clip.audioFadeOutDuration === undefined
        ? undefined
        : Math.min(clip.audioFadeOutDuration, duration),
  };
}

function leftVideoFragment(clip: VideoTimelineClip, timelineEnd: number) {
  const sourceSplit = timelineTimeToSourceTime(clip, timelineEnd);
  const reverse = isReverseVideoClip(clip);
  const freeze = isFreezeFrameClip(clip);

  return clampVideoDurations({
    ...clip,
    timelineEnd,
    sourceIn: freeze ? clip.sourceIn : reverse ? sourceSplit : clip.sourceIn,
    sourceOut: freeze ? clip.sourceOut : reverse ? clip.sourceOut : sourceSplit,
    transformKeyframes: sliceVideoTransformKeyframes(
      clip,
      clip.timelineStart,
      timelineEnd,
    ),
    transitionOutType: "none",
    transitionOutDuration: 0,
    videoFadeOutDuration: 0,
    audioFadeOutDuration: 0,
    // Range edits create intentional boundaries, not temporary Ripple splits.
    rippleAutoHealOutBoundaryId: undefined,
  });
}

function rightVideoFragment(
  clip: VideoTimelineClip,
  timelineStart: number,
  id: string,
) {
  const sourceSplit = timelineTimeToSourceTime(clip, timelineStart);
  const reverse = isReverseVideoClip(clip);
  const freeze = isFreezeFrameClip(clip);

  return clampVideoDurations({
    ...clip,
    id,
    timelineStart,
    sourceIn: freeze ? clip.sourceIn : reverse ? clip.sourceIn : sourceSplit,
    sourceOut: freeze ? clip.sourceOut : reverse ? sourceSplit : clip.sourceOut,
    transformKeyframes: sliceVideoTransformKeyframes(
      clip,
      timelineStart,
      clip.timelineEnd,
    ),
    transitionInType: "none",
    transitionInDuration: 0,
    videoFadeInDuration: 0,
    audioFadeInDuration: 0,
    rippleAutoHealInBoundaryId: undefined,
  });
}

function shiftVideoClip(clip: VideoTimelineClip, delta: number) {
  return {
    ...clip,
    timelineStart: Math.max(0, clip.timelineStart + delta),
    timelineEnd: Math.max(0, clip.timelineEnd + delta),
  };
}

function editVideoClips(
  clips: VideoTimelineClip[],
  range: TimelineRange,
  mode: TimelineRangeEditMode,
  trackSettings: TimelineTrackSettings,
) {
  const duration = range.end - range.start;
  const next: VideoTimelineClip[] = [];
  let changed = false;

  for (const clip of clips) {
    if (isTrackLocked(clip.trackId, trackSettings)) {
      next.push(clip);
      continue;
    }

    if (clip.timelineEnd <= range.start + EPSILON) {
      next.push(clip);
      continue;
    }

    if (clip.timelineStart >= range.end - EPSILON) {
      if (mode === "extract") {
        next.push(shiftVideoClip(clip, -duration));
        changed = true;
      } else {
        next.push(clip);
      }
      continue;
    }

    changed = true;

    const hasLeft = clip.timelineStart < range.start - EPSILON;
    const hasRight = clip.timelineEnd > range.end + EPSILON;

    if (hasLeft) {
      const left = leftVideoFragment(clip, range.start);

      if (left.timelineEnd - left.timelineStart >= MIN_FRAGMENT_DURATION) {
        next.push(left);
      }
    }

    if (hasRight) {
      const rightId = hasLeft ? crypto.randomUUID() : clip.id;
      let right = rightVideoFragment(clip, range.end, rightId);

      if (mode === "extract") {
        right = shiftVideoClip(right, -duration);
      }

      if (right.timelineEnd - right.timelineStart >= MIN_FRAGMENT_DURATION) {
        next.push(right);
      }
    }
  }

  return {
    clips: sortVideoClips(next),
    changed,
  };
}

function sortAudioClips(clips: AudioTimelineClip[]) {
  return [...clips].sort(
    (a, b) =>
      a.timelineStart - b.timelineStart ||
      a.timelineEnd - b.timelineEnd ||
      a.trackId.localeCompare(b.trackId),
  );
}

function editAudioClips(
  clips: AudioTimelineClip[],
  range: TimelineRange,
  mode: TimelineRangeEditMode,
  trackSettings: TimelineTrackSettings,
) {
  const duration = range.end - range.start;
  const next: AudioTimelineClip[] = [];
  let changed = false;

  for (const clip of clips) {
    if (isTrackLocked(clip.trackId, trackSettings)) {
      next.push(clip);
      continue;
    }

    if (clip.timelineEnd <= range.start + EPSILON) {
      next.push(clip);
      continue;
    }

    if (clip.timelineStart >= range.end - EPSILON) {
      if (mode === "extract") {
        next.push({
          ...clip,
          timelineStart: Math.max(0, clip.timelineStart - duration),
          timelineEnd: Math.max(0, clip.timelineEnd - duration),
        });
        changed = true;
      } else {
        next.push(clip);
      }
      continue;
    }

    changed = true;
    const hasLeft = clip.timelineStart < range.start - EPSILON;
    const hasRight = clip.timelineEnd > range.end + EPSILON;

    if (hasLeft) {
      const sourceOut = clip.sourceIn + (range.start - clip.timelineStart);
      const left: AudioTimelineClip = {
        ...clip,
        timelineEnd: range.start,
        sourceOut,
        fadeOutDuration: 0,
      };
      if (left.timelineEnd - left.timelineStart >= MIN_FRAGMENT_DURATION)
        next.push(left);
    }

    if (hasRight) {
      const sourceIn = clip.sourceIn + (range.end - clip.timelineStart);
      const rightStart = mode === "extract" ? range.start : range.end;
      const rightEnd =
        mode === "extract" ? clip.timelineEnd - duration : clip.timelineEnd;
      const right: AudioTimelineClip = {
        ...clip,
        id: hasLeft ? crypto.randomUUID() : clip.id,
        timelineStart: rightStart,
        timelineEnd: rightEnd,
        sourceIn,
        fadeInDuration: 0,
      };
      if (right.timelineEnd - right.timelineStart >= MIN_FRAGMENT_DURATION)
        next.push(right);
    }
  }

  return { clips: sortAudioClips(next), changed };
}

function editSubtitles(
  subtitles: Subtitle[],
  range: TimelineRange,
  mode: TimelineRangeEditMode,
  trackSettings: TimelineTrackSettings,
) {
  const duration = range.end - range.start;
  const next: Subtitle[] = [];
  let changed = false;

  for (const subtitle of subtitles) {
    const trackId = getSubtitleTrackId(subtitle);

    if (isTrackLocked(trackId, trackSettings)) {
      next.push(subtitle);
      continue;
    }

    if (subtitle.endTime <= range.start + EPSILON) {
      next.push(subtitle);
      continue;
    }

    if (subtitle.startTime >= range.end - EPSILON) {
      if (mode === "extract") {
        next.push({
          ...subtitle,
          startTime: Math.max(0, subtitle.startTime - duration),
          endTime: Math.max(0, subtitle.endTime - duration),
        });
        changed = true;
      } else {
        next.push(subtitle);
      }
      continue;
    }

    changed = true;

    const hasLeft = subtitle.startTime < range.start - EPSILON;
    const hasRight = subtitle.endTime > range.end + EPSILON;

    if (mode === "extract" && hasLeft && hasRight) {
      const shortened = {
        ...subtitle,
        endTime: subtitle.endTime - duration,
      };

      if (shortened.endTime - shortened.startTime >= MIN_FRAGMENT_DURATION) {
        next.push(shortened);
      }

      continue;
    }

    if (hasLeft) {
      const left = {
        ...subtitle,
        endTime: range.start,
      };

      if (left.endTime - left.startTime >= MIN_FRAGMENT_DURATION) {
        next.push(left);
      }
    }

    if (hasRight) {
      const rightStart = mode === "extract" ? range.start : range.end;
      const rightEnd =
        mode === "extract" ? subtitle.endTime - duration : subtitle.endTime;
      const right = {
        ...subtitle,
        id: hasLeft ? crypto.randomUUID() : subtitle.id,
        startTime: rightStart,
        endTime: rightEnd,
      };

      if (right.endTime - right.startTime >= MIN_FRAGMENT_DURATION) {
        next.push(right);
      }
    }
  }

  return {
    subtitles: sortSubtitles(next),
    changed,
  };
}

function sortAdjustmentLayers(layers: AdjustmentLayerClip[]) {
  return [...layers].sort(
    (a, b) =>
      a.timelineStart - b.timelineStart ||
      a.timelineEnd - b.timelineEnd ||
      a.trackId.localeCompare(b.trackId),
  );
}

function editAdjustmentLayers(
  layers: AdjustmentLayerClip[],
  range: TimelineRange,
  mode: TimelineRangeEditMode,
  trackSettings: TimelineTrackSettings,
) {
  const duration = range.end - range.start;
  const next: AdjustmentLayerClip[] = [];
  let changed = false;

  for (const layer of layers) {
    if (isTrackLocked(layer.trackId, trackSettings)) {
      next.push(layer);
      continue;
    }

    if (layer.timelineEnd <= range.start + EPSILON) {
      next.push(layer);
      continue;
    }

    if (layer.timelineStart >= range.end - EPSILON) {
      if (mode === "extract") {
        next.push({
          ...layer,
          timelineStart: Math.max(0, layer.timelineStart - duration),
          timelineEnd: Math.max(0, layer.timelineEnd - duration),
        });
        changed = true;
      } else {
        next.push(layer);
      }
      continue;
    }

    changed = true;
    const hasLeft = layer.timelineStart < range.start - EPSILON;
    const hasRight = layer.timelineEnd > range.end + EPSILON;

    if (hasLeft) {
      next.push(
        normalizedAdjustmentLayer({
          ...layer,
          timelineEnd: range.start,
          keyframes: trimAdjustmentLayerKeyframes(
            layer,
            layer.timelineStart,
            range.start,
          ),
        }),
      );
    }

    if (hasRight) {
      const originalStart = range.end;
      const originalEnd = layer.timelineEnd;
      const shiftedStart = mode === "extract" ? range.start : originalStart;
      const shiftedEnd =
        mode === "extract" ? originalEnd - duration : originalEnd;
      next.push(
        normalizedAdjustmentLayer({
          ...layer,
          id: hasLeft ? crypto.randomUUID() : layer.id,
          timelineStart: shiftedStart,
          timelineEnd: shiftedEnd,
          keyframes: trimAdjustmentLayerKeyframes(
            layer,
            originalStart,
            originalEnd,
          ),
        }),
      );
    }
  }

  return { layers: sortAdjustmentLayers(next), changed };
}

function editMarkers(
  markers: TimelineMarker[],
  range: TimelineRange,
  mode: TimelineRangeEditMode,
) {
  if (mode !== "extract") {
    return {
      markers,
      changed: false,
    };
  }

  const duration = range.end - range.start;
  const next: TimelineMarker[] = [];
  let changed = false;

  for (const marker of markers) {
    if (marker.time < range.start - EPSILON) {
      next.push(marker);
      continue;
    }

    if (marker.time >= range.end - EPSILON) {
      next.push({
        ...marker,
        time: Math.max(0, marker.time - duration),
      });
      changed = true;
      continue;
    }

    // Markers inside extracted time disappear with that section of timeline.
    changed = true;
  }

  return {
    markers: next.sort((a, b) => a.time - b.time),
    changed,
  };
}

export function applyTimelineRangeEdit({
  range: rawRange,
  mode,
  videoClips,
  audioClips,
  adjustmentLayers,
  subtitles,
  markers,
  trackSettings,
}: TimelineRangeEditInput): TimelineRangeEditResult {
  const range = normalizeRange(rawRange);

  if (!range) {
    return {
      videoClips,
      audioClips,
      adjustmentLayers,
      subtitles,
      markers,
      changed: false,
    };
  }

  const videoResult = editVideoClips(videoClips, range, mode, trackSettings);
  const audioResult = editAudioClips(audioClips, range, mode, trackSettings);
  const adjustmentResult = editAdjustmentLayers(
    adjustmentLayers,
    range,
    mode,
    trackSettings,
  );
  const subtitleResult = editSubtitles(subtitles, range, mode, trackSettings);
  const markerResult = editMarkers(markers, range, mode);

  return {
    videoClips: videoResult.clips,
    audioClips: audioResult.clips,
    adjustmentLayers: adjustmentResult.layers,
    subtitles: subtitleResult.subtitles,
    markers: markerResult.markers,
    changed:
      videoResult.changed ||
      audioResult.changed ||
      adjustmentResult.changed ||
      subtitleResult.changed ||
      markerResult.changed,
  };
}
