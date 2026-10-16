import type {
  AdjustmentLayerClip,
  AudioTimelineClip,
  TimelineTrackId,
  TimelineTrackSettings,
  VideoTimelineClip,
} from "../types/timelineModel";
import {
  TIMELINE_FPS,
  TIMELINE_FRAME_DURATION,
  snapTimelineTimeToFrame,
} from "./timelineFrames";
import {
  defaultTrackControlState,
  nextTimelineTrackId,
  timelineTrackIndexFromId,
  timelineTrackKindFromId,
} from "./timelineModel";
import {
  VIDEO_LAYER_STRIDE,
  effectiveAdjustmentLayer,
  effectiveVideoLayer,
} from "./videoLayers";

/*
 * Pure placement planner for video clips (no React, no side effects).
 *
 * Rules (ripple mode does NOT use this module):
 *  1. A clip keeps its exact requested start time (snapped to the frame grid).
 *  2. It goes on the preferred track if the whole range is free, otherwise on
 *     the first other usable video track with room (lowest track index first).
 *  3. If no track has room, a new video track + linked audio track pair is
 *     planned, and its clips get a layer above everything else in the stack.
 *
 * Collision checks compare integer frame positions. Touching edges are fine.
 */

export type PlacementItem = {
  /** Caller-defined identifier, returned unchanged on the assignment. */
  key: string;
  /** Track the clip came from (or was dropped on). Items sharing a source
   *  track are kept together on one target track. */
  sourceTrackId: TimelineTrackId;
  /** Requested start in seconds. */
  start: number;
  /** Clip length in seconds. */
  duration: number;
};

export type PlacementInput = {
  videoClips: VideoTimelineClip[];
  audioClips: AudioTimelineClip[];
  adjustmentLayers: AdjustmentLayerClip[];
  trackSettings: TimelineTrackSettings;
  items: PlacementItem[];
  /** Used only when all items share one source track. */
  preferredTrackId?: TimelineTrackId;
  /** Skip video tracks without a linked audio track (their clips would be
   *  silent). Default true. */
  requireLinkedAudio?: boolean;
};

export type PlacementAssignment = {
  key: string;
  trackId: TimelineTrackId;
  start: number;
  end: number;
  /** Explicit stack layer to store on the clip, when one should be set. */
  layer?: number;
  onNewTrack: boolean;
};

export type NewTrackPlan = {
  videoTrackId: TimelineTrackId;
  audioTrackId: TimelineTrackId;
  layer: number;
};

export type PlacementPlan = {
  assignments: PlacementAssignment[];
  newTracks: NewTrackPlan[];
};

type FrameRange = { start: number; end: number };

export function frameOf(seconds: number) {
  return Math.round(seconds * TIMELINE_FPS);
}

/** Snap a requested range to the same grid the editor stores clips on. */
export function snapPlacementRange(start: number, duration: number) {
  const snappedStart = Math.max(0, snapTimelineTimeToFrame(start));
  const snappedEnd = Math.max(
    snapTimelineTimeToFrame(snappedStart + Math.max(0, duration)),
    snappedStart + TIMELINE_FRAME_DURATION,
  );
  return { start: snappedStart, end: snappedEnd };
}

function toFrameRange(start: number, end: number): FrameRange {
  const first = frameOf(start);
  return { start: first, end: Math.max(first + 1, frameOf(end)) };
}

function rangesOverlap(a: FrameRange, b: FrameRange) {
  return a.start < b.end && b.start < a.end;
}

/** True when [start, end) is free of video clips and adjustment layers. */
export function isVideoRangeFree(
  videoClips: VideoTimelineClip[],
  adjustmentLayers: AdjustmentLayerClip[],
  trackId: TimelineTrackId,
  start: number,
  end: number,
  excludedClipId?: string,
) {
  const range = toFrameRange(start, end);

  for (const clip of videoClips) {
    if (clip.trackId !== trackId || clip.id === excludedClipId) continue;
    if (rangesOverlap(range, toFrameRange(clip.timelineStart, clip.timelineEnd))) {
      return false;
    }
  }

  for (const layer of adjustmentLayers) {
    if (layer.trackId !== trackId) continue;
    if (rangesOverlap(range, toFrameRange(layer.timelineStart, layer.timelineEnd))) {
      return false;
    }
  }

  return true;
}

function isEligibleVideoTrack(
  trackId: string,
  settings: TimelineTrackSettings,
  requireLinkedAudio: boolean,
) {
  if (timelineTrackKindFromId(trackId) !== "video") return false;
  const state = settings[trackId];
  if (state?.deleted === true || state?.locked === true || state?.hidden === true) {
    return false;
  }
  if (requireLinkedAudio && !state?.linkedTrackId) return false;
  return true;
}

function collectVideoTrackIds(
  settings: TimelineTrackSettings,
  videoClips: VideoTimelineClip[],
) {
  const ids = new Set<string>();

  for (const id of Object.keys(settings)) {
    if (timelineTrackKindFromId(id) === "video" && settings[id]?.deleted !== true) {
      ids.add(id);
    }
  }
  for (const clip of videoClips) {
    if (settings[clip.trackId]?.deleted !== true) ids.add(clip.trackId);
  }

  return [...ids].sort(
    (a, b) => timelineTrackIndexFromId(a) - timelineTrackIndexFromId(b),
  );
}

function topStackLayer(
  videoClips: VideoTimelineClip[],
  adjustmentLayers: AdjustmentLayerClip[],
) {
  let top = 0;
  for (const clip of videoClips) top = Math.max(top, effectiveVideoLayer(clip));
  for (const layer of adjustmentLayers) {
    top = Math.max(top, effectiveAdjustmentLayer(layer));
  }
  return top;
}

/** Explicit layer of the nearest clip on the track, if it has one. */
function inheritedLayer(
  videoClips: VideoTimelineClip[],
  trackId: TimelineTrackId,
  start: number,
): number | undefined {
  let bestLayer: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const clip of videoClips) {
    if (clip.trackId !== trackId || !Number.isFinite(clip.layer)) continue;
    const distance = Math.abs(clip.timelineStart - start);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestLayer = clip.layer as number;
    }
  }

  return bestLayer;
}

export function planVideoPlacement(input: PlacementInput): PlacementPlan {
  const requireLinkedAudio = input.requireLinkedAudio ?? true;

  const snapped = input.items.map((item) => ({
    ...item,
    ...snapPlacementRange(item.start, item.duration),
  }));

  const groups = new Map<string, typeof snapped>();
  for (const item of snapped) {
    const list = groups.get(item.sourceTrackId);
    if (list) list.push(item);
    else groups.set(item.sourceTrackId, [item]);
  }
  const orderedGroups = [...groups.entries()].sort(
    ([a], [b]) => timelineTrackIndexFromId(a) - timelineTrackIndexFromId(b),
  );

  const eligible = collectVideoTrackIds(
    input.trackSettings,
    input.videoClips,
  ).filter((id) => isEligibleVideoTrack(id, input.trackSettings, requireLinkedAudio));

  const used = new Set<string>();
  const assignments: PlacementAssignment[] = [];
  const newTracks: NewTrackPlan[] = [];
  let workingSettings: TimelineTrackSettings = { ...input.trackSettings };
  let topLayer = topStackLayer(input.videoClips, input.adjustmentLayers);

  for (const [sourceTrackId, items] of orderedGroups) {
    const preferred =
      orderedGroups.length === 1
        ? (input.preferredTrackId ?? sourceTrackId)
        : sourceTrackId;

    const candidates = [preferred, ...eligible.filter((id) => id !== preferred)].filter(
      (id) => eligible.includes(id) && !used.has(id),
    );

    const target = candidates.find((id) =>
      items.every((item) =>
        isVideoRangeFree(
          input.videoClips,
          input.adjustmentLayers,
          id,
          item.start,
          item.end,
        ),
      ),
    );

    if (target) {
      used.add(target);
      for (const item of items) {
        assignments.push({
          key: item.key,
          trackId: target,
          start: item.start,
          end: item.end,
          layer: inheritedLayer(input.videoClips, target, item.start),
          onNewTrack: false,
        });
      }
      continue;
    }

    const videoTrackId = nextTimelineTrackId(
      "video",
      workingSettings,
      input.videoClips,
      input.audioClips,
    );
    workingSettings = {
      ...workingSettings,
      [videoTrackId]: { ...defaultTrackControlState("video"), deleted: false },
    };
    const audioTrackId = nextTimelineTrackId(
      "audio",
      workingSettings,
      input.videoClips,
      input.audioClips,
    );
    workingSettings = {
      ...workingSettings,
      [audioTrackId]: { ...defaultTrackControlState("audio"), deleted: false },
    };

    topLayer += VIDEO_LAYER_STRIDE;
    used.add(videoTrackId);
    newTracks.push({ videoTrackId, audioTrackId, layer: topLayer });

    for (const item of items) {
      assignments.push({
        key: item.key,
        trackId: videoTrackId,
        start: item.start,
        end: item.end,
        layer: topLayer,
        onNewTrack: true,
      });
    }
  }

  const order = new Map(input.items.map((item, index) => [item.key, index]));
  assignments.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));

  return { assignments, newTracks };
}

/**
 * Re-check a plan against (possibly newer) state. Returns the keys of
 * assignments that would now collide. An empty array means safe to commit.
 */
export function findPlanConflicts(
  input: PlacementInput,
  plan: PlacementPlan,
): string[] {
  const conflicts = new Set<string>();
  const activeIds = new Set(
    collectVideoTrackIds(input.trackSettings, input.videoClips),
  );

  for (const assignment of plan.assignments) {
    if (assignment.onNewTrack) {
      if (activeIds.has(assignment.trackId)) conflicts.add(assignment.key);
    } else if (
      !isVideoRangeFree(
        input.videoClips,
        input.adjustmentLayers,
        assignment.trackId,
        assignment.start,
        assignment.end,
      )
    ) {
      conflicts.add(assignment.key);
    }
  }

  for (let i = 0; i < plan.assignments.length; i += 1) {
    for (let j = i + 1; j < plan.assignments.length; j += 1) {
      const a = plan.assignments[i];
      const b = plan.assignments[j];
      if (a.trackId !== b.trackId) continue;
      if (
        rangesOverlap(
          toFrameRange(a.start, a.end),
          toFrameRange(b.start, b.end),
        )
      ) {
        conflicts.add(a.key);
        conflicts.add(b.key);
      }
    }
  }

  return [...conflicts];
}