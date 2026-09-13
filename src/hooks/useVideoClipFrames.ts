import { useEffect, useMemo, useRef, useState } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";

import type { VideoTimelineClip } from "../types/timelineModel";

export type VideoClipFrames = Record<string, string[]>;

type SampledFrame = {
  time: number;
  url: string;
};

type SourceFrameCacheEntry = {
  duration: number;
  density: number;
  frames: SampledFrame[];
};

const BASE_SECONDS_PER_FRAME = 2.2;
const MIN_SOURCE_FRAME_COUNT = 6;
const MAX_SOURCE_FRAME_COUNT = 180;
const FRAME_WIDTH = 128;
const JPEG_QUALITY = 0.7;
const FRAME_PAINT_DELAY_MS = 36;

function normalizeZoom(zoom: number) {
  if (!Number.isFinite(zoom)) {
    return 1;
  }

  return Math.max(1, Math.min(12, zoom));
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

function requestedFrameCount(duration: number, zoom: number) {
  const safeDuration = Math.max(0.1, duration);
  const safeZoom = normalizeZoom(zoom);
  const secondsPerFrame = BASE_SECONDS_PER_FRAME / safeZoom;

  return Math.max(
    MIN_SOURCE_FRAME_COUNT,
    Math.min(
      MAX_SOURCE_FRAME_COUNT,
      Math.ceil(safeDuration / secondsPerFrame) + 1,
    ),
  );
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

async function generateSourceFrames(
  sourcePath: string,
  expectedDuration: number,
  density: number,
  signal: AbortSignal,
  onProgress?: (frames: SampledFrame[], duration: number) => void,
) {
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

    if (signal.aborted || video.videoWidth <= 0 || video.videoHeight <= 0) {
      return null;
    }

    const actualDuration =
      Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : expectedDuration;

    if (actualDuration <= 0) {
      return null;
    }

    const aspectRatio = video.videoWidth / video.videoHeight;
    const canvas = document.createElement("canvas");
    canvas.width = FRAME_WIDTH;
    canvas.height = Math.max(1, Math.round(FRAME_WIDTH / aspectRatio));

    const context = canvas.getContext("2d", { alpha: false });

    if (!context) {
      return null;
    }

    const frameCount = requestedFrameCount(actualDuration, density);
    const frames: SampledFrame[] = [];
    const sourceEndLimit = Math.max(0, actualDuration - 0.01);

    for (let index = 0; index < frameCount; index += 1) {
      if (signal.aborted) {
        return null;
      }

      const ratio = frameCount <= 1 ? 0 : index / (frameCount - 1);
      const targetTime = Math.max(
        0,
        Math.min(sourceEndLimit, actualDuration * ratio),
      );

      await seekAndWaitForFrame(video, targetTime, signal);

      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({
        time: targetTime,
        url: canvas.toDataURL("image/jpeg", JPEG_QUALITY),
      });

      if (index === 0 || index % 3 === 2 || index === frameCount - 1) {
        onProgress?.([...frames], actualDuration);
      }
    }

    return {
      duration: actualDuration,
      density,
      frames,
    } satisfies SourceFrameCacheEntry;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

function nearestFrameAtOrAfter(
  frames: SampledFrame[],
  time: number,
) {
  return frames.findIndex((frame) => frame.time >= time - 0.001);
}

function framesForClip(
  clip: VideoTimelineClip,
  sourceFrames: SampledFrame[],
) {
  if (sourceFrames.length === 0) {
    return [];
  }

  const startIndexRaw = nearestFrameAtOrAfter(sourceFrames, clip.sourceIn);
  const startIndex = startIndexRaw >= 0 ? startIndexRaw : sourceFrames.length - 1;

  const selected = sourceFrames.slice(startIndex).filter(
    (frame) => frame.time <= clip.sourceOut + 0.001,
  );

  if (selected.length > 0) {
    return selected.map((frame) => frame.url);
  }

  const nearest = sourceFrames.reduce((best, frame) =>
    Math.abs(frame.time - clip.sourceIn) < Math.abs(best.time - clip.sourceIn)
      ? frame
      : best,
  );

  return [nearest.url];
}

function buildClipFrameMap(
  videoClips: VideoTimelineClip[],
  cache: Map<string, SourceFrameCacheEntry>,
) {
  const result: VideoClipFrames = {};

  for (const clip of videoClips) {
    const cached = cache.get(clip.sourcePath);

    if (!cached) {
      continue;
    }

    result[clip.id] = framesForClip(clip, cached.frames);
  }

  return result;
}

export function useVideoClipFrames(
  videoClips: VideoTimelineClip[],
  zoom = 1,
) {
  const [framesByClipId, setFramesByClipId] = useState<VideoClipFrames>({});
  const cacheRef = useRef<Map<string, SourceFrameCacheEntry>>(new Map());
  const safeZoom = normalizeZoom(zoom);

  const sources = useMemo(() => {
    const byPath = new Map<string, number>();

    for (const clip of videoClips) {
      if (!clip.sourcePath) {
        continue;
      }

      byPath.set(
        clip.sourcePath,
        Math.max(
          byPath.get(clip.sourcePath) ?? 0,
          sourceDurationForClip(clip),
        ),
      );
    }

    return [...byPath.entries()].map(([path, duration]) => ({ path, duration }));
  }, [videoClips]);

  /*
   * Clip trims only change sourceIn/sourceOut. Because the cache is source-wide,
   * we can immediately select a different slice of already decoded thumbnails
   * while the resize handle is moving instead of throwing away the strip and
   * waiting for a brand-new clip-specific extraction.
   */
  useEffect(() => {
    setFramesByClipId(buildClipFrameMap(videoClips, cacheRef.current));
  }, [videoClips, safeZoom]);

  useEffect(() => {
    const controller = new AbortController();

    const timeout = window.setTimeout(() => {
      void (async () => {
        for (const source of sources) {
          if (controller.signal.aborted) {
            return;
          }

          const cached = cacheRef.current.get(source.path);

          /*
           * A higher-density cache is also valid at lower zoom levels. When the
           * user zooms in we keep showing the existing strip immediately and
           * progressively add denser samples in the background.
           */
          if (
            cached &&
            cached.density >= safeZoom &&
            cached.duration >= source.duration - 0.05
          ) {
            continue;
          }

          try {
            const generated = await generateSourceFrames(
              source.path,
              source.duration,
              safeZoom,
              controller.signal,
              (partialFrames, actualDuration) => {
                if (controller.signal.aborted) {
                  return;
                }

                cacheRef.current.set(source.path, {
                  duration: actualDuration,
                  density: safeZoom,
                  frames: partialFrames,
                });

                setFramesByClipId(
                  buildClipFrameMap(videoClips, cacheRef.current),
                );
              },
            );

            if (generated && !controller.signal.aborted) {
              cacheRef.current.set(source.path, generated);
              setFramesByClipId(
                buildClipFrameMap(videoClips, cacheRef.current),
              );
            }
          } catch (error) {
            if (
              !(error instanceof DOMException && error.name === "AbortError")
            ) {
              console.warn(
                `Could not generate timeline frames for ${source.path}:`,
                error,
              );
            }
          }
        }
      })();
    }, 80);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [sources, safeZoom]);

  return framesByClipId;
}
