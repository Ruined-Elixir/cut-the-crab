import type {
  VideoTimelineClip,
  VideoTransformKeyframe,
  VideoTransformKeyframeProperty,
  VideoTransformKeyframes,
} from "../types/timelineModel";

const EPSILON = 0.0005;

export const VIDEO_TRANSFORM_KEYFRAME_PROPERTIES = [
  "positionX",
  "positionY",
  "scale",
  "rotation",
  "opacity",
] as const satisfies readonly VideoTransformKeyframeProperty[];

export type EvaluatedVideoTransform = {
  positionX: number;
  positionY: number;
  scale: number;
  rotation: number;
  opacity: number;
};

export function clampVideoTransformValue(
  property: VideoTransformKeyframeProperty,
  value: number,
) {
  if (!Number.isFinite(value)) {
    return defaultVideoTransformValue(property);
  }

  switch (property) {
    case "positionX":
    case "positionY":
      return Math.max(-100, Math.min(100, value));
    case "scale":
      return Math.max(10, Math.min(400, value));
    case "rotation":
      return Math.max(-180, Math.min(180, value));
    case "opacity":
      return Math.max(0, Math.min(100, value));
  }
}

export function defaultVideoTransformValue(
  property: VideoTransformKeyframeProperty,
) {
  switch (property) {
    case "positionX":
    case "positionY":
    case "rotation":
      return 0;
    case "scale":
    case "opacity":
      return 100;
  }
}

export function baseVideoTransformValue(
  clip: VideoTimelineClip,
  property: VideoTransformKeyframeProperty,
) {
  const value = clip[property];
  return clampVideoTransformValue(
    property,
    typeof value === "number" ? value : defaultVideoTransformValue(property),
  );
}

export function clipLocalTime(clip: VideoTimelineClip, timelineTime: number) {
  const duration = Math.max(0, clip.timelineEnd - clip.timelineStart);
  return Math.max(0, Math.min(duration, timelineTime - clip.timelineStart));
}

export function normalizeVideoTransformKeyframes(
  keyframes: VideoTransformKeyframes | undefined,
  clipDuration: number,
): VideoTransformKeyframes | undefined {
  if (!keyframes) return undefined;

  const result: VideoTransformKeyframes = {};
  let hasAny = false;

  for (const property of VIDEO_TRANSFORM_KEYFRAME_PROPERTIES) {
    const channel = keyframes[property];
    if (!channel?.length) continue;

    const sorted = channel
      .filter(
        (keyframe): keyframe is VideoTransformKeyframe =>
          !!keyframe &&
          Number.isFinite(keyframe.time) &&
          Number.isFinite(keyframe.value),
      )
      .map((keyframe) => ({
        time: Math.max(0, Math.min(clipDuration, keyframe.time)),
        value: clampVideoTransformValue(property, keyframe.value),
      }))
      .sort((a, b) => a.time - b.time);

    const deduped: VideoTransformKeyframe[] = [];
    for (const keyframe of sorted) {
      const previous = deduped[deduped.length - 1];
      if (previous && Math.abs(previous.time - keyframe.time) <= EPSILON) {
        previous.time = keyframe.time;
        previous.value = keyframe.value;
      } else {
        deduped.push({ ...keyframe });
      }
    }

    if (deduped.length > 0) {
      result[property] = deduped;
      hasAny = true;
    }
  }

  return hasAny ? result : undefined;
}

export function videoTransformChannel(
  clip: VideoTimelineClip,
  property: VideoTransformKeyframeProperty,
) {
  return clip.transformKeyframes?.[property] ?? [];
}

export function hasVideoTransformKeyframes(
  clip: VideoTimelineClip,
  property?: VideoTransformKeyframeProperty,
) {
  if (property) return videoTransformChannel(clip, property).length > 0;
  return VIDEO_TRANSFORM_KEYFRAME_PROPERTIES.some(
    (item) => videoTransformChannel(clip, item).length > 0,
  );
}

export function hasVideoTransformKeyframeAtTime(
  clip: VideoTimelineClip,
  property: VideoTransformKeyframeProperty,
  timelineTime: number,
) {
  const localTime = clipLocalTime(clip, timelineTime);
  return videoTransformChannel(clip, property).some(
    (keyframe) => Math.abs(keyframe.time - localTime) <= EPSILON,
  );
}

export function evaluateVideoTransformPropertyAtLocalTime(
  clip: VideoTimelineClip,
  property: VideoTransformKeyframeProperty,
  localTime: number,
) {
  const channel = videoTransformChannel(clip, property);
  if (channel.length === 0) return baseVideoTransformValue(clip, property);
  if (channel.length === 1) return channel[0].value;

  const sorted = [...channel].sort((a, b) => a.time - b.time);
  if (localTime <= sorted[0].time + EPSILON) return sorted[0].value;
  const last = sorted[sorted.length - 1];
  if (localTime >= last.time - EPSILON) return last.value;

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const left = sorted[index];
    const right = sorted[index + 1];
    if (localTime < left.time - EPSILON || localTime > right.time + EPSILON) {
      continue;
    }

    const span = Math.max(EPSILON, right.time - left.time);
    const progress = Math.max(0, Math.min(1, (localTime - left.time) / span));
    return left.value + (right.value - left.value) * progress;
  }

  return last.value;
}

export function evaluateVideoTransformProperty(
  clip: VideoTimelineClip,
  property: VideoTransformKeyframeProperty,
  timelineTime: number,
) {
  return evaluateVideoTransformPropertyAtLocalTime(
    clip,
    property,
    clipLocalTime(clip, timelineTime),
  );
}

export function evaluateVideoTransform(
  clip: VideoTimelineClip,
  timelineTime: number,
): EvaluatedVideoTransform {
  return {
    positionX: evaluateVideoTransformProperty(clip, "positionX", timelineTime),
    positionY: evaluateVideoTransformProperty(clip, "positionY", timelineTime),
    scale: evaluateVideoTransformProperty(clip, "scale", timelineTime),
    rotation: evaluateVideoTransformProperty(clip, "rotation", timelineTime),
    opacity: evaluateVideoTransformProperty(clip, "opacity", timelineTime),
  };
}

export function withEvaluatedVideoTransform(
  clip: VideoTimelineClip,
  timelineTime: number,
): VideoTimelineClip {
  return { ...clip, ...evaluateVideoTransform(clip, timelineTime) };
}

export function upsertVideoTransformKeyframe(
  clip: VideoTimelineClip,
  property: VideoTransformKeyframeProperty,
  timelineTime: number,
  value: number,
): VideoTimelineClip {
  const localTime = clipLocalTime(clip, timelineTime);
  const channel = [...videoTransformChannel(clip, property)];
  const nextValue = clampVideoTransformValue(property, value);
  const existingIndex = channel.findIndex(
    (keyframe) => Math.abs(keyframe.time - localTime) <= EPSILON,
  );

  if (existingIndex >= 0) {
    channel[existingIndex] = { time: localTime, value: nextValue };
  } else {
    channel.push({ time: localTime, value: nextValue });
  }

  channel.sort((a, b) => a.time - b.time);
  return {
    ...clip,
    transformKeyframes: {
      ...(clip.transformKeyframes ?? {}),
      [property]: channel,
    },
  };
}

export function toggleVideoTransformKeyframeAtTime(
  clip: VideoTimelineClip,
  property: VideoTransformKeyframeProperty,
  timelineTime: number,
): VideoTimelineClip {
  const localTime = clipLocalTime(clip, timelineTime);
  const channel = [...videoTransformChannel(clip, property)];
  const existingIndex = channel.findIndex(
    (keyframe) => Math.abs(keyframe.time - localTime) <= EPSILON,
  );

  if (existingIndex < 0) {
    return upsertVideoTransformKeyframe(
      clip,
      property,
      timelineTime,
      evaluateVideoTransformPropertyAtLocalTime(clip, property, localTime),
    );
  }

  const removedValue = channel[existingIndex].value;
  channel.splice(existingIndex, 1);
  const nextKeyframes = { ...(clip.transformKeyframes ?? {}) };
  if (channel.length > 0) {
    nextKeyframes[property] = channel;
  } else {
    delete nextKeyframes[property];
  }

  return {
    ...clip,
    // Removing the only keyframe should preserve the visible value instead of
    // snapping all the way back to an older static base value.
    ...(channel.length === 0 ? { [property]: removedValue } : {}),
    transformKeyframes: Object.values(nextKeyframes).some(
      (items) => items && items.length > 0,
    )
      ? nextKeyframes
      : undefined,
  };
}

export function setVideoTransformPropertyAtTime(
  clip: VideoTimelineClip,
  property: VideoTransformKeyframeProperty,
  timelineTime: number,
  value: number,
): VideoTimelineClip {
  const nextValue = clampVideoTransformValue(property, value);
  if (hasVideoTransformKeyframes(clip, property)) {
    return upsertVideoTransformKeyframe(
      clip,
      property,
      timelineTime,
      nextValue,
    );
  }

  return { ...clip, [property]: nextValue };
}

function ensureBoundaryKeyframe(
  clip: VideoTimelineClip,
  property: VideoTransformKeyframeProperty,
  originalLocalTime: number,
  nextLocalTime: number,
  result: VideoTransformKeyframe[],
) {
  if (!hasVideoTransformKeyframes(clip, property)) return;
  if (
    result.some(
      (keyframe) => Math.abs(keyframe.time - nextLocalTime) <= EPSILON,
    )
  )
    return;
  result.push({
    time: nextLocalTime,
    value: evaluateVideoTransformPropertyAtLocalTime(
      clip,
      property,
      originalLocalTime,
    ),
  });
}

/**
 * Slices transform animation to a retained timeline segment of the original
 * clip and re-bases keyframe times to the new clip's local zero.
 */
export function sliceVideoTransformKeyframes(
  clip: VideoTimelineClip,
  retainedTimelineStart: number,
  retainedTimelineEnd: number,
): VideoTransformKeyframes | undefined {
  const originalDuration = Math.max(0, clip.timelineEnd - clip.timelineStart);
  const startOffset = Math.max(
    0,
    Math.min(originalDuration, retainedTimelineStart - clip.timelineStart),
  );
  const endOffset = Math.max(
    startOffset,
    Math.min(originalDuration, retainedTimelineEnd - clip.timelineStart),
  );
  const nextDuration = Math.max(0, endOffset - startOffset);
  const result: VideoTransformKeyframes = {};
  let hasAny = false;

  for (const property of VIDEO_TRANSFORM_KEYFRAME_PROPERTIES) {
    if (!hasVideoTransformKeyframes(clip, property)) continue;
    const channel = videoTransformChannel(clip, property);
    const next: VideoTransformKeyframe[] = channel
      .filter(
        (keyframe) =>
          keyframe.time >= startOffset - EPSILON &&
          keyframe.time <= endOffset + EPSILON,
      )
      .map((keyframe) => ({
        time: Math.max(0, Math.min(nextDuration, keyframe.time - startOffset)),
        value: keyframe.value,
      }));

    ensureBoundaryKeyframe(clip, property, startOffset, 0, next);
    ensureBoundaryKeyframe(clip, property, endOffset, nextDuration, next);
    next.sort((a, b) => a.time - b.time);

    // De-duplicate keys injected at exact existing boundaries.
    const deduped: VideoTransformKeyframe[] = [];
    for (const keyframe of next) {
      const previous = deduped[deduped.length - 1];
      if (previous && Math.abs(previous.time - keyframe.time) <= EPSILON) {
        previous.value = keyframe.value;
      } else {
        deduped.push({ ...keyframe });
      }
    }

    if (deduped.length > 0) {
      result[property] = deduped;
      hasAny = true;
    }
  }

  return hasAny ? result : undefined;
}

export function mergeVideoTransformKeyframes(
  left: VideoTimelineClip,
  right: VideoTimelineClip,
): VideoTransformKeyframes | undefined {
  const leftDuration = Math.max(0, left.timelineEnd - left.timelineStart);
  const result: VideoTransformKeyframes = {};
  let hasAny = false;

  for (const property of VIDEO_TRANSFORM_KEYFRAME_PROPERTIES) {
    const leftChannel = videoTransformChannel(left, property);
    const rightChannel = videoTransformChannel(right, property).map(
      (keyframe) => ({
        time: keyframe.time + leftDuration,
        value: keyframe.value,
      }),
    );
    const combined = [...leftChannel, ...rightChannel].sort(
      (a, b) => a.time - b.time,
    );
    const deduped: VideoTransformKeyframe[] = [];
    for (const keyframe of combined) {
      const previous = deduped[deduped.length - 1];
      if (previous && Math.abs(previous.time - keyframe.time) <= EPSILON) {
        // Both fragments carry the same sampled split value. Prefer the right
        // side when tiny floating-point differences exist.
        previous.value = keyframe.value;
      } else {
        deduped.push({ ...keyframe });
      }
    }
    if (deduped.length > 0) {
      result[property] = deduped;
      hasAny = true;
    }
  }

  return hasAny ? result : undefined;
}

export function allVideoTransformKeyframeTimes(clip: VideoTimelineClip) {
  const times = new Set<number>();
  for (const property of VIDEO_TRANSFORM_KEYFRAME_PROPERTIES) {
    for (const keyframe of videoTransformChannel(clip, property)) {
      times.add(keyframe.time);
    }
  }
  return [...times].sort((a, b) => a - b);
}

/**
 * Scales clip-local transform keyframe times when the clip is retimed so each
 * keyframe stays attached to the same relative source-media position.
 */
export function retimeVideoTransformKeyframes(
  keyframes: VideoTransformKeyframes | undefined,
  oldDuration: number,
  newDuration: number,
): VideoTransformKeyframes | undefined {
  if (!keyframes) return undefined;
  if (oldDuration <= EPSILON || newDuration <= EPSILON) {
    return normalizeVideoTransformKeyframes(
      keyframes,
      Math.max(0, newDuration),
    );
  }

  const ratio = newDuration / oldDuration;
  const scaled: VideoTransformKeyframes = {};

  for (const property of VIDEO_TRANSFORM_KEYFRAME_PROPERTIES) {
    const channel = keyframes[property];
    if (!channel?.length) continue;
    scaled[property] = channel.map((keyframe) => ({
      time: keyframe.time * ratio,
      value: keyframe.value,
    }));
  }

  return normalizeVideoTransformKeyframes(scaled, newDuration);
}
