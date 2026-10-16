import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";

import { probeMediaStreams, type MediaStreams } from "./mediaProbe";

import { getSubtitleTrackId, type Subtitle } from "../types/subtitle";
import type {
  AdjustmentLayerClip,
  AdjustmentLayerProperty,
  AudioTimelineClip,
  TimelineTrackSettings,
  VideoMask,
  VideoTimelineClip,
  VideoTransformKeyframeProperty,
} from "../types/timelineModel";

import { ASS_HEIGHT, ASS_WIDTH, buildAssTrack, DEFAULT_ASS_FONT_FAMILY, DEFAULT_ASS_FONT_URL } from "../utils/assSubtitles";
import { ensureSubtitleFontLoaded } from "../utils/subtitleTextMetrics";
import { programViewportRectForAspect } from "../utils/programSnapping";
import {
  adjustmentLayerChannel,
  adjustmentLayerPropertyBaseValue,
} from "../utils/adjustmentLayers";
import {
  isFreezeFrameClip,
  isReverseVideoClip,
  videoPlaybackRate,
} from "../utils/videoRetime";
import {
  baseVideoTransformValue,
  hasVideoTransformKeyframes,
  videoTransformChannel,
} from "../utils/videoTransformKeyframes";
import { videoEffectFfmpegFilters } from "../utils/videoEffects";
import { activeVideoMask, normalizeVideoMask } from "../utils/videoMasks";
import {
  effectiveAdjustmentLayer,
  effectiveVideoLayer,
} from "../utils/videoLayers";
import {
  ffmpegBlendMode,
  isNormalBlendMode,
  normalizeVideoBlendMode,
} from "../utils/blendModes";

export type VideoExportProgress = {
  progress: number;
  status: string;
};

export type ExportTimelineRange = {
  start: number;
  end: number;
};

export type ExportFrameSize = {
  width: number;
  height: number;
};

export type ExportProgramPreviewSize = {
  width: number;
  height: number;
};

export const DEFAULT_EXPORT_FRAME_SIZE: ExportFrameSize = {
  width: 1920,
  height: 1080,
};

type ExportTimelineVideoOptions = {
  timelineDuration: number;
  videoClips: VideoTimelineClip[];
  audioClips: AudioTimelineClip[];
  adjustmentLayers: AdjustmentLayerClip[];
  trackSettings: TimelineTrackSettings;
  range?: ExportTimelineRange | null;
  frameSize?: ExportFrameSize;
  /**
   * CSS-pixel size of the Program Monitor editing canvas at export time.
   * Aspect-ratio guides are viewports inside this canvas, so reproducing its
   * aspect before the final crop is required for preview/export parity.
   */
  programPreviewSize?: ExportProgramPreviewSize;
  onStart?: () => void;
  onProgress?: (progress: VideoExportProgress) => void;
  onJobCreated?: (jobId: string) => void;
  isCancelled?: () => boolean;
};

type ClipRenderWindow = {
  sourceIn: number;
  sourceOut: number;
  timelineStart: number;
  timelineEnd: number;
  transitionInCross?: { start: number; duration: number };
  transitionOutCross?: { start: number; duration: number };
};

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

function evenDimension(value: number, fallback: number) {
  const finite = Number.isFinite(value) ? Math.round(value) : fallback;
  const clamped = Math.max(64, Math.min(7680, finite));
  return clamped % 2 === 0 ? clamped : clamped + 1;
}

function normalizeExportFrameSize(
  frameSize?: ExportFrameSize,
): ExportFrameSize {
  return {
    width: evenDimension(
      frameSize?.width ?? DEFAULT_EXPORT_FRAME_SIZE.width,
      DEFAULT_EXPORT_FRAME_SIZE.width,
    ),
    height: evenDimension(
      frameSize?.height ?? DEFAULT_EXPORT_FRAME_SIZE.height,
      DEFAULT_EXPORT_FRAME_SIZE.height,
    ),
  };
}

function exportViewportForFrameSize(frameSize: ExportFrameSize) {
  const normalized = normalizeExportFrameSize(frameSize);
  return programViewportRectForAspect(
    ASS_WIDTH,
    ASS_HEIGHT,
    normalized.width / normalized.height,
  );
}

function previewCompositionSize(previewSize?: ExportProgramPreviewSize) {
  const width = previewSize?.width ?? ASS_WIDTH;
  const height = previewSize?.height ?? ASS_HEIGHT;
  const valid =
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0;

  const aspect = valid ? width / height : ASS_WIDTH / ASS_HEIGHT;
  const compositionHeight = ASS_HEIGHT;
  // Work at a stable 1080 design height while preserving the actual Program
  // Monitor aspect. This is resolution-independent but geometrically identical
  // to the editing canvas.
  let compositionWidth = Math.max(2, Math.round(compositionHeight * aspect));
  if (compositionWidth % 2 !== 0) compositionWidth += 1;

  return { width: compositionWidth, height: compositionHeight };
}

function atempoFilters(rate: number) {
  const filters: string[] = [];
  let remaining = Math.max(0.01, rate);

  while (remaining < 0.5 - 0.000001) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }

  while (remaining > 2 + 0.000001) {
    filters.push("atempo=2");
    remaining /= 2;
  }

  if (Math.abs(remaining - 1) > 0.000001) {
    filters.push(`atempo=${n(remaining, 6)}`);
  }

  return filters;
}

function ffmpegKeyframeExpression(
  clip: VideoTimelineClip,
  property: VideoTransformKeyframeProperty,
  timeExpression: string,
  valueMultiplier = 1,
) {
  const channel = [...videoTransformChannel(clip, property)].sort(
    (a, b) => a.time - b.time,
  );
  const scaled = (value: number) => n(value * valueMultiplier, 6);

  if (channel.length === 0) {
    return scaled(baseVideoTransformValue(clip, property));
  }
  if (channel.length === 1) {
    return scaled(channel[0].value);
  }

  let expression = scaled(channel[channel.length - 1].value);
  for (let index = channel.length - 2; index >= 0; index -= 1) {
    const left = channel[index];
    const right = channel[index + 1];
    const span = Math.max(0.000001, right.time - left.time);
    const leftValue = left.value * valueMultiplier;
    const rightValue = right.value * valueMultiplier;
    const interpolated = `${n(leftValue, 6)}+(${n(rightValue - leftValue, 6)})*(${timeExpression}-${n(left.time, 6)})/${n(span, 6)}`;
    expression = `if(lt(${timeExpression},${n(right.time, 6)}),${interpolated},${expression})`;
  }

  const first = channel[0];
  return `if(lt(${timeExpression},${n(first.time, 6)}),${scaled(first.value)},${expression})`;
}

function ffmpegAdjustmentPropertyExpression(
  layer: AdjustmentLayerClip,
  property: AdjustmentLayerProperty,
  timeExpression = "t",
) {
  const channel = [...adjustmentLayerChannel(layer, property)].sort(
    (a, b) => a.time - b.time,
  );
  const baseValue = adjustmentLayerPropertyBaseValue(layer, property);

  if (channel.length === 0) return n(baseValue, 6);
  if (channel.length === 1) return n(channel[0].value, 6);

  let expression = n(channel[channel.length - 1].value, 6);
  for (let index = channel.length - 2; index >= 0; index -= 1) {
    const left = channel[index];
    const right = channel[index + 1];
    const leftTime = layer.timelineStart + left.time;
    const rightTime = layer.timelineStart + right.time;
    const span = Math.max(0.000001, rightTime - leftTime);
    const interpolated = `${n(left.value, 6)}+(${n(right.value - left.value, 6)})*(${timeExpression}-${n(leftTime, 6)})/${n(span, 6)}`;
    expression = `if(lt(${timeExpression},${n(rightTime, 6)}),${interpolated},${expression})`;
  }

  const firstTime = layer.timelineStart + channel[0].time;
  return `if(lt(${timeExpression},${n(firstTime, 6)}),${n(channel[0].value, 6)},${expression})`;
}

function clipDuration(clip: VideoTimelineClip) {
  return Math.max(0.001, clip.timelineEnd - clip.timelineStart);
}

function transitionDuration(clip: VideoTimelineClip, edge: "in" | "out") {
  const duration = clipDuration(clip);
  const requested =
    edge === "in"
      ? (clip.transitionInDuration ?? 0.5)
      : (clip.transitionOutDuration ?? 0.5);

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

  const tracks = [
    ...new Set(
      videoClips
        .map((clip) => clip.trackId)
        .filter((trackId) => /^video-\d+$/.test(trackId)),
    ),
  ].sort((a, b) => videoTrackIndex(a) - videoTrackIndex(b));

  for (const trackId of tracks) {
    const clips = videoClips
      .filter((clip) => clip.trackId === trackId)
      .sort((a, b) => a.timelineStart - b.timelineStart);

    for (let index = 0; index < clips.length - 1; index += 1) {
      const outgoing = clips[index];
      const incoming = clips[index + 1];

      if (
        isFreezeFrameClip(outgoing) ||
        isFreezeFrameClip(incoming) ||
        isReverseVideoClip(outgoing) ||
        isReverseVideoClip(incoming)
      ) {
        continue;
      }

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
      const outgoingRate = videoPlaybackRate(outgoing);
      const incomingRate = videoPlaybackRate(incoming);
      const outgoingSourceHalf = half * outgoingRate;
      const incomingSourceHalf = half * incomingRate;
      const outgoingSourceDuration =
        outgoing.sourceDuration ?? outgoing.sourceOut;
      const incomingSourceDuration =
        incoming.sourceDuration ?? incoming.sourceOut;

      const hasOutgoingHandle =
        outgoing.sourceOut + outgoingSourceHalf <=
        outgoingSourceDuration + EPSILON;
      const hasIncomingHandle =
        incoming.sourceIn - incomingSourceHalf >= -EPSILON;

      if (
        !hasOutgoingHandle ||
        !hasIncomingHandle ||
        incomingSourceDuration <= 0
      ) {
        continue;
      }

      const outgoingWindow = windows.get(outgoing.id)!;
      const incomingWindow = windows.get(incoming.id)!;

      outgoingWindow.sourceOut = Math.min(
        outgoingSourceDuration,
        outgoing.sourceOut + outgoingSourceHalf,
      );
      outgoingWindow.timelineEnd = outgoing.timelineEnd + half;
      outgoingWindow.transitionOutCross = {
        start: Math.max(0, clipDuration(outgoing) - half),
        duration,
      };

      incomingWindow.sourceIn = Math.max(
        0,
        incoming.sourceIn - incomingSourceHalf,
      );
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

function linkedAudioTrackId(
  videoTrackId: string,
  trackSettings: TimelineTrackSettings,
) {
  const candidate = trackSettings[videoTrackId]?.linkedTrackId;
  return candidate && /^audio-\d+$/.test(candidate) ? candidate : null;
}

function audioTrackMuted(
  audioTrackId: string,
  trackSettings: TimelineTrackSettings,
) {
  const soloActive = Object.entries(trackSettings).some(
    ([trackId, settings]) =>
      /^audio-\d+$/.test(trackId) &&
      settings.deleted !== true &&
      settings.solo === true,
  );
  return (
    !!trackSettings[audioTrackId]?.muted ||
    (soloActive && trackSettings[audioTrackId]?.solo !== true)
  );
}

function normalizeExportRange(
  range: ExportTimelineRange | null | undefined,
  timelineDuration: number,
) {
  if (!range) {
    return null;
  }

  const maxDuration = Math.max(0, timelineDuration);
  const start = clamp(Math.min(range.start, range.end), 0, maxDuration);
  const end = clamp(Math.max(range.start, range.end), 0, maxDuration);

  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.001) {
    return null;
  }

  return { start, end };
}

function subtitlesForExportRange(
  subtitles: Subtitle[],
  range: ExportTimelineRange | null,
) {
  if (!range) {
    return subtitles;
  }

  return subtitles.flatMap((subtitle) => {
    const start = Math.max(subtitle.startTime, range.start);
    const end = Math.min(subtitle.endTime, range.end);

    if (end - start < 0.001) {
      return [];
    }

    return [
      {
        ...subtitle,
        startTime: start - range.start,
        endTime: end - range.start,
      },
    ];
  });
}

function appendStaticMaskSource(
  filterParts: string[],
  mask: VideoMask,
  width: number,
  height: number,
  duration: number,
  label: string,
) {
  const normalized = normalizeVideoMask(mask)!;
  const cx = (normalized.positionX / 100) * width;
  const cy = (normalized.positionY / 100) * height;
  const maskWidth = Math.max(1, (normalized.width / 100) * width);
  const maskHeight = Math.max(1, (normalized.height / 100) * height);
  const feather = Math.max(0, normalized.feather) * (height / 1080);
  const halfW = maskWidth / 2;
  const halfH = maskHeight / 2;
  const shapeExpression =
    normalized.shape === "ellipse"
      ? `if(lte(pow((X-${n(cx, 5)})/${n(Math.max(0.5, halfW), 5)}\\,2)+pow((Y-${n(cy, 5)})/${n(Math.max(0.5, halfH), 5)}\\,2)\\,1)\\,255\\,0)`
      : `if(between(X\\,${n(cx - halfW, 5)}\\,${n(cx + halfW, 5)})*between(Y\\,${n(cy - halfH, 5)}\\,${n(cy + halfH, 5)})\\,255\\,0)`;
  const filters = [
    `geq=lum='${shapeExpression}'`,
    ...(feather > 0.001 ? [`gblur=sigma=${n(feather, 4)}`] : []),
    ...(normalized.invert ? ["negate"] : []),
    `tpad=stop_mode=clone:stop_duration=${n(duration, 3)}`,
    `trim=duration=${n(duration, 3)}`,
    "setpts=PTS-STARTPTS",
  ];
  filterParts.push(
    `color=c=black:s=${width}x${height}:r=${OUTPUT_FPS}:d=${n(1 / OUTPUT_FPS, 6)},format=gray,${filters.join(",")}[${label}]`,
  );
}

function appendMaskToRgba(
  filterParts: string[],
  inputLabel: string,
  maskLabel: string,
  stage: number,
) {
  const colorLabel = `vmaskcolor${stage}`;
  const alphaSourceLabel = `vmaskalphasrc${stage}`;
  const alphaLabel = `vmaskalpha${stage}`;
  const multipliedLabel = `vmaskmul${stage}`;
  const outputLabel = `vmasked${stage}`;
  filterParts.push(
    `[${inputLabel}]format=rgba,split=2[${colorLabel}][${alphaSourceLabel}]`,
  );
  filterParts.push(`[${alphaSourceLabel}]alphaextract[${alphaLabel}]`);
  filterParts.push(
    `[${alphaLabel}][${maskLabel}]blend=all_mode=multiply[${multipliedLabel}]`,
  );
  filterParts.push(
    `[${colorLabel}][${multipliedLabel}]alphamerge[${outputLabel}]`,
  );
  return outputLabel;
}

function createStreamAllocator(
  filterParts: string[],
  videoUses: Map<number, number>,
  audioUses: Map<number, number>,
) {
  const queues = new Map<string, string[]>();

  const register = (kind: "v" | "a", index: number, uses: number) => {
    if (uses <= 1) return;
    const labels = Array.from({ length: uses }, (_, useIndex) =>
      `s${kind}${index}_${useIndex}`,
    );
    const filter = kind === "v" ? "split" : "asplit";
    filterParts.push(
      `[${index}:${kind}]${filter}=${uses}${labels
        .map((label) => `[${label}]`)
        .join("")}`,
    );
    queues.set(`${kind}${index}`, labels);
  };

  for (const [index, uses] of videoUses) register("v", index, uses);
  for (const [index, uses] of audioUses) register("a", index, uses);

  const take = (kind: "v" | "a", index: number) =>
    queues.get(`${kind}${index}`)?.shift() ?? `${index}:${kind}`;

  return {
    takeVideo: (index: number) => take("v", index),
    takeAudio: (index: number) => take("a", index),
  };
}

function incrementStreamUse(map: Map<number, number>, inputIndex: number) {
  map.set(inputIndex, (map.get(inputIndex) ?? 0) + 1);
}

function buildTimelineFilterGraph(
  videoClips: VideoTimelineClip[],
  audioClips: AudioTimelineClip[],
  adjustmentLayers: AdjustmentLayerClip[],
  trackSettings: TimelineTrackSettings,
  timelineDuration: number,
  streams: Map<string, MediaStreams>,
  range?: ExportTimelineRange | null,
  frameSize?: ExportFrameSize,
  programPreviewSize?: ExportProgramPreviewSize,
) {
  const safeDuration = Math.max(0.1, timelineDuration);
  const normalizedFrameSize = normalizeExportFrameSize(frameSize);
  const outputWidth = normalizedFrameSize.width;
  const outputHeight = normalizedFrameSize.height;

  // Reproduce the actual Program Monitor editing canvas first. The dashed
  // aspect-ratio boxes are centered viewports INSIDE that canvas; they are not
  // separate canvases. Starting directly at 1920x1080 changes the meaning of
  // position/contain geometry whenever the viewer itself is wider than 16:9.
  //
  // Use a fixed 1080 design height with the monitor's live aspect ratio so the
  // geometry is deterministic while remaining pixel-independent. The selected
  // export preset is cropped from this virtual canvas exactly like its dashed
  // guide in the viewer, then scaled to the requested output resolution.
  const compositionSize = previewCompositionSize(programPreviewSize);
  const compositionWidth = compositionSize.width;
  const compositionHeight = compositionSize.height;
  const exportViewport = programViewportRectForAspect(
    compositionWidth,
    compositionHeight,
    outputWidth / outputHeight,
  );
  const exportRange = normalizeExportRange(range, safeDuration);
  const outputDuration = exportRange
    ? Math.max(0.001, exportRange.end - exportRange.start)
    : safeDuration;
  const windows = buildRenderWindows(videoClips);
  const filterParts: string[] = [];

  filterParts.push(
    `color=c=black@0:s=${compositionWidth}x${compositionHeight}:r=${OUTPUT_FPS}:d=${n(
      safeDuration,
      3,
    )},format=rgba[basev]`,
  );

  const renderableClips = [...videoClips]
    .filter((clip) => /^video-\d+$/.test(clip.trackId))
    .sort(
      (a, b) =>
        effectiveVideoLayer(a) - effectiveVideoLayer(b) ||
        a.timelineStart - b.timelineStart ||
        a.id.localeCompare(b.id),
    );

  const standaloneAudioClips = [...audioClips]
    .filter(
      (clip) =>
        /^audio-\d+$/.test(clip.trackId) &&
        !trackSettings[clip.trackId]?.deleted &&
        !trackSettings[clip.trackId]?.linkedTrackId,
    )
    .sort(
      (a, b) =>
        a.trackId.localeCompare(b.trackId) || a.timelineStart - b.timelineStart,
    );

  const sourceHasVideo = (sourcePath: string) =>
    streams.get(sourcePath)?.hasVideo === true;
  const sourceHasAudio = (sourcePath: string) =>
    streams.get(sourcePath)?.hasAudio === true;

  const contributesLinkedAudio = (clip: VideoTimelineClip) => {
    const audioTrackId = linkedAudioTrackId(clip.trackId, trackSettings);
    return (
      !isFreezeFrameClip(clip) &&
      !!audioTrackId &&
      !audioTrackMuted(audioTrackId, trackSettings) &&
      !clip.audioMuted &&
      sourceHasAudio(clip.sourcePath)
    );
  };

  const contributesStandaloneAudio = (clip: AudioTimelineClip) =>
    !audioTrackMuted(clip.trackId, trackSettings) &&
    !clip.muted &&
    sourceHasAudio(clip.sourcePath);

  const orderedVideoClips = renderableClips.filter(
    (clip) =>
      videoTrackVisible(clip.trackId, trackSettings) &&
      sourceHasVideo(clip.sourcePath),
  );

  // FFmpeg opens each unique source file once. Because a single unlabeled input
  // stream cannot feed multiple filter chains directly, shared video/audio
  // streams are split/asplit exactly once below and each consumer takes one
  // generated label. Hidden video tracks still contribute linked audio.
  const requiredLinkedClips = renderableClips.filter(
    (clip) =>
      (videoTrackVisible(clip.trackId, trackSettings) &&
        sourceHasVideo(clip.sourcePath)) ||
      contributesLinkedAudio(clip),
  );

  const inputPaths = [
    ...new Set([
      ...requiredLinkedClips.map((clip) => clip.sourcePath),
      ...standaloneAudioClips
        .filter(contributesStandaloneAudio)
        .map((clip) => clip.sourcePath),
    ]),
  ];

  const inputIndexByPath = new Map(
    inputPaths.map((path, index) => [path, index] as const),
  );
  const clipInputIndex = new Map<string, number>();
  requiredLinkedClips.forEach((clip) => {
    const inputIndex = inputIndexByPath.get(clip.sourcePath);
    if (inputIndex !== undefined) clipInputIndex.set(clip.id, inputIndex);
  });

  const standaloneAudioInputIndex = new Map<string, number>();
  standaloneAudioClips.forEach((clip) => {
    const inputIndex = inputIndexByPath.get(clip.sourcePath);
    if (inputIndex !== undefined) {
      standaloneAudioInputIndex.set(clip.id, inputIndex);
    }
  });

  const videoUses = new Map<number, number>();
  for (const clip of orderedVideoClips) {
    const inputIndex = clipInputIndex.get(clip.id);
    if (inputIndex !== undefined) incrementStreamUse(videoUses, inputIndex);
  }

  const audioUses = new Map<number, number>();
  for (const clip of renderableClips) {
    if (!contributesLinkedAudio(clip)) continue;
    const inputIndex = clipInputIndex.get(clip.id);
    if (inputIndex !== undefined) incrementStreamUse(audioUses, inputIndex);
  }
  for (const clip of standaloneAudioClips) {
    if (!contributesStandaloneAudio(clip)) continue;
    const inputIndex = standaloneAudioInputIndex.get(clip.id);
    if (inputIndex !== undefined) incrementStreamUse(audioUses, inputIndex);
  }

  const streamAllocator = createStreamAllocator(
    filterParts,
    videoUses,
    audioUses,
  );

  const overlayLabels: string[] = [];

  for (let index = 0; index < orderedVideoClips.length; index += 1) {
    const clip = orderedVideoClips[index];
    const window = windows.get(clip.id)!;
    const inputIndex = clipInputIndex.get(clip.id)!;
    const label = `vclip${index}`;
    const playbackRate = videoPlaybackRate(clip);
    const localDuration = isFreezeFrameClip(clip)
      ? Math.max(0.001, window.timelineEnd - window.timelineStart)
      : Math.max(0.001, (window.sourceOut - window.sourceIn) / playbackRate);

    const cropTop = clamp(clip.cropTop ?? 0, 0, 49) / 100;
    const cropRight = clamp(clip.cropRight ?? 0, 0, 49) / 100;
    const cropBottom = clamp(clip.cropBottom ?? 0, 0, 49) / 100;
    const cropLeft = clamp(clip.cropLeft ?? 0, 0, 49) / 100;
    const cropWidthFactor = Math.max(0.02, 1 - cropLeft - cropRight);
    const cropHeightFactor = Math.max(0.02, 1 - cropTop - cropBottom);

    const scale = clamp(clip.scale ?? 100, 10, 400) / 100;
    const rotation = clamp(clip.rotation ?? 0, -180, 180);
    const opacity = clamp(clip.opacity ?? 100, 0, 100) / 100;
    const localTimeExpression = `(t+${n(window.timelineStart - clip.timelineStart, 6)})`;
    const scaleAnimated = hasVideoTransformKeyframes(clip, "scale");
    const rotationAnimated = hasVideoTransformKeyframes(clip, "rotation");
    const opacityAnimated = hasVideoTransformKeyframes(clip, "opacity");

    const videoFilters: string[] = [];
    if (isFreezeFrameClip(clip)) {
      const frameTime = Math.max(
        0,
        clip.freezeFrameSourceTime ?? window.sourceIn,
      );
      const frameEnd = frameTime + 1 / OUTPUT_FPS;
      videoFilters.push(
        `trim=start=${n(frameTime, 6)}:end=${n(frameEnd, 6)}`,
        "setpts=PTS-STARTPTS",
        `fps=${OUTPUT_FPS}`,
        `tpad=stop_mode=clone:stop_duration=${n(localDuration, 6)}`,
        `trim=duration=${n(localDuration, 6)}`,
      );
    } else {
      videoFilters.push(
        `trim=start=${n(window.sourceIn)}:end=${n(window.sourceOut)}`,
        "setpts=PTS-STARTPTS",
      );
      if (isReverseVideoClip(clip))
        videoFilters.push("reverse", "setpts=PTS-STARTPTS");
      videoFilters.push(`setpts=(PTS-STARTPTS)/${n(playbackRate, 6)}`);
    }
    videoFilters.push(
      `scale=${compositionWidth}:${compositionHeight}:force_original_aspect_ratio=decrease`,
      "format=rgba",
    );
    videoFilters.push(...videoEffectFfmpegFilters(clip.effects));

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

    if (opacityAnimated) {
      const opacityTimeExpression = `(T+${n(window.timelineStart - clip.timelineStart, 6)})`;
      const opacityExpression = ffmpegKeyframeExpression(
        clip,
        "opacity",
        opacityTimeExpression,
        0.01,
      );
      videoFilters.push(
        `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${opacityExpression})'`,
      );
    } else if (opacity < 0.9999) {
      videoFilters.push(`colorchannelmixer=aa=${n(opacity, 6)}`);
    }

    if (rotationAnimated) {
      const rotationExpression = ffmpegKeyframeExpression(
        clip,
        "rotation",
        localTimeExpression,
      );
      videoFilters.push(
        `rotate='(${rotationExpression})*PI/180':ow=hypot(iw\\,ih):oh=ow:c=black@0`,
      );
    } else if (Math.abs(rotation) > 0.001) {
      videoFilters.push(
        `rotate=${n(rotation)}*PI/180:ow=rotw(iw):oh=roth(ih):c=black@0`,
      );
    }

    // Uniform scale and rotation commute. Scaling after rotation keeps the
    // rotate canvas based on a stable input size, which avoids clipping when
    // an animated Scale channel grows later in the clip.
    if (scaleAnimated) {
      const scaleExpression = ffmpegKeyframeExpression(
        clip,
        "scale",
        localTimeExpression,
        0.01,
      );
      videoFilters.push(
        `scale=w='iw*(${scaleExpression})':h='ih*(${scaleExpression})':eval=frame`,
      );
    } else if (Math.abs(scale - 1) > 0.0001) {
      videoFilters.push(`scale=iw*${n(scale)}:ih*${n(scale)}`);
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
      videoFilters.push(`fade=t=in:st=0:d=${n(videoFadeInDuration)}:alpha=1`);
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

    filterParts.push(
      `[${streamAllocator.takeVideo(inputIndex)}]${videoFilters.join(",")}[${label}]`,
    );
    overlayLabels.push(label);
  }

  let currentVideoLabel = "basev";
  let compositeStage = 0;
  const overlayLabelByClipId = new Map<string, string>();
  orderedVideoClips.forEach((clip, index) =>
    overlayLabelByClipId.set(clip.id, overlayLabels[index]),
  );

  const compositionItems = [
    ...orderedVideoClips.map((clip) => ({
      kind: "video" as const,
      id: clip.id,
      timelineStart: clip.timelineStart,
      layer: effectiveVideoLayer(clip),
      clip,
    })),
    ...adjustmentLayers
      .filter(
        (layer) =>
          /^video-\d+$/.test(layer.trackId) &&
          layer.enabled !== false &&
          trackSettings[layer.trackId]?.deleted !== true &&
          trackSettings[layer.trackId]?.hidden !== true,
      )
      .map((layer) => ({
        kind: "adjustment" as const,
        id: layer.id,
        timelineStart: layer.timelineStart,
        layer: effectiveAdjustmentLayer(layer),
        adjustment: layer,
      })),
  ].sort(
    (a, b) =>
      a.layer - b.layer ||
      (a.kind === b.kind ? 0 : a.kind === "adjustment" ? -1 : 1) ||
      a.timelineStart - b.timelineStart ||
      a.id.localeCompare(b.id),
  );

  for (const item of compositionItems) {
    if (item.kind === "adjustment") {
      const layer = item.adjustment;
      const opacity = ffmpegAdjustmentPropertyExpression(layer, "opacity");
      const exposure = ffmpegAdjustmentPropertyExpression(layer, "exposure");
      const contrastControl = ffmpegAdjustmentPropertyExpression(
        layer,
        "contrast",
      );
      const saturationControl = ffmpegAdjustmentPropertyExpression(
        layer,
        "saturation",
      );
      const temperature = ffmpegAdjustmentPropertyExpression(
        layer,
        "temperature",
      );
      const tint = ffmpegAdjustmentPropertyExpression(layer, "tint");
      const highlights = ffmpegAdjustmentPropertyExpression(
        layer,
        "highlights",
      );
      const shadows = ffmpegAdjustmentPropertyExpression(layer, "shadows");
      const whites = ffmpegAdjustmentPropertyExpression(layer, "whites");
      const blacks = ffmpegAdjustmentPropertyExpression(layer, "blacks");

      // Build the Adjustment Layer at full strength first, then mix that full
      // result back over the untouched lower composite using the animated
      // Opacity channel. This makes Opacity consistently govern color controls,
      // Blur/Sharpen/Vignette, masks, and non-Normal blend modes.
      const brightness = `clip(((${exposure})*0.12+(${whites})*0.0016+(${blacks})*0.0009),-1,1)`;
      const contrast = `clip(1+((${contrastControl})/100*0.75+(${whites})*0.0012-(${blacks})*0.0010),0.05,2)`;
      const saturation = `clip(((${saturationControl})/100),0,3)`;
      const gamma = `clip(1+((${shadows})/100)*0.5-((${highlights})/100)*0.18,0.4,3)`;
      const gammaWeight = `clip(1-max(0,((${shadows})/100))*0.55,0.1,1)`;
      const gammaR = `clip(1+((${temperature})/100)*0.14+((${tint})/100)*0.07,0.5,2)`;
      const gammaG = `clip(1-((${tint})/100)*0.12,0.5,2)`;
      const gammaB = `clip(1-((${temperature})/100)*0.14+((${tint})/100)*0.07,0.5,2)`;
      const enable = `between(t,${n(layer.timelineStart, 6)},${n(layer.timelineEnd, 6)})`;
      const mixStrength = `clip(((${opacity})/100)*(${enable}),0,1)`;
      const layerMask = activeVideoMask(layer.mask);
      const blendMode = normalizeVideoBlendMode(layer.blendMode);
      const usesBlendMode = !isNormalBlendMode(blendMode);

      const mixBaseLabel = `vadjmixbase${compositeStage++}`;
      const workBranchLabel = `vadjwork${compositeStage++}`;
      const extraLabels: string[] = [];
      let blendBaseLabel: string | null = null;
      let maskBaseLabel: string | null = null;

      if (usesBlendMode) {
        blendBaseLabel = `vadjblendbase${compositeStage++}`;
        extraLabels.push(blendBaseLabel);
      }
      if (layerMask) {
        maskBaseLabel = `vadjmaskbase${compositeStage++}`;
        extraLabels.push(maskBaseLabel);
      }

      const splitLabels = [mixBaseLabel, workBranchLabel, ...extraLabels];
      filterParts.push(
        `[${currentVideoLabel}]split=${splitLabels.length}${splitLabels
          .map((label) => `[${label}]`)
          .join("")}`,
      );

      let fullResultLabel = `vadj${compositeStage++}`;
      filterParts.push(
        `[${workBranchLabel}]eq=brightness='${brightness}':contrast='${contrast}':saturation='${saturation}':gamma='${gamma}':gamma_weight='${gammaWeight}':gamma_r='${gammaR}':gamma_g='${gammaG}':gamma_b='${gammaB}':eval=frame:enable='${enable}'[${fullResultLabel}]`,
      );

      for (const effectFilter of videoEffectFfmpegFilters(
        layer.effects,
        enable,
      )) {
        const effectLabel = `vfx${compositeStage++}`;
        filterParts.push(`[${fullResultLabel}]${effectFilter}[${effectLabel}]`);
        fullResultLabel = effectLabel;
      }

      if (usesBlendMode && blendBaseLabel) {
        const blendBaseColorLabel = `vadjblendbasecolor${compositeStage++}`;
        const blendBaseAlphaSourceLabel = `vadjblendbasealphasrc${compositeStage++}`;
        const blendBaseAlphaLabel = `vadjblendbasealpha${compositeStage++}`;
        const adjustedBlendLabel = `vadjblendsource${compositeStage++}`;
        const rawBlendLabel = `vadjblendraw${compositeStage++}`;
        const rawBlendColorLabel = `vadjblendrawcolor${compositeStage++}`;
        const blendedRgbaLabel = `vadjblendrgba${compositeStage++}`;

        filterParts.push(
          `[${blendBaseLabel}]split=2[${blendBaseColorLabel}][${blendBaseAlphaSourceLabel}]`,
        );
        filterParts.push(
          `[${blendBaseAlphaSourceLabel}]alphaextract[${blendBaseAlphaLabel}]`,
        );
        filterParts.push(
          `[${fullResultLabel}]format=rgba[${adjustedBlendLabel}]`,
        );
        filterParts.push(
          `[${adjustedBlendLabel}][${blendBaseColorLabel}]blend=all_mode=${ffmpegBlendMode(
            blendMode,
          )}:enable='${enable}':eof_action=pass:repeatlast=0:shortest=0[${rawBlendLabel}]`,
        );
        filterParts.push(
          `[${rawBlendLabel}]format=gbrp[${rawBlendColorLabel}]`,
        );
        filterParts.push(
          `[${rawBlendColorLabel}][${blendBaseAlphaLabel}]alphamerge[${blendedRgbaLabel}]`,
        );
        fullResultLabel = blendedRgbaLabel;
      }

      if (layerMask && maskBaseLabel) {
        const maskLabel = `vadjmasksource${compositeStage++}`;
        appendStaticMaskSource(
          filterParts,
          layerMask,
          compositionWidth,
          compositionHeight,
          safeDuration,
          maskLabel,
        );
        const maskedLabel = appendMaskToRgba(
          filterParts,
          fullResultLabel,
          maskLabel,
          compositeStage++,
        );
        const mergedLabel = `vadjmaskedmerge${compositeStage++}`;
        filterParts.push(
          `[${maskBaseLabel}][${maskedLabel}]overlay=x=0:y=0:eof_action=pass:repeatlast=0:shortest=0[${mergedLabel}]`,
        );
        fullResultLabel = mergedLabel;
      }

      const mixedLabel = `vadjmixed${compositeStage++}`;
      filterParts.push(
        `[${mixBaseLabel}][${fullResultLabel}]blend=all_expr='A*(1-(${mixStrength}))+B*(${mixStrength})':eof_action=pass:repeatlast=0:shortest=0[${mixedLabel}]`,
      );
      currentVideoLabel = mixedLabel;
      continue;
    }

    const clip = item.clip;
      const overlayLabel = overlayLabelByClipId.get(clip.id);
      if (!overlayLabel) continue;
      const nextLabel = `vstack${compositeStage++}`;
      const overlayLocalTime = `(t-${n(clip.timelineStart, 6)})`;
      const positionXExpression = ffmpegKeyframeExpression(
        clip,
        "positionX",
        overlayLocalTime,
      );
      const positionYExpression = ffmpegKeyframeExpression(
        clip,
        "positionY",
        overlayLocalTime,
      );
      const x = `(main_w-overlay_w)/2+((${positionXExpression})/100)*main_w`;
      const y = `(main_h-overlay_h)/2+((${positionYExpression})/100)*main_h`;

      const clipMask = activeVideoMask(clip.mask);
      const blendMode = normalizeVideoBlendMode(clip.blendMode);
      const usesBlendMode = !isNormalBlendMode(blendMode);

      if (clipMask || usesBlendMode) {
        const transparentLabel = `vtransparent${compositeStage++}`;
        const placedLabel = `vplaced${compositeStage++}`;
        filterParts.push(
          `color=c=black@0:s=${compositionWidth}x${compositionHeight}:r=${OUTPUT_FPS}:d=${n(safeDuration, 3)},format=rgba[${transparentLabel}]`,
        );
        filterParts.push(
          `[${transparentLabel}][${overlayLabel}]overlay=x='${x}':y='${y}':eof_action=pass:repeatlast=0:shortest=0[${placedLabel}]`,
        );

        let sourceLabel = placedLabel;
        if (clipMask) {
          const maskLabel = `vmasksource${compositeStage++}`;
          appendStaticMaskSource(
            filterParts,
            clipMask,
            compositionWidth,
            compositionHeight,
            safeDuration,
            maskLabel,
          );
          sourceLabel = appendMaskToRgba(
            filterParts,
            sourceLabel,
            maskLabel,
            compositeStage++,
          );
        }

        if (usesBlendMode) {
          const baseKeepLabel = `vblendbasekeep${compositeStage++}`;
          const baseBlendLabel = `vblendbase${compositeStage++}`;
          const baseAlphaSourceLabel = `vblendbasealphasrc${compositeStage++}`;
          const baseAlphaLabel = `vblendbasealpha${compositeStage++}`;
          const sourceBlendLabel = `vblendsource${compositeStage++}`;
          const sourceAlphaSourceLabel = `vblendalphasrc${compositeStage++}`;
          const sourceColorSourceLabel = `vblendcolorsrc${compositeStage++}`;
          const sourceAlphaLabel = `vblendalpha${compositeStage++}`;
          const sourceColorLabel = `vblendsourcecolor${compositeStage++}`;
          const rawBlendLabel = `vblendraw${compositeStage++}`;
          const rawBlendColorLabel = `vblendrawcolor${compositeStage++}`;
          const resolvedColorLabel = `vblendresolvedcolor${compositeStage++}`;
          const rgbaLabel = `vblendrgba${compositeStage++}`;

          // Blend modes belong to the transparent video stack, not the black
          // Program Monitor background. Preserve the source color wherever the
          // current stack has no alpha, and use the blended color only where a
          // real lower video layer exists. This mirrors CSS isolated-group
          // compositing and prevents bottom/gap regions from multiplying with
          // black during export.
          filterParts.push(
            `[${currentVideoLabel}]split=3[${baseKeepLabel}][${baseBlendLabel}][${baseAlphaSourceLabel}]`,
          );
          filterParts.push(
            `[${sourceLabel}]split=3[${sourceBlendLabel}][${sourceAlphaSourceLabel}][${sourceColorSourceLabel}]`,
          );
          filterParts.push(
            `[${baseAlphaSourceLabel}]alphaextract[${baseAlphaLabel}]`,
          );
          filterParts.push(
            `[${sourceAlphaSourceLabel}]alphaextract[${sourceAlphaLabel}]`,
          );
          filterParts.push(
            `[${sourceColorSourceLabel}]format=gbrp[${sourceColorLabel}]`,
          );
          filterParts.push(
            `[${sourceBlendLabel}][${baseBlendLabel}]blend=all_mode=${ffmpegBlendMode(
              blendMode,
            )}:eof_action=pass:repeatlast=0:shortest=0[${rawBlendLabel}]`,
          );
          filterParts.push(
            `[${rawBlendLabel}]format=gbrp[${rawBlendColorLabel}]`,
          );
          filterParts.push(
            `[${sourceColorLabel}][${rawBlendColorLabel}][${baseAlphaLabel}]maskedmerge[${resolvedColorLabel}]`,
          );
          filterParts.push(
            `[${resolvedColorLabel}][${sourceAlphaLabel}]alphamerge[${rgbaLabel}]`,
          );
          filterParts.push(
            `[${baseKeepLabel}][${rgbaLabel}]overlay=x=0:y=0:eof_action=pass:repeatlast=0:shortest=0[${nextLabel}]`,
          );
        } else {
          filterParts.push(
            `[${currentVideoLabel}][${sourceLabel}]overlay=x=0:y=0:eof_action=pass:repeatlast=0:shortest=0[${nextLabel}]`,
          );
        }
      } else {
        filterParts.push(
          `[${currentVideoLabel}][${overlayLabel}]overlay=x='${x}':y='${y}':eof_action=pass:repeatlast=0:shortest=0[${nextLabel}]`,
        );
      }
      currentVideoLabel = nextLabel;
  }

  // The Program Monitor's black is a viewer background, not a blend source.
  // Flatten the finished transparent video stack onto black only after all
  // clip/Adjustment blend operations are complete.
  const finalBackgroundLabel = `vfinalbg${compositeStage++}`;
  const opaqueCompositionLabel = `vopaque${compositeStage++}`;
  filterParts.push(
    `color=c=black:s=${compositionWidth}x${compositionHeight}:r=${OUTPUT_FPS}:d=${n(
      safeDuration,
      3,
    )}[${finalBackgroundLabel}]`,
  );
  filterParts.push(
    `[${finalBackgroundLabel}][${currentVideoLabel}]overlay=x=0:y=0:eof_action=pass:repeatlast=0:shortest=0[${opaqueCompositionLabel}]`,
  );

  // Crop the finished Program-Monitor composition to the chosen guide, then
  // scale that viewport to the requested output resolution. Keeping this step
  // after all clip transforms/layers is what makes the export a literal
  // "what is inside the dashed box" result.
  const viewportLabel = `vviewport${compositeStage++}`;
  filterParts.push(
    `[${opaqueCompositionLabel}]crop=w=${n(exportViewport.width, 6)}:h=${n(
      exportViewport.height,
      6,
    )}:x=${n(exportViewport.left, 6)}:y=${n(
      exportViewport.top,
      6,
    )},scale=${outputWidth}:${outputHeight}:flags=lanczos[${viewportLabel}]`,
  );

  if (exportRange) {
    filterParts.push(
      `[${viewportLabel}]trim=start=${n(exportRange.start)}:end=${n(
        exportRange.end,
      )},setpts=PTS-STARTPTS,fps=${OUTPUT_FPS}[vcomp]`,
    );
  } else {
    filterParts.push(
      `[${viewportLabel}]trim=duration=${n(
        safeDuration,
        3,
      )},setpts=PTS-STARTPTS,fps=${OUTPUT_FPS}[vcomp]`,
    );
  }

  const audioLabels: string[] = [];

  for (const clip of renderableClips) {
    if (!contributesLinkedAudio(clip)) continue;

    const inputIndex = clipInputIndex.get(clip.id);
    if (inputIndex === undefined) continue;
    const duration = clipDuration(clip);
    const volume = clamp(clip.audioVolume ?? 100, 0, 100) / 100;
    const fadeIn = clamp(clip.audioFadeInDuration ?? 0, 0, duration);
    const fadeOut = clamp(clip.audioFadeOutDuration ?? 0, 0, duration);
    const label = `aclip${audioLabels.length}`;
    const filters = [
      `atrim=start=${n(clip.sourceIn)}:end=${n(clip.sourceOut)}`,
      "asetpts=PTS-STARTPTS",
      ...(isReverseVideoClip(clip) ? ["areverse", "asetpts=PTS-STARTPTS"] : []),
      ...atempoFilters(videoPlaybackRate(clip)),
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

    filterParts.push(
      `[${streamAllocator.takeAudio(inputIndex)}]${filters.join(",")}[${label}]`,
    );
    audioLabels.push(label);
  }

  for (const clip of standaloneAudioClips) {
    if (!contributesStandaloneAudio(clip)) continue;

    const inputIndex = standaloneAudioInputIndex.get(clip.id);
    if (inputIndex === undefined) continue;
    const duration = Math.max(0.001, clip.timelineEnd - clip.timelineStart);
    const volume = clamp(clip.volume ?? 100, 0, 100) / 100;
    const fadeIn = clamp(clip.fadeInDuration ?? 0, 0, duration);
    const fadeOut = clamp(clip.fadeOutDuration ?? 0, 0, duration);
    const label = `astandalone${audioLabels.length}`;
    const filters = [
      `atrim=start=${n(clip.sourceIn)}:end=${n(clip.sourceOut)}`,
      "asetpts=PTS-STARTPTS",
      `volume=${n(volume)}`,
    ];

    if (fadeIn > 0.001) filters.push(`afade=t=in:st=0:d=${n(fadeIn)}`);
    if (fadeOut > 0.001) {
      filters.push(
        `afade=t=out:st=${n(Math.max(0, duration - fadeOut))}:d=${n(fadeOut)}`,
      );
    }

    const delayMs = Math.max(0, Math.round(clip.timelineStart * 1000));
    filters.push(`adelay=${delayMs}:all=1`);
    filterParts.push(
      `[${streamAllocator.takeAudio(inputIndex)}]${filters.join(",")}[${label}]`,
    );
    audioLabels.push(label);
  }

  filterParts.push(
    `anullsrc=r=48000:cl=stereo,atrim=duration=${n(safeDuration, 3)}[asilent]`,
  );

  let mixedAudioLabel = "asilent";

  if (audioLabels.length > 0) {
    const mixInputs = ["asilent", ...audioLabels]
      .map((label) => `[${label}]`)
      .join("");
    filterParts.push(
      `${mixInputs}amix=inputs=${
        audioLabels.length + 1
      }:duration=longest:normalize=0[amixed]`,
    );
    mixedAudioLabel = "amixed";
  }

  if (exportRange) {
    filterParts.push(
      `[${mixedAudioLabel}]atrim=start=${n(exportRange.start)}:end=${n(
        exportRange.end,
      )},asetpts=PTS-STARTPTS[aout]`,
    );
  } else {
    filterParts.push(
      `[${mixedAudioLabel}]atrim=duration=${n(
        safeDuration,
        3,
      )},asetpts=PTS-STARTPTS[aout]`,
    );
  }

  return {
    inputPaths,
    filterComplex: filterParts.join(";"),
    outputDuration,
    exportRange,
  };
}

export async function exportStyledVideo(
  videoPath: string,
  subtitles: Subtitle[],
  options: ExportTimelineVideoOptions,
): Promise<string | null> {
  const normalizedRange = normalizeExportRange(
    options.range,
    options.timelineDuration,
  );

  const outputPath = await save({
    title: normalizedRange ? "Export Selected Range" : "Export Edited Timeline",
    filters: [
      {
        name: "MP4 Video",
        extensions: ["mp4"],
      },
    ],
    defaultPath: normalizedRange
      ? "cut-the-crab-range-export.mp4"
      : "cut-the-crab-export.mp4",
  });

  if (!outputPath) {
    return null;
  }
  if (options.isCancelled?.()) return null;

  const frameSize = normalizeExportFrameSize(options.frameSize);
  const visibleSubtitles = subtitles.filter(
    (subtitle) => !options.trackSettings[getSubtitleTrackId(subtitle)]?.hidden,
  );
  await ensureSubtitleFontLoaded(DEFAULT_ASS_FONT_FAMILY, DEFAULT_ASS_FONT_URL);
  const assContent = buildAssTrack(
    subtitlesForExportRange(visibleSubtitles, normalizedRange),
    {
      playResWidth: frameSize.width,
      playResHeight: frameSize.height,
      sourceViewport: exportViewportForFrameSize(frameSize),
    },
  );
  const streams = await probeMediaStreams([
    ...options.videoClips.map((clip) => clip.sourcePath),
    ...options.audioClips.map((clip) => clip.sourcePath),
  ]);

  if (options.isCancelled?.()) return null;

  const { inputPaths, filterComplex, outputDuration } =
    buildTimelineFilterGraph(
      options.videoClips,
      options.audioClips,
      options.adjustmentLayers,
      options.trackSettings,
      options.timelineDuration,
      streams,
      normalizedRange,
      frameSize,
      options.programPreviewSize,
    );

  const resolvedInputs = inputPaths.length > 0 ? inputPaths : [videoPath];

  const exportJobId = crypto.randomUUID();
  options.onJobCreated?.(exportJobId);

  const unlisten = await listen<VideoExportProgress>(
    "video-export-progress",
    (event) => {
      const payload =
        normalizedRange &&
        event.payload.status === "Rendering edited timeline..."
          ? {
              ...event.payload,
              status: "Rendering selected range...",
            }
          : event.payload;

      options.onProgress?.(payload);
    },
  );

  options.onStart?.();

  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });

  if (options.isCancelled?.()) {
    unlisten();
    return null;
  }

  try {
    await invoke("export_styled_video", {
      videoPath,
      outputPath,
      assContent,
      videoDuration: outputDuration,
      inputPaths: resolvedInputs,
      filterComplex,
      // The native exporter registers this job ID against the live FFmpeg
      // child so cancel_video_export can terminate exactly this export.
      exportJobId,
    });
  } finally {
    unlisten();
  }

  return outputPath;
}
export async function cancelVideoExport(exportJobId: string): Promise<void> {
  await invoke("cancel_video_export", {
    exportJobId,
  });
}

