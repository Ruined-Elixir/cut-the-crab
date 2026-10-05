import type {
  AdjustmentLayerClip,
  TimelineTrackId,
  VideoTimelineClip,
} from "../types/timelineModel";

export const VIDEO_LAYER_STRIDE = 1024;

export type ProgramStackItem =
  | { kind: "video"; id: string; layer: number; timelineStart: number }
  | { kind: "adjustment"; id: string; layer: number; timelineStart: number };

export function videoTrackIndexFromLayerTrack(trackId: string) {
  const match = /^video-(\d+)$/.exec(trackId);
  return match ? Number(match[1]) : 1;
}

export function defaultLayerForTrack(trackId: TimelineTrackId) {
  return videoTrackIndexFromLayerTrack(trackId) * VIDEO_LAYER_STRIDE;
}

export function effectiveVideoLayer(clip: VideoTimelineClip) {
  return Number.isFinite(clip.layer)
    ? (clip.layer as number)
    : defaultLayerForTrack(clip.trackId);
}

export function effectiveAdjustmentLayer(layer: AdjustmentLayerClip) {
  return Number.isFinite(layer.layer)
    ? (layer.layer as number)
    : defaultLayerForTrack(layer.trackId);
}

export function compareVideoStack(a: VideoTimelineClip, b: VideoTimelineClip) {
  return (
    effectiveVideoLayer(a) - effectiveVideoLayer(b) ||
    a.timelineStart - b.timelineStart ||
    a.id.localeCompare(b.id)
  );
}

export function compareAdjustmentStack(
  a: AdjustmentLayerClip,
  b: AdjustmentLayerClip,
) {
  return (
    effectiveAdjustmentLayer(a) - effectiveAdjustmentLayer(b) ||
    a.timelineStart - b.timelineStart ||
    a.id.localeCompare(b.id)
  );
}

export function compareMixedStackItems(a: ProgramStackItem, b: ProgramStackItem) {
  return (
    a.layer - b.layer ||
    (a.kind === b.kind ? 0 : a.kind === "adjustment" ? -1 : 1) ||
    a.timelineStart - b.timelineStart ||
    a.id.localeCompare(b.id)
  );
}

export function buildProgramStackItems(
  videoClips: VideoTimelineClip[],
  adjustmentLayers: AdjustmentLayerClip[],
): ProgramStackItem[] {
  return [
    ...videoClips.map((clip) => ({
      kind: "video" as const,
      id: clip.id,
      layer: effectiveVideoLayer(clip),
      timelineStart: clip.timelineStart,
    })),
    ...adjustmentLayers.map((layer) => ({
      kind: "adjustment" as const,
      id: layer.id,
      layer: effectiveAdjustmentLayer(layer),
      timelineStart: layer.timelineStart,
    })),
  ].sort(compareMixedStackItems);
}

export function programStackRankMap(
  videoClips: VideoTimelineClip[],
  adjustmentLayers: AdjustmentLayerClip[],
) {
  const result = new Map<string, number>();
  buildProgramStackItems(videoClips, adjustmentLayers).forEach((item, index) => {
    result.set(`${item.kind}:${item.id}`, (index + 1) * 10);
  });
  return result;
}

export function normalizedProgramLayersForVideoOrder(
  allVideoClips: VideoTimelineClip[],
  allAdjustmentLayers: AdjustmentLayerClip[],
  visibleVideoIdsTopToBottom: string[],
) {
  const visibleSet = new Set(visibleVideoIdsTopToBottom);
  const existing = buildProgramStackItems(allVideoClips, allAdjustmentLayers);
  const visibleSlots = existing
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.kind === "video" && visibleSet.has(item.id))
    .map(({ index }) => index);

  if (visibleSlots.length !== visibleVideoIdsTopToBottom.length) return null;

  const requestedBottomToTop = [...visibleVideoIdsTopToBottom].reverse();
  const reordered = [...existing];

  visibleSlots.forEach((slotIndex, index) => {
    const requestedId = requestedBottomToTop[index];
    const existingItem = existing.find(
      (item) => item.kind === "video" && item.id === requestedId,
    );
    if (existingItem) reordered[slotIndex] = existingItem;
  });

  const videoLayers = new Map<string, number>();
  const adjustmentLayers = new Map<string, number>();
  reordered.forEach((item, index) => {
    const value = (index + 1) * VIDEO_LAYER_STRIDE;
    if (item.kind === "video") videoLayers.set(item.id, value);
    else adjustmentLayers.set(item.id, value);
  });
  return { videoLayers, adjustmentLayers };
}

export function displayLayerNumber(layer: number) {
  return Math.max(1, Math.round(layer / VIDEO_LAYER_STRIDE));
}
