import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";

import type { Subtitle } from "../types/subtitle";
import type {
  TimelineTrackSettings,
  VideoTimelineClip,
} from "../types/timelineModel";

import { buildAssTrack } from "../utils/assSubtitles";

export type VideoExportProgress = {
  progress: number;
  status: string;
};

type ExportTimelineVideoOptions = {
  timelineDuration: number;
  videoClips: VideoTimelineClip[];
  trackSettings: TimelineTrackSettings;
  onStart?: () => void;
  onProgress?: (progress: VideoExportProgress) => void;
};

type ClipRenderWindow = {
  sourceIn: number;
  sourceOut: number;
  timelineStart: number;
  timelineEnd: number;
  transitionInCross?: { start: number; duration: number };
  transitionOutCross?: { start: number; duration: number };
};

const OUTPUT_WIDTH = 1920;
const OUTPUT_HEIGHT = 1080;
const OUTPUT_FPS = 30;
const EPSILON = 0.03;

function videoTrackIndex(trackId: string) {
  const match = /^video-(\d+)$/.exec(trackId);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function n(value: number, digits = 4) {
  return Number.isFinite(value) ? value.toFixed(digits) : "0";
}

function clipDuration(clip: VideoTimelineClip) {
  return Math.max(0.001, clip.timelineEnd - clip.timelineStart);
}

function transitionDuration(
  clip: VideoTimelineClip,
  edge: "in" | "out",
) {
  const duration = clipDuration(clip);
  const requested =
    edge === "in"
      ? clip.transitionInDuration ?? 0.5
      : clip.transitionOutDuration ?? 0.5;

  return clamp(requested, 0.1, Math.min(5, duration / 2));
}

function isAdjacent(a: VideoTimelineClip, b: VideoTimelineClip) {
  return Math.abs(a.timelineEnd - b.timelineStart) <= EPSILON;
}

function buildRenderWindows(videoClips: VideoTimelineClip[]) {
  const windows = new Map<string, ClipRenderWindow>();

  for (const clip of videoClips) {
    windows.set(clip.id, {
      sourceIn: clip.sourceIn,
      sourceOut: clip.sourceOut,
      timelineStart: clip.timelineStart,
      timelineEnd: clip.timelineEnd,
    });
  }

  const tracks = [...new Set(
    videoClips
      .map((clip) => clip.trackId)
      .filter((trackId) => /^video-\d+$/.test(trackId)),
  )].sort((a, b) => videoTrackIndex(a) - videoTrackIndex(b));

  for (const trackId of tracks) {
    const clips = videoClips
      .filter((clip) => clip.trackId === trackId)
      .sort((a, b) => a.timelineStart - b.timelineStart);

    for (let index = 0; index < clips.length - 1; index += 1) {
      const outgoing = clips[index];
      const incoming = clips[index + 1];

      if (!isAdjacent(outgoing, incoming)) {
        continue;
      }

      const outgoingCross = outgoing.transitionOutType === "cross-dissolve";
      const incomingCross = incoming.transitionInType === "cross-dissolve";

      if (!outgoingCross && !incomingCross) {
        continue;
      }

      const requestedDuration = outgoingCross
        ? transitionDuration(outgoing, "out")
        : transitionDuration(incoming, "in");

      const duration = incomingCross
        ? Math.min(requestedDuration, transitionDuration(incoming, "in"))
        : requestedDuration;

      const half = duration / 2;
      const outgoingSourceDuration = outgoing.sourceDuration ?? outgoing.sourceOut;
      const incomingSourceDuration = incoming.sourceDuration ?? incoming.sourceOut;

      const hasOutgoingHandle = outgoing.sourceOut + half <= outgoingSourceDuration + EPSILON;
      const hasIncomingHandle = incoming.sourceIn - half >= -EPSILON;

      if (!hasOutgoingHandle || !hasIncomingHandle || incomingSourceDuration <= 0) {
        continue;
      }

      const outgoingWindow = windows.get(outgoing.id)!;
      const incomingWindow = windows.get(incoming.id)!;

      outgoingWindow.sourceOut = Math.min(outgoingSourceDuration, outgoing.sourceOut + half);
      outgoingWindow.timelineEnd = outgoing.timelineEnd + half;
      outgoingWindow.transitionOutCross = {
        start: Math.max(0, clipDuration(outgoing) - half),
        duration,
      };

      incomingWindow.sourceIn = Math.max(0, incoming.sourceIn - half);
      incomingWindow.timelineStart = Math.max(0, incoming.timelineStart - half);
      incomingWindow.transitionInCross = {
        start: 0,
        duration,
      };
    }
  }

  return windows;
}

function videoTrackVisible(
  trackId: string,
  trackSettings: TimelineTrackSettings,
) {
  return !trackSettings[trackId]?.hidden;
}

function audioTrackMuted(
  videoTrackId: string,
  trackSettings: TimelineTrackSettings,
) {
  const index = videoTrackIndex(videoTrackId);
  const audioTrackId = Number.isFinite(index) ? `audio-${index}` : "audio-1";
  return !!trackSettings[audioTrackId]?.muted;
}

function buildTimelineFilterGraph(
  videoClips: VideoTimelineClip[],
  trackSettings: TimelineTrackSettings,
  timelineDuration: number,
) {
  const safeDuration = Math.max(0.1, timelineDuration);
  const windows = buildRenderWindows(videoClips);
  const filterParts: string[] = [];

  filterParts.push(
    `color=c=black:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:r=${OUTPUT_FPS}:d=${n(
      safeDuration,
      3,
    )}[basev]`,
  );

  const renderableClips = [...videoClips]
    .filter((clip) => /^video-\d+$/.test(clip.trackId))
    .sort((a, b) =>
      videoTrackIndex(a.trackId) - videoTrackIndex(b.trackId) ||
      a.timelineStart - b.timelineStart
    );

  const inputPaths = renderableClips.map((clip) => clip.sourcePath);
  const clipInputIndex = new Map<string, number>();
  renderableClips.forEach((clip, index) => clipInputIndex.set(clip.id, index));

  const orderedVideoClips = renderableClips.filter((clip) =>
    videoTrackVisible(clip.trackId, trackSettings),
  );

  const overlayLabels: string[] = [];

  for (let index = 0; index < orderedVideoClips.length; index += 1) {
    const clip = orderedVideoClips[index];
    const window = windows.get(clip.id)!;
    const inputIndex = clipInputIndex.get(clip.id)!;
    const label = `vclip${index}`;
    const localDuration = Math.max(0.001, window.sourceOut - window.sourceIn);

    const cropTop = clamp(clip.cropTop ?? 0, 0, 49) / 100;
    const cropRight = clamp(clip.cropRight ?? 0, 0, 49) / 100;
    const cropBottom = clamp(clip.cropBottom ?? 0, 0, 49) / 100;
    const cropLeft = clamp(clip.cropLeft ?? 0, 0, 49) / 100;
    const cropWidthFactor = Math.max(0.02, 1 - cropLeft - cropRight);
    const cropHeightFactor = Math.max(0.02, 1 - cropTop - cropBottom);

    const scale = clamp(clip.scale ?? 100, 10, 400) / 100;
    const rotation = clamp(clip.rotation ?? 0, -180, 180);

    const videoFilters: string[] = [
      `trim=start=${n(window.sourceIn)}:end=${n(window.sourceOut)}`,
      "setpts=PTS-STARTPTS",
      `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease`,
      "format=rgba",
    ];

    if (cropTop > 0 || cropRight > 0 || cropBottom > 0 || cropLeft > 0) {
      videoFilters.push(
        `crop=iw*${n(cropWidthFactor)}:ih*${n(cropHeightFactor)}:iw*${n(
          cropLeft,
        )}:ih*${n(cropTop)}`,
      );
      videoFilters.push(
        `pad=iw/${n(cropWidthFactor)}:ih/${n(cropHeightFactor)}:iw*${n(
          cropLeft / cropWidthFactor,
        )}:ih*${n(cropTop / cropHeightFactor)}:color=black@0`,
      );
    }

    if (Math.abs(scale - 1) > 0.0001) {
      videoFilters.push(`scale=iw*${n(scale)}:ih*${n(scale)}`);
    }

    if (Math.abs(rotation) > 0.001) {
      videoFilters.push(
        `rotate=${n(rotation)}*PI/180:ow=rotw(iw):oh=roth(ih):c=black@0`,
      );
    }

    const transitionInType = clip.transitionInType ?? "none";
    const transitionOutType = clip.transitionOutType ?? "none";
    const videoFadeInDuration = clamp(
      clip.videoFadeInDuration ?? 0,
      0,
      localDuration,
    );
    const videoFadeOutDuration = clamp(
      clip.videoFadeOutDuration ?? 0,
      0,
      localDuration,
    );

    if (videoFadeInDuration > 0.001) {
      videoFilters.push(
        `fade=t=in:st=0:d=${n(videoFadeInDuration)}:alpha=1`,
      );
    }

    if (videoFadeOutDuration > 0.001) {
      videoFilters.push(
        `fade=t=out:st=${n(
          Math.max(0, localDuration - videoFadeOutDuration),
        )}:d=${n(videoFadeOutDuration)}:alpha=1`,
      );
    }

    if (window.transitionInCross) {
      videoFilters.push(
        `fade=t=in:st=${n(window.transitionInCross.start)}:d=${n(
          window.transitionInCross.duration,
        )}:alpha=1`,
      );
    } else if (transitionInType === "cross-dissolve") {
      videoFilters.push(
        `fade=t=in:st=0:d=${n(transitionDuration(clip, "in"))}:alpha=1`,
      );
    } else if (transitionInType === "fade-black") {
      videoFilters.push(
        `fade=t=in:st=0:d=${n(transitionDuration(clip, "in"))}:color=black`,
      );
    }

    if (window.transitionOutCross) {
      videoFilters.push(
        `fade=t=out:st=${n(window.transitionOutCross.start)}:d=${n(
          window.transitionOutCross.duration,
        )}:alpha=1`,
      );
    } else if (transitionOutType === "cross-dissolve") {
      const duration = transitionDuration(clip, "out");
      videoFilters.push(
        `fade=t=out:st=${n(Math.max(0, localDuration - duration))}:d=${n(
          duration,
        )}:alpha=1`,
      );
    } else if (transitionOutType === "fade-black") {
      const duration = transitionDuration(clip, "out");
      videoFilters.push(
        `fade=t=out:st=${n(Math.max(0, localDuration - duration))}:d=${n(
          duration,
        )}:color=black`,
      );
    }

    videoFilters.push(`setpts=PTS+${n(window.timelineStart)}/TB`);

    filterParts.push(`[${inputIndex}:v]${videoFilters.join(",")}[${label}]`);
    overlayLabels.push(label);
  }

  let currentVideoLabel = "basev";

  for (let index = 0; index < orderedVideoClips.length; index += 1) {
    const clip = orderedVideoClips[index];
    const nextLabel = `vstack${index}`;
    const x = `(main_w-overlay_w)/2+(${n(clip.positionX ?? 0)}/100)*main_w`;
    const y = `(main_h-overlay_h)/2+(${n(clip.positionY ?? 0)}/100)*main_h`;

    filterParts.push(
      `[${currentVideoLabel}][${overlayLabels[index]}]overlay=x='${x}':y='${y}':eof_action=pass:repeatlast=0:shortest=0[${nextLabel}]`,
    );
    currentVideoLabel = nextLabel;
  }

  filterParts.push(
    `[${currentVideoLabel}]trim=duration=${n(safeDuration, 3)},fps=${OUTPUT_FPS}[vcomp]`,
  );

  const audioLabels: string[] = [];

  for (const clip of renderableClips) {
    if (audioTrackMuted(clip.trackId, trackSettings) || clip.audioMuted) {
      continue;
    }

    const inputIndex = clipInputIndex.get(clip.id)!;
    const duration = clipDuration(clip);
    const volume = clamp(clip.audioVolume ?? 100, 0, 100) / 100;
    const fadeIn = clamp(clip.audioFadeInDuration ?? 0, 0, duration);
    const fadeOut = clamp(clip.audioFadeOutDuration ?? 0, 0, duration);
    const label = `aclip${audioLabels.length}`;
    const filters = [
      `atrim=start=${n(clip.sourceIn)}:end=${n(clip.sourceOut)}`,
      "asetpts=PTS-STARTPTS",
      `volume=${n(volume)}`,
    ];

    if (fadeIn > 0.001) {
      filters.push(`afade=t=in:st=0:d=${n(fadeIn)}`);
    }

    if (fadeOut > 0.001) {
      filters.push(
        `afade=t=out:st=${n(Math.max(0, duration - fadeOut))}:d=${n(fadeOut)}`,
      );
    }

    const delayMs = Math.max(0, Math.round(clip.timelineStart * 1000));
    filters.push(`adelay=${delayMs}:all=1`);

    filterParts.push(`[${inputIndex}:a]${filters.join(",")}[${label}]`);
    audioLabels.push(label);
  }

  filterParts.push(
    `anullsrc=r=48000:cl=stereo,atrim=duration=${n(safeDuration, 3)}[asilent]`,
  );

  if (audioLabels.length > 0) {
    const mixInputs = ["asilent", ...audioLabels]
      .map((label) => `[${label}]`)
      .join("");
    filterParts.push(
      `${mixInputs}amix=inputs=${audioLabels.length + 1}:duration=longest:normalize=0,atrim=duration=${n(
        safeDuration,
        3,
      )}[aout]`,
    );
  } else {
    filterParts.push(`[asilent]anull[aout]`);
  }

  return {
    inputPaths,
    filterComplex: filterParts.join(";"),
  };
}

export async function exportStyledVideo(
  videoPath: string,
  subtitles: Subtitle[],
  options: ExportTimelineVideoOptions,
): Promise<string | null> {
  const outputPath = await save({
    title: "Export Edited Timeline",
    filters: [
      {
        name: "MP4 Video",
        extensions: ["mp4"],
      },
    ],
    defaultPath: "cut-the-crab-export.mp4",
  });

  if (!outputPath) {
    return null;
  }

  const assContent = buildAssTrack(
    options.trackSettings["subtitle-1"]?.hidden ? [] : subtitles,
  );
  const { inputPaths, filterComplex } = buildTimelineFilterGraph(
    options.videoClips,
    options.trackSettings,
    options.timelineDuration,
  );

  const resolvedInputs = inputPaths.length > 0 ? inputPaths : [videoPath];

  const unlisten = await listen<VideoExportProgress>(
    "video-export-progress",
    (event) => {
      options.onProgress?.(event.payload);
    },
  );

  options.onStart?.();

  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });

  try {
    await invoke("export_styled_video", {
      videoPath,
      outputPath,
      assContent,
      videoDuration: options.timelineDuration,
      inputPaths: resolvedInputs,
      filterComplex,
    });
  } finally {
    unlisten();
  }

  return outputPath;
}
