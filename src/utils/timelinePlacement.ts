import type { AdjustmentLayerClip, AudioTimelineClip, TimelineTrackId, TimelineTrackSettings, VideoTimelineClip } from "../types/timelineModel";
import { DEFAULT_TIMELINE_TRACK_SETTINGS } from "../types/timelineModel";
import { nextTimelineTrackId, timelineTrackIndexFromId } from "./timelineModel";
import { snapTimelineTimeToFrame, TIMELINE_FPS } from "./timelineFrames";
import { effectiveVideoLayer, effectiveAdjustmentLayer, defaultLayerForTrack } from "./videoLayers";

export type PlacementInput = {
  videoClips: VideoTimelineClip[];
  audioClips: AudioTimelineClip[];
  adjustmentLayers: AdjustmentLayerClip[];
  trackSettings: TimelineTrackSettings;
  items: Array<{ key: string; sourceTrackId: TimelineTrackId; start: number; duration: number }>;
  preferredTrackId?: TimelineTrackId;
};
export type PlacementPlan = {
  assignments: Array<{ key: string; trackId: TimelineTrackId; start: number; end: number; layer?: number }>;
  newTracks: Array<{ videoTrackId: TimelineTrackId; audioTrackId: TimelineTrackId }>;
};

// Comparing integer frame boundaries avoids floating-point edge collisions.
export function snapPlacementRange(start: number, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Invalid clip duration");
  const snappedStart = snapTimelineTimeToFrame(start);
  const startFrame = Math.round(snappedStart * TIMELINE_FPS);
  const frameCount = Math.max(1, Math.round(duration * TIMELINE_FPS));
  return { start: startFrame / TIMELINE_FPS, end: (startFrame + frameCount) / TIMELINE_FPS };
}
const overlaps = (a: number, b: number, c: number, d: number) => Math.round(a * TIMELINE_FPS) < Math.round(d * TIMELINE_FPS) && Math.round(c * TIMELINE_FPS) < Math.round(b * TIMELINE_FPS);
export function isVideoRangeFree(videoClips: VideoTimelineClip[], adjustmentLayers: AdjustmentLayerClip[], trackId: TimelineTrackId, start: number, end: number) {
  return !videoClips.some(c => c.trackId === trackId && overlaps(start, end, c.timelineStart, c.timelineEnd))
    && !adjustmentLayers.some(c => c.trackId === trackId && overlaps(start, end, c.timelineStart, c.timelineEnd));
}
export function planVideoPlacement(input: PlacementInput): PlacementPlan {
  const settings: TimelineTrackSettings = { ...DEFAULT_TIMELINE_TRACK_SETTINGS, ...input.trackSettings };
  const reserved: Array<{ trackId: string; timelineStart: number; timelineEnd: number }> = [];
  const newTracks: PlacementPlan["newTracks"] = [];
  const assignments: PlacementPlan["assignments"] = [];
  const usable = (id: string) => {
    const s = settings[id];
    const audio = s?.linkedTrackId;
    return /^video-\d+$/.test(id) && !!s && !s.locked && !s.hidden && !s.deleted && !!audio && /^audio-\d+$/.test(audio) && !settings[audio]?.deleted;
  };
  const trackIds = () => [...new Set([...Object.keys(settings), ...input.videoClips.map(c => c.trackId)])].filter(usable).sort((a,b) => timelineTrackIndexFromId(a) - timelineTrackIndexFromId(b));
  const maxLayer = Math.max(0, ...input.videoClips.map(effectiveVideoLayer), ...input.adjustmentLayers.map(effectiveAdjustmentLayer));
  // Allocate an entire source-track group together, even when its cues have gaps.
  const groups = new Map<string, typeof input.items>();
  for (const item of input.items) {
    const group = groups.get(item.sourceTrackId) ?? [];
    group.push(item);
    groups.set(item.sourceTrackId, group);
  }
  const singleSourceTrack = groups.size === 1;
  for (const [sourceTrackId, items] of groups) {
    const ranges = items.map(item => ({ item, range: snapPlacementRange(item.start, item.duration) }));
    const available = (id: string) => ranges.every(({range}, i) =>
      isVideoRangeFree(input.videoClips, input.adjustmentLayers, id, range.start, range.end) &&
      !reserved.some(c => c.trackId === id && overlaps(range.start, range.end, c.timelineStart, c.timelineEnd)) &&
      !ranges.slice(0, i).some(({range: other}) => overlaps(range.start, range.end, other.start, other.end))
    );
    const preferred = singleSourceTrack ? (input.preferredTrackId ?? sourceTrackId) : sourceTrackId;
    let target = [preferred, ...trackIds()].filter((id, idx, arr) => arr.indexOf(id) === idx)
      .find(id => usable(id) && available(id));
    let newLayer: number | undefined;
    if (!target) {
      target = nextTimelineTrackId("video", settings, input.videoClips, input.audioClips);
      const audioId = nextTimelineTrackId("audio", settings, input.videoClips, input.audioClips);
      settings[target] = { locked: false, hidden: false, linkedTrackId: audioId };
      settings[audioId] = { locked: true, linkedTrackId: target };
      newTracks.push({ videoTrackId: target, audioTrackId: audioId });
      newLayer = Math.max(maxLayer + newTracks.length, defaultLayerForTrack(target));
    }
    for (const {item, range} of ranges) {
      // An existing target track uses its layer defaults; never preserve source-layer overrides.
      assignments.push({ key: item.key, trackId: target, start: range.start, end: range.end,
        ...(newLayer === undefined ? {} : {layer: newLayer}) });
      reserved.push({trackId: target, timelineStart: range.start, timelineEnd: range.end});
    }
  }
  return { assignments, newTracks };
}
export function findPlanConflicts(input: PlacementInput, plan: PlacementPlan): string[] {
  const conflicts: string[] = [];
  const occupied = [...input.videoClips, ...input.adjustmentLayers].map(c => ({ trackId: c.trackId, start: c.timelineStart, end: c.timelineEnd }));
  for (const a of plan.assignments) {
    if (occupied.some(c => c.trackId === a.trackId && overlaps(a.start,a.end,c.start,c.end))) conflicts.push(a.key);
    occupied.push({ trackId: a.trackId, start: a.start, end: a.end });
  }
  return conflicts;
}
