import type {
  TimelineTrackId,
  VideoTimelineClip,
} from "../types/timelineModel";
import {
  mergeVideoTransformKeyframes,
  sliceVideoTransformKeyframes,
} from "./videoTransformKeyframes";
import {
  isFreezeFrameClip,
  isReverseVideoClip,
  timelineTimeToSourceTime,
} from "./videoRetime";
import { videoEffectStacksEqual } from "./videoEffects";
import { videoMasksEqual } from "./videoMasks";

const EPSILON = 0.000001;

function sortVideoClips(clips: VideoTimelineClip[]) {
  return [...clips].sort(
    (a, b) =>
      a.timelineStart - b.timelineStart ||
      a.timelineEnd - b.timelineEnd ||
      a.trackId.localeCompare(b.trackId),
  );
}

function clipDuration(clip: VideoTimelineClip) {
  return Math.max(0, clip.timelineEnd - clip.timelineStart);
}

function almostEqual(a: number, b: number) {
  return Math.abs(a - b) <= EPSILON;
}

function optionalNumberEqual(
  a: number | undefined,
  b: number | undefined,
  fallback: number,
) {
  return almostEqual(a ?? fallback, b ?? fallback);
}

function sameContinuousClipProperties(
  left: VideoTimelineClip,
  right: VideoTimelineClip,
) {
  return (
    left.trackId === right.trackId &&
    left.sourceId === right.sourceId &&
    left.sourcePath === right.sourcePath &&
    left.sourceName === right.sourceName &&
    optionalNumberEqual(left.sourceDuration, right.sourceDuration, -1) &&
    optionalNumberEqual(left.playbackRate, right.playbackRate, 1) &&
    (left.playbackDirection ?? "forward") ===
      (right.playbackDirection ?? "forward") &&
    ((left.freezeFrameSourceTime === undefined &&
      right.freezeFrameSourceTime === undefined) ||
      (left.freezeFrameSourceTime !== undefined &&
        right.freezeFrameSourceTime !== undefined &&
        almostEqual(
          left.freezeFrameSourceTime,
          right.freezeFrameSourceTime,
        ))) &&
    optionalNumberEqual(left.positionX, right.positionX, 0) &&
    optionalNumberEqual(left.positionY, right.positionY, 0) &&
    optionalNumberEqual(left.scale, right.scale, 100) &&
    optionalNumberEqual(left.rotation, right.rotation, 0) &&
    optionalNumberEqual(left.opacity, right.opacity, 100) &&
    optionalNumberEqual(left.cropTop, right.cropTop, 0) &&
    optionalNumberEqual(left.cropRight, right.cropRight, 0) &&
    optionalNumberEqual(left.cropBottom, right.cropBottom, 0) &&
    optionalNumberEqual(left.cropLeft, right.cropLeft, 0) &&
    optionalNumberEqual(left.audioVolume, right.audioVolume, 100) &&
    (left.audioMuted ?? false) === (right.audioMuted ?? false) &&
    videoEffectStacksEqual(left.effects, right.effects) &&
    videoMasksEqual(left.mask, right.mask) &&
    (left.blendMode ?? "normal") === (right.blendMode ?? "normal")
  );
}

function hasUntouchedAutoSplitEdges(
  left: VideoTimelineClip,
  right: VideoTimelineClip,
) {
  return (
    (left.transitionOutType ?? "none") === "none" &&
    (right.transitionInType ?? "none") === "none" &&
    optionalNumberEqual(left.videoFadeOutDuration, 0, 0) &&
    optionalNumberEqual(right.videoFadeInDuration, 0, 0) &&
    optionalNumberEqual(left.audioFadeOutDuration, 0, 0) &&
    optionalNumberEqual(right.audioFadeInDuration, 0, 0)
  );
}

function hasMatchingAutoHealBoundary(
  left: VideoTimelineClip,
  right: VideoTimelineClip,
) {
  const boundaryId = left.rippleAutoHealOutBoundaryId;
  return Boolean(boundaryId) && boundaryId === right.rippleAutoHealInBoundaryId;
}

function hasContinuousSourceBoundary(
  left: VideoTimelineClip,
  right: VideoTimelineClip,
) {
  return isFreezeFrameClip(left)
    ? isFreezeFrameClip(right) &&
        almostEqual(left.freezeFrameSourceTime!, right.freezeFrameSourceTime!)
    : isReverseVideoClip(left)
      ? almostEqual(left.sourceIn, right.sourceOut)
      : almostEqual(left.sourceOut, right.sourceIn);
}

function canAutoHealSourcePair(
  left: VideoTimelineClip,
  right: VideoTimelineClip,
) {
  return (
    hasMatchingAutoHealBoundary(left, right) &&
    hasContinuousSourceBoundary(left, right) &&
    sameContinuousClipProperties(left, right) &&
    hasUntouchedAutoSplitEdges(left, right)
  );
}

function canAutoHealPair(left: VideoTimelineClip, right: VideoTimelineClip) {
  return (
    almostEqual(left.timelineEnd, right.timelineStart) &&
    canAutoHealSourcePair(left, right)
  );
}

function mergeAutoHealPair(
  left: VideoTimelineClip,
  right: VideoTimelineClip,
): VideoTimelineClip {
  return {
    ...left,
    timelineEnd: right.timelineEnd,
    sourceIn: isReverseVideoClip(left) ? right.sourceIn : left.sourceIn,
    sourceOut: isReverseVideoClip(left) ? left.sourceOut : right.sourceOut,
    transformKeyframes: mergeVideoTransformKeyframes(left, right),
    // The internal Ripple boundary disappears. Keep the real outer-right edge
    // settings from the right fragment and the real outer-left edge settings
    // already carried by the left fragment.
    transitionOutType: right.transitionOutType,
    transitionOutDuration: right.transitionOutDuration,
    videoFadeOutDuration: right.videoFadeOutDuration,
    audioFadeOutDuration: right.audioFadeOutDuration,
    rippleAutoHealOutBoundaryId: right.rippleAutoHealOutBoundaryId,
  };
}

export type AutoHealRippleResult = {
  clips: VideoTimelineClip[];
  /** Maps fragment IDs that disappeared to the surviving merged clip ID. */
  healedIdMap: Map<string, string>;
  changed: boolean;
};

/**
 * Heals only edit points that were created automatically by Ripple insertion.
 * A manual blade/range split has no matching boundary marker and therefore can
 * never be merged by this function.
 */
export function autoHealRippleSplits(
  clips: VideoTimelineClip[],
): AutoHealRippleResult {
  const byTrack = new Map<TimelineTrackId, VideoTimelineClip[]>();
  const healedIdMap = new Map<string, string>();
  const output: VideoTimelineClip[] = [];

  for (const clip of clips) {
    const list = byTrack.get(clip.trackId) ?? [];
    list.push(clip);
    byTrack.set(clip.trackId, list);
  }

  for (const trackClips of byTrack.values()) {
    const healedTrack: VideoTimelineClip[] = [];

    for (const clip of sortVideoClips(trackClips)) {
      const previous = healedTrack[healedTrack.length - 1];

      if (!previous || !canAutoHealPair(previous, clip)) {
        healedTrack.push(clip);
        continue;
      }

      const merged = mergeAutoHealPair(previous, clip);
      healedTrack[healedTrack.length - 1] = merged;
      healedIdMap.set(clip.id, merged.id);
    }

    output.push(...healedTrack);
  }

  return {
    clips: sortVideoClips(output),
    healedIdMap,
    changed: healedIdMap.size > 0,
  };
}

/**
 * Copies/duplicates must become independent edits. Keeping a Ripple boundary
 * token on a copied fragment could later make it heal with the original clip.
 */
export function stripRippleAutoHealMetadata(
  clip: VideoTimelineClip,
): VideoTimelineClip {
  const copy = { ...clip };
  delete copy.rippleAutoHealInBoundaryId;
  delete copy.rippleAutoHealOutBoundaryId;
  return copy;
}

export type FreezeAutoRestoreDeleteResult = {
  clips: VideoTimelineClip[];
  restoredFreezeIds: string[];
  changed: boolean;
};

function canRestoreFreezeSourcePair(
  left: VideoTimelineClip,
  freeze: VideoTimelineClip,
  right: VideoTimelineClip,
  expectedBoundaryId: string,
) {
  const hasExpectedMarkers =
    left.rippleAutoHealOutBoundaryId === expectedBoundaryId &&
    right.rippleAutoHealInBoundaryId === expectedBoundaryId;
  const isLegacyUnmarkedFreeze =
    left.rippleAutoHealOutBoundaryId === undefined &&
    right.rippleAutoHealInBoundaryId === undefined;
  const sourceBoundary = isReverseVideoClip(left)
    ? left.sourceIn
    : left.sourceOut;

  return (
    (hasExpectedMarkers || isLegacyUnmarkedFreeze) &&
    hasContinuousSourceBoundary(left, right) &&
    almostEqual(freeze.freezeFrameSourceTime ?? Number.NaN, sourceBoundary) &&
    sameContinuousClipProperties(left, right) &&
    hasUntouchedAutoSplitEdges(left, right)
  );
}

type FreezeRestoreTriple = {
  freeze: VideoTimelineClip;
  left: VideoTimelineClip;
  right: VideoTimelineClip;
  /** Entire current timeline gap that disappears when the HOLD is removed. */
  collapseDuration: number;
};

function mergeFreezeRestorePair(
  left: VideoTimelineClip,
  right: VideoTimelineClip,
  timelineStart: number,
  timelineEnd: number,
): VideoTimelineClip {
  return {
    ...left,
    timelineStart,
    timelineEnd,
    sourceIn: isReverseVideoClip(left) ? right.sourceIn : left.sourceIn,
    sourceOut: isReverseVideoClip(left) ? left.sourceOut : right.sourceOut,
    transformKeyframes: mergeVideoTransformKeyframes(left, right),
    transitionOutType: right.transitionOutType,
    transitionOutDuration: right.transitionOutDuration,
    videoFadeOutDuration: right.videoFadeOutDuration,
    audioFadeOutDuration: right.audioFadeOutDuration,
    // The Freeze-generated internal boundary is gone. Preserve only a real
    // outer Ripple boundary that may already exist on the right fragment.
    rippleAutoHealOutBoundaryId: right.rippleAutoHealOutBoundaryId,
  };
}

/**
 * Restores generated Freeze/HOLD insertions *before* ordinary Delete/Ripple
 * Delete runs. This intentionally merges the original left/right fragments
 * directly instead of relying on the generic Ripple auto-healer to notice the
 * pair after the HOLD has been removed.
 *
 * Only HOLD clips included in `selectedIds` are considered. A HOLD is restored
 * when its generated source fragments still belong to the same Freeze lineage
 * and their original source/edit properties remain compatible. The right
 * fragment may have been moved later and the HOLD may have been resized. Other selected clip IDs
 * are left untouched here so the caller can apply normal Delete semantics to
 * them afterward.
 *
 * v19.0 HOLDs created before dedicated auto-restore still work through the
 * conservative legacy-unmarked fallback in `canRestoreFreezeSourcePair`.
 */
export function deleteVideoClipsWithFreezeAutoRestore(
  clips: VideoTimelineClip[],
  selectedIds: Iterable<string>,
): FreezeAutoRestoreDeleteResult {
  const selected = new Set(selectedIds);

  if (selected.size === 0) {
    return { clips, restoredFreezeIds: [], changed: false };
  }

  const sorted = sortVideoClips(clips);
  const triples: FreezeRestoreTriple[] = [];
  const claimedClipIds = new Set<string>();

  for (const freeze of sorted) {
    if (!selected.has(freeze.id) || !isFreezeFrameClip(freeze)) {
      continue;
    }

    const expectedBoundaryId = `freeze-heal:${freeze.id}`;

    // Newer Freeze insertions carry a stable lineage token on the two source
    // fragments. Prefer that identity over timeline adjacency so users can move
    // the right fragment later and/or resize the HOLD without losing the ability
    // to restore the original continuous clip.
    let left = sorted.find(
      (clip) =>
        !selected.has(clip.id) &&
        !claimedClipIds.has(clip.id) &&
        clip.trackId === freeze.trackId &&
        clip.rippleAutoHealOutBoundaryId === expectedBoundaryId,
    );
    let right = sorted.find(
      (clip) =>
        !selected.has(clip.id) &&
        !claimedClipIds.has(clip.id) &&
        clip.trackId === freeze.trackId &&
        clip.rippleAutoHealInBoundaryId === expectedBoundaryId,
    );

    // Legacy v19 HOLDs created before the lineage token existed can still use
    // the old conservative adjacency fallback. We intentionally do not guess
    // across arbitrary gaps for unmarked fragments.
    if (!left || !right) {
      left = sorted.find(
        (clip) =>
          !selected.has(clip.id) &&
          !claimedClipIds.has(clip.id) &&
          clip.trackId === freeze.trackId &&
          clip.rippleAutoHealOutBoundaryId === undefined &&
          almostEqual(clip.timelineEnd, freeze.timelineStart),
      );
      right = sorted.find(
        (clip) =>
          !selected.has(clip.id) &&
          !claimedClipIds.has(clip.id) &&
          clip.trackId === freeze.trackId &&
          clip.rippleAutoHealInBoundaryId === undefined &&
          almostEqual(clip.timelineStart, freeze.timelineEnd),
      );
    }

    if (
      !left ||
      !right ||
      !canRestoreFreezeSourcePair(left, freeze, right, expectedBoundaryId)
    ) {
      continue;
    }

    // The right fragment may have been moved later and the HOLD may have been
    // stretched to fill that space. Restoring the original source clip removes
    // the entire *current* interval between the generated fragments, not merely
    // the HOLD's original/current duration.
    const collapseDuration = right.timelineStart - left.timelineEnd;
    if (collapseDuration < -EPSILON) {
      continue;
    }

    // Do not collapse unrelated material that the user inserted into the gap.
    // The HOLD itself is allowed anywhere inside the interval.
    const hasBlockingClip = sorted.some(
      (clip) =>
        clip.id !== freeze.id &&
        clip.id !== left!.id &&
        clip.id !== right!.id &&
        !selected.has(clip.id) &&
        clip.trackId === freeze.trackId &&
        clip.timelineEnd > left!.timelineEnd + EPSILON &&
        clip.timelineStart < right!.timelineStart - EPSILON,
    );
    if (hasBlockingClip) {
      continue;
    }

    triples.push({
      freeze,
      left,
      right,
      collapseDuration: Math.max(0, collapseDuration),
    });
    claimedClipIds.add(freeze.id);
    claimedClipIds.add(left.id);
    claimedClipIds.add(right.id);
  }

  if (triples.length === 0) {
    return { clips, restoredFreezeIds: [], changed: false };
  }

  triples.sort(
    (a, b) =>
      a.freeze.timelineStart - b.freeze.timelineStart ||
      a.freeze.trackId.localeCompare(b.freeze.trackId),
  );

  const triplesByLeftId = new Map(
    triples.map((triple) => [triple.left.id, triple]),
  );
  const consumedIds = new Set<string>();
  for (const triple of triples) {
    consumedIds.add(triple.freeze.id);
    consumedIds.add(triple.right.id);
  }

  const shiftBefore = (trackId: TimelineTrackId, time: number) => {
    let shift = 0;
    for (const triple of triples) {
      if (
        triple.freeze.trackId === trackId &&
        triple.right.timelineStart <= time + EPSILON
      ) {
        shift += triple.collapseDuration;
      }
    }
    return shift;
  };

  const output: VideoTimelineClip[] = [];

  for (const clip of sorted) {
    if (consumedIds.has(clip.id)) {
      continue;
    }

    const triple = triplesByLeftId.get(clip.id);
    if (triple) {
      const startShift = shiftBefore(clip.trackId, triple.left.timelineStart);
      const endShift = shiftBefore(clip.trackId, triple.right.timelineEnd);
      output.push(
        mergeFreezeRestorePair(
          triple.left,
          triple.right,
          Math.max(0, triple.left.timelineStart - startShift),
          Math.max(0, triple.right.timelineEnd - endShift),
        ),
      );
      continue;
    }

    const shift = shiftBefore(clip.trackId, clip.timelineStart);
    output.push(
      shift > EPSILON
        ? {
            ...clip,
            timelineStart: Math.max(0, clip.timelineStart - shift),
            timelineEnd: Math.max(0, clip.timelineEnd - shift),
          }
        : clip,
    );
  }

  return {
    clips: sortVideoClips(output),
    restoredFreezeIds: triples.map((triple) => triple.freeze.id),
    changed: true,
  };
}

function splitClipForRippleInsert(
  clip: VideoTimelineClip,
  insertTime: number,
  openedDuration: number,
  createSplitId: (clip: VideoTimelineClip) => string,
): VideoTimelineClip[] {
  if (
    insertTime <= clip.timelineStart + EPSILON ||
    insertTime >= clip.timelineEnd - EPSILON
  ) {
    return [];
  }

  const sourceSplit = timelineTimeToSourceTime(clip, insertTime);
  const reverse = isReverseVideoClip(clip);
  const freeze = isFreezeFrameClip(clip);
  const rightId = createSplitId(clip);
  const boundaryId = `ripple-heal:${rightId}`;

  const left: VideoTimelineClip = {
    ...clip,
    timelineEnd: insertTime,
    sourceIn: freeze ? clip.sourceIn : reverse ? sourceSplit : clip.sourceIn,
    sourceOut: freeze ? clip.sourceOut : reverse ? clip.sourceOut : sourceSplit,
    transformKeyframes: sliceVideoTransformKeyframes(
      clip,
      clip.timelineStart,
      insertTime,
    ),
    transitionOutType: "none",
    videoFadeOutDuration: 0,
    audioFadeOutDuration: 0,
    rippleAutoHealOutBoundaryId: boundaryId,
  };

  const right: VideoTimelineClip = {
    ...clip,
    id: rightId,
    timelineStart: insertTime + openedDuration,
    timelineEnd: clip.timelineEnd + openedDuration,
    sourceIn: freeze ? clip.sourceIn : reverse ? clip.sourceIn : sourceSplit,
    sourceOut: freeze ? clip.sourceOut : reverse ? sourceSplit : clip.sourceOut,
    transformKeyframes: sliceVideoTransformKeyframes(
      clip,
      insertTime,
      clip.timelineEnd,
    ),
    transitionInType: "none",
    videoFadeInDuration: 0,
    audioFadeInDuration: 0,
    rippleAutoHealInBoundaryId: boundaryId,
  };

  return [left, right];
}

export type RippleDeleteResult = {
  clips: VideoTimelineClip[];
  changed: boolean;
};

/**
 * Removes selected clips and closes only the duration occupied by those clips
 * on each affected video track. Existing gaps remain intact, while every later
 * clip on that same track shifts left by the total removed duration before it.
 */
export function rippleDeleteVideoClips(
  clips: VideoTimelineClip[],
  selectedIds: Iterable<string>,
): RippleDeleteResult {
  const selected = new Set(selectedIds);

  if (selected.size === 0) {
    return { clips, changed: false };
  }

  const selectedByTrack = new Map<TimelineTrackId, VideoTimelineClip[]>();

  for (const clip of clips) {
    if (!selected.has(clip.id)) {
      continue;
    }

    const list = selectedByTrack.get(clip.trackId) ?? [];
    list.push(clip);
    selectedByTrack.set(clip.trackId, list);
  }

  if (selectedByTrack.size === 0) {
    return { clips, changed: false };
  }

  for (const list of selectedByTrack.values()) {
    list.sort((a, b) => a.timelineStart - b.timelineStart);
  }

  const next: VideoTimelineClip[] = [];

  for (const clip of clips) {
    if (selected.has(clip.id)) {
      continue;
    }

    const removedOnTrack = selectedByTrack.get(clip.trackId);

    if (!removedOnTrack || removedOnTrack.length === 0) {
      next.push(clip);
      continue;
    }

    let shift = 0;

    for (const removed of removedOnTrack) {
      if (removed.timelineEnd <= clip.timelineStart + EPSILON) {
        shift += clipDuration(removed);
      }
    }

    next.push(
      shift > EPSILON
        ? {
            ...clip,
            timelineStart: Math.max(0, clip.timelineStart - shift),
            timelineEnd: Math.max(0, clip.timelineEnd - shift),
          }
        : clip,
    );
  }

  return {
    clips: sortVideoClips(next),
    changed: true,
  };
}

export type RippleInsertOptions = {
  requestedTrackId?: TimelineTrackId;
  preserveIds?: boolean;
  createId?: () => string;
  createSplitId?: (clip: VideoTimelineClip) => string;
};

export type RippleInsertResult = {
  clips: VideoTimelineClip[];
  insertedIds: string[];
  groupStart: number;
  groupEnd: number;
  openedDuration: number;
};

/**
 * Opens one synchronized time span on every destination track used by the
 * inserted group. Clips after the insertion point shift right. A clip crossing
 * the insertion point is split so no source frames are lost.
 */
export function rippleInsertVideoClipGroup(
  existingClips: VideoTimelineClip[],
  sourceClips: VideoTimelineClip[],
  requestedTimelineStart: number,
  options: RippleInsertOptions = {},
): RippleInsertResult {
  if (sourceClips.length === 0) {
    return {
      clips: existingClips,
      insertedIds: [],
      groupStart: Math.max(0, requestedTimelineStart),
      groupEnd: Math.max(0, requestedTimelineStart),
      openedDuration: 0,
    };
  }

  const sourceTrackIds = [...new Set(sourceClips.map((clip) => clip.trackId))];
  const canRetargetSingleTrack =
    options.requestedTrackId !== undefined && sourceTrackIds.length === 1;
  const prepared = sourceClips.map((clip) => ({
    ...clip,
    trackId: canRetargetSingleTrack ? options.requestedTrackId! : clip.trackId,
  }));

  const originalGroupStart = Math.min(
    ...prepared.map((clip) => clip.timelineStart),
  );
  const originalGroupEnd = Math.max(
    ...prepared.map((clip) => clip.timelineEnd),
  );
  const openedDuration = Math.max(
    EPSILON,
    originalGroupEnd - originalGroupStart,
  );
  const groupStart = Math.max(0, requestedTimelineStart);
  const groupEnd = groupStart + openedDuration;
  const destinationTracks = new Set(prepared.map((clip) => clip.trackId));
  const createId = options.createId ?? (() => crypto.randomUUID());
  const createSplitId = options.createSplitId ?? (() => crypto.randomUUID());

  const opened: VideoTimelineClip[] = [];

  for (const clip of existingClips) {
    if (!destinationTracks.has(clip.trackId)) {
      opened.push(clip);
      continue;
    }

    if (clip.timelineEnd <= groupStart + EPSILON) {
      opened.push(clip);
      continue;
    }

    if (clip.timelineStart >= groupStart - EPSILON) {
      opened.push({
        ...clip,
        timelineStart: clip.timelineStart + openedDuration,
        timelineEnd: clip.timelineEnd + openedDuration,
      });
      continue;
    }

    const split = splitClipForRippleInsert(
      clip,
      groupStart,
      openedDuration,
      createSplitId,
    );

    if (split.length > 0) {
      opened.push(...split);
    } else {
      opened.push(clip);
    }
  }

  const insertedIds: string[] = [];
  const inserted = prepared.map((clip) => {
    const id = options.preserveIds ? clip.id : createId();
    const relativeStart = clip.timelineStart - originalGroupStart;
    const relativeEnd = clip.timelineEnd - originalGroupStart;
    insertedIds.push(id);

    const base = options.preserveIds ? clip : stripRippleAutoHealMetadata(clip);

    return {
      ...base,
      id,
      timelineStart: groupStart + relativeStart,
      timelineEnd: groupStart + relativeEnd,
    };
  });

  return {
    clips: sortVideoClips([...opened, ...inserted]),
    insertedIds,
    groupStart,
    groupEnd,
    openedDuration,
  };
}

export type RippleMoveOptions = {
  requestedTrackId?: TimelineTrackId;
  createSplitId?: (clip: VideoTimelineClip) => string;
};

/**
 * Magnetic move = close the source holes, then insert the selected group at
 * the new position while opening space at the destination. Recomputing from an
 * immutable drag-origin snapshot makes repeated mousemove updates stable.
 */
export function rippleMoveVideoClipGroup(
  originClips: VideoTimelineClip[],
  selectedIds: Iterable<string>,
  anchorId: string,
  requestedAnchorStart: number,
  options: RippleMoveOptions = {},
): VideoTimelineClip[] {
  const selected = new Set(selectedIds);
  const moving = originClips.filter((clip) => selected.has(clip.id));
  const anchor = moving.find((clip) => clip.id === anchorId);

  if (!anchor || moving.length === 0) {
    return originClips;
  }

  const movingGroupStart = Math.min(
    ...moving.map((clip) => clip.timelineStart),
  );
  const movingGroupEnd = Math.max(...moving.map((clip) => clip.timelineEnd));
  const movingGroupDuration = Math.max(
    EPSILON,
    movingGroupEnd - movingGroupStart,
  );
  const anchorOffset = anchor.timelineStart - movingGroupStart;
  const requestedGroupStart = Math.max(0, requestedAnchorStart - anchorOffset);
  const sourceTracks = new Set(moving.map((clip) => clip.trackId));

  // A magnetic group move treats the selected time span as one block. Refuse
  // the ripple rearrangement when unrelated clips live inside that block on an
  // affected source track; moving them implicitly would be surprising.
  const hasUnselectedInsideSourceSpan = originClips.some(
    (clip) =>
      !selected.has(clip.id) &&
      sourceTracks.has(clip.trackId) &&
      clip.timelineEnd > movingGroupStart + EPSILON &&
      clip.timelineStart < movingGroupEnd - EPSILON,
  );

  if (hasUnselectedInsideSourceSpan) {
    return originClips;
  }

  const closedSource = originClips
    .filter((clip) => !selected.has(clip.id))
    .map((clip) => {
      if (
        sourceTracks.has(clip.trackId) &&
        clip.timelineStart >= movingGroupEnd - EPSILON
      ) {
        return {
          ...clip,
          timelineStart: Math.max(0, clip.timelineStart - movingGroupDuration),
          timelineEnd: Math.max(0, clip.timelineEnd - movingGroupDuration),
        };
      }

      return clip;
    });

  return rippleInsertVideoClipGroup(closedSource, moving, requestedGroupStart, {
    requestedTrackId: options.requestedTrackId,
    preserveIds: true,
    createSplitId: options.createSplitId,
  }).clips;
}
