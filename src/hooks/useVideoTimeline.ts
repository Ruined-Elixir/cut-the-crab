import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ProjectMediaAsset } from "../types/project";
import type {
  TimelineTrackId,
  VideoTimelineClip,
  VideoTransitionType,
} from "../types/timelineModel";
import {
  clampVideoClipGroupMoveDelta,
  findNextAvailableVideoClipGroupShift,
} from "../utils/timelineMultiClip";

const MIN_VIDEO_CLIP_DURATION = 0.1;
const DEFAULT_VIDEO_TRACK_ID: TimelineTrackId = "video-1";

const VIDEO_TRACK_ID_PATTERN = /^video-(\d+)$/;

type UseVideoTimelineOptions = {
  sourcePath: string | null;
  sourceName: string | null;
  sourceDuration: number;
};

function normalizeVideoTrackId(trackId: TimelineTrackId): TimelineTrackId {
  return VIDEO_TRACK_ID_PATTERN.test(trackId) ? trackId : DEFAULT_VIDEO_TRACK_ID;
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
    (clip) =>
      clip.trackId === trackId &&
      clip.id !== excludedClipId,
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
  const sorted = sortVideoClips(
    clipsOnTrack(clips, trackId, excludedClipId),
  );

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
  const sorted = sortVideoClips(
    clipsOnTrack(clips, trackId, excludedClipId),
  );

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
    positionX: 0,
    positionY: 0,
    scale: 100,
    rotation: 0,
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
}: UseVideoTimelineOptions) {
  const [videoClips, setVideoClips] =
    useState<VideoTimelineClip[]>([]);

  const [
    selectedVideoClipId,
    setSelectedVideoClipId,
  ] = useState<string | null>(null);
  const [selectedVideoClipIds, setSelectedVideoClipIds] = useState<string[]>([]);

  const groupMoveOriginRef = useRef<{
    anchorId: string;
    selectedClips: VideoTimelineClip[];
  } | null>(null);
  const initializedSourceRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      !sourcePath ||
      !sourceName ||
      sourceDuration <= 0
    ) {
      return;
    }

    if (initializedSourceRef.current === sourcePath) {
      return;
    }

    initializedSourceRef.current = sourcePath;

    setVideoClips([
      createFullSourceClip(
        sourcePath,
        sourceName,
        sourceDuration,
      ),
    ]);

    setSelectedVideoClipId(null);
    setSelectedVideoClipIds([]);
  }, [sourcePath, sourceName, sourceDuration]);

  const selectedVideoClip = useMemo(
    () =>
      videoClips.find(
        (clip) => clip.id === selectedVideoClipId,
      ) ?? null,
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
          primary === id ? next[next.length - 1] ?? null : primary,
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
        : unique[unique.length - 1] ?? null;

    setSelectedVideoClipIds(unique);
    setSelectedVideoClipId(primary);
  };

  const replaceVideoClips = (
    clips: VideoTimelineClip[],
    options?: { markSourceInitializedFor?: string },
  ) => {
    if (options?.markSourceInitializedFor) {
      initializedSourceRef.current = options.markSourceInitializedFor;
    }

    const normalized = clips.map((clip) => ({
      ...clip,
      trackId: normalizeVideoTrackId(clip.trackId),
    }));

    setVideoClips(sortVideoClips(normalized));

    const availableIds = new Set(normalized.map((clip) => clip.id));

    setSelectedVideoClipIds((current) => current.filter((id) => availableIds.has(id)));
    setSelectedVideoClipId((current) =>
      current && availableIds.has(current) ? current : null,
    );
  };

  const initializeDefaultVideoClip = () => {
    if (
      !sourcePath ||
      !sourceName ||
      sourceDuration <= 0 ||
      initializedSourceRef.current === sourcePath
    ) {
      return;
    }

    initializedSourceRef.current = sourcePath;

    setVideoClips([
      createFullSourceClip(
        sourcePath,
        sourceName,
        sourceDuration,
      ),
    ]);

    setSelectedVideoClipId(null);
    setSelectedVideoClipIds([]);
  };

  const beginVideoClipMove = (id: string) => {
    if (!selectedVideoClipIds.includes(id) || selectedVideoClipIds.length <= 1) {
      groupMoveOriginRef.current = null;
      return;
    }

    const selectedSet = new Set(selectedVideoClipIds);
    groupMoveOriginRef.current = {
      anchorId: id,
      selectedClips: videoClips
        .filter((clip) => selectedSet.has(clip.id))
        .map((clip) => ({ ...clip })),
    };
  };

  const endVideoClipMove = () => {
    groupMoveOriginRef.current = null;
  };

  const moveVideoClip = (
    id: string,
    requestedTimelineStart: number,
  ) => {
    setVideoClips((current) => {
      const groupOrigin = groupMoveOriginRef.current;

      if (groupOrigin?.anchorId === id && groupOrigin.selectedClips.length > 1) {
        const anchor = groupOrigin.selectedClips.find((clip) => clip.id === id);

        if (!anchor) {
          return current;
        }

        const selectedSet = new Set(groupOrigin.selectedClips.map((clip) => clip.id));
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

        return sortVideoClips(
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

      return sortVideoClips(
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
      );
    });
  };

  const moveVideoClipToTrack = (
    id: string,
    targetTrackId: TimelineTrackId,
    requestedTimelineStart?: number,
  ) => {
    const normalizedTrackId = normalizeVideoTrackId(targetTrackId);

    setVideoClips((current) => {
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

      return sortVideoClips(
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
      );
    });
  };

  const resizeVideoClip = (
    id: string,
    newTimelineStart: number,
    newTimelineEnd: number,
  ) => {
    setVideoClips((current) => {
      const target = current.find((clip) => clip.id === id);

      if (!target) {
        return current;
      }

      const earliestTimelineStart = Math.max(
        0,
        target.timelineStart - target.sourceIn,
      );

      const clipSourceDuration =
        target.sourceDuration ?? sourceDuration;

      const latestTimelineEnd =
        target.timelineEnd +
        Math.max(0, clipSourceDuration - target.sourceOut);

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

      const nextSourceIn = target.sourceIn + sourceStartDelta;
      const nextSourceOut = target.sourceOut + sourceEndDelta;

      if (
        nextSourceOut - nextSourceIn < MIN_VIDEO_CLIP_DURATION
      ) {
        return current;
      }

      const sameTrackClips = clipsOnTrack(
        current,
        target.trackId,
        id,
      );

      const overlaps = sameTrackClips.some(
        (clip) =>
          nextEnd > clip.timelineStart &&
          nextStart < clip.timelineEnd,
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
              }
            : clip,
        ),
      );
    });
  };

  const splitVideoClip = (
    id: string,
    splitTime: number,
  ) => {
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

      const sourceSplit =
        target.sourceIn + (splitTime - target.timelineStart);

      const left: VideoTimelineClip = {
        ...target,
        timelineEnd: splitTime,
        sourceOut: sourceSplit,
        transitionOutType: "none",
        videoFadeOutDuration: 0,
        audioFadeOutDuration: 0,
      };

      const right: VideoTimelineClip = {
        ...target,
        id: crypto.randomUUID(),
        timelineStart: splitTime,
        sourceIn: sourceSplit,
        transitionInType: "none",
        videoFadeInDuration: 0,
        audioFadeInDuration: 0,
      };

      window.requestAnimationFrame(() => {
        setSelectedVideoClipId(right.id);
        setSelectedVideoClipIds([right.id]);
      });

      return sortVideoClips(
        current.flatMap((clip) =>
          clip.id === id ? [left, right] : [clip],
        ),
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
      const timelineStart = findNextAvailableTimelineStart(
        current,
        trackId,
        requestedTimelineStart,
        clipDuration,
      );

      const copy: VideoTimelineClip = {
        ...sourceClip,
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
      const timelineStart = findNextAvailableTimelineStart(
        current,
        trackId,
        sourceClip.timelineEnd,
        clipDuration,
      );

      const copy: VideoTimelineClip = {
        ...sourceClip,
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
      const timelineStart = findNextAvailableTimelineStart(
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
        positionX: 0,
        positionY: 0,
        scale: 100,
        rotation: 0,
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

    const sourceTrackIds = [...new Set(sourceClips.map((clip) => clip.trackId))];
    const canRetargetSingleTrack = requestedTrackId && sourceTrackIds.length === 1;
    const prepared = sourceClips.map((clip) => ({
      ...clip,
      trackId: canRetargetSingleTrack
        ? normalizeVideoTrackId(requestedTrackId)
        : normalizeVideoTrackId(clip.trackId),
    }));
    const newIds = prepared.map(() => crypto.randomUUID());

    setVideoClips((current) => {
      const shift = findNextAvailableVideoClipGroupShift(
        current,
        prepared,
        requestedTimelineStart,
      );

      const copies = prepared.map((clip, index) => ({
        ...clip,
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

  const updateVideoClipTransform = (
    id: string,
    transform: {
      positionX?: number;
      positionY?: number;
      scale?: number;
      rotation?: number;
      cropTop?: number;
      cropRight?: number;
      cropBottom?: number;
      cropLeft?: number;
    },
  ) => {
    setVideoClips((current) =>
      current.map((clip) => {
        if (clip.id !== id) {
          return clip;
        }

        const nextPositionX =
          transform.positionX === undefined
            ? clip.positionX ?? 0
            : Math.max(-100, Math.min(100, transform.positionX));
        const nextPositionY =
          transform.positionY === undefined
            ? clip.positionY ?? 0
            : Math.max(-100, Math.min(100, transform.positionY));
        const nextScale =
          transform.scale === undefined
            ? clip.scale ?? 100
            : Math.max(10, Math.min(400, transform.scale));
        const nextRotation =
          transform.rotation === undefined
            ? clip.rotation ?? 0
            : Math.max(-180, Math.min(180, transform.rotation));
        const clampCrop = (value: number) => Math.max(0, Math.min(49, value));
        const nextCropTop =
          transform.cropTop === undefined ? clip.cropTop ?? 0 : clampCrop(transform.cropTop);
        const nextCropRight =
          transform.cropRight === undefined ? clip.cropRight ?? 0 : clampCrop(transform.cropRight);
        const nextCropBottom =
          transform.cropBottom === undefined ? clip.cropBottom ?? 0 : clampCrop(transform.cropBottom);
        const nextCropLeft =
          transform.cropLeft === undefined ? clip.cropLeft ?? 0 : clampCrop(transform.cropLeft);

        return {
          ...clip,
          positionX: nextPositionX,
          positionY: nextPositionY,
          scale: nextScale,
          rotation: nextRotation,
          cropTop: nextCropTop,
          cropRight: nextCropRight,
          cropBottom: nextCropBottom,
          cropLeft: nextCropLeft,
        };
      }),
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
    updateVideoClipTransform(id, {
      positionX: 0,
      positionY: 0,
      scale: 100,
      rotation: 0,
      cropTop: 0,
      cropRight: 0,
      cropBottom: 0,
      cropLeft: 0,
    });
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
            transitionInType: transition.type ?? clip.transitionInType ?? "none",
            transitionInDuration:
              transition.duration === undefined
                ? clip.transitionInDuration ?? 0.5
                : clampDuration(transition.duration),
          };
        }

        return {
          ...clip,
          transitionOutType: transition.type ?? clip.transitionOutType ?? "none",
          transitionOutDuration:
            transition.duration === undefined
              ? clip.transitionOutDuration ?? 0.5
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
              ? clip.audioVolume ?? 100
              : Math.max(0, Math.min(100, audio.volume)),
          audioMuted:
            audio.muted === undefined
              ? clip.audioMuted ?? false
              : audio.muted,
          audioFadeInDuration:
            audio.fadeInDuration === undefined
              ? clip.audioFadeInDuration ?? 0
              : clampFade(audio.fadeInDuration),
          audioFadeOutDuration:
            audio.fadeOutDuration === undefined
              ? clip.audioFadeOutDuration ?? 0
              : clampFade(audio.fadeOutDuration),
        };
      }),
    );
  };

  const deleteVideoClips = (ids: string[]) => {
    const removedIds = new Set(ids);

    setVideoClips((current) => current.filter((clip) => !removedIds.has(clip.id)));
    setSelectedVideoClipIds((current) => current.filter((id) => !removedIds.has(id)));
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
    updateVideoClipTransform,
    applyVideoClipCropToTrack,
    resetVideoClipTransform,
    updateVideoClipTransition,
    updateVideoClipOpacityFade,
    updateVideoClipAudio,

    replaceVideoClips,
    initializeDefaultVideoClip,
  };
}
