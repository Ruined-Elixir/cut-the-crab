import { useEffect, useMemo, useRef, useState } from "react";

import type { ProjectMediaAsset } from "../types/project";
import type {
  TimelineTrackId,
  VideoBlendMode,
  VideoEffectInstance,
  VideoMask,
  VideoTimelineClip,
  VideoTransitionType,
  VideoTransformKeyframeProperty,
} from "../types/timelineModel";
import {
  clampVideoClipGroupMoveDelta,
  findNextAvailableVideoClipGroupShift,
} from "../utils/timelineMultiClip";
import {
  isFreezeFrameClip,
  isReverseVideoClip,
  normalizeVideoPlaybackRate,
  sourceDeltaToTimelineDelta,
  timelineDeltaToSourceDelta,
  timelineTimeToSourceTime,
} from "../utils/videoRetime";
import {
  autoHealRippleSplits,
  deleteVideoClipsWithFreezeAutoRestore,
  rippleDeleteVideoClips,
  rippleInsertVideoClipGroup,
  rippleMoveVideoClipGroup,
  stripRippleAutoHealMetadata,
} from "../utils/timelineRippleEdits";
import {
  retimeVideoTransformKeyframes,
  setVideoTransformPropertyAtTime,
  withEvaluatedVideoTransform,
  sliceVideoTransformKeyframes,
  toggleVideoTransformKeyframeAtTime,
} from "../utils/videoTransformKeyframes";
import { TIMELINE_FRAME_DURATION, snapTimelineTimeToFrame } from "../utils/timelineFrames";

const MIN_VIDEO_CLIP_DURATION = 0.1;
const DEFAULT_VIDEO_TRACK_ID: TimelineTrackId = "video-1";

const VIDEO_TRACK_ID_PATTERN = /^video-(\d+)$/;

function quantizeVideoClipTimeline(clip: VideoTimelineClip): VideoTimelineClip {
  const timelineStart = Math.max(0, snapTimelineTimeToFrame(clip.timelineStart));
  const timelineEnd = Math.max(
    timelineStart + TIMELINE_FRAME_DURATION,
    snapTimelineTimeToFrame(clip.timelineEnd),
  );
  return { ...clip, timelineStart, timelineEnd };
}

type UseVideoTimelineOptions = {
  sourcePath: string | null;
  sourceName: string | null;
  sourceDuration: number;
  rippleMode?: boolean;
};

function normalizeVideoTrackId(trackId: TimelineTrackId): TimelineTrackId {
  return VIDEO_TRACK_ID_PATTERN.test(trackId)
    ? trackId
    : DEFAULT_VIDEO_TRACK_ID;
}

function sortVideoClips(clips: VideoTimelineClip[]) {
  return [...clips].sort(
    (a, b) =>
      a.timelineStart - b.timelineStart ||
      a.timelineEnd - b.timelineEnd ||
      a.trackId.localeCompare(b.trackId),
  );
}

function clipsOnTrack(
  clips: VideoTimelineClip[],
  trackId: TimelineTrackId,
  excludedClipId?: string,
) {
  return clips.filter(
    (clip) => clip.trackId === trackId && clip.id !== excludedClipId,
  );
}

function findNextAvailableTimelineStart(
  clips: VideoTimelineClip[],
  trackId: TimelineTrackId,
  requestedStart: number,
  clipDuration: number,
  excludedClipId?: string,
) {
  let start = Math.max(0, requestedStart);
  const sorted = sortVideoClips(clipsOnTrack(clips, trackId, excludedClipId));

  for (const clip of sorted) {
    const end = start + clipDuration;

    if (end <= clip.timelineStart) {
      break;
    }

    if (start >= clip.timelineEnd) {
      continue;
    }

    start = clip.timelineEnd;
  }

  return start;
}

/*
 * Moving a clip is different from inserting a new one.  The old move path
 * reused findNextAvailableTimelineStart(), which always searches forward.
 * That meant nudging a clip slightly left into an occupied region could send
 * it all the way to the far side of a long neighbouring clip.  During a drag
 * this looked exactly like the clip had disappeared.
 *
 * For moves, choose the closest legal position instead.  A clip therefore
 * stops against the nearest neighbour edge rather than teleporting across it.
 */
function findNearestAvailableTimelineStart(
  clips: VideoTimelineClip[],
  trackId: TimelineTrackId,
  requestedStart: number,
  clipDuration: number,
  excludedClipId?: string,
) {
  const requested = Math.max(0, requestedStart);
  const duration = Math.max(MIN_VIDEO_CLIP_DURATION, clipDuration);
  const sorted = sortVideoClips(clipsOnTrack(clips, trackId, excludedClipId));

  if (sorted.length === 0) {
    return requested;
  }

  const candidates: number[] = [];
  let gapStart = 0;

  for (const clip of sorted) {
    const gapEnd = Math.max(gapStart, clip.timelineStart);
    const latestStartInGap = gapEnd - duration;

    if (latestStartInGap >= gapStart - 0.000001) {
      candidates.push(
        Math.max(gapStart, Math.min(requested, latestStartInGap)),
      );
    }

    gapStart = Math.max(gapStart, clip.timelineEnd);
  }

  // The final gap is unbounded, so the closest legal point is either the
  // requested location itself or the end of the last occupied region.
  candidates.push(Math.max(gapStart, requested));

  let best = candidates[0] ?? requested;
  let bestDistance = Math.abs(best - requested);

  for (const candidate of candidates.slice(1)) {
    const distance = Math.abs(candidate - requested);

    if (
      distance < bestDistance - 0.000001 ||
      (Math.abs(distance - bestDistance) <= 0.000001 && candidate < best)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return Math.max(0, best);
}

function createFullSourceClip(
  sourcePath: string,
  sourceName: string,
  sourceDuration: number,
): VideoTimelineClip {
  return {
    id: crypto.randomUUID(),
    kind: "video",
    trackId: DEFAULT_VIDEO_TRACK_ID,
    sourceId: sourcePath,
    sourcePath,
    sourceName,
    sourceIn: 0,
    sourceOut: sourceDuration,
    sourceDuration,
    playbackRate: 1,
    positionX: 0,
    positionY: 0,
    scale: 100,
    rotation: 0,
    opacity: 100,
    cropTop: 0,
    cropRight: 0,
    cropBottom: 0,
    cropLeft: 0,
    transitionInType: "none",
    transitionInDuration: 0.5,
    transitionOutType: "none",
    transitionOutDuration: 0.5,
    videoFadeInDuration: 0,
    videoFadeOutDuration: 0,
    audioVolume: 100,
    audioMuted: false,
    audioFadeInDuration: 0,
    audioFadeOutDuration: 0,
    timelineStart: 0,
    timelineEnd: sourceDuration,
  };
}

export function useVideoTimeline({
  sourcePath,
  sourceName,
  sourceDuration,
  rippleMode = false,
}: UseVideoTimelineOptions) {
  const [videoClips, setVideoClipsState] = useState<VideoTimelineClip[]>([]);
  const setVideoClips = (
    update:
      | VideoTimelineClip[]
      | ((current: VideoTimelineClip[]) => VideoTimelineClip[]),
  ) => {
    setVideoClipsState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      return next.map(quantizeVideoClipTimeline);
    });
  };

  const [selectedVideoClipId, setSelectedVideoClipId] = useState<string | null>(
    null,
  );
  const [selectedVideoClipIds, setSelectedVideoClipIds] = useState<string[]>(
    [],
  );

  const groupMoveOriginRef = useRef<{
    anchorId: string;
    selectedClips: VideoTimelineClip[];
    allClips: VideoTimelineClip[];
    rippleToken: string;
  } | null>(null);
  const initializedSourceRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sourcePath || !sourceName || sourceDuration <= 0) {
      return;
    }

    if (initializedSourceRef.current === sourcePath) {
      return;
    }

    initializedSourceRef.current = sourcePath;

    setVideoClips([
      createFullSourceClip(sourcePath, sourceName, sourceDuration),
    ]);

    setSelectedVideoClipId(null);
    setSelectedVideoClipIds([]);
  }, [sourcePath, sourceName, sourceDuration]);

  const selectedVideoClip = useMemo(
    () => videoClips.find((clip) => clip.id === selectedVideoClipId) ?? null,
    [videoClips, selectedVideoClipId],
  );

  const clearVideoClipSelection = () => {
    setSelectedVideoClipId(null);
    setSelectedVideoClipIds([]);
  };

  const selectVideoClip = (
    id: string,
    mode: "single" | "toggle" | "focus" = "single",
  ) => {
    if (mode === "single") {
      setSelectedVideoClipId(id);
      setSelectedVideoClipIds([id]);
      return;
    }

    if (mode === "focus") {
      setSelectedVideoClipId(id);
      setSelectedVideoClipIds((current) =>
        current.includes(id) ? current : [id],
      );
      return;
    }

    setSelectedVideoClipIds((current) => {
      if (current.includes(id)) {
        const next = current.filter((clipId) => clipId !== id);
        setSelectedVideoClipId((primary) =>
          primary === id ? (next[next.length - 1] ?? null) : primary,
        );
        return next;
      }

      const next = [...current, id];
      setSelectedVideoClipId(id);
      return next;
    });
  };

  const selectVideoClips = (ids: string[], primaryId?: string | null) => {
    const unique = [...new Set(ids)];
    const primary =
      primaryId && unique.includes(primaryId)
        ? primaryId
        : (unique[unique.length - 1] ?? null);

    setSelectedVideoClipIds(unique);
    setSelectedVideoClipId(primary);
  };

  const healRippleSplitsAndRemapSelection = (clips: VideoTimelineClip[]) => {
    const healed = autoHealRippleSplits(clips);

    if (!healed.changed) {
      return healed.clips;
    }

    const resolveId = (id: string) => {
      let current = id;
      const visited = new Set<string>();

      while (healed.healedIdMap.has(current) && !visited.has(current)) {
        visited.add(current);
        current = healed.healedIdMap.get(current)!;
      }

      return current;
    };

    const availableIds = new Set(healed.clips.map((clip) => clip.id));

    window.requestAnimationFrame(() => {
      setSelectedVideoClipIds((current) =>
        [...new Set(current.map(resolveId))].filter((id) =>
          availableIds.has(id),
        ),
      );
      setSelectedVideoClipId((current) => {
        if (!current) {
          return null;
        }

        const resolved = resolveId(current);
        return availableIds.has(resolved) ? resolved : null;
      });
    });

    return healed.clips;
  };

  const replaceVideoClips = (
    clips: VideoTimelineClip[],
    options?: { markSourceInitializedFor?: string },
  ) => {
    if (options?.markSourceInitializedFor) {
      initializedSourceRef.current = clips.some(
        (clip) => clip.sourcePath === options.markSourceInitializedFor,
      )
        ? options.markSourceInitializedFor
        : null;
    }

    const normalized = clips.map((clip) => ({
      ...clip,
      trackId: normalizeVideoTrackId(clip.trackId),
    }));
    const healed = autoHealRippleSplits(normalized);

    setVideoClips(healed.clips);

    const resolveId = (id: string) => {
      let current = id;
      const visited = new Set<string>();

      while (healed.healedIdMap.has(current) && !visited.has(current)) {
        visited.add(current);
        current = healed.healedIdMap.get(current)!;
      }

      return current;
    };
    const availableIds = new Set(healed.clips.map((clip) => clip.id));

    setSelectedVideoClipIds((current) =>
      [...new Set(current.map(resolveId))].filter((id) => availableIds.has(id)),
    );
    setSelectedVideoClipId((current) => {
      if (!current) {
        return null;
      }

      const resolved = resolveId(current);
      return availableIds.has(resolved) ? resolved : null;
    });
  };

  const initializeDefaultVideoClip = (knownDuration?: number) => {
    const duration = knownDuration ?? sourceDuration;

    if (
      !sourcePath ||
      !sourceName ||
      duration <= 0 ||
      initializedSourceRef.current === sourcePath
    ) {
      return;
    }

    initializedSourceRef.current = sourcePath;

    setVideoClips([createFullSourceClip(sourcePath, sourceName, duration)]);

    setSelectedVideoClipId(null);
    setSelectedVideoClipIds([]);
  };

  const beginVideoClipMove = (id: string) => {
    const isSelected = selectedVideoClipIds.includes(id);
    const shouldCaptureOrigin =
      isSelected && (rippleMode || selectedVideoClipIds.length > 1);

    if (!shouldCaptureOrigin) {
      groupMoveOriginRef.current = null;
      return;
    }

    const selectedSet = new Set(selectedVideoClipIds);
    groupMoveOriginRef.current = {
      anchorId: id,
      selectedClips: videoClips
        .filter((clip) => selectedSet.has(clip.id))
        .map((clip) => ({ ...clip })),
      allClips: videoClips.map((clip) => ({ ...clip })),
      rippleToken: crypto.randomUUID(),
    };
  };

  const endVideoClipMove = () => {
    groupMoveOriginRef.current = null;
  };

  const moveVideoClip = (id: string, requestedTimelineStart: number) => {
    requestedTimelineStart = snapTimelineTimeToFrame(requestedTimelineStart);
    setVideoClips((current) => {
      const groupOrigin = groupMoveOriginRef.current;

      if (rippleMode && groupOrigin?.anchorId === id) {
        return healRippleSplitsAndRemapSelection(
          rippleMoveVideoClipGroup(
            groupOrigin.allClips,
            groupOrigin.selectedClips.map((clip) => clip.id),
            id,
            requestedTimelineStart,
            {
              createSplitId: (clip) =>
                `${clip.id}-ripple-${groupOrigin.rippleToken}`,
            },
          ),
        );
      }

      if (
        groupOrigin?.anchorId === id &&
        groupOrigin.selectedClips.length > 1
      ) {
        const anchor = groupOrigin.selectedClips.find((clip) => clip.id === id);

        if (!anchor) {
          return current;
        }

        const selectedSet = new Set(
          groupOrigin.selectedClips.map((clip) => clip.id),
        );
        const unselected = current.filter((clip) => !selectedSet.has(clip.id));
        const requestedDelta = requestedTimelineStart - anchor.timelineStart;
        const delta = clampVideoClipGroupMoveDelta(
          groupOrigin.selectedClips,
          unselected,
          requestedDelta,
        );
        const originsById = new Map(
          groupOrigin.selectedClips.map((clip) => [clip.id, clip]),
        );

        return healRippleSplitsAndRemapSelection(
          sortVideoClips(
            current.map((clip) => {
              const origin = originsById.get(clip.id);

              return origin
                ? {
                    ...clip,
                    timelineStart: origin.timelineStart + delta,
                    timelineEnd: origin.timelineEnd + delta,
                  }
                : clip;
            }),
          ),
        );
      }

      const target = current.find((clip) => clip.id === id);

      if (!target) {
        return current;
      }

      const clipDuration = target.timelineEnd - target.timelineStart;
      const trackId = normalizeVideoTrackId(target.trackId);
      const newStart = findNearestAvailableTimelineStart(
        current,
        trackId,
        requestedTimelineStart,
        clipDuration,
        id,
      );

      return healRippleSplitsAndRemapSelection(
        sortVideoClips(
          current.map((clip) =>
            clip.id === id
              ? {
                  ...clip,
                  trackId,
                  timelineStart: newStart,
                  timelineEnd: newStart + clipDuration,
                }
              : clip,
          ),
        ),
      );
    });
  };

  const moveVideoClipToTrack = (
    id: string,
    targetTrackId: TimelineTrackId,
    requestedTimelineStart?: number,
  ) => {
    const normalizedTrackId = normalizeVideoTrackId(targetTrackId);
    if (requestedTimelineStart !== undefined) {
      requestedTimelineStart = snapTimelineTimeToFrame(requestedTimelineStart);
    }

    setVideoClips((current) => {
      const groupOrigin = groupMoveOriginRef.current;

      if (rippleMode && groupOrigin?.anchorId === id) {
        return healRippleSplitsAndRemapSelection(
          rippleMoveVideoClipGroup(
            groupOrigin.allClips,
            groupOrigin.selectedClips.map((clip) => clip.id),
            id,
            requestedTimelineStart ??
              groupOrigin.selectedClips.find((clip) => clip.id === id)
                ?.timelineStart ??
              0,
            {
              requestedTrackId: normalizedTrackId,
              createSplitId: (clip) =>
                `${clip.id}-ripple-${groupOrigin.rippleToken}`,
            },
          ),
        );
      }

      const target = current.find((clip) => clip.id === id);

      if (!target) {
        return current;
      }

      const clipDuration = target.timelineEnd - target.timelineStart;
      const requestedStart = requestedTimelineStart ?? target.timelineStart;
      const timelineStart = findNearestAvailableTimelineStart(
        current,
        normalizedTrackId,
        requestedStart,
        clipDuration,
        id,
      );

      return healRippleSplitsAndRemapSelection(
        sortVideoClips(
          current.map((clip) =>
            clip.id === id
              ? {
                  ...clip,
                  trackId: normalizedTrackId,
                  timelineStart,
                  timelineEnd: timelineStart + clipDuration,
                }
              : clip,
          ),
        ),
      );
    });
  };

  const resizeVideoClip = (
    id: string,
    newTimelineStart: number,
    newTimelineEnd: number,
  ) => {
    newTimelineStart = snapTimelineTimeToFrame(newTimelineStart);
    newTimelineEnd = snapTimelineTimeToFrame(newTimelineEnd);
    setVideoClips((current) => {
      const target = current.find((clip) => clip.id === id);

      if (!target) {
        return current;
      }

      if (isFreezeFrameClip(target)) {
        const nextStart = Math.max(
          0,
          Math.min(newTimelineStart, newTimelineEnd - MIN_VIDEO_CLIP_DURATION),
        );
        const nextEnd = Math.max(
          nextStart + MIN_VIDEO_CLIP_DURATION,
          newTimelineEnd,
        );
        const overlaps = clipsOnTrack(current, target.trackId, id).some(
          (clip) =>
            nextEnd > clip.timelineStart && nextStart < clip.timelineEnd,
        );
        if (overlaps) return current;

        return sortVideoClips(
          current.map((clip) =>
            clip.id === id
              ? {
                  ...clip,
                  timelineStart: nextStart,
                  timelineEnd: nextEnd,
                  transformKeyframes: sliceVideoTransformKeyframes(
                    target,
                    nextStart,
                    nextEnd,
                  ),
                }
              : clip,
          ),
        );
      }

      const reverse = isReverseVideoClip(target);
      const clipSourceDuration = target.sourceDuration ?? sourceDuration;
      const earliestTimelineStart = Math.max(
        0,
        target.timelineStart -
          sourceDeltaToTimelineDelta(
            target,
            reverse
              ? Math.max(0, clipSourceDuration - target.sourceOut)
              : target.sourceIn,
          ),
      );

      const latestTimelineEnd =
        target.timelineEnd +
        sourceDeltaToTimelineDelta(
          target,
          reverse
            ? target.sourceIn
            : Math.max(0, clipSourceDuration - target.sourceOut),
        );

      const nextStart = Math.max(
        earliestTimelineStart,
        Math.min(
          newTimelineStart,
          Math.min(
            newTimelineEnd - MIN_VIDEO_CLIP_DURATION,
            target.timelineEnd - MIN_VIDEO_CLIP_DURATION,
          ),
        ),
      );

      const nextEnd = Math.min(
        latestTimelineEnd,
        Math.max(
          Math.max(
            nextStart + MIN_VIDEO_CLIP_DURATION,
            target.timelineStart + MIN_VIDEO_CLIP_DURATION,
          ),
          newTimelineEnd,
        ),
      );

      const sourceStartDelta = nextStart - target.timelineStart;
      const sourceEndDelta = nextEnd - target.timelineEnd;

      const nextSourceIn = reverse
        ? target.sourceIn - timelineDeltaToSourceDelta(target, sourceEndDelta)
        : target.sourceIn +
          timelineDeltaToSourceDelta(target, sourceStartDelta);
      const nextSourceOut = reverse
        ? target.sourceOut -
          timelineDeltaToSourceDelta(target, sourceStartDelta)
        : target.sourceOut + timelineDeltaToSourceDelta(target, sourceEndDelta);

      if (
        sourceDeltaToTimelineDelta(target, nextSourceOut - nextSourceIn) <
        MIN_VIDEO_CLIP_DURATION
      ) {
        return current;
      }

      const sameTrackClips = clipsOnTrack(current, target.trackId, id);

      const overlaps = sameTrackClips.some(
        (clip) => nextEnd > clip.timelineStart && nextStart < clip.timelineEnd,
      );

      if (overlaps) {
        return current;
      }

      return sortVideoClips(
        current.map((clip) =>
          clip.id === id
            ? {
                ...clip,
                timelineStart: nextStart,
                timelineEnd: nextEnd,
                sourceIn: nextSourceIn,
                sourceOut: nextSourceOut,
                transformKeyframes: sliceVideoTransformKeyframes(
                  target,
                  nextStart,
                  nextEnd,
                ),
                rippleAutoHealInBoundaryId:
                  Math.abs(nextStart - target.timelineStart) > 0.000001
                    ? undefined
                    : clip.rippleAutoHealInBoundaryId,
                rippleAutoHealOutBoundaryId:
                  Math.abs(nextEnd - target.timelineEnd) > 0.000001
                    ? undefined
                    : clip.rippleAutoHealOutBoundaryId,
              }
            : clip,
        ),
      );
    });
  };

  const splitVideoClip = (
    id: string,
    splitTime: number,
    rightClipId: string = crypto.randomUUID(),
  ) => {
    splitTime = snapTimelineTimeToFrame(splitTime);
    setVideoClips((current) => {
      const target = current.find((clip) => clip.id === id);

      if (!target) {
        return current;
      }

      if (
        splitTime <= target.timelineStart + MIN_VIDEO_CLIP_DURATION ||
        splitTime >= target.timelineEnd - MIN_VIDEO_CLIP_DURATION
      ) {
        return current;
      }

      const sourceSplit = timelineTimeToSourceTime(target, splitTime);
      const reverse = isReverseVideoClip(target);
      const freeze = isFreezeFrameClip(target);

      const left: VideoTimelineClip = {
        ...target,
        timelineEnd: splitTime,
        sourceIn: freeze
          ? target.sourceIn
          : reverse
            ? sourceSplit
            : target.sourceIn,
        sourceOut: freeze
          ? target.sourceOut
          : reverse
            ? target.sourceOut
            : sourceSplit,
        transformKeyframes: sliceVideoTransformKeyframes(
          target,
          target.timelineStart,
          splitTime,
        ),
        transitionOutType: "none",
        videoFadeOutDuration: 0,
        audioFadeOutDuration: 0,
        // Manual blade boundaries are intentional and must never auto-heal.
        rippleAutoHealOutBoundaryId: undefined,
      };

      const right: VideoTimelineClip = {
        ...target,
        id: rightClipId,
        timelineStart: splitTime,
        sourceIn: freeze
          ? target.sourceIn
          : reverse
            ? target.sourceIn
            : sourceSplit,
        sourceOut: freeze
          ? target.sourceOut
          : reverse
            ? sourceSplit
            : target.sourceOut,
        transformKeyframes: sliceVideoTransformKeyframes(
          target,
          splitTime,
          target.timelineEnd,
        ),
        transitionInType: "none",
        videoFadeInDuration: 0,
        audioFadeInDuration: 0,
        rippleAutoHealInBoundaryId: undefined,
      };

      window.requestAnimationFrame(() => {
        setSelectedVideoClipId(right.id);
        setSelectedVideoClipIds([right.id]);
      });

      return sortVideoClips(
        current.flatMap((clip) => (clip.id === id ? [left, right] : [clip])),
      );
    });
  };

  const insertVideoClipCopy = (
    sourceClip: VideoTimelineClip,
    requestedTimelineStart: number,
    requestedTrackId: TimelineTrackId = sourceClip.trackId,
  ) => {
    const newId = crypto.randomUUID();

    setVideoClips((current) => {
      const clipDuration = Math.max(
        MIN_VIDEO_CLIP_DURATION,
        sourceClip.timelineEnd - sourceClip.timelineStart,
      );
      const trackId = normalizeVideoTrackId(requestedTrackId);

      if (rippleMode) {
        const result = rippleInsertVideoClipGroup(
          current,
          [
            {
              ...sourceClip,
              trackId,
              timelineEnd: sourceClip.timelineStart + clipDuration,
            },
          ],
          requestedTimelineStart,
          {
            requestedTrackId: trackId,
            createId: () => newId,
          },
        );

        window.requestAnimationFrame(() => {
          setSelectedVideoClipId(newId);
          setSelectedVideoClipIds([newId]);
        });

        return result.clips;
      }

      const timelineStart = findNextAvailableTimelineStart(
        current,
        trackId,
        requestedTimelineStart,
        clipDuration,
      );

      const copy: VideoTimelineClip = {
        ...stripRippleAutoHealMetadata(sourceClip),
        id: newId,
        trackId,
        timelineStart,
        timelineEnd: timelineStart + clipDuration,
      };

      window.requestAnimationFrame(() => {
        setSelectedVideoClipId(newId);
        setSelectedVideoClipIds([newId]);
      });

      return sortVideoClips([...current, copy]);
    });
  };

  const duplicateVideoClip = (id: string) => {
    const newId = crypto.randomUUID();

    setVideoClips((current) => {
      const sourceClip = current.find((clip) => clip.id === id);

      if (!sourceClip) {
        return current;
      }

      const clipDuration = Math.max(
        MIN_VIDEO_CLIP_DURATION,
        sourceClip.timelineEnd - sourceClip.timelineStart,
      );
      const trackId = normalizeVideoTrackId(sourceClip.trackId);

      if (rippleMode) {
        const result = rippleInsertVideoClipGroup(
          current,
          [sourceClip],
          sourceClip.timelineEnd,
          {
            requestedTrackId: trackId,
            createId: () => newId,
          },
        );

        window.requestAnimationFrame(() => {
          setSelectedVideoClipId(newId);
          setSelectedVideoClipIds([newId]);
        });

        return result.clips;
      }

      const timelineStart = findNextAvailableTimelineStart(
        current,
        trackId,
        sourceClip.timelineEnd,
        clipDuration,
      );

      const copy: VideoTimelineClip = {
        ...stripRippleAutoHealMetadata(sourceClip),
        id: newId,
        trackId,
        timelineStart,
        timelineEnd: timelineStart + clipDuration,
      };

      window.requestAnimationFrame(() => {
        setSelectedVideoClipId(newId);
        setSelectedVideoClipIds([newId]);
      });

      return sortVideoClips([...current, copy]);
    });
  };

  const insertVideoClipFromMedia = (
    asset: ProjectMediaAsset,
    requestedTimelineStart: number,
    requestedTrackId: TimelineTrackId = DEFAULT_VIDEO_TRACK_ID,
  ) => {
    if (asset.duration <= 0) {
      return;
    }

    const newId = crypto.randomUUID();
    const trackId = normalizeVideoTrackId(requestedTrackId);

    setVideoClips((current) => {
      const timelineStart = rippleMode
        ? Math.max(0, requestedTimelineStart)
        : findNextAvailableTimelineStart(
            current,
            trackId,
            requestedTimelineStart,
            asset.duration,
          );

      const clip: VideoTimelineClip = {
        id: newId,
        kind: "video",
        trackId,
        sourceId: asset.id,
        sourcePath: asset.path,
        sourceName: asset.name,
        sourceIn: 0,
        sourceOut: asset.duration,
        sourceDuration: asset.duration,
        playbackRate: 1,
        positionX: 0,
        positionY: 0,
        scale: 100,
        rotation: 0,
        opacity: 100,
        cropTop: 0,
        cropRight: 0,
        cropBottom: 0,
        cropLeft: 0,
        transitionInType: "none",
        transitionInDuration: 0.5,
        transitionOutType: "none",
        transitionOutDuration: 0.5,
        videoFadeInDuration: 0,
        videoFadeOutDuration: 0,
        audioVolume: 100,
        audioMuted: false,
        audioFadeInDuration: 0,
        audioFadeOutDuration: 0,
        timelineStart,
        timelineEnd: timelineStart + asset.duration,
      };

      window.requestAnimationFrame(() => {
        setSelectedVideoClipId(newId);
        setSelectedVideoClipIds([newId]);
      });

      if (rippleMode) {
        return rippleInsertVideoClipGroup(current, [clip], timelineStart, {
          requestedTrackId: trackId,
          preserveIds: true,
        }).clips;
      }

      return sortVideoClips([...current, clip]);
    });
  };

  const insertVideoClipCopies = (
    sourceClips: VideoTimelineClip[],
    requestedTimelineStart: number,
    requestedTrackId?: TimelineTrackId,
  ) => {
    if (sourceClips.length === 0) {
      return [] as string[];
    }

    const sourceTrackIds = [
      ...new Set(sourceClips.map((clip) => clip.trackId)),
    ];
    const canRetargetSingleTrack =
      requestedTrackId && sourceTrackIds.length === 1;
    const prepared = sourceClips.map((clip) => ({
      ...clip,
      trackId: canRetargetSingleTrack
        ? normalizeVideoTrackId(requestedTrackId)
        : normalizeVideoTrackId(clip.trackId),
    }));
    const newIds = prepared.map(() => crypto.randomUUID());

    setVideoClips((current) => {
      if (rippleMode) {
        let idIndex = 0;
        const result = rippleInsertVideoClipGroup(
          current,
          prepared,
          requestedTimelineStart,
          {
            requestedTrackId: canRetargetSingleTrack
              ? normalizeVideoTrackId(requestedTrackId)
              : undefined,
            createId: () => newIds[idIndex++] ?? crypto.randomUUID(),
          },
        );

        window.requestAnimationFrame(() => {
          setSelectedVideoClipIds(result.insertedIds);
          setSelectedVideoClipId(result.insertedIds[0] ?? null);
        });

        return result.clips;
      }

      const shift = findNextAvailableVideoClipGroupShift(
        current,
        prepared,
        requestedTimelineStart,
      );

      const copies = prepared.map((clip, index) => ({
        ...stripRippleAutoHealMetadata(clip),
        id: newIds[index],
        timelineStart: clip.timelineStart + shift,
        timelineEnd: clip.timelineEnd + shift,
      }));

      window.requestAnimationFrame(() => {
        setSelectedVideoClipIds(newIds);
        setSelectedVideoClipId(newIds[0] ?? null);
      });

      return sortVideoClips([...current, ...copies]);
    });

    return newIds;
  };

  const updateVideoClipPlaybackRate = (id: string, requestedRate: number) => {
    const normalizedRate = normalizeVideoPlaybackRate(requestedRate);

    setVideoClips((current) => {
      const target = current.find((clip) => clip.id === id);

      if (!target || isFreezeFrameClip(target)) {
        return current;
      }

      const sourceSpan = Math.max(0, target.sourceOut - target.sourceIn);
      if (sourceSpan <= 0) {
        return current;
      }

      const nextRate = normalizedRate;
      const oldDuration = target.timelineEnd - target.timelineStart;
      const nextDuration = sourceSpan / nextRate;

      if (nextDuration < MIN_VIDEO_CLIP_DURATION) {
        return current;
      }

      const nextTimelineEnd = target.timelineStart + nextDuration;
      const durationDelta = nextDuration - oldDuration;

      if (!rippleMode) {
        const overlaps = clipsOnTrack(current, target.trackId, id).some(
          (clip) =>
            nextTimelineEnd > clip.timelineStart + 0.000001 &&
            target.timelineStart < clip.timelineEnd - 0.000001,
        );

        if (overlaps) {
          return current;
        }
      }

      const maxTransitionDuration = Math.max(
        0.1,
        Math.min(5, nextDuration / 2),
      );
      const updatedTarget: VideoTimelineClip = {
        ...target,
        playbackRate: nextRate,
        timelineEnd: nextTimelineEnd,
        transformKeyframes: retimeVideoTransformKeyframes(
          target.transformKeyframes,
          oldDuration,
          nextDuration,
        ),
        transitionInDuration: Math.min(
          target.transitionInDuration ?? 0.5,
          maxTransitionDuration,
        ),
        transitionOutDuration: Math.min(
          target.transitionOutDuration ?? 0.5,
          maxTransitionDuration,
        ),
        videoFadeInDuration: Math.min(
          target.videoFadeInDuration ?? 0,
          nextDuration,
        ),
        videoFadeOutDuration: Math.min(
          target.videoFadeOutDuration ?? 0,
          nextDuration,
        ),
        audioFadeInDuration: Math.min(
          target.audioFadeInDuration ?? 0,
          nextDuration,
        ),
        audioFadeOutDuration: Math.min(
          target.audioFadeOutDuration ?? 0,
          nextDuration,
        ),
      };

      return sortVideoClips(
        current.map((clip) => {
          if (clip.id === id) {
            return updatedTarget;
          }

          if (
            rippleMode &&
            clip.trackId === target.trackId &&
            clip.timelineStart >= target.timelineEnd - 0.000001
          ) {
            return {
              ...clip,
              timelineStart: Math.max(0, clip.timelineStart + durationDelta),
              timelineEnd: Math.max(0, clip.timelineEnd + durationDelta),
            };
          }

          return clip;
        }),
      );
    });
  };

  const toggleVideoClipReverse = (id: string) => {
    setVideoClips((current) =>
      current.map((clip) =>
        clip.id === id && !isFreezeFrameClip(clip)
          ? {
              ...clip,
              playbackDirection: isReverseVideoClip(clip)
                ? "forward"
                : "reverse",
              rippleAutoHealInBoundaryId: undefined,
              rippleAutoHealOutBoundaryId: undefined,
            }
          : clip,
      ),
    );
  };

  const insertVideoFreezeFrame = (
    id: string,
    timelineTime: number,
    holdDuration = 2,
  ) => {
    const freezeId = crypto.randomUUID();
    const rightId = crypto.randomUUID();
    const safeHoldDuration = Math.max(MIN_VIDEO_CLIP_DURATION, holdDuration);

    setVideoClips((current) => {
      const target = current.find((clip) => clip.id === id);
      if (
        !target ||
        isFreezeFrameClip(target) ||
        timelineTime <= target.timelineStart + MIN_VIDEO_CLIP_DURATION ||
        timelineTime >= target.timelineEnd - MIN_VIDEO_CLIP_DURATION
      ) {
        return current;
      }

      const sourceSplit = timelineTimeToSourceTime(target, timelineTime);
      const reverse = isReverseVideoClip(target);
      const sourceDurationForFrame = Math.max(
        target.sourceDuration ?? target.sourceOut,
        target.sourceOut,
      );
      const frameSpan = Math.min(
        1 / 30,
        Math.max(0.001, sourceDurationForFrame),
      );
      const frameIn = Math.max(
        0,
        Math.min(sourceSplit, Math.max(0, sourceDurationForFrame - frameSpan)),
      );
      const frameOut = Math.min(sourceDurationForFrame, frameIn + frameSpan);

      // Reuse the existing auto-heal boundary metadata for Freeze insertion.
      // The two source-contiguous fragments can then be restored if the HOLD
      // clip is later deleted while the generated boundary is still untouched.
      const freezeHealBoundaryId = `freeze-heal:${freezeId}`;

      const left: VideoTimelineClip = {
        ...target,
        timelineEnd: timelineTime,
        sourceIn: reverse ? sourceSplit : target.sourceIn,
        sourceOut: reverse ? target.sourceOut : sourceSplit,
        transformKeyframes: sliceVideoTransformKeyframes(
          target,
          target.timelineStart,
          timelineTime,
        ),
        transitionOutType: "none",
        videoFadeOutDuration: 0,
        audioFadeOutDuration: 0,
        rippleAutoHealOutBoundaryId: freezeHealBoundaryId,
      };

      const evaluated = withEvaluatedVideoTransform(target, timelineTime);
      const freezeClip: VideoTimelineClip = {
        ...stripRippleAutoHealMetadata(evaluated),
        id: freezeId,
        timelineStart: timelineTime,
        timelineEnd: timelineTime + safeHoldDuration,
        sourceIn: frameIn,
        sourceOut: Math.max(frameIn + 0.001, frameOut),
        playbackRate: 1,
        playbackDirection: "forward",
        freezeFrameSourceTime: sourceSplit,
        transformKeyframes: undefined,
        transitionInType: "none",
        transitionOutType: "none",
        videoFadeInDuration: 0,
        videoFadeOutDuration: 0,
        audioMuted: true,
        audioFadeInDuration: 0,
        audioFadeOutDuration: 0,
      };

      const right: VideoTimelineClip = {
        ...target,
        id: rightId,
        timelineStart: timelineTime + safeHoldDuration,
        timelineEnd: target.timelineEnd + safeHoldDuration,
        sourceIn: reverse ? target.sourceIn : sourceSplit,
        sourceOut: reverse ? sourceSplit : target.sourceOut,
        transformKeyframes: sliceVideoTransformKeyframes(
          target,
          timelineTime,
          target.timelineEnd,
        ),
        transitionInType: "none",
        videoFadeInDuration: 0,
        audioFadeInDuration: 0,
        rippleAutoHealInBoundaryId: freezeHealBoundaryId,
      };

      const shifted = current.flatMap((clip) => {
        if (clip.id === id) return [left, freezeClip, right];
        if (
          clip.trackId === target.trackId &&
          clip.timelineStart >= target.timelineEnd - 0.000001
        ) {
          return [
            {
              ...clip,
              timelineStart: clip.timelineStart + safeHoldDuration,
              timelineEnd: clip.timelineEnd + safeHoldDuration,
            },
          ];
        }
        return [clip];
      });

      window.requestAnimationFrame(() => {
        setSelectedVideoClipId(freezeId);
        setSelectedVideoClipIds([freezeId]);
      });

      return sortVideoClips(shifted);
    });

    return freezeId;
  };

  const updateVideoClipTransform = (
    id: string,
    transform: {
      positionX?: number;
      positionY?: number;
      scale?: number;
      rotation?: number;
      opacity?: number;
      cropTop?: number;
      cropRight?: number;
      cropBottom?: number;
      cropLeft?: number;
    },
    timelineTime?: number,
  ) => {
    setVideoClips((current) =>
      current.map((clip) => {
        if (clip.id !== id) return clip;

        let next = clip;
        const animatedTime = timelineTime ?? clip.timelineStart;
        const animatedProperties: VideoTransformKeyframeProperty[] = [
          "positionX",
          "positionY",
          "scale",
          "rotation",
          "opacity",
        ];

        for (const property of animatedProperties) {
          const value = transform[property];
          if (value !== undefined) {
            next = setVideoTransformPropertyAtTime(
              next,
              property,
              animatedTime,
              value,
            );
          }
        }

        const clampCrop = (value: number) => Math.max(0, Math.min(49, value));
        return {
          ...next,
          cropTop:
            transform.cropTop === undefined
              ? (next.cropTop ?? 0)
              : clampCrop(transform.cropTop),
          cropRight:
            transform.cropRight === undefined
              ? (next.cropRight ?? 0)
              : clampCrop(transform.cropRight),
          cropBottom:
            transform.cropBottom === undefined
              ? (next.cropBottom ?? 0)
              : clampCrop(transform.cropBottom),
          cropLeft:
            transform.cropLeft === undefined
              ? (next.cropLeft ?? 0)
              : clampCrop(transform.cropLeft),
        };
      }),
    );
  };

  const updateVideoClipEffects = (
    id: string,
    effects: VideoEffectInstance[],
  ) => {
    setVideoClips((current) =>
      current.map((clip) =>
        clip.id === id
          ? {
              ...clip,
              effects:
                effects.length > 0
                  ? effects.map((effect) => ({ ...effect }))
                  : undefined,
            }
          : clip,
      ),
    );
  };

  const updateVideoClipMask = (id: string, mask: VideoMask | undefined) => {
    setVideoClips((current) =>
      current.map((clip) =>
        clip.id === id
          ? { ...clip, mask: mask ? { ...mask } : undefined }
          : clip,
      ),
    );
  };

  const updateVideoClipBlendMode = (id: string, blendMode: VideoBlendMode) => {
    setVideoClips((current) =>
      current.map((clip) => (clip.id === id ? { ...clip, blendMode } : clip)),
    );
  };

  const toggleVideoClipTransformKeyframe = (
    id: string,
    property: VideoTransformKeyframeProperty,
    timelineTime: number,
  ) => {
    setVideoClips((current) =>
      current.map((clip) =>
        clip.id === id
          ? toggleVideoTransformKeyframeAtTime(clip, property, timelineTime)
          : clip,
      ),
    );
  };

  const applyVideoClipCropToTrack = (id: string) => {
    setVideoClips((current) => {
      const source = current.find((clip) => clip.id === id);
      if (!source) {
        return current;
      }

      const cropTop = source.cropTop ?? 0;
      const cropRight = source.cropRight ?? 0;
      const cropBottom = source.cropBottom ?? 0;
      const cropLeft = source.cropLeft ?? 0;

      return current.map((clip) =>
        clip.trackId === source.trackId
          ? {
              ...clip,
              cropTop,
              cropRight,
              cropBottom,
              cropLeft,
            }
          : clip,
      );
    });
  };

  const resetVideoClipTransform = (id: string) => {
    setVideoClips((current) =>
      current.map((clip) =>
        clip.id === id
          ? {
              ...clip,
              positionX: 0,
              positionY: 0,
              scale: 100,
              rotation: 0,
              opacity: 100,
              transformKeyframes: undefined,
              cropTop: 0,
              cropRight: 0,
              cropBottom: 0,
              cropLeft: 0,
            }
          : clip,
      ),
    );
  };

  const updateVideoClipTransition = (
    id: string,
    edge: "in" | "out",
    transition: {
      type?: VideoTransitionType;
      duration?: number;
    },
  ) => {
    setVideoClips((current) =>
      current.map((clip) => {
        if (clip.id !== id) {
          return clip;
        }

        const clipDuration = Math.max(
          MIN_VIDEO_CLIP_DURATION,
          clip.timelineEnd - clip.timelineStart,
        );
        const maxTransitionDuration = Math.max(
          0.1,
          Math.min(5, clipDuration / 2),
        );
        const clampDuration = (value: number) =>
          Math.max(0.1, Math.min(maxTransitionDuration, value));

        if (edge === "in") {
          return {
            ...clip,
            transitionInType:
              transition.type ?? clip.transitionInType ?? "none",
            transitionInDuration:
              transition.duration === undefined
                ? (clip.transitionInDuration ?? 0.5)
                : clampDuration(transition.duration),
          };
        }

        return {
          ...clip,
          transitionOutType:
            transition.type ?? clip.transitionOutType ?? "none",
          transitionOutDuration:
            transition.duration === undefined
              ? (clip.transitionOutDuration ?? 0.5)
              : clampDuration(transition.duration),
        };
      }),
    );
  };

  const updateVideoClipOpacityFade = (
    id: string,
    edge: "in" | "out",
    duration: number,
  ) => {
    setVideoClips((current) =>
      current.map((clip) => {
        if (clip.id !== id) {
          return clip;
        }

        const clipDuration = Math.max(
          MIN_VIDEO_CLIP_DURATION,
          clip.timelineEnd - clip.timelineStart,
        );
        const maxFadeDuration = clipDuration;
        const nextDuration = Math.max(0, Math.min(maxFadeDuration, duration));

        return edge === "in"
          ? { ...clip, videoFadeInDuration: nextDuration }
          : { ...clip, videoFadeOutDuration: nextDuration };
      }),
    );
  };

  const updateVideoClipAudio = (
    id: string,
    audio: {
      volume?: number;
      muted?: boolean;
      fadeInDuration?: number;
      fadeOutDuration?: number;
    },
  ) => {
    setVideoClips((current) =>
      current.map((clip) => {
        if (clip.id !== id) {
          return clip;
        }

        const clipDuration = Math.max(
          MIN_VIDEO_CLIP_DURATION,
          clip.timelineEnd - clip.timelineStart,
        );
        const maxFadeDuration = clipDuration;
        const clampFade = (value: number) =>
          Math.max(0, Math.min(maxFadeDuration, value));

        return {
          ...clip,
          audioVolume:
            audio.volume === undefined
              ? (clip.audioVolume ?? 100)
              : Math.max(0, Math.min(100, audio.volume)),
          audioMuted:
            audio.muted === undefined
              ? (clip.audioMuted ?? false)
              : audio.muted,
          audioFadeInDuration:
            audio.fadeInDuration === undefined
              ? (clip.audioFadeInDuration ?? 0)
              : clampFade(audio.fadeInDuration),
          audioFadeOutDuration:
            audio.fadeOutDuration === undefined
              ? (clip.audioFadeOutDuration ?? 0)
              : clampFade(audio.fadeOutDuration),
        };
      }),
    );
  };

  const deleteVideoClips = (ids: string[]) => {
    const removedIds = new Set(ids);

    setVideoClips((current) => {
      // Generated Freeze/HOLD clips are an inverse edit: removing an untouched
      // HOLD should first restore its original source clip regardless of whether
      // Ripple mode is enabled. Do this before applying ordinary Delete
      // semantics to any other selected clips.
      const freezeRestore = deleteVideoClipsWithFreezeAutoRestore(
        current,
        removedIds,
      );
      const restoredFreezeIds = new Set(freezeRestore.restoredFreezeIds);
      const ordinaryRemovedIds = new Set(
        [...removedIds].filter((id) => !restoredFreezeIds.has(id)),
      );

      let next = freezeRestore.clips;

      if (ordinaryRemovedIds.size > 0) {
        next = rippleMode
          ? rippleDeleteVideoClips(next, ordinaryRemovedIds).clips
          : next.filter((clip) => !ordinaryRemovedIds.has(clip.id));
      }

      return healRippleSplitsAndRemapSelection(next);
    });
    setSelectedVideoClipIds((current) =>
      current.filter((id) => !removedIds.has(id)),
    );
    setSelectedVideoClipId((current) =>
      current && removedIds.has(current) ? null : current,
    );
  };

  const deleteVideoClip = (id: string) => {
    deleteVideoClips([id]);
  };

  const deleteVideoTrack = (trackId: TimelineTrackId) => {
    const normalizedTrackId = normalizeVideoTrackId(trackId);

    setVideoClips((current) => {
      const removedIds = new Set(
        current
          .filter((clip) => clip.trackId === normalizedTrackId)
          .map((clip) => clip.id),
      );

      window.requestAnimationFrame(() => {
        setSelectedVideoClipIds((selectedIds) =>
          selectedIds.filter((id) => !removedIds.has(id)),
        );
        setSelectedVideoClipId((selectedId) =>
          selectedId && removedIds.has(selectedId) ? null : selectedId,
        );
      });

      return current.filter((clip) => clip.trackId !== normalizedTrackId);
    });
  };

  return {
    videoClips,
    selectedVideoClipId,
    selectedVideoClipIds,
    selectedVideoClip,

    selectVideoClip,
    selectVideoClips,
    clearVideoClipSelection,

    beginVideoClipMove,
    endVideoClipMove,
    moveVideoClip,
    moveVideoClipToTrack,
    resizeVideoClip,
    splitVideoClip,
    deleteVideoClip,
    deleteVideoClips,
    deleteVideoTrack,
    insertVideoClipCopy,
    insertVideoClipCopies,
    duplicateVideoClip,
    insertVideoClipFromMedia,
    updateVideoClipPlaybackRate,
    toggleVideoClipReverse,
    insertVideoFreezeFrame,
    updateVideoClipTransform,
    updateVideoClipEffects,
    updateVideoClipMask,
    updateVideoClipBlendMode,
    toggleVideoClipTransformKeyframe,
    applyVideoClipCropToTrack,
    resetVideoClipTransform,
    updateVideoClipTransition,
    updateVideoClipOpacityFade,
    updateVideoClipAudio,

    replaceVideoClips,
    initializeDefaultVideoClip,
  };
}
