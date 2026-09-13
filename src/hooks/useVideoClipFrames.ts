import { useEffect, useMemo, useRef, useState } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";

import type { VideoTimelineClip } from "../types/timelineModel";

export type VideoClipFrame = {
  sourceTime: number;
  url: string;
  leftPercent: number;
  widthPercent: number;
  exact: boolean;
};

export type VideoClipFrames = Record<string, VideoClipFrame[]>;

type SampledFrame = {
  time: number;
  url: string;
};

type SourceFrameCacheEntry = {
  duration: number;
  frames: SampledFrame[];
};

type ClipFramePlan = {
  clipId: string;
  sourcePath: string;
  sourceIn: number;
  sourceOut: number;
  targetTimes: number[];
};

type SourceFramePlan = {
  sourcePath: string;
  expectedDuration: number;
  targetTimes: number[];
};

const FRAME_TILE_WIDTH_PX = 78;
const MAX_CLIP_FRAME_SLOTS = 220;
const FRAME_WIDTH = 128;
const JPEG_QUALITY = 0.7;
const FRAME_PAINT_DELAY_MS = 34;
const FRAME_MATCH_MIN_TOLERANCE = 0.035;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clipDuration(clip: VideoTimelineClip) {
  return Math.max(0, clip.timelineEnd - clip.timelineStart);
}

function sourceDurationForClip(clip: VideoTimelineClip) {
  if (
    typeof clip.sourceDuration === "number" &&
    Number.isFinite(clip.sourceDuration) &&
    clip.sourceDuration > 0
  ) {
    return clip.sourceDuration;
  }

  return Math.max(clip.sourceOut, 0);
}

function desiredSlotCount(
  clip: VideoTimelineClip,
  timelineDuration: number,
  timelineTrackWidthPx: number,
) {
  if (timelineDuration <= 0 || timelineTrackWidthPx <= 0) {
    return 1;
  }

  const pixelWidth =
    (clipDuration(clip) / timelineDuration) * timelineTrackWidthPx;

  return clamp(
    Math.ceil(pixelWidth / FRAME_TILE_WIDTH_PX),
    1,
    MAX_CLIP_FRAME_SLOTS,
  );
}

function buildClipPlan(
  clip: VideoTimelineClip,
  timelineDuration: number,
  timelineTrackWidthPx: number,
): ClipFramePlan {
  const slotCount = desiredSlotCount(
    clip,
    timelineDuration,
    timelineTrackWidthPx,
  );
  const sourceDuration = Math.max(0, clip.sourceOut - clip.sourceIn);
  const targetTimes = Array.from({ length: slotCount }, (_, index) => {
    const ratio = (index + 0.5) / slotCount;
    return clip.sourceIn + sourceDuration * ratio;
  });

  return {
    clipId: clip.id,
    sourcePath: clip.sourcePath,
    sourceIn: clip.sourceIn,
    sourceOut: clip.sourceOut,
    targetTimes,
  };
}

function mergeTargetTimes(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  const result: number[] = [];

  for (const time of sorted) {
    const previous = result[result.length - 1];

    if (previous === undefined || Math.abs(previous - time) > 0.018) {
      result.push(time);
    }
  }

  return result;
}

function spreadOrder<T>(items: T[]) {
  if (items.length <= 2) {
    return [...items];
  }

  const result: T[] = [];
  const seen = new Set<number>();
  const queue: Array<[number, number]> = [[0, items.length - 1]];

  const pushIndex = (index: number) => {
    if (!seen.has(index)) {
      seen.add(index);
      result.push(items[index]);
    }
  };

  pushIndex(0);
  pushIndex(items.length - 1);

  while (queue.length > 0) {
    const [start, end] = queue.shift()!;

    if (end - start <= 1) {
      continue;
    }

    const middle = Math.floor((start + end) / 2);
    pushIndex(middle);
    queue.push([start, middle], [middle, end]);
  }

  return result;
}

function waitForEvent(
  target: HTMLMediaElement,
  eventName: "loadedmetadata" | "loadeddata" | "seeked",
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(eventName, handleEvent);
      target.removeEventListener("error", handleError);
      signal.removeEventListener("abort", handleAbort);
    };

    const handleEvent = () => {
      cleanup();
      resolve();
    };

    const handleError = () => {
      cleanup();
      reject(new Error(`Video failed while waiting for ${eventName}.`));
    };

    const handleAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    target.addEventListener(eventName, handleEvent, { once: true });
    target.addEventListener("error", handleError, { once: true });
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function waitForFramePaint(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let timeoutId = 0;
    let frameId1 = 0;
    let frameId2 = 0;
    let settled = false;

    const cleanup = () => {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }

      if (frameId1) {
        window.cancelAnimationFrame(frameId1);
      }

      if (frameId2) {
        window.cancelAnimationFrame(frameId2);
      }

      signal.removeEventListener("abort", handleAbort);
    };

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve();
    };

    const handleAbort = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal.addEventListener("abort", handleAbort, { once: true });

    frameId1 = window.requestAnimationFrame(() => {
      frameId2 = window.requestAnimationFrame(() => {
        timeoutId = window.setTimeout(finish, FRAME_PAINT_DELAY_MS);
      });
    });
  });
}

async function seekAndWaitForFrame(
  video: HTMLVideoElement,
  targetTime: number,
  signal: AbortSignal,
) {
  if (Math.abs(video.currentTime - targetTime) > 0.005) {
    video.currentTime = targetTime;
    await waitForEvent(video, "seeked", signal);
  }

  await waitForFramePaint(signal);
}

function nearestFrame(frames: SampledFrame[], targetTime: number) {
  if (frames.length === 0) {
    return null;
  }

  let low = 0;
  let high = frames.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const frame = frames[middle];

    if (frame.time < targetTime) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const after = frames[Math.min(low, frames.length - 1)];
  const before = frames[Math.max(0, low - 1)];

  return Math.abs(before.time - targetTime) <= Math.abs(after.time - targetTime)
    ? before
    : after;
}

function addFrameToCache(
  cache: SourceFrameCacheEntry,
  frame: SampledFrame,
) {
  const existingIndex = cache.frames.findIndex(
    (candidate) => Math.abs(candidate.time - frame.time) < 0.008,
  );

  if (existingIndex >= 0) {
    cache.frames[existingIndex] = frame;
  } else {
    cache.frames.push(frame);
    cache.frames.sort((a, b) => a.time - b.time);
  }
}

function frameTolerance(targetTimes: number[], index: number) {
  if (targetTimes.length <= 1) {
    return 0.15;
  }

  const previous = targetTimes[Math.max(0, index - 1)];
  const next = targetTimes[Math.min(targetTimes.length - 1, index + 1)];
  const spacing = Math.max(0.001, (next - previous) / (index === 0 || index === targetTimes.length - 1 ? 1 : 2));

  return Math.max(FRAME_MATCH_MIN_TOLERANCE, spacing * 0.28);
}

function buildClipFrameMap(
  plans: ClipFramePlan[],
  cache: Map<string, SourceFrameCacheEntry>,
) {
  const result: VideoClipFrames = {};

  for (const plan of plans) {
    const cached = cache.get(plan.sourcePath);

    if (!cached || cached.frames.length === 0 || plan.targetTimes.length === 0) {
      continue;
    }

    const slotWidth = 100 / plan.targetTimes.length;

    result[plan.clipId] = plan.targetTimes
      .map((targetTime, index) => {
        const frame = nearestFrame(cached.frames, targetTime);

        if (!frame) {
          return null;
        }

        return {
          sourceTime: targetTime,
          url: frame.url,
          leftPercent: index * slotWidth,
          widthPercent: slotWidth + 0.08,
          exact:
            Math.abs(frame.time - targetTime) <=
            frameTolerance(plan.targetTimes, index),
        } satisfies VideoClipFrame;
      })
      .filter((frame): frame is VideoClipFrame => frame !== null);
  }

  return result;
}

async function generateMissingFrames(
  plan: SourceFramePlan,
  cacheEntry: SourceFrameCacheEntry,
  signal: AbortSignal,
  onFrame: () => void,
) {
  if (!plan.sourcePath || plan.targetTimes.length === 0) {
    return;
  }

  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = convertFileSrc(plan.sourcePath);

  try {
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await waitForEvent(video, "loadedmetadata", signal);
    }

    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForEvent(video, "loadeddata", signal);
    }

    if (signal.aborted || video.videoWidth <= 0 || video.videoHeight <= 0) {
      return;
    }

    const actualDuration =
      Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : plan.expectedDuration;

    if (actualDuration <= 0) {
      return;
    }

    cacheEntry.duration = actualDuration;

    const aspectRatio = video.videoWidth / video.videoHeight;
    const canvas = document.createElement("canvas");
    canvas.width = FRAME_WIDTH;
    canvas.height = Math.max(1, Math.round(FRAME_WIDTH / aspectRatio));

    const context = canvas.getContext("2d", { alpha: false });

    if (!context) {
      return;
    }

    const sourceEndLimit = Math.max(0, actualDuration - 0.01);
    const targetTimes = plan.targetTimes.map((time) =>
      clamp(time, 0, sourceEndLimit),
    );

    const missing = targetTimes.filter((targetTime, index) => {
      const nearest = nearestFrame(cacheEntry.frames, targetTime);
      return (
        !nearest ||
        Math.abs(nearest.time - targetTime) > frameTolerance(targetTimes, index)
      );
    });

    const orderedMissing = spreadOrder(missing);

    for (let index = 0; index < orderedMissing.length; index += 1) {
      if (signal.aborted) {
        return;
      }

      const targetTime = orderedMissing[index];
      await seekAndWaitForFrame(video, targetTime, signal);

      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      addFrameToCache(cacheEntry, {
        time: targetTime,
        url: canvas.toDataURL("image/jpeg", JPEG_QUALITY),
      });

      /*
       * Paint the first rough coverage immediately, then batch later updates a
       * little so hundreds of detailed frames do not cause excessive React
       * renders while zoomed all the way in.
       */
      if (index < 8 || index % 3 === 2 || index === orderedMissing.length - 1) {
        onFrame();
      }
    }
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

export function useVideoClipFrames(
  videoClips: VideoTimelineClip[],
  timelineDuration: number,
  timelineTrackWidthPx: number,
) {
  const [framesByClipId, setFramesByClipId] = useState<VideoClipFrames>({});
  const cacheRef = useRef<Map<string, SourceFrameCacheEntry>>(new Map());

  const clipPlans = useMemo(
    () =>
      videoClips.map((clip) =>
        buildClipPlan(clip, timelineDuration, timelineTrackWidthPx),
      ),
    [videoClips, timelineDuration, timelineTrackWidthPx],
  );

  const sourcePlans = useMemo(() => {
    const bySource = new Map<
      string,
      { expectedDuration: number; targetTimes: number[] }
    >();

    for (const clip of videoClips) {
      if (!clip.sourcePath) {
        continue;
      }

      const current = bySource.get(clip.sourcePath) ?? {
        expectedDuration: 0,
        targetTimes: [],
      };

      current.expectedDuration = Math.max(
        current.expectedDuration,
        sourceDurationForClip(clip),
      );
      bySource.set(clip.sourcePath, current);
    }

    for (const plan of clipPlans) {
      const source = bySource.get(plan.sourcePath);

      if (source) {
        source.targetTimes.push(...plan.targetTimes);
      }
    }

    return [...bySource.entries()].map(
      ([sourcePath, source]): SourceFramePlan => ({
        sourcePath,
        expectedDuration: source.expectedDuration,
        targetTimes: mergeTargetTimes(source.targetTimes),
      }),
    );
  }, [videoClips, clipPlans]);

  const sourcePlanSignature = useMemo(
    () =>
      sourcePlans
        .map(
          (plan) =>
            `${plan.sourcePath}|${plan.targetTimes.length}|${plan.targetTimes
              .map((time) => time.toFixed(2))
              .join(",")}`,
        )
        .join("||"),
    [sourcePlans],
  );

  /*
   * Re-map immediately from whatever is already cached. Zooming therefore
   * never clears the old thumbnails: the new, denser slot layout is populated
   * from nearest cached samples on the very next render.
   */
  useEffect(() => {
    setFramesByClipId(buildClipFrameMap(clipPlans, cacheRef.current));
  }, [clipPlans]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void (async () => {
        for (const plan of sourcePlans) {
          if (controller.signal.aborted) {
            return;
          }

          let cacheEntry = cacheRef.current.get(plan.sourcePath);

          if (!cacheEntry) {
            cacheEntry = {
              duration: plan.expectedDuration,
              frames: [],
            };
            cacheRef.current.set(plan.sourcePath, cacheEntry);
          }

          try {
            await generateMissingFrames(
              plan,
              cacheEntry,
              controller.signal,
              () => {
                if (!controller.signal.aborted) {
                  setFramesByClipId(
                    buildClipFrameMap(clipPlans, cacheRef.current),
                  );
                }
              },
            );
          } catch (error) {
            if (
              !(error instanceof DOMException && error.name === "AbortError")
            ) {
              console.warn(
                `Could not generate timeline frames for ${plan.sourcePath}:`,
                error,
              );
            }
          }
        }
      })();
    }, 45);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [sourcePlanSignature]);

  return framesByClipId;
}
