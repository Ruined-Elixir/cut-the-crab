import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ProjectMediaAsset } from "../types/project";
import type { VideoTimelineClip } from "../types/timelineModel";

const MIN_VIDEO_CLIP_DURATION = 0.1;

type UseVideoTimelineOptions = {
  sourcePath: string | null;
  sourceName: string | null;
  sourceDuration: number;
};

function sortVideoClips(clips: VideoTimelineClip[]) {
  return [...clips].sort(
    (a, b) =>
      a.timelineStart - b.timelineStart ||
      a.timelineEnd - b.timelineEnd,
  );
}


function findNextAvailableTimelineStart(
  clips: VideoTimelineClip[],
  requestedStart: number,
  clipDuration: number,
) {
  let start = Math.max(0, requestedStart);
  const sorted = sortVideoClips(clips);

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
    trackId: "video-1",
    sourceId: sourcePath,
    sourcePath,
    sourceName,
    sourceIn: 0,
    sourceOut: sourceDuration,
    sourceDuration,
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

  const initializedSourceRef = useRef<string | null>(
    null,
  );

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
  }, [
    sourcePath,
    sourceName,
    sourceDuration,
  ]);

  const selectedVideoClip = useMemo(
    () =>
      videoClips.find(
        (clip) =>
          clip.id === selectedVideoClipId,
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
    options?: { markSourceInitialized?: boolean },
  ) => {
    if (sourcePath && options?.markSourceInitialized) {
      initializedSourceRef.current = sourcePath;
    }

    setVideoClips(sortVideoClips(clips));

    setSelectedVideoClipId((current) =>
      current &&
      clips.some((clip) => clip.id === current)
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
      const target = current.find(
        (clip) => clip.id === id,
      );

      if (!target) {
        return current;
      }

      const clipDuration =
        target.timelineEnd -
        target.timelineStart;

      let newStart = Math.max(0, requestedTimelineStart);

      const others = current.filter(
        (clip) => clip.id !== id,
      );

      for (const other of others) {
        const newEnd = newStart + clipDuration;

        if (
          newEnd <= other.timelineStart ||
          newStart >= other.timelineEnd
        ) {
          continue;
        }

        const left =
          other.timelineStart - clipDuration;
        const right = other.timelineEnd;

        newStart =
          Math.abs(requestedTimelineStart - left) <=
          Math.abs(requestedTimelineStart - right)
            ? left
            : right;

        newStart = Math.max(0, newStart);
      }

      return sortVideoClips(
        current.map((clip) =>
          clip.id === id
            ? {
                ...clip,
                timelineStart: newStart,
                timelineEnd:
                  newStart + clipDuration,
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
      const target = current.find(
        (clip) => clip.id === id,
      );

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

      const sourceStartDelta =
        nextStart - target.timelineStart;
      const sourceEndDelta =
        nextEnd - target.timelineEnd;

      const nextSourceIn =
        target.sourceIn + sourceStartDelta;

      const nextSourceOut =
        target.sourceOut + sourceEndDelta;

      if (
        nextSourceOut - nextSourceIn <
        MIN_VIDEO_CLIP_DURATION
      ) {
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
      const target = current.find(
        (clip) => clip.id === id,
      );

      if (!target) {
        return current;
      }

      if (
        splitTime <=
          target.timelineStart +
            MIN_VIDEO_CLIP_DURATION ||
        splitTime >=
          target.timelineEnd -
            MIN_VIDEO_CLIP_DURATION
      ) {
        return current;
      }

      const sourceSplit =
        target.sourceIn +
        (splitTime - target.timelineStart);

      const left: VideoTimelineClip = {
        ...target,
        timelineEnd: splitTime,
        sourceOut: sourceSplit,
      };

      const right: VideoTimelineClip = {
        ...target,
        id: crypto.randomUUID(),
        timelineStart: splitTime,
        sourceIn: sourceSplit,
      };

      window.requestAnimationFrame(() => {
        setSelectedVideoClipId(right.id);
      });

      return sortVideoClips(
        current.flatMap((clip) =>
          clip.id === id
            ? [left, right]
            : [clip],
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

      const timelineStart = findNextAvailableTimelineStart(
        current,
        requestedTimelineStart,
        clipDuration,
      );

      const copy: VideoTimelineClip = {
        ...sourceClip,
        id: newId,
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

      const timelineStart = findNextAvailableTimelineStart(
        current,
        sourceClip.timelineEnd,
        clipDuration,
      );

      const copy: VideoTimelineClip = {
        ...sourceClip,
        id: newId,
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
  ) => {
    if (asset.duration <= 0) {
      return;
    }

    const newId = crypto.randomUUID();

    setVideoClips((current) => {
      const timelineStart = findNextAvailableTimelineStart(
        current,
        requestedTimelineStart,
        asset.duration,
      );

      const clip: VideoTimelineClip = {
        id: newId,
        kind: "video",
        trackId: "video-1",
        sourceId: asset.id,
        sourcePath: asset.path,
        sourceName: asset.name,
        sourceIn: 0,
        sourceOut: asset.duration,
        sourceDuration: asset.duration,
        timelineStart,
        timelineEnd: timelineStart + asset.duration,
      };

      window.requestAnimationFrame(() => {
        setSelectedVideoClipId(newId);
      });

      return sortVideoClips([...current, clip]);
    });
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
    resizeVideoClip,
    splitVideoClip,
    deleteVideoClip,
    insertVideoClipCopy,
    duplicateVideoClip,
    insertVideoClipFromMedia,

    replaceVideoClips,
    initializeDefaultVideoClip,
  };
}
