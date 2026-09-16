import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";

import { getSubtitleTrackId, type Subtitle } from "../types/subtitle";
import type {
  AudioTimelineClip,
  TimelineTrackSettings,
  VideoTimelineClip,
  VideoTransformKeyframeProperty,
} from "../types/timelineModel";

import { buildAssTrack } from "../utils/assSubtitles";
import { isFreezeFrameClip, isReverseVideoClip, videoPlaybackRate } from "../utils/videoRetime";
import {
  baseVideoTransformValue,
  hasVideoTransformKeyframes,
  videoTransformChannel,
} from "../utils/videoTransformKeyframes";

export type VideoExportProgress = {
  progress: number;
  status: string;
};

export type ExportTimelineRange = {
  start: number;
  end: number;
};

type ExportTimelineVideoOptions = {
  timelineDuration: number;
  videoClips: VideoTimelineClip[];
  audioClips: AudioTimelineClip[];
  trackSettings: TimelineTrackSettings;
  range?: ExportTimelineRange | null;
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
      const outgoingSourceDuration = outgoing.sourceDuration ?? outgoing.sourceOut;
      const incomingSourceDuration = incoming.sourceDuration ?? incoming.sourceOut;

      const hasOutgoingHandle =
        outgoing.sourceOut + outgoingSourceHalf <= outgoingSourceDuration + EPSILON;
      const hasIncomingHandle = incoming.sourceIn - incomingSourceHalf >= -EPSILON;

      if (!hasOutgoingHandle || !hasIncomingHandle || incomingSourceDuration <= 0) {
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

      incomingWindow.sourceIn = Math.max(0, incoming.sourceIn - incomingSourceHalf);
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

    return [{
      ...subtitle,
      startTime: start - range.start,
      endTime: end - range.start,
    }];
  });
}

function buildTimelineFilterGraph(
  videoClips: VideoTimelineClip[],
  audioClips: AudioTimelineClip[],
  trackSettings: TimelineTrackSettings,
  timelineDuration: number,
  range?: ExportTimelineRange | null,
) {
  const safeDuration = Math.max(0.1, timelineDuration);
  const exportRange = normalizeExportRange(range, safeDuration);
  const outputDuration = exportRange
    ? Math.max(0.001, exportRange.end - exportRange.start)
    : safeDuration;
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

  const standaloneAudioClips = [...audioClips]
    .filter((clip) =>
      /^audio-\d+$/.test(clip.trackId) &&
      !trackSettings[clip.trackId]?.deleted &&
      !trackSettings[clip.trackId]?.linkedTrackId
    )
    .sort((a, b) => a.trackId.localeCompare(b.trackId) || a.timelineStart - b.timelineStart);

  const inputPaths = [
    ...renderableClips.map((clip) => clip.sourcePath),
    ...standaloneAudioClips.map((clip) => clip.sourcePath),
  ];
  const clipInputIndex = new Map<string, number>();
  renderableClips.forEach((clip, index) => clipInputIndex.set(clip.id, index));
  const standaloneAudioInputIndex = new Map<string, number>();
  standaloneAudioClips.forEach((clip, index) =>
    standaloneAudioInputIndex.set(clip.id, renderableClips.length + index),
  );

  const orderedVideoClips = renderableClips.filter((clip) =>
    videoTrackVisible(clip.trackId, trackSettings),
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
      const frameTime = Math.max(0, clip.freezeFrameSourceTime ?? window.sourceIn);
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
      if (isReverseVideoClip(clip)) videoFilters.push("reverse", "setpts=PTS-STARTPTS");
      videoFilters.push(`setpts=(PTS-STARTPTS)/${n(playbackRate, 6)}`);
    }
    videoFilters.push(
      `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease`,
      "format=rgba",
    );

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

    filterParts.push(
      `[${currentVideoLabel}][${overlayLabels[index]}]overlay=x='${x}':y='${y}':eof_action=pass:repeatlast=0:shortest=0[${nextLabel}]`,
    );
    currentVideoLabel = nextLabel;
  }

  if (exportRange) {
    filterParts.push(
      `[${currentVideoLabel}]trim=start=${n(exportRange.start)}:end=${n(
        exportRange.end,
      )},setpts=PTS-STARTPTS,fps=${OUTPUT_FPS}[vcomp]`,
    );
  } else {
    filterParts.push(
      `[${currentVideoLabel}]trim=duration=${n(
        safeDuration,
        3,
      )},setpts=PTS-STARTPTS,fps=${OUTPUT_FPS}[vcomp]`,
    );
  }

  const audioLabels: string[] = [];

  for (const clip of renderableClips) {
    if (isFreezeFrameClip(clip)) continue;
    const audioTrackId = linkedAudioTrackId(clip.trackId, trackSettings);
    if (!audioTrackId || audioTrackMuted(audioTrackId, trackSettings) || clip.audioMuted) {
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

    filterParts.push(`[${inputIndex}:a]${filters.join(",")}[${label}]`);
    audioLabels.push(label);
  }

  for (const clip of standaloneAudioClips) {
    if (audioTrackMuted(clip.trackId, trackSettings) || clip.muted) {
      continue;
    }

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
    filterParts.push(`[${inputIndex}:a]${filters.join(",")}[${label}]`);
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
    title: normalizedRange
      ? "Export Selected Range"
      : "Export Edited Timeline",
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

  const visibleSubtitles = subtitles.filter(
    (subtitle) => !options.trackSettings[getSubtitleTrackId(subtitle)]?.hidden,
  );
  const assContent = buildAssTrack(
    subtitlesForExportRange(visibleSubtitles, normalizedRange),
  );
  const { inputPaths, filterComplex, outputDuration } =
    buildTimelineFilterGraph(
      options.videoClips,
      options.audioClips,
      options.trackSettings,
      options.timelineDuration,
      normalizedRange,
    );

  const resolvedInputs = inputPaths.length > 0 ? inputPaths : [videoPath];

  const unlisten = await listen<VideoExportProgress>(
    "video-export-progress",
    (event) => {
      const payload = normalizedRange && event.payload.status === "Rendering edited timeline..."
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

  try {
    await invoke("export_styled_video", {
      videoPath,
      outputPath,
      assContent,
      videoDuration: outputDuration,
      inputPaths: resolvedInputs,
      filterComplex,
    });
  } finally {
    unlisten();
  }

  return outputPath;
}
