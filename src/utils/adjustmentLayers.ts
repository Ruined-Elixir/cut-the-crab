import type {
  AdjustmentLayerClip,
  AdjustmentLayerKeyframe,
  AdjustmentLayerKeyframes,
  AdjustmentLayerProperty,
  TimelineTrackSettings,
} from "../types/timelineModel";

export const DEFAULT_ADJUSTMENT_LAYER_DURATION = 5;
export const MIN_ADJUSTMENT_LAYER_DURATION = 0.1;
export const ADJUSTMENT_KEYFRAME_EPSILON = 1 / 60;

export const ADJUSTMENT_LAYER_PROPERTIES: AdjustmentLayerProperty[] = [
  "opacity",
  "exposure",
  "contrast",
  "saturation",
  "temperature",
  "tint",
  "highlights",
  "shadows",
  "whites",
  "blacks",
];

export const DEFAULT_ADJUSTMENT_LAYER_VALUES = {
  enabled: true,
  opacity: 100,
  exposure: 0,
  contrast: 0,
  saturation: 100,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
} as const;

function finite(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

export function clampAdjustmentOpacity(value: number) {
  return Math.max(0, Math.min(100, finite(value, 100)));
}

export function clampAdjustmentExposure(value: number) {
  return Math.max(-3, Math.min(3, finite(value, 0)));
}

export function clampAdjustmentContrast(value: number) {
  return Math.max(-100, Math.min(100, finite(value, 0)));
}

export function clampAdjustmentSaturation(value: number) {
  return Math.max(0, Math.min(200, finite(value, 100)));
}

export function clampAdjustmentTemperature(value: number) {
  return Math.max(-100, Math.min(100, finite(value, 0)));
}

export function clampAdjustmentTint(value: number) {
  return Math.max(-100, Math.min(100, finite(value, 0)));
}

export function clampAdjustmentTone(value: number) {
  return Math.max(-100, Math.min(100, finite(value, 0)));
}

export function clampAdjustmentProperty(
  property: AdjustmentLayerProperty,
  value: number,
) {
  switch (property) {
    case "opacity":
      return clampAdjustmentOpacity(value);
    case "exposure":
      return clampAdjustmentExposure(value);
    case "contrast":
      return clampAdjustmentContrast(value);
    case "saturation":
      return clampAdjustmentSaturation(value);
    case "temperature":
      return clampAdjustmentTemperature(value);
    case "tint":
      return clampAdjustmentTint(value);
    case "highlights":
    case "shadows":
    case "whites":
    case "blacks":
      return clampAdjustmentTone(value);
  }
}

export function adjustmentLayerDuration(layer: AdjustmentLayerClip) {
  return Math.max(
    MIN_ADJUSTMENT_LAYER_DURATION,
    layer.timelineEnd - layer.timelineStart,
  );
}

export function adjustmentLayerPropertyBaseValue(
  layer: AdjustmentLayerClip,
  property: AdjustmentLayerProperty,
) {
  return clampAdjustmentProperty(property, layer[property]);
}

export function normalizeAdjustmentKeyframes(
  keyframes: AdjustmentLayerKeyframes | undefined,
  duration: number,
): AdjustmentLayerKeyframes | undefined {
  if (!keyframes) return undefined;
  const safeDuration = Math.max(MIN_ADJUSTMENT_LAYER_DURATION, duration);
  const normalized: AdjustmentLayerKeyframes = {};

  for (const property of ADJUSTMENT_LAYER_PROPERTIES) {
    const channel = keyframes[property];
    if (!Array.isArray(channel) || channel.length === 0) continue;

    const sorted = channel
      .filter(
        (key): key is AdjustmentLayerKeyframe =>
          !!key && Number.isFinite(key.time) && Number.isFinite(key.value),
      )
      .map((key) => ({
        time: Math.max(0, Math.min(safeDuration, key.time)),
        value: clampAdjustmentProperty(property, key.value),
      }))
      .sort((a, b) => a.time - b.time);

    const deduped: AdjustmentLayerKeyframe[] = [];
    for (const key of sorted) {
      const previous = deduped[deduped.length - 1];
      if (previous && Math.abs(previous.time - key.time) <= ADJUSTMENT_KEYFRAME_EPSILON) {
        deduped[deduped.length - 1] = key;
      } else {
        deduped.push(key);
      }
    }

    if (deduped.length > 0) normalized[property] = deduped;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizedAdjustmentLayer(
  layer: AdjustmentLayerClip,
): AdjustmentLayerClip {
  const duration = adjustmentLayerDuration(layer);
  return {
    ...layer,
    enabled: layer.enabled !== false,
    opacity: clampAdjustmentOpacity(layer.opacity),
    exposure: clampAdjustmentExposure(layer.exposure),
    contrast: clampAdjustmentContrast(layer.contrast),
    saturation: clampAdjustmentSaturation(layer.saturation),
    temperature: clampAdjustmentTemperature(layer.temperature),
    tint: clampAdjustmentTint(layer.tint),
    highlights: clampAdjustmentTone(layer.highlights),
    shadows: clampAdjustmentTone(layer.shadows),
    whites: clampAdjustmentTone(layer.whites),
    blacks: clampAdjustmentTone(layer.blacks),
    keyframes: normalizeAdjustmentKeyframes(layer.keyframes, duration),
  };
}

export function adjustmentLayerChannel(
  layer: AdjustmentLayerClip,
  property: AdjustmentLayerProperty,
) {
  return layer.keyframes?.[property] ?? [];
}

export function hasAdjustmentLayerKeyframes(
  layer: AdjustmentLayerClip,
  property?: AdjustmentLayerProperty,
) {
  if (property) return adjustmentLayerChannel(layer, property).length > 0;
  return ADJUSTMENT_LAYER_PROPERTIES.some(
    (candidate) => adjustmentLayerChannel(layer, candidate).length > 0,
  );
}

function evaluateChannel(
  channel: AdjustmentLayerKeyframe[],
  relativeTime: number,
  fallback: number,
) {
  if (channel.length === 0) return fallback;
  if (channel.length === 1 || relativeTime <= channel[0].time) return channel[0].value;

  const last = channel[channel.length - 1];
  if (relativeTime >= last.time) return last.value;

  for (let index = 0; index < channel.length - 1; index += 1) {
    const left = channel[index];
    const right = channel[index + 1];
    if (relativeTime > right.time) continue;
    const span = Math.max(0.000001, right.time - left.time);
    const progress = Math.max(0, Math.min(1, (relativeTime - left.time) / span));
    return left.value + (right.value - left.value) * progress;
  }

  return last.value;
}

export function evaluateAdjustmentLayerProperty(
  layer: AdjustmentLayerClip,
  property: AdjustmentLayerProperty,
  timelineTime: number,
) {
  const base = adjustmentLayerPropertyBaseValue(layer, property);
  const channel = adjustmentLayerChannel(layer, property);
  if (channel.length === 0) return base;

  const relativeTime = Math.max(
    0,
    Math.min(adjustmentLayerDuration(layer), timelineTime - layer.timelineStart),
  );
  return clampAdjustmentProperty(
    property,
    evaluateChannel(channel, relativeTime, base),
  );
}

export type EvaluatedAdjustmentLayerValues = Record<AdjustmentLayerProperty, number>;

export function evaluatedAdjustmentLayerValues(
  layer: AdjustmentLayerClip,
  timelineTime: number,
): EvaluatedAdjustmentLayerValues {
  return Object.fromEntries(
    ADJUSTMENT_LAYER_PROPERTIES.map((property) => [
      property,
      evaluateAdjustmentLayerProperty(layer, property, timelineTime),
    ]),
  ) as EvaluatedAdjustmentLayerValues;
}

export function adjustmentKeyframeAtTime(
  layer: AdjustmentLayerClip,
  property: AdjustmentLayerProperty,
  timelineTime: number,
) {
  const relativeTime = timelineTime - layer.timelineStart;
  return adjustmentLayerChannel(layer, property).find(
    (key) => Math.abs(key.time - relativeTime) <= ADJUSTMENT_KEYFRAME_EPSILON,
  );
}

export function setAdjustmentPropertyKeyframe(
  layer: AdjustmentLayerClip,
  property: AdjustmentLayerProperty,
  timelineTime: number,
  value: number,
): AdjustmentLayerClip {
  const duration = adjustmentLayerDuration(layer);
  const relativeTime = Math.max(0, Math.min(duration, timelineTime - layer.timelineStart));
  const channel = [...adjustmentLayerChannel(layer, property)];
  const nextKey = {
    time: relativeTime,
    value: clampAdjustmentProperty(property, value),
  };
  const existingIndex = channel.findIndex(
    (key) => Math.abs(key.time - relativeTime) <= ADJUSTMENT_KEYFRAME_EPSILON,
  );

  if (existingIndex >= 0) channel[existingIndex] = nextKey;
  else channel.push(nextKey);

  channel.sort((a, b) => a.time - b.time);
  return normalizedAdjustmentLayer({
    ...layer,
    keyframes: {
      ...(layer.keyframes ?? {}),
      [property]: channel,
    },
  });
}

export function removeAdjustmentPropertyKeyframe(
  layer: AdjustmentLayerClip,
  property: AdjustmentLayerProperty,
  timelineTime: number,
): AdjustmentLayerClip {
  const relativeTime = timelineTime - layer.timelineStart;
  const channel = adjustmentLayerChannel(layer, property).filter(
    (key) => Math.abs(key.time - relativeTime) > ADJUSTMENT_KEYFRAME_EPSILON,
  );
  const nextKeyframes: AdjustmentLayerKeyframes = { ...(layer.keyframes ?? {}) };

  if (channel.length > 0) nextKeyframes[property] = channel;
  else delete nextKeyframes[property];

  return normalizedAdjustmentLayer({
    ...layer,
    keyframes: Object.keys(nextKeyframes).length > 0 ? nextKeyframes : undefined,
  });
}

export function allAdjustmentLayerKeyframeTimes(layer: AdjustmentLayerClip) {
  const times = new Set<number>();
  for (const property of ADJUSTMENT_LAYER_PROPERTIES) {
    for (const key of adjustmentLayerChannel(layer, property)) times.add(key.time);
  }
  return [...times].sort((a, b) => a - b);
}

export function adjustmentLayerKeyframeCountAtTime(
  layer: AdjustmentLayerClip,
  relativeTime: number,
) {
  let count = 0;
  for (const property of ADJUSTMENT_LAYER_PROPERTIES) {
    if (
      adjustmentLayerChannel(layer, property).some(
        (key) => Math.abs(key.time - relativeTime) <= ADJUSTMENT_KEYFRAME_EPSILON,
      )
    ) {
      count += 1;
    }
  }
  return count;
}

export function trimAdjustmentLayerKeyframes(
  layer: AdjustmentLayerClip,
  newTimelineStart: number,
  newTimelineEnd: number,
) {
  const nextDuration = Math.max(
    MIN_ADJUSTMENT_LAYER_DURATION,
    newTimelineEnd - newTimelineStart,
  );
  if (!layer.keyframes) return undefined;

  const shifted: AdjustmentLayerKeyframes = {};
  for (const property of ADJUSTMENT_LAYER_PROPERTIES) {
    const originalChannel = adjustmentLayerChannel(layer, property);
    if (originalChannel.length === 0) continue;

    const channel: AdjustmentLayerKeyframe[] = [
      {
        time: 0,
        value: evaluateAdjustmentLayerProperty(layer, property, newTimelineStart),
      },
      ...originalChannel
        .map((key) => ({
          absoluteTime: layer.timelineStart + key.time,
          value: key.value,
        }))
        .filter(
          (key) =>
            key.absoluteTime > newTimelineStart + ADJUSTMENT_KEYFRAME_EPSILON &&
            key.absoluteTime < newTimelineEnd - ADJUSTMENT_KEYFRAME_EPSILON,
        )
        .map((key) => ({
          time: key.absoluteTime - newTimelineStart,
          value: key.value,
        })),
      {
        time: nextDuration,
        value: evaluateAdjustmentLayerProperty(layer, property, newTimelineEnd),
      },
    ];

    shifted[property] = channel;
  }

  return normalizeAdjustmentKeyframes(shifted, nextDuration);
}

export function adjustmentLayerStrength(
  layer: AdjustmentLayerClip,
  timelineTime = layer.timelineStart,
) {
  if (layer.enabled === false) return 0;
  return evaluateAdjustmentLayerProperty(layer, "opacity", timelineTime) / 100;
}

export function adjustmentLayerIsActive(
  layer: AdjustmentLayerClip,
  timelineTime: number,
  trackSettings?: TimelineTrackSettings,
) {
  return (
    layer.enabled !== false &&
    timelineTime >= layer.timelineStart &&
    timelineTime < layer.timelineEnd &&
    trackSettings?.[layer.trackId]?.deleted !== true &&
    trackSettings?.[layer.trackId]?.hidden !== true &&
    adjustmentLayerStrength(layer, timelineTime) > 0.0001
  );
}

export function videoTrackIndex(trackId: string) {
  const match = /^video-(\d+)$/.exec(trackId);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

export function adjustmentLayersAffectingVideoTrack(
  layers: AdjustmentLayerClip[],
  timelineTime: number,
  videoTrackId: string,
  trackSettings?: TimelineTrackSettings,
) {
  const targetIndex = videoTrackIndex(videoTrackId);

  return layers
    .filter(
      (layer) =>
        adjustmentLayerIsActive(layer, timelineTime, trackSettings) &&
        videoTrackIndex(layer.trackId) > targetIndex,
    )
    .sort(
      (a, b) =>
        videoTrackIndex(a.trackId) - videoTrackIndex(b.trackId) ||
        a.timelineStart - b.timelineStart,
    );
}

export type AdjustmentFilterParameters = {
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
  gammaWeight: number;
  gammaR: number;
  gammaG: number;
  gammaB: number;
  temperature: number;
  tint: number;
};

export function adjustmentFilterParameters(
  layers: AdjustmentLayerClip[],
  timelineTime: number,
): AdjustmentFilterParameters {
  let brightness = 1;
  let contrast = 1;
  let saturation = 1;
  let gamma = 1;
  let gammaWeight = 1;
  let gammaR = 1;
  let gammaG = 1;
  let gammaB = 1;
  let temperature = 0;
  let tint = 0;

  for (const layer of layers) {
    if (layer.enabled === false) continue;
    const values = evaluatedAdjustmentLayerValues(layer, timelineTime);
    const strength = values.opacity / 100;
    if (strength <= 0.0001) continue;

    brightness *= Math.max(
      0.05,
      1 + values.exposure * 0.12 * strength + values.whites * 0.0016 * strength + values.blacks * 0.0009 * strength,
    );
    contrast *= Math.max(
      0.05,
      1 + (values.contrast / 100) * 0.75 * strength + values.whites * 0.0012 * strength - values.blacks * 0.0010 * strength,
    );
    saturation *= Math.max(
      0,
      1 + (values.saturation / 100 - 1) * strength,
    );

    const shadowAmount = (values.shadows / 100) * strength;
    const highlightAmount = (values.highlights / 100) * strength;
    gamma *= Math.max(0.4, 1 + shadowAmount * 0.5 - highlightAmount * 0.18);
    gammaWeight *= Math.max(0.1, Math.min(1, 1 - Math.max(0, shadowAmount) * 0.55));

    const tempAmount = (values.temperature / 100) * strength;
    const tintAmount = (values.tint / 100) * strength;
    gammaR *= Math.max(0.5, 1 + tempAmount * 0.14 + tintAmount * 0.07);
    gammaG *= Math.max(0.5, 1 - tintAmount * 0.12);
    gammaB *= Math.max(0.5, 1 - tempAmount * 0.14 + tintAmount * 0.07);
    temperature += tempAmount;
    tint += tintAmount;
  }

  return {
    brightness,
    contrast,
    saturation,
    gamma,
    gammaWeight,
    gammaR,
    gammaG,
    gammaB,
    temperature: Math.max(-1, Math.min(1, temperature)),
    tint: Math.max(-1, Math.min(1, tint)),
  };
}

export function adjustmentCssFilter(
  layers: AdjustmentLayerClip[],
  timelineTime: number,
) {
  if (layers.length === 0) return "";

  const parameters = adjustmentFilterParameters(layers, timelineTime);
  const temperatureAmount = Math.abs(parameters.temperature);
  const tintAmount = Math.abs(parameters.tint);
  const temperatureFilter = temperatureAmount < 0.001
    ? ""
    : parameters.temperature > 0
      ? ` sepia(${(temperatureAmount * 0.28).toFixed(4)}) hue-rotate(-12deg) saturate(${(1 + temperatureAmount * 0.18).toFixed(4)})`
      : ` sepia(${(temperatureAmount * 0.22).toFixed(4)}) hue-rotate(168deg) saturate(${(1 + temperatureAmount * 0.12).toFixed(4)})`;
  const tintFilter = tintAmount < 0.001
    ? ""
    : parameters.tint > 0
      ? ` sepia(${(tintAmount * 0.12).toFixed(4)}) hue-rotate(286deg) saturate(${(1 + tintAmount * 0.08).toFixed(4)})`
      : ` sepia(${(tintAmount * 0.10).toFixed(4)}) hue-rotate(74deg) saturate(${(1 + tintAmount * 0.06).toFixed(4)})`;

  // CSS has no direct shadows/highlights/white/black controls. Their tonal
  // contribution is folded into brightness/contrast above; FFmpeg export uses
  // gamma channels as well for a closer match.
  return `brightness(${parameters.brightness.toFixed(4)}) contrast(${parameters.contrast.toFixed(4)}) saturate(${parameters.saturation.toFixed(4)})${temperatureFilter}${tintFilter}`.trim();
}
