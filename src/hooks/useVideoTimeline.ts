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

const MIN_VIDEO_CLIP_DURATION = 0.1;
const DEFAULT_VIDEO_TRACK_ID: TimelineTrackId = "video-1";

const VIDEO_TRACK_IDS = new Set<TimelineTrackId>([
  "video-1",
  "video-2",
]);

type UseVideoTimelineOptions = {
  sourcePath: string | null;
  sourceName: string | null;
  sourceDuration: number;
};

function normalizeVideoTrackId(trackId: TimelineTrackId): TimelineTrackId {
  return VIDEO_TRACK_IDS.has(trackId) ? trackId : DEFAULT_VIDEO_TRACK_ID;
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
  };

  const selectVideoClip = (id: string) => {
    setSelectedVideoClipId(id);
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

    setSelectedVideoClipId((current) =>
      current && normalized.some((clip) => clip.id === current)
        ? current
        : null,
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
  };

  const moveVideoClip = (
    id: string,
    requestedTimelineStart: number,
  ) => {
    setVideoClips((current) => {
      const target = current.find((clip) => clip.id === id);

      if (!target) {
        return current;
      }

      const clipDuration = target.timelineEnd - target.timelineStart;
      const trackId = normalizeVideoTrackId(target.trackId);
      const newStart = findNextAvailableTimelineStart(
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
      const timelineStart = findNextAvailableTimelineStart(
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
      };

      const right: VideoTimelineClip = {
        ...target,
        id: crypto.randomUUID(),
        timelineStart: splitTime,
        sourceIn: sourceSplit,
        transitionInType: "none",
      };

      window.requestAnimationFrame(() => {
        setSelectedVideoClipId(right.id);
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
  ) => {
    const newId = crypto.randomUUID();

    setVideoClips((current) => {
      const clipDuration = Math.max(
        MIN_VIDEO_CLIP_DURATION,
        sourceClip.timelineEnd - sourceClip.timelineStart,
      );
      const trackId = normalizeVideoTrackId(sourceClip.trackId);
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
        timelineStart,
        timelineEnd: timelineStart + asset.duration,
      };

      window.requestAnimationFrame(() => {
        setSelectedVideoClipId(newId);
      });

      return sortVideoClips([...current, clip]);
    });
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

  const deleteVideoClip = (id: string) => {
    setVideoClips((current) =>
      current.filter((clip) => clip.id !== id),
    );

    setSelectedVideoClipId((current) =>
      current === id ? null : current,
    );
  };

  return {
    videoClips,
    selectedVideoClipId,
    selectedVideoClip,

    selectVideoClip,
    clearVideoClipSelection,

    moveVideoClip,
    moveVideoClipToTrack,
    resizeVideoClip,
    splitVideoClip,
    deleteVideoClip,
    insertVideoClipCopy,
    duplicateVideoClip,
    insertVideoClipFromMedia,
    updateVideoClipTransform,
    resetVideoClipTransform,
    updateVideoClipTransition,

    replaceVideoClips,
    initializeDefaultVideoClip,
  };
}
