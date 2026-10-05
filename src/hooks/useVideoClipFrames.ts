import { useEffect, useMemo, useState } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";

import type { VideoTimelineClip } from "../types/timelineModel";
import { traceCut } from "../utils/cutTrace";
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
  decodePath: string;
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
const FRAME_CALLBACK_TIMEOUT_MS = 260;
const FRAME_CALLBACK_TIME_TOLERANCE_SECONDS = 0.12;
const CAPTURE_RETRY_OFFSETS_SECONDS = [0, 0.04, 0.09];
const MIN_SAMPLE_INTERVAL_SECONDS = 0.18;
const SOURCE_WORKERS = 1;
// Filmstrip decoding uses throwaway <video> elements that read the SAME
// source files the Program Monitor is simultaneously trying to buffer and
// play. Without a cap, opening a project with a couple of clips could start
// up to SOURCE_WORKERS*2 (priority+background) decode workers PER SOURCE, all
// at once, competing with live playback for disk/decoder bandwidth right when
// an upcoming clip most needs to buffer ahead of a hard cut. This semaphore
// bounds how many filmstrip workers may run at the same time, app-wide,
// regardless of how many sources are being thumbnailed.
const MAX_CONCURRENT_SOURCE_WORKERS = 1;
const RETRY_BACKOFF_MS = [600, 1500, 4000];

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function createSemaphore(maxConcurrent: number) {
  type Waiter = {
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    onAbort: () => void;
  };

  let active = 0;
  const queue: Waiter[] = [];

  const drain = () => {
    while (active < maxConcurrent && queue.length > 0) {
      const waiter = queue.shift()!;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) continue;

      active += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
        drain();
      });
    }
  };

  const acquire = (signal: AbortSignal) =>
    new Promise<() => void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }

      const waiter = {} as Waiter;
      waiter.signal = signal;
      waiter.resolve = resolve;
      waiter.onAbort = () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        reject(new DOMException("Aborted", "AbortError"));
      };

      queue.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      drain();
    });

  return { acquire };
}

const sourceWorkerSemaphore = createSemaphore(MAX_CONCURRENT_SOURCE_WORKERS);

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

function waitForFramePaint(
  video: HTMLVideoElement,
  targetTime: number,
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    type FrameMetadata = { mediaTime?: number };
    type FrameVideo = HTMLVideoElement & {
      requestVideoFrameCallback?: (
        callback: (now: number, metadata: FrameMetadata) => void,
      ) => number;
      cancelVideoFrameCallback?: (id: number) => void;
    };

    const frameVideo = video as FrameVideo;
    let timeoutId = 0;
    let animationFrameId = 0;
    let videoFrameId: number | null = null;
    let settled = false;

    const cleanup = () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      if (animationFrameId) window.cancelAnimationFrame(animationFrameId);
      if (
        videoFrameId !== null &&
        typeof frameVideo.cancelVideoFrameCallback === "function"
      ) {
        frameVideo.cancelVideoFrameCallback(videoFrameId);
      }
      signal.removeEventListener("abort", handleAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const requestDecodedFrame = () => {
      if (
        settled ||
        signal.aborted ||
        typeof frameVideo.requestVideoFrameCallback !== "function"
      ) {
        return;
      }

      videoFrameId = frameVideo.requestVideoFrameCallback((_now, metadata) => {
        videoFrameId = null;
        const mediaTime = metadata?.mediaTime;
        if (
          Number.isFinite(mediaTime) &&
          Math.abs((mediaTime as number) - targetTime) >
            FRAME_CALLBACK_TIME_TOLERANCE_SECONDS
        ) {
          requestDecodedFrame();
          return;
        }
        finish();
      });
    };

    signal.addEventListener("abort", handleAbort, { once: true });

    if (typeof frameVideo.requestVideoFrameCallback === "function") {
      requestDecodedFrame();
      // A seeked event can arrive before WebKit has actually presented the
      // requested decoded frame. Give rVFC a real chance to confirm the frame
      // first; only then fall back to a normal paint turn.
      timeoutId = window.setTimeout(() => {
        animationFrameId = window.requestAnimationFrame(() => {
          timeoutId = window.setTimeout(finish, FRAME_PAINT_DELAY_MS);
        });
      }, FRAME_CALLBACK_TIMEOUT_MS);
      return;
    }

    animationFrameId = window.requestAnimationFrame(() => {
      timeoutId = window.setTimeout(finish, FRAME_PAINT_DELAY_MS);
    });
  });
}

function waitForCurrentData(video: HTMLVideoElement, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let animationFrameId = 0;
    let timeoutId = 0;
    let settled = false;

    const cleanup = () => {
      if (animationFrameId) window.cancelAnimationFrame(animationFrameId);
      if (timeoutId) window.clearTimeout(timeoutId);
      signal.removeEventListener("abort", handleAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const check = () => {
      if (
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        !video.seeking
      ) {
        finish();
        return;
      }
      animationFrameId = window.requestAnimationFrame(check);
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    timeoutId = window.setTimeout(finish, 900);
    check();
  });
}

async function seekAndWaitForFrame(
  video: HTMLVideoElement,
  targetTime: number,
  signal: AbortSignal,
) {
  if (Math.abs(video.currentTime - targetTime) > 0.004) {
    // Attach the seeked listener BEFORE assigning currentTime. Small local
    // seeks can complete quickly enough in WebKit that listening afterwards
    // occasionally misses the event and leaves a thumbnail worker hanging.
    const seeked = waitForEvent(video, "seeked", signal);
    video.currentTime = targetTime;
    await seeked;
  }

  await waitForCurrentData(video, signal);
  await waitForFramePaint(video, targetTime, signal);
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

function canvasLooksUnpainted(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
) {
  // A failed/stale WebKit seek commonly leaves the canvas as the exact dark
  // backing fill (or nearly uniform black). Only use this as a RETRY signal;
  // after the final attempt the frame is still accepted so legitimate black
  // footage is never permanently hidden from the filmstrip.
  const sampleWidth = Math.min(32, canvas.width);
  const sampleHeight = Math.min(18, canvas.height);
  const left = Math.max(0, Math.floor((canvas.width - sampleWidth) / 2));
  const top = Math.max(0, Math.floor((canvas.height - sampleHeight) / 2));
  const data = context.getImageData(left, top, sampleWidth, sampleHeight).data;

  let minLuma = 255;
  let maxLuma = 0;
  let meanLuma = 0;
  let samples = 0;

  for (let index = 0; index < data.length; index += 16) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const luma = (r + g + b) / 3;
    minLuma = Math.min(minLuma, luma);
    maxLuma = Math.max(maxLuma, luma);
    meanLuma += luma;
    samples += 1;
  }

  meanLuma /= Math.max(1, samples);
  return maxLuma - minLuma < 5 && meanLuma < 28;
}

async function captureFrameWithRetry(
  video: HTMLVideoElement,
  targetTime: number,
  duration: number,
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  signal: AbortSignal,
) {
  const maxTime = Math.max(0, duration - 0.01);

  for (let attempt = 0; attempt < CAPTURE_RETRY_OFFSETS_SECONDS.length; attempt += 1) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    const captureTime = clamp(
      targetTime + CAPTURE_RETRY_OFFSETS_SECONDS[attempt],
      0,
      maxTime,
    );
    await seekAndWaitForFrame(video, captureTime, signal);
    drawContainedFrame(context, video, canvas);

    const looksUnpainted = canvasLooksUnpainted(context, canvas);
    if (!looksUnpainted || attempt === CAPTURE_RETRY_OFFSETS_SECONDS.length - 1) {
      return;
    }
  }
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
  previewPathsBySource: Record<string, string>,
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
    // Always request the exact first visible source frame for every timeline
    // clip. Background source-wide sampling is intentionally coarse and must
    // not be allowed to stand in for a clip's source-in point.
    entry.priority.push(timelineTimeToSourceTime(clip, clip.timelineStart));

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
      decodePath: previewPathsBySource[sourcePath] ?? sourcePath,
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

function missingTimes(cache: SourceFrameCacheEntry, times: number[]) {
  if (times.length === 0) return [];
  const sorted = mergeTimes(times);

  return sorted.filter((time, index) => {
    const previousGap =
      index > 0 ? Math.abs(time - sorted[index - 1]) : Number.POSITIVE_INFINITY;
    const nextGap =
      index + 1 < sorted.length
        ? Math.abs(sorted[index + 1] - time)
        : Number.POSITIVE_INFINITY;
    const localSpacing = Math.min(previousGap, nextGap);
    const tolerance = Number.isFinite(localSpacing)
      ? clamp(localSpacing * 0.28, 0.03, 0.35)
      : 0.08;
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
  if (times.length === 0) return [];

  // Throttle how many of these decode workers may run at once, app-wide. The
  // semaphore itself is abort-aware: an effect that is superseded while queued
  // is removed from the queue, so it cannot later consume a slot forever.
  let releaseWorkerSlot: (() => void) | null = null;
  try {
    releaseWorkerSlot = await sourceWorkerSemaphore.acquire(signal);
  } catch {
    return [];
  }

  const failedTimes: number[] = [];
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = convertFileSrc(sourcePath);

  try {
    // A failure here (a genuine decode/`error` event, not just slowness) used
    // to escape this function entirely, abort the whole plan via the
    // Promise.all above, and get logged with no retry. Under exactly the kind
    // of resource pressure this cap is meant to relieve, metadata/data loading
    // failing transiently is as likely as a single seek failing, so it gets
    // the same treatment: every time in this bucket is reported as missing
    // and picked up by the retry below.
    try {
      if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
        await waitForEvent(video, "loadedmetadata", signal);
      }
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        await waitForEvent(video, "loadeddata", signal);
      }
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        return failedTimes;
      }
      return times;
    }
    if (signal.aborted) return failedTimes;
    if (video.videoWidth <= 0 || video.videoHeight <= 0) return times;

    const canvas = document.createElement("canvas");
    canvas.width = THUMB_WIDTH;
    canvas.height = THUMB_HEIGHT;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return times;

    for (let index = 0; index < times.length; index += 1) {
      if (signal.aborted) return failedTimes;
      const targetTime = clamp(
        times[index],
        0,
        Math.max(0, cache.duration - 0.01),
      );

      // A single bad seek (transient decode pressure, a frame the codec
      // cannot land on exactly, a brief source hiccup) must not abort the
      // whole bucket: that previously killed thumbnail generation for an
      // entire source file until the timeline view changed enough to alter
      // the sample plan. Record it and move on; it is retried below.
      try {
        await captureFrameWithRetry(
          video,
          targetTime,
          cache.duration,
          context,
          canvas,
          signal,
        );
        addFrameToCache(cache, {
          time: targetTime,
          url: canvas.toDataURL("image/jpeg", JPEG_QUALITY),
        });
      } catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          return failedTimes;
        }
        failedTimes.push(targetTime);
      }

      if (eager || index % 3 === 2 || index === times.length - 1) onProgress();
    }
  } finally {
    video.removeAttribute("src");
    video.load();
    releaseWorkerSlot?.();
  }

  return failedTimes;
}

async function runBucketed(
  decodePath: string,
  times: number[],
  cache: SourceFrameCacheEntry,
  signal: AbortSignal,
  onProgress: () => void,
  eager: boolean,
): Promise<number[]> {
  if (times.length === 0) return [];
  const buckets = Array.from({ length: SOURCE_WORKERS }, () => [] as number[]);
  times.forEach((time, index) => buckets[index % SOURCE_WORKERS].push(time));
  const results = await Promise.all(
    buckets.map((bucket) =>
      runWorker(decodePath, bucket, cache, signal, onProgress, eager),
    ),
  );
  return results.flat();
}

// Per-source retry state. A single bad seek is now handled inside runWorker,
// but if a source is under sustained pressure (proxy encode still running,
// several sources thumbnailing at once, a slow disk) a batch of times can
// keep failing. Retrying only reacts to that; it is keyed by sourcePath so a
// retry for a source the component is no longer interested in is dropped.
const retryTimersBySource = new Map<string, number>();
const retryAttemptsBySource = new Map<string, number>();
const retryDecodePathBySource = new Map<string, string>();

function scheduleRetry(
  plan: SourcePlan,
  onProgress: () => void,
  getSignal: () => AbortSignal | null,
) {
  const attempt = retryAttemptsBySource.get(plan.sourcePath) ?? 0;
  if (attempt >= RETRY_BACKOFF_MS.length) return;

  const existing = retryTimersBySource.get(plan.sourcePath);
  if (existing !== undefined) window.clearTimeout(existing);

  const timer = window.setTimeout(() => {
    retryTimersBySource.delete(plan.sourcePath);
    const signal = getSignal();
    if (!signal || signal.aborted) return;
    retryAttemptsBySource.set(plan.sourcePath, attempt + 1);
    void generateSourceFrames(plan, signal, onProgress, getSignal);
  }, RETRY_BACKOFF_MS[attempt]);

  retryTimersBySource.set(plan.sourcePath, timer);
}

async function generateSourceFrames(
  plan: SourcePlan,
  signal: AbortSignal,
  onProgress: () => void,
  // Supplies the CURRENT abort signal at retry time, since the one closed
  // over by a scheduled retry may belong to an effect run that has since been
  // superseded (the component re-rendered, the plan changed, etc.).
  getSignal: () => AbortSignal | null = () => signal,
) {
  const previousDecodePath = retryDecodePathBySource.get(plan.sourcePath);
  if (previousDecodePath !== plan.decodePath) {
    const timer = retryTimersBySource.get(plan.sourcePath);
    if (timer !== undefined) window.clearTimeout(timer);
    retryTimersBySource.delete(plan.sourcePath);
    retryAttemptsBySource.delete(plan.sourcePath);
    retryDecodePathBySource.set(plan.sourcePath, plan.decodePath);
  }

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
  );
  const failedPriority = await runBucketed(
    plan.decodePath,
    priorityMissing,
    cache,
    signal,
    onProgress,
    true,
  );

  if (signal.aborted) return;

  const backgroundMissing = missingTimes(
    cache,
    plan.backgroundTimes.map((time) =>
      clamp(time, 0, Math.max(0, cache.duration - 0.01)),
    ),
  );
  const failedBackground = await runBucketed(
    plan.decodePath,
    backgroundMissing,
    cache,
    signal,
    onProgress,
    false,
  );

  if (signal.aborted) return;

  if (failedPriority.length > 0 || failedBackground.length > 0) {
    scheduleRetry(plan, onProgress, getSignal);
  } else {
    retryAttemptsBySource.delete(plan.sourcePath);
  }
}

export function useVideoClipFrames(
  videoClips: VideoTimelineClip[],
  pixelsPerSecond: number,
  visibleStart: number,
  visibleEnd: number,
  previewPathsBySource: Record<string, string> = {},
  playbackActive = false,
) {
  const [revision, setRevision] = useState(0);

  const sourcePlans = useMemo(
    () =>
      sourcePlansFor(
        videoClips,
        pixelsPerSecond,
        visibleStart,
        visibleEnd,
        previewPathsBySource,
      ),
    [videoClips, pixelsPerSecond, visibleStart, visibleEnd, previewPathsBySource],
  );

  const planSignature = useMemo(
    () =>
      sourcePlans
        .map(
          (plan) =>
            `${plan.sourcePath}|${plan.decodePath}|${plan.expectedDuration.toFixed(3)}|${plan.priorityTimes
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

    // Playback has absolute priority over cosmetic timeline thumbnails. When
    // transport starts, React cleans up the previous effect and aborts any
    // active filmstrip seek immediately. Missing frames resume from the cache
    // when playback stops instead of competing with the incoming clip decoder.
    if (playbackActive) {
      return () => controller.abort();
    }

    // A retry scheduled from a previous effect run must resolve against THIS
    // run's signal (or a later one), never a stale, already-aborted one.
    const getSignal = () =>
      controller.signal.aborted ? null : controller.signal;

    // A 12 ms delay was effectively "start immediately". That let filmstrip
    // decode workers start competing with the Program Monitor's own buffering
    // the instant a project opened or an edit changed the plan, right when an
    // upcoming clip most needs its buffer-ahead window to itself. A few
    // hundred ms is still invisible for thumbnails but gives playback a head
    // start; the per-source semaphore above caps the ongoing contention.
    const startDelay = 220;

    const timer = window.setTimeout(() => {
      void Promise.all(
        sourcePlans.map(async (plan) => {
          try {
            traceCut("filmstrip-task-start", {
              sourcePath: plan.sourcePath,
              decodePath: plan.decodePath,
            });
            await generateSourceFrames(
              plan,
              controller.signal,
              () => {
                if (!controller.signal.aborted) setRevision((value) => value + 1);
              },
              getSignal,
            );
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
    }, startDelay);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [planSignature, playbackActive]);

  return framesByClipId;
}