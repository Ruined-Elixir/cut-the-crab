import { useEffect, useMemo, useState } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";

import type { VideoTimelineClip } from "../types/timelineModel";
import {
  isFreezeFrameClip,
  timelineTimeToSourceTime,
  videoPlaybackRate,
} from "../utils/videoRetime";

export type VideoClipFrame = {
  sourceTime: number;
  url: string;
  leftPercent: number;
  widthPercent: number;
};

export type VideoClipFrames = Record<string, VideoClipFrame[]>;

type SampledFrame = { time: number; url: string };
type SourceFrameCacheEntry = { duration: number; frames: SampledFrame[] };
type SourcePlan = {
  sourcePath: string;
  expectedDuration: number;
  priorityTimes: number[];
  backgroundTimes: number[];
};

const SOURCE_CACHE = new Map<string, SourceFrameCacheEntry>();
const FRAME_TILE_WIDTH_PX = 82;
const MAX_DISPLAY_SLOTS_PER_CLIP = 320;
const MAX_SOURCE_CACHE_FRAMES = 480;
const COARSE_SOURCE_FRAMES = 24;
const THUMB_WIDTH = 160;
const THUMB_HEIGHT = 90;
const JPEG_QUALITY = 0.72;
const FRAME_PAINT_DELAY_MS = 10;
const MIN_SAMPLE_INTERVAL_SECONDS = 0.18;
const SOURCE_WORKERS = 2;

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

function nearestFrame(frames: SampledFrame[], targetTime: number) {
  if (frames.length === 0) return null;
  let low = 0;
  let high = frames.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (frames[middle].time < targetTime) low = middle + 1;
    else high = middle - 1;
  }
  const after = frames[Math.min(low, frames.length - 1)];
  const before = frames[Math.max(0, low - 1)];
  return Math.abs(before.time - targetTime) <= Math.abs(after.time - targetTime)
    ? before
    : after;
}

function addFrameToCache(cache: SourceFrameCacheEntry, frame: SampledFrame) {
  const existingIndex = cache.frames.findIndex(
    (candidate) => Math.abs(candidate.time - frame.time) < 0.012,
  );
  if (existingIndex >= 0) cache.frames[existingIndex] = frame;
  else {
    cache.frames.push(frame);
    cache.frames.sort((a, b) => a.time - b.time);
  }

  if (cache.frames.length > MAX_SOURCE_CACHE_FRAMES) {
    const keep = Array.from({ length: MAX_SOURCE_CACHE_FRAMES }, (_, index) => {
      const ratio = index / Math.max(1, MAX_SOURCE_CACHE_FRAMES - 1);
      return cache.frames[Math.round(ratio * (cache.frames.length - 1))];
    });
    cache.frames = keep.filter(
      (frame, index) => index === 0 || frame.time !== keep[index - 1].time,
    );
  }
}

function uniformTimes(duration: number, count: number) {
  if (duration <= 0 || count <= 0) return [];
  if (count === 1) return [0];
  const end = Math.max(0, duration - 0.01);
  return Array.from(
    { length: count },
    (_, index) => (index / (count - 1)) * end,
  );
}

function uniformRangeTimes(start: number, end: number, interval: number) {
  if (end <= start) return [start];
  const safeInterval = Math.max(0.04, interval);
  const count = Math.max(2, Math.ceil((end - start) / safeInterval) + 1);
  return Array.from(
    { length: count },
    (_, index) => start + ((end - start) * index) / Math.max(1, count - 1),
  );
}

function mergeTimes(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  const merged: number[] = [];
  for (const time of sorted) {
    const previous = merged[merged.length - 1];
    if (previous === undefined || Math.abs(previous - time) > 0.025)
      merged.push(time);
  }
  return merged;
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
    let frameId = 0;
    const cleanup = () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      if (frameId) window.cancelAnimationFrame(frameId);
      signal.removeEventListener("abort", handleAbort);
    };
    const handleAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    frameId = window.requestAnimationFrame(() => {
      timeoutId = window.setTimeout(() => {
        cleanup();
        resolve();
      }, FRAME_PAINT_DELAY_MS);
    });
  });
}

async function seekAndWaitForFrame(
  video: HTMLVideoElement,
  targetTime: number,
  signal: AbortSignal,
) {
  if (Math.abs(video.currentTime - targetTime) > 0.004) {
    video.currentTime = targetTime;
    await waitForEvent(video, "seeked", signal);
  }
  await waitForFramePaint(signal);
}

function drawContainedFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
) {
  context.fillStyle = "#101112";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const sourceAspect = video.videoWidth / video.videoHeight;
  const targetAspect = canvas.width / canvas.height;
  let drawWidth = canvas.width;
  let drawHeight = canvas.height;
  if (sourceAspect > targetAspect) drawHeight = canvas.width / sourceAspect;
  else drawWidth = canvas.height * sourceAspect;
  context.drawImage(
    video,
    (canvas.width - drawWidth) / 2,
    (canvas.height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

function desiredSourceSampleCount(duration: number, pixelsPerSecond: number) {
  if (duration <= 0) return 0;
  const desiredInterval = Math.max(
    MIN_SAMPLE_INTERVAL_SECONDS,
    FRAME_TILE_WIDTH_PX / Math.max(0.01, pixelsPerSecond),
  );
  return clamp(
    Math.ceil(duration / desiredInterval) + 1,
    COARSE_SOURCE_FRAMES,
    MAX_SOURCE_CACHE_FRAMES,
  );
}

function sourcePlansFor(
  videoClips: VideoTimelineClip[],
  pixelsPerSecond: number,
  visibleStart: number,
  visibleEnd: number,
): SourcePlan[] {
  const bySource = new Map<string, { duration: number; priority: number[] }>();
  const visibleSpan = Math.max(1, visibleEnd - visibleStart);
  const prefetchStart = Math.max(0, visibleStart - visibleSpan);
  const prefetchEnd = visibleEnd + visibleSpan;
  const timelineSampleInterval =
    FRAME_TILE_WIDTH_PX / Math.max(0.01, pixelsPerSecond);

  for (const clip of videoClips) {
    if (!clip.sourcePath) continue;
    const entry = bySource.get(clip.sourcePath) ?? {
      duration: 0,
      priority: [],
    };
    entry.duration = Math.max(entry.duration, sourceDurationForClip(clip));

    const overlapStart = Math.max(clip.timelineStart, prefetchStart);
    const overlapEnd = Math.min(clip.timelineEnd, prefetchEnd);
    if (overlapEnd > overlapStart) {
      const sourceStart = timelineTimeToSourceTime(clip, overlapStart);
      const sourceEnd = timelineTimeToSourceTime(clip, overlapEnd);
      const sourceSampleInterval =
        timelineSampleInterval * videoPlaybackRate(clip);
      entry.priority.push(
        ...uniformRangeTimes(
          Math.min(sourceStart, sourceEnd),
          Math.max(sourceStart, sourceEnd),
          sourceSampleInterval,
        ),
      );
    }
    bySource.set(clip.sourcePath, entry);
  }

  return [...bySource.entries()].map(([sourcePath, entry]) => {
    const duration = entry.duration;
    const coarseCount = Math.min(
      COARSE_SOURCE_FRAMES,
      Math.max(6, Math.ceil(duration / 8) + 1),
    );
    const detailCount = desiredSourceSampleCount(duration, pixelsPerSecond);
    const priorityTimes = mergeTimes(entry.priority);
    const priorityKeys = new Set(priorityTimes.map((time) => time.toFixed(2)));
    const backgroundTimes = mergeTimes([
      ...uniformTimes(duration, coarseCount),
      ...uniformTimes(duration, detailCount),
    ]).filter((time) => !priorityKeys.has(time.toFixed(2)));

    return {
      sourcePath,
      expectedDuration: duration,
      priorityTimes,
      backgroundTimes,
    };
  });
}

function displayFramesForClip(
  clip: VideoTimelineClip,
  pixelsPerSecond: number,
  cache: SourceFrameCacheEntry | undefined,
): VideoClipFrame[] {
  if (!cache || cache.frames.length < 2) return [];
  const pixelWidth = Math.max(1, clipDuration(clip) * pixelsPerSecond);
  const slotCount = clamp(
    Math.ceil(pixelWidth / FRAME_TILE_WIDTH_PX),
    1,
    MAX_DISPLAY_SLOTS_PER_CLIP,
  );
  const slotWidth = 100 / slotCount;
  return Array.from({ length: slotCount }, (_, index) => {
    const ratio = index / slotCount;
    const timelineTime =
      clip.timelineStart + (clip.timelineEnd - clip.timelineStart) * ratio;
    const targetTime = isFreezeFrameClip(clip)
      ? clip.freezeFrameSourceTime!
      : timelineTimeToSourceTime(clip, timelineTime);
    const nearest = nearestFrame(cache.frames, targetTime) ?? cache.frames[0];
    return {
      sourceTime: targetTime,
      url: nearest.url,
      leftPercent: index * slotWidth,
      widthPercent: slotWidth + 0.06,
    };
  });
}

function buildClipFrameMap(
  videoClips: VideoTimelineClip[],
  pixelsPerSecond: number,
) {
  const result: VideoClipFrames = {};
  for (const clip of videoClips) {
    result[clip.id] = displayFramesForClip(
      clip,
      pixelsPerSecond,
      SOURCE_CACHE.get(clip.sourcePath),
    );
  }
  return result;
}

function missingTimes(
  cache: SourceFrameCacheEntry,
  times: number[],
  duration: number,
) {
  if (times.length === 0) return [];
  const sampleSpacing =
    times.length > 1 ? duration / (times.length - 1) : duration;
  const tolerance = Math.max(0.03, sampleSpacing * 0.28);
  return times.filter((time) => {
    const nearest = nearestFrame(cache.frames, time);
    return !nearest || Math.abs(nearest.time - time) > tolerance;
  });
}

async function runWorker(
  sourcePath: string,
  times: number[],
  cache: SourceFrameCacheEntry,
  signal: AbortSignal,
  onProgress: () => void,
  eager: boolean,
) {
  if (times.length === 0) return;
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = convertFileSrc(sourcePath);

  try {
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await waitForEvent(video, "loadedmetadata", signal);
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForEvent(video, "loadeddata", signal);
    }
    if (signal.aborted || video.videoWidth <= 0 || video.videoHeight <= 0)
      return;

    const canvas = document.createElement("canvas");
    canvas.width = THUMB_WIDTH;
    canvas.height = THUMB_HEIGHT;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;

    for (let index = 0; index < times.length; index += 1) {
      if (signal.aborted) return;
      const targetTime = clamp(
        times[index],
        0,
        Math.max(0, cache.duration - 0.01),
      );
      await seekAndWaitForFrame(video, targetTime, signal);
      drawContainedFrame(context, video, canvas);
      addFrameToCache(cache, {
        time: targetTime,
        url: canvas.toDataURL("image/jpeg", JPEG_QUALITY),
      });
      if (eager || index % 3 === 2 || index === times.length - 1) onProgress();
    }
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

async function generateSourceFrames(
  plan: SourcePlan,
  signal: AbortSignal,
  onProgress: () => void,
) {
  let cache = SOURCE_CACHE.get(plan.sourcePath);
  if (!cache) {
    cache = { duration: plan.expectedDuration, frames: [] };
    SOURCE_CACHE.set(plan.sourcePath, cache);
  }
  cache.duration = Math.max(cache.duration, plan.expectedDuration);

  const priorityMissing = missingTimes(
    cache,
    plan.priorityTimes.map((time) =>
      clamp(time, 0, Math.max(0, cache.duration - 0.01)),
    ),
    cache.duration,
  );

  const priorityBuckets = Array.from(
    { length: SOURCE_WORKERS },
    () => [] as number[],
  );
  priorityMissing.forEach((time, index) =>
    priorityBuckets[index % SOURCE_WORKERS].push(time),
  );
  await Promise.all(
    priorityBuckets.map((times) =>
      runWorker(plan.sourcePath, times, cache!, signal, onProgress, true),
    ),
  );

  if (signal.aborted) return;

  const backgroundMissing = missingTimes(
    cache,
    plan.backgroundTimes.map((time) =>
      clamp(time, 0, Math.max(0, cache.duration - 0.01)),
    ),
    cache.duration,
  );
  const backgroundBuckets = Array.from(
    { length: SOURCE_WORKERS },
    () => [] as number[],
  );
  backgroundMissing.forEach((time, index) =>
    backgroundBuckets[index % SOURCE_WORKERS].push(time),
  );
  await Promise.all(
    backgroundBuckets.map((times) =>
      runWorker(plan.sourcePath, times, cache!, signal, onProgress, false),
    ),
  );
}

export function useVideoClipFrames(
  videoClips: VideoTimelineClip[],
  pixelsPerSecond: number,
  visibleStart: number,
  visibleEnd: number,
) {
  const [revision, setRevision] = useState(0);

  const sourcePlans = useMemo(
    () => sourcePlansFor(videoClips, pixelsPerSecond, visibleStart, visibleEnd),
    [videoClips, pixelsPerSecond, visibleStart, visibleEnd],
  );

  const planSignature = useMemo(
    () =>
      sourcePlans
        .map(
          (plan) =>
            `${plan.sourcePath}|${plan.expectedDuration.toFixed(3)}|${plan.priorityTimes
              .map((time) => time.toFixed(2))
              .join(",")}|${plan.backgroundTimes.length}`,
        )
        .join("||"),
    [sourcePlans],
  );

  const framesByClipId = useMemo(
    () => buildClipFrameMap(videoClips, pixelsPerSecond),
    [videoClips, pixelsPerSecond, revision],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void Promise.all(
        sourcePlans.map(async (plan) => {
          try {
            await generateSourceFrames(plan, controller.signal, () => {
              if (!controller.signal.aborted) setRevision((value) => value + 1);
            });
          } catch (error) {
            if (!(
              error instanceof DOMException && error.name === "AbortError"
            )) {
              console.warn(
                `Could not generate source-wide timeline thumbnails for ${plan.sourcePath}:`,
                error,
              );
            }
          }
        }),
      );
    }, 12);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [planSignature]);

  return framesByClipId;
}
