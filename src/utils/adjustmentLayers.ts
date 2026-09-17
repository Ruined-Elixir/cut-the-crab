import type { AdjustmentLayerClip, TimelineTrackSettings } from "../types/timelineModel";

export const DEFAULT_ADJUSTMENT_LAYER_DURATION = 5;
export const MIN_ADJUSTMENT_LAYER_DURATION = 0.1;

export const DEFAULT_ADJUSTMENT_LAYER_VALUES = {
  opacity: 100,
  exposure: 0,
  contrast: 0,
  saturation: 100,
  temperature: 0,
} as const;

export function clampAdjustmentOpacity(value: number) {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 100));
}

export function clampAdjustmentExposure(value: number) {
  return Math.max(-3, Math.min(3, Number.isFinite(value) ? value : 0));
}

export function clampAdjustmentContrast(value: number) {
  return Math.max(-100, Math.min(100, Number.isFinite(value) ? value : 0));
}

export function clampAdjustmentSaturation(value: number) {
  return Math.max(0, Math.min(200, Number.isFinite(value) ? value : 100));
}

export function clampAdjustmentTemperature(value: number) {
  return Math.max(-100, Math.min(100, Number.isFinite(value) ? value : 0));
}

export function normalizedAdjustmentLayer(
  layer: AdjustmentLayerClip,
): AdjustmentLayerClip {
  return {
    ...layer,
    opacity: clampAdjustmentOpacity(layer.opacity),
    exposure: clampAdjustmentExposure(layer.exposure),
    contrast: clampAdjustmentContrast(layer.contrast),
    saturation: clampAdjustmentSaturation(layer.saturation),
    temperature: clampAdjustmentTemperature(layer.temperature),
  };
}

export function adjustmentLayerStrength(layer: AdjustmentLayerClip) {
  return clampAdjustmentOpacity(layer.opacity) / 100;
}

export function adjustmentLayerIsActive(
  layer: AdjustmentLayerClip,
  timelineTime: number,
  trackSettings?: TimelineTrackSettings,
) {
  return (
    timelineTime >= layer.timelineStart &&
    timelineTime < layer.timelineEnd &&
    trackSettings?.[layer.trackId]?.deleted !== true &&
    trackSettings?.[layer.trackId]?.hidden !== true &&
    adjustmentLayerStrength(layer) > 0.0001
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
  temperature: number;
};

export function adjustmentFilterParameters(
  layers: AdjustmentLayerClip[],
): AdjustmentFilterParameters {
  let brightness = 1;
  let contrast = 1;
  let saturation = 1;
  let temperature = 0;

  for (const layer of layers) {
    const strength = adjustmentLayerStrength(layer);
    brightness *= Math.max(0.05, 1 + clampAdjustmentExposure(layer.exposure) * 0.12 * strength);
    contrast *= Math.max(0.05, 1 + (clampAdjustmentContrast(layer.contrast) / 100) * 0.75 * strength);
    saturation *= Math.max(
      0,
      1 + (clampAdjustmentSaturation(layer.saturation) / 100 - 1) * strength,
    );
    temperature += (clampAdjustmentTemperature(layer.temperature) / 100) * strength;
  }

  return {
    brightness,
    contrast,
    saturation,
    temperature: Math.max(-1, Math.min(1, temperature)),
  };
}

export function adjustmentCssFilter(
  layers: AdjustmentLayerClip[],
) {
  if (layers.length === 0) return "";

  const parameters = adjustmentFilterParameters(layers);
  const temperatureAmount = Math.abs(parameters.temperature);
  const temperatureFilter = temperatureAmount < 0.001
    ? ""
    : parameters.temperature > 0
      ? ` sepia(${(temperatureAmount * 0.28).toFixed(4)}) hue-rotate(-12deg) saturate(${(1 + temperatureAmount * 0.18).toFixed(4)})`
      : ` sepia(${(temperatureAmount * 0.22).toFixed(4)}) hue-rotate(168deg) saturate(${(1 + temperatureAmount * 0.12).toFixed(4)})`;

  return `brightness(${parameters.brightness.toFixed(4)}) contrast(${parameters.contrast.toFixed(4)}) saturate(${parameters.saturation.toFixed(4)})${temperatureFilter}`.trim();
}
