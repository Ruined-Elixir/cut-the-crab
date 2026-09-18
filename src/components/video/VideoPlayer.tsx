import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { convertFileSrc } from "@tauri-apps/api/core";

import {
  canShowNativeContextMenu,
  showNativeContextMenu,
} from "../../services/nativeContextMenu";

import { getSubtitleTrackId, type Subtitle, type SubtitleStyle } from "../../types/subtitle";
import type {
  AdjustmentLayerClip,
  AudioTimelineClip,
  TimelineTrackId,
  TimelineTrackSettings,
  VideoTimelineClip,
} from "../../types/timelineModel";

import { adjustmentCssFilter, adjustmentLayersAffectingVideoTrack } from "../../utils/adjustmentLayers";

import VideoControls from "./VideoControls";
import VideoSubtitleOverlay from "./VideoSubtitleOverlay";
import { isFreezeFrameClip, isReverseVideoClip, timelineTimeToSourceTime, videoPlaybackRate } from "../../utils/videoRetime";
import {
  PROGRAM_OBJECT_SNAP_THRESHOLD_PX,
  snapProgramBoundsToBounds,
  snapProgramPercent,
  type ProgramBounds,
  type ProgramSnapGuide,
} from "../../utils/programSnapping";
import {
  evaluateVideoTransform,
  evaluateVideoTransformProperty,
  withEvaluatedVideoTransform,
} from "../../utils/videoTransformKeyframes";

import "./VideoPlayer.css";

type SeekRequest = {
  time: number;
  id: number;
};

export type VideoPlayerHandle = {
  setSkimPreviewTime: (time: number | null) => void;
};

type VideoPlayerProps = {
  videoPath: string | null;
  videoName: string | null;
  onChooseVideo?: () => void | Promise<void>;

  onDurationChange?: (duration: number) => void;
  onTimeChange?: (currentTime: number) => void;

  seekRequest?: SeekRequest | null;

  videoClips: VideoTimelineClip[];
  audioClips: AudioTimelineClip[];
  adjustmentLayers: AdjustmentLayerClip[];
  timelineDuration: number;
  trackSettings: TimelineTrackSettings;
  selectedVideoClipId?: string | null;
  interactiveVideoClipIds?: string[];
  onVideoClipSelect?: (id: string) => void;
  onVideoTransformChange?: (
    id: string,
    transform: {
      positionX?: number;
      positionY?: number;
      scale?: number;
      rotation?: number;
      opacity?: number;
      cropTop?: number;
      cropRight?: number;
      cropBottom?: number;
      cropLeft?: number;
    },
  ) => void;
  onApplyVideoCropToTrack?: (id: string) => void;
  /** Original source path -> disposable editing proxy path. */
  proxyPathsBySource?: Record<string, string>;

  subtitles: Subtitle[];
  currentTime: number;

  selectedSubtitleId?: string | null;
  interactiveSubtitleIds?: string[];
  onSubtitleSelect?: (id: string) => void;

  onSubtitlePositionChange?: (
    id: string,
    positionX: number,
    positionY: number,
  ) => void;

  onSubtitleTextChange?: (id: string, text: string) => void;
  onSubtitleStyleChange?: (id: string, style: SubtitleStyle) => void;
  onAllSubtitleStylesChange?: (style: SubtitleStyle) => void;
};

type VideoTrackId = string;
type AudioTrackId = string;

type VisibilityState = Record<VideoTrackId, boolean>;

type VideoDimensions = {
  width: number;
  height: number;
};

type ShellDimensions = {
  width: number;
  height: number;
};

type OpacityEditorState = {
  clipId: string;
  clientX: number;
  clientY: number;
};

const MAX_NATIVE_VIDEO_PREVIEW_RATE = 2;
const MAX_PROXY_VIDEO_PREVIEW_RATE = 4;
const HIGH_SPEED_PREVIEW_MIN_SEEK_INTERVAL_MS = 90;

function videoPreviewPlaybackRate(
  clip: VideoTimelineClip,
  hasProxy: boolean,
) {
  const maxRate = hasProxy
    ? MAX_PROXY_VIDEO_PREVIEW_RATE
    : MAX_NATIVE_VIDEO_PREVIEW_RATE;
  return Math.min(videoPlaybackRate(clip), maxRate);
}


type SameTrackDissolve = {
  trackId: VideoTrackId;
  outgoing: VideoTimelineClip;
  incoming: VideoTimelineClip;
  cutTime: number;
  startTime: number;
  endTime: number;
  duration: number;
  progress: number;
};

function findSameTrackDissolve(
  videoClips: VideoTimelineClip[],
  timelineTime: number,
  trackId: VideoTrackId,
): SameTrackDissolve | null {
  const trackClips = videoClips
    .filter((clip) => clip.trackId === trackId)
    .sort((a, b) => a.timelineStart - b.timelineStart);

  for (let index = 0; index < trackClips.length - 1; index += 1) {
    const outgoing = trackClips[index];
    const incoming = trackClips[index + 1];
    if (
      isFreezeFrameClip(outgoing) ||
      isFreezeFrameClip(incoming) ||
      isReverseVideoClip(outgoing) ||
      isReverseVideoClip(incoming)
    ) {
      continue;
    }
    const cutTime = outgoing.timelineEnd;

    if (Math.abs(incoming.timelineStart - cutTime) > 0.03) {
      continue;
    }

    const outEnabled = outgoing.transitionOutType === "cross-dissolve";
    const inEnabled = incoming.transitionInType === "cross-dissolve";

    if (!outEnabled && !inEnabled) {
      continue;
    }

    const requestedDuration = outEnabled && inEnabled
      ? Math.min(
          outgoing.transitionOutDuration ?? 0.5,
          incoming.transitionInDuration ?? 0.5,
        )
      : outEnabled
        ? outgoing.transitionOutDuration ?? 0.5
        : incoming.transitionInDuration ?? 0.5;

    const outgoingDuration = outgoing.timelineEnd - outgoing.timelineStart;
    const incomingDuration = incoming.timelineEnd - incoming.timelineStart;
    const sourceDuration = outgoing.sourceDuration ?? outgoing.sourceOut;
    const outgoingPostHandle =
      Math.max(0, sourceDuration - outgoing.sourceOut) / videoPlaybackRate(outgoing);
    const incomingPreHandle =
      Math.max(0, incoming.sourceIn) / videoPlaybackRate(incoming);

    // A true centered dissolve needs media handles on both sides of the edit.
    // If either clip has no handle, the ordinary per-clip transition preview
    // remains the fallback instead of inventing/freeze-framing media.
    const maxHandleDuration = 2 * Math.min(outgoingPostHandle, incomingPreHandle);
    const duration = Math.max(
      0,
      Math.min(
        5,
        requestedDuration,
        outgoingDuration,
        incomingDuration,
        maxHandleDuration,
      ),
    );

    if (duration < 0.1) {
      continue;
    }

    const startTime = cutTime - duration / 2;
    const endTime = cutTime + duration / 2;

    if (timelineTime < startTime || timelineTime >= endTime) {
      continue;
    }

    return {
      trackId,
      outgoing,
      incoming,
      cutTime,
      startTime,
      endTime,
      duration,
      progress: Math.max(0, Math.min(1, (timelineTime - startTime) / duration)),
    };
  }

  return null;
}

const ROTATION_SNAP_INCREMENT_DEGREES = 45;
const ROTATION_SNAP_THRESHOLD_DEGREES = 4;

function normalizeRotation(value: number) {
  let normalized = value;

  while (normalized > 180) normalized -= 360;
  while (normalized < -180) normalized += 360;

  return normalized;
}

function snapRotation(value: number) {
  const normalized = normalizeRotation(value);
  const snapTarget = normalizeRotation(
    Math.round(normalized / ROTATION_SNAP_INCREMENT_DEGREES) *
      ROTATION_SNAP_INCREMENT_DEGREES,
  );

  return Math.abs(normalized - snapTarget) <= ROTATION_SNAP_THRESHOLD_DEGREES
    ? snapTarget
    : normalized;
}

function formatRotation(value: number) {
  const normalized = normalizeRotation(value);
  const rounded = Math.round(normalized);
  return `${Object.is(rounded, -0) ? 0 : rounded}°`;
}

function pointerAngleDegrees(
  clientX: number,
  clientY: number,
  centerX: number,
  centerY: number,
) {
  return (Math.atan2(clientY - centerY, clientX - centerX) * 180) / Math.PI;
}

function findActiveVideoClip(
  videoClips: VideoTimelineClip[],
  timelineTime: number,
  trackId: VideoTrackId,
) {
  return (
    videoClips.find(
      (clip) =>
        clip.trackId === trackId &&
        timelineTime >= clip.timelineStart &&
        timelineTime < clip.timelineEnd,
    ) ?? null
  );
}

function audioTrackIndex(trackId: string) {
  const match = /^audio-(\d+)$/.exec(trackId);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function findActiveAudioClip(
  clips: AudioTimelineClip[],
  timelineTime: number,
  trackId: AudioTrackId,
) {
  return clips.find(
    (clip) =>
      clip.trackId === trackId &&
      timelineTime >= clip.timelineStart &&
      timelineTime < clip.timelineEnd,
  ) ?? null;
}

function videoTrackIndex(trackId: string) {
  const match = /^video-(\d+)$/.exec(trackId);
  return match ? Number(match[1]) : 1;
}

function videoTrackLabel(trackId: string) {
  return `V${videoTrackIndex(trackId)}`;
}

function isTrackHidden(
  trackSettings: TimelineTrackSettings,
  trackId: TimelineTrackId,
) {
  return trackSettings[trackId]?.hidden ?? false;
}

function isTrackMuted(
  trackSettings: TimelineTrackSettings,
  trackId: TimelineTrackId,
) {
  return trackSettings[trackId]?.muted ?? false;
}

function hasSoloAudioTrack(trackSettings: TimelineTrackSettings) {
  return Object.entries(trackSettings).some(
    ([trackId, settings]) =>
      /^audio-\d+$/.test(trackId) &&
      settings.deleted !== true &&
      settings.solo === true,
  );
}

function videoTransformStyle(
  clip: VideoTimelineClip | null,
  sourceSize: VideoDimensions = { width: 16, height: 9 },
  shellSize: ShellDimensions = { width: 0, height: 0 },
  timelineTime = clip?.timelineStart ?? 0,
): CSSProperties {
  if (!clip) {
    return {
      transform: "translate3d(0%, 0%, 0) scale(1) rotate(0deg)",
      transformOrigin: "center center",
      clipPath: "inset(0% 0% 0% 0%)",
    };
  }

  const evaluated = evaluateVideoTransform(clip, timelineTime);
  const positionX = evaluated.positionX;
  const positionY = evaluated.positionY;
  const scale = evaluated.scale;
  const rotation = evaluated.rotation;
  const cropTop = Math.max(0, Math.min(49, clip.cropTop ?? 0));
  const cropRight = Math.max(0, Math.min(49, clip.cropRight ?? 0));
  const cropBottom = Math.max(0, Math.min(49, clip.cropBottom ?? 0));
  const cropLeft = Math.max(0, Math.min(49, clip.cropLeft ?? 0));

  let clipPath = `inset(${cropTop}% ${cropRight}% ${cropBottom}% ${cropLeft}%)`;

  /*
   * The media element spans the whole Program canvas and uses object-fit:contain.
   * Crop values, however, are defined relative to the actual source image. Convert
   * source-image crop percentages into canvas insets so transparent letterbox space
   * never becomes part of the crop geometry.
   */
  if (
    shellSize.width > 0 &&
    shellSize.height > 0 &&
    sourceSize.width > 0 &&
    sourceSize.height > 0
  ) {
    const fitScale = Math.min(
      shellSize.width / sourceSize.width,
      shellSize.height / sourceSize.height,
    );
    const fittedWidth = sourceSize.width * fitScale;
    const fittedHeight = sourceSize.height * fitScale;
    const fittedLeft = (shellSize.width - fittedWidth) / 2;
    const fittedTop = (shellSize.height - fittedHeight) / 2;

    const topPx = fittedTop + (cropTop / 100) * fittedHeight;
    const rightPx =
      shellSize.width -
      (fittedLeft + (1 - cropRight / 100) * fittedWidth);
    const bottomPx =
      shellSize.height -
      (fittedTop + (1 - cropBottom / 100) * fittedHeight);
    const leftPx = fittedLeft + (cropLeft / 100) * fittedWidth;

    clipPath = `inset(${(topPx / shellSize.height) * 100}% ${
      (rightPx / shellSize.width) * 100
    }% ${(bottomPx / shellSize.height) * 100}% ${
      (leftPx / shellSize.width) * 100
    }%)`;
  }

  return {
    transform: `translate3d(${positionX}%, ${positionY}%, 0) scale(${scale / 100}) rotate(${rotation}deg)`,
    transformOrigin: "center center",
    clipPath,
  };
}


function videoOpacityFadeFactor(
  clip: VideoTimelineClip,
  timelineTime: number,
) {
  const clipDuration = Math.max(0.1, clip.timelineEnd - clip.timelineStart);
  const maxFadeDuration = clipDuration;
  const fadeIn = Math.max(0, Math.min(maxFadeDuration, clip.videoFadeInDuration ?? 0));
  const fadeOut = Math.max(0, Math.min(maxFadeDuration, clip.videoFadeOutDuration ?? 0));
  const elapsed = Math.max(0, timelineTime - clip.timelineStart);
  const remaining = Math.max(0, clip.timelineEnd - timelineTime);
  const inGain = fadeIn > 0 ? Math.min(1, elapsed / fadeIn) : 1;
  const outGain = fadeOut > 0 ? Math.min(1, remaining / fadeOut) : 1;
  return Math.max(0, Math.min(1, inGain, outGain));
}

function videoTransitionStyle(
  clip: VideoTimelineClip | null,
  timelineTime: number,
): CSSProperties {
  if (!clip) {
    return { opacity: 1, filter: "brightness(1)" };
  }

  let opacity = evaluateVideoTransformProperty(clip, "opacity", timelineTime) / 100;
  let brightness = 1;

  const clipDuration = Math.max(0.1, clip.timelineEnd - clip.timelineStart);
  const maxTransitionDuration = Math.max(0.1, Math.min(5, clipDuration / 2));
  const maxOpacityFadeDuration = clipDuration;
  const localElapsed = Math.max(0, timelineTime - clip.timelineStart);
  const localRemaining = Math.max(0, clip.timelineEnd - timelineTime);
  const videoFadeInDuration = Math.max(
    0,
    Math.min(maxOpacityFadeDuration, clip.videoFadeInDuration ?? 0),
  );
  const videoFadeOutDuration = Math.max(
    0,
    Math.min(maxOpacityFadeDuration, clip.videoFadeOutDuration ?? 0),
  );

  if (videoFadeInDuration > 0 && localElapsed < videoFadeInDuration) {
    opacity = Math.min(opacity, localElapsed / videoFadeInDuration);
  }

  if (videoFadeOutDuration > 0 && localRemaining < videoFadeOutDuration) {
    opacity = Math.min(opacity, localRemaining / videoFadeOutDuration);
  }

  const inType = clip.transitionInType ?? "none";
  const inDuration = Math.max(
    0.1,
    Math.min(maxTransitionDuration, clip.transitionInDuration ?? 0.5),
  );
  const inElapsed = timelineTime - clip.timelineStart;

  if (inType !== "none" && inElapsed >= 0 && inElapsed < inDuration) {
    const progress = Math.max(0, Math.min(1, inElapsed / inDuration));

    if (inType === "cross-dissolve") {
      opacity = Math.min(opacity, progress);
    } else if (inType === "fade-black") {
      brightness = Math.min(brightness, progress);
    }
  }

  const outType = clip.transitionOutType ?? "none";
  const outDuration = Math.max(
    0.1,
    Math.min(maxTransitionDuration, clip.transitionOutDuration ?? 0.5),
  );
  const remaining = clip.timelineEnd - timelineTime;

  if (outType !== "none" && remaining >= 0 && remaining < outDuration) {
    const progress = Math.max(0, Math.min(1, remaining / outDuration));

    if (outType === "cross-dissolve") {
      opacity = Math.min(opacity, progress);
    } else if (outType === "fade-black") {
      brightness = Math.min(brightness, progress);
    }
  }

  return {
    opacity,
    filter: `brightness(${brightness})`,
  };
}

function adjustedVideoTransitionStyle(
  clip: VideoTimelineClip,
  timelineTime: number,
  adjustmentLayers: AdjustmentLayerClip[],
  trackSettings: TimelineTrackSettings,
): CSSProperties {
  const baseStyle = videoTransitionStyle(clip, timelineTime);
  const adjustmentFilter = adjustmentCssFilter(
    adjustmentLayersAffectingVideoTrack(
      adjustmentLayers,
      timelineTime,
      clip.trackId,
      trackSettings,
    ),
    timelineTime,
  );

  return {
    ...baseStyle,
    filter: [baseStyle.filter, adjustmentFilter].filter(Boolean).join(" ") || undefined,
  };
}

function programBoundsForClip(
  clip: VideoTimelineClip,
  dimensions: VideoDimensions,
  shell: ShellDimensions,
  timelineTime = clip.timelineStart,
): ProgramBounds {
  const shellWidth = Math.max(1, shell.width);
  const shellHeight = Math.max(1, shell.height);
  const sourceWidth = Math.max(1, dimensions.width);
  const sourceHeight = Math.max(1, dimensions.height);

  const containScale = Math.min(
    shellWidth / sourceWidth,
    shellHeight / sourceHeight,
  );

  const baseWidth = sourceWidth * containScale;
  const baseHeight = sourceHeight * containScale;

  const cropTop = Math.max(0, Math.min(49, clip.cropTop ?? 0));
  const cropRight = Math.max(0, Math.min(49, clip.cropRight ?? 0));
  const cropBottom = Math.max(0, Math.min(49, clip.cropBottom ?? 0));
  const cropLeft = Math.max(0, Math.min(49, clip.cropLeft ?? 0));

  const localLeft = -baseWidth / 2 + (cropLeft / 100) * baseWidth;
  const localRight = baseWidth / 2 - (cropRight / 100) * baseWidth;
  const localTop = -baseHeight / 2 + (cropTop / 100) * baseHeight;
  const localBottom = baseHeight / 2 - (cropBottom / 100) * baseHeight;

  const evaluated = evaluateVideoTransform(clip, timelineTime);
  const scale = evaluated.scale / 100;
  const radians = (evaluated.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  const centerX = shellWidth / 2 + (evaluated.positionX / 100) * shellWidth;
  const centerY = shellHeight / 2 + (evaluated.positionY / 100) * shellHeight;

  const corners = [
    [localLeft, localTop],
    [localRight, localTop],
    [localRight, localBottom],
    [localLeft, localBottom],
  ].map(([x, y]) => {
    const scaledX = x * scale;
    const scaledY = y * scale;

    return {
      x: centerX + scaledX * cos - scaledY * sin,
      y: centerY + scaledX * sin + scaledY * cos,
    };
  });

  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);

  return {
    left,
    right,
    top,
    bottom,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
  };
}

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(function VideoPlayer({
  videoPath,
  videoName,
  onChooseVideo,
  onDurationChange,
  onTimeChange,
  seekRequest,
  videoClips,
  audioClips,
  adjustmentLayers,
  timelineDuration,
  trackSettings,
  selectedVideoClipId,
  interactiveVideoClipIds,
  onVideoClipSelect,
  onVideoTransformChange,
  onApplyVideoCropToTrack,
  proxyPathsBySource = {},
  subtitles,
  currentTime,
  selectedSubtitleId,
  interactiveSubtitleIds,
  onSubtitleSelect,
  onSubtitlePositionChange,
  onSubtitleTextChange,
  onSubtitleStyleChange,
  onAllSubtitleStylesChange,
}, ref) {
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [skimPreviewTime, setSkimPreviewTime] = useState<number | null>(null);
  const [videoVisibility, setVideoVisibility] = useState<VisibilityState>({});
  const [videoDimensions, setVideoDimensions] = useState<
    Record<VideoTrackId, VideoDimensions>
  >({});
  const [shellDimensions, setShellDimensions] = useState<ShellDimensions>({
    width: 0,
    height: 0,
  });
  const [programTransformClipId, setProgramTransformClipId] = useState<string | null>(null);
  const [cropModeClipId, setCropModeClipId] = useState<string | null>(null);
  const [opacityEditor, setOpacityEditor] = useState<OpacityEditorState | null>(null);
  const cropStartRef = useRef<{
    clipId: string;
    cropTop: number;
    cropRight: number;
    cropBottom: number;
    cropLeft: number;
  } | null>(null);
  const [programSnapGuides, setProgramSnapGuides] = useState<ProgramSnapGuide[]>([]);

  const videoRefs = useRef<Record<VideoTrackId, HTMLVideoElement | null>>({});
  const dissolveOutgoingRefs = useRef<Record<VideoTrackId, HTMLVideoElement | null>>({});
  const dissolveIncomingRefs = useRef<Record<VideoTrackId, HTMLVideoElement | null>>({});
  const audioRefs = useRef<Record<AudioTrackId, HTMLAudioElement | null>>({});
  const primaryMetadataAudioRef = useRef<HTMLAudioElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const opacityEditorRef = useRef<HTMLDivElement | null>(null);
  const highSpeedPreviewSeekAtRef = useRef<Record<string, number>>({});

  const currentTimeRef = useRef(currentTime);
  const timelineDurationRef = useRef(timelineDuration);
  const sourceDurationRef = useRef(duration);
  const videoClipsRef = useRef(videoClips);
  const audioClipsRef = useRef(audioClips);
  const trackSettingsRef = useRef(trackSettings);
  const isPlayingRef = useRef(false);
  const videoTrackIdsRef = useRef<VideoTrackId[]>([]);
  const audioTrackIdsRef = useRef<AudioTrackId[]>([]);
  const displayTimeRef = useRef(currentTime);

  const interactiveVideoClipIdSet = useMemo(
    () =>
      interactiveVideoClipIds
        ? new Set(interactiveVideoClipIds)
        : null,
    [interactiveVideoClipIds],
  );

  const isProgramVideoClipInteractive = (clip: VideoTimelineClip) =>
    !interactiveVideoClipIdSet || interactiveVideoClipIdSet.has(clip.id);

  useImperativeHandle(ref, () => ({
    setSkimPreviewTime: (time: number | null) => {
      if (isPlayingRef.current || time === null || !Number.isFinite(time)) {
        setSkimPreviewTime(null);
        return;
      }

      const maxDuration = Math.max(0, timelineDurationRef.current || 0);
      setSkimPreviewTime(Math.max(0, Math.min(maxDuration, time)));
    },
  }), []);

  const isSkimPreviewActive = !isPlaying && skimPreviewTime !== null;
  const displayTime = isSkimPreviewActive ? skimPreviewTime : currentTime;
  displayTimeRef.current = displayTime;

  const onTimeChangeRef = useRef(onTimeChange);
  const onDurationChangeRef = useRef(onDurationChange);

  const activeVideoClipIdRefs = useRef<Record<VideoTrackId, string | null>>({});
  const activeAudioClipIdRefs = useRef<Record<AudioTrackId, string | null>>({});

  const playbackAnchorTimelineRef = useRef(currentTime);
  const playbackAnchorPerformanceRef = useRef(0);

  const skipSeconds = 10;

  const videoTrackIds = useMemo(() => {
    const ids = new Set<string>(["video-1", "video-2"]);

    for (const clip of videoClips) {
      if (/^video-\d+$/.test(clip.trackId)) ids.add(clip.trackId);
    }

    for (const id of Object.keys(trackSettings)) {
      if (/^video-\d+$/.test(id)) ids.add(id);
    }

    return [...ids].sort((a, b) => videoTrackIndex(a) - videoTrackIndex(b));
  }, [trackSettings, videoClips]);

  const audioTrackIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of Object.keys(trackSettings)) {
      if (/^audio-\d+$/.test(id) && trackSettings[id]?.deleted !== true) ids.add(id);
    }
    for (const clip of audioClips) {
      if (/^audio-\d+$/.test(clip.trackId)) ids.add(clip.trackId);
    }
    return [...ids].sort((a, b) => audioTrackIndex(a) - audioTrackIndex(b));
  }, [audioClips, trackSettings]);

  const activeClipsByTrack = useMemo(() => {
    const result: Record<string, VideoTimelineClip | null> = {};
    for (const trackId of videoTrackIds) {
      result[trackId] = findActiveVideoClip(videoClips, displayTime, trackId);
    }
    return result;
  }, [displayTime, videoClips, videoTrackIds]);

  const dissolvesByTrack = useMemo(() => {
    const result: Record<string, SameTrackDissolve | null> = {};
    for (const trackId of videoTrackIds) {
      result[trackId] = findSameTrackDissolve(videoClips, displayTime, trackId);
    }
    return result;
  }, [displayTime, videoClips, videoTrackIds]);

  const sourceUrlsByTrack = useMemo(() => {
    const result: Record<string, string | null> = {};
    for (const trackId of videoTrackIds) {
      const clip = activeClipsByTrack[trackId];
      if (!clip?.sourcePath) {
        result[trackId] = null;
        continue;
      }
      const previewPath = proxyPathsBySource[clip.sourcePath] ?? clip.sourcePath;
      result[trackId] = convertFileSrc(previewPath);
    }
    return result;
  }, [activeClipsByTrack, proxyPathsBySource, videoTrackIds]);

  const audioSourcesByTrack = useMemo(() => {
    const result: Record<string, string | null> = {};
    for (const audioTrackId of audioTrackIds) {
      const linkedVideoTrackId = trackSettings[audioTrackId]?.linkedTrackId;
      if (linkedVideoTrackId && /^video-\d+$/.test(linkedVideoTrackId)) {
        result[audioTrackId] = activeClipsByTrack[linkedVideoTrackId]?.sourcePath ?? null;
      } else {
        result[audioTrackId] = findActiveAudioClip(audioClips, displayTime, audioTrackId)?.sourcePath ?? null;
      }
    }
    return result;
  }, [activeClipsByTrack, audioClips, audioTrackIds, displayTime, trackSettings]);

  const primaryVideoUrl = useMemo(
    () => (videoPath ? convertFileSrc(videoPath) : null),
    [videoPath],
  );

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    timelineDurationRef.current = timelineDuration;
  }, [timelineDuration]);

  useEffect(() => {
    sourceDurationRef.current = duration;
  }, [duration]);

  useEffect(() => {
    videoClipsRef.current = videoClips;
  }, [videoClips]);

  useEffect(() => {
    audioClipsRef.current = audioClips;
  }, [audioClips]);

  useEffect(() => {
    trackSettingsRef.current = trackSettings;
  }, [trackSettings]);

  useEffect(() => {
    videoTrackIdsRef.current = videoTrackIds;
  }, [videoTrackIds]);

  useEffect(() => {
    audioTrackIdsRef.current = audioTrackIds;
  }, [audioTrackIds]);

  useEffect(() => {
    onTimeChangeRef.current = onTimeChange;
  }, [onTimeChange]);

  useEffect(() => {
    onDurationChangeRef.current = onDurationChange;
  }, [onDurationChange]);

  useEffect(() => {
    setOpacityEditor((current) =>
      current && current.clipId !== selectedVideoClipId ? null : current,
    );
  }, [selectedVideoClipId]);

  useEffect(() => {
    if (!interactiveVideoClipIdSet) {
      return;
    }

    if (
      programTransformClipId &&
      !interactiveVideoClipIdSet.has(programTransformClipId)
    ) {
      setProgramTransformClipId(null);
      setProgramSnapGuides([]);
    }

    if (cropModeClipId && !interactiveVideoClipIdSet.has(cropModeClipId)) {
      cropStartRef.current = null;
      setCropModeClipId(null);
    }

    setOpacityEditor((current) =>
      current && !interactiveVideoClipIdSet.has(current.clipId) ? null : current,
    );
  }, [cropModeClipId, interactiveVideoClipIdSet, programTransformClipId]);

  useEffect(() => {
    if (!opacityEditor) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        opacityEditorRef.current &&
        event.target instanceof Node &&
        opacityEditorRef.current.contains(event.target)
      ) {
        return;
      }
      setOpacityEditor(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpacityEditor(null);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [opacityEditor]);

  useEffect(() => {
    const shell = shellRef.current;

    if (!shell) {
      return;
    }

    const updateShellDimensions = () => {
      const rect = shell.getBoundingClientRect();
      setShellDimensions({
        width: rect.width,
        height: rect.height,
      });
    };

    updateShellDimensions();

    const observer = new ResizeObserver(updateShellDimensions);
    observer.observe(shell);

    return () => observer.disconnect();
  }, [videoPath]);

  const videoElementForTrack = (trackId: VideoTrackId) =>
    videoRefs.current[trackId] ?? null;

  const audioElementForTrack = (trackId: AudioTrackId) =>
    audioRefs.current[trackId] ?? null;

  const dissolveElementsForTrack = (trackId: VideoTrackId) => ({
    outgoing: dissolveOutgoingRefs.current[trackId] ?? null,
    incoming: dissolveIncomingRefs.current[trackId] ?? null,
  });

  const syncHighSpeedVideoPreview = (
    element: HTMLVideoElement,
    clip: VideoTimelineClip,
    expectedSourceTime: number,
    syncKey: string,
    forceSeek: boolean,
  ) => {
    const requestedRate = videoPlaybackRate(clip);
    if (isFreezeFrameClip(clip) || isReverseVideoClip(clip)) {
      element.playbackRate = 1;
      const now = performance.now();
      const lastSeekAt = highSpeedPreviewSeekAtRef.current[syncKey] ?? 0;
      const drift = Math.abs(expectedSourceTime - element.currentTime);
      if ((forceSeek || drift > 0.035) && now - lastSeekAt >= 45) {
        try {
          element.currentTime = expectedSourceTime;
          highSpeedPreviewSeekAtRef.current[syncKey] = now;
        } catch (error) {
          console.error(`${syncKey} special-playback seek failed:`, error);
        }
      }
      return;
    }
    const hasProxy = element.dataset.previewProxy === "true";
    const maxNativePreviewRate = hasProxy
      ? MAX_PROXY_VIDEO_PREVIEW_RATE
      : MAX_NATIVE_VIDEO_PREVIEW_RATE;
    element.playbackRate = videoPreviewPlaybackRate(clip, hasProxy);

    if (requestedRate <= maxNativePreviewRate || forceSeek) {
      return;
    }

    // WKWebView can struggle to continuously decode full-resolution media at
    // 3x/4x. Keep the hardware-backed media element in its reliable <=2x
    // range, then periodically jump over frames so the displayed source time
    // remains aligned with the real retimed timeline. This is deliberately a
    // preview-only trick-play path; export still renders the exact requested
    // playback rate with FFmpeg.
    const sourceLag = expectedSourceTime - element.currentTime;
    const driftThreshold = Math.max(0.16, requestedRate * 0.06);
    const now = performance.now();
    const lastSeekAt = highSpeedPreviewSeekAtRef.current[syncKey] ?? 0;

    if (
      sourceLag > driftThreshold &&
      now - lastSeekAt >= HIGH_SPEED_PREVIEW_MIN_SEEK_INTERVAL_MS
    ) {
      try {
        element.currentTime = expectedSourceTime;
        highSpeedPreviewSeekAtRef.current[syncKey] = now;
      } catch (error) {
        console.error(`${syncKey} high-speed preview seek failed:`, error);
      }
    }
  };

  const syncSameTrackDissolve = (
    trackId: VideoTrackId,
    timelineTime: number,
    shouldPlay: boolean,
    forceSeek = false,
  ) => {
    const dissolve = findSameTrackDissolve(
      videoClipsRef.current,
      timelineTime,
      trackId,
    );
    const elements = dissolveElementsForTrack(trackId);

    if (!dissolve) {
      elements.outgoing?.pause();
      elements.incoming?.pause();
      return false;
    }

    const pairs = [
      { element: elements.outgoing, clip: dissolve.outgoing },
      { element: elements.incoming, clip: dissolve.incoming },
    ];

    for (const { element, clip } of pairs) {
      if (!element || element.dataset.sourcePath !== clip.sourcePath) {
        continue;
      }

      const rawSourceTime = timelineTimeToSourceTime(clip, timelineTime);
      const maxSourceTime = Number.isFinite(element.duration)
        ? element.duration
        : clip.sourceDuration ?? clip.sourceOut;
      const safeSourceTime = Math.max(0, Math.min(maxSourceTime || rawSourceTime, rawSourceTime));

      const requestedRate = videoPlaybackRate(clip);
      if (
        forceSeek ||
        (requestedRate <= MAX_NATIVE_VIDEO_PREVIEW_RATE &&
          Math.abs(element.currentTime - safeSourceTime) > 0.12)
      ) {
        try {
          element.currentTime = safeSourceTime;
        } catch (error) {
          console.error(`${trackId} dissolve seek failed:`, error);
        }
      }

      syncHighSpeedVideoPreview(
        element,
        clip,
        safeSourceTime,
        `${trackId}:dissolve:${clip.id}`,
        forceSeek,
      );

      if (shouldPlay) {
        if (element.paused) {
          void element.play().catch((error) => {
            console.error(`${trackId} dissolve playback failed:`, error);
          });
        }
      } else if (!element.paused) {
        element.pause();
      }
    }

    return true;
  };

  const syncVideoTrackToTimeline = (
    trackId: VideoTrackId,
    timelineTime: number,
    shouldPlay: boolean,
    forceSeek = false,
  ) => {
    const video = videoElementForTrack(trackId);
    const activeClip = findActiveVideoClip(
      videoClipsRef.current,
      timelineTime,
      trackId,
    );
    const hasTrueDissolve = findSameTrackDissolve(
      videoClipsRef.current,
      timelineTime,
      trackId,
    ) !== null;

    if (hasTrueDissolve) {
      activeVideoClipIdRefs.current[trackId] = null;
      video?.pause();
      setVideoVisibility((current) =>
        current[trackId] ? { ...current, [trackId]: false } : current,
      );
      return;
    }

    if (!video || !activeClip) {
      activeVideoClipIdRefs.current[trackId] = null;
      video?.pause();
      setVideoVisibility((current) =>
        current[trackId] ? { ...current, [trackId]: false } : current,
      );
      return;
    }

    const loadedSourcePath = video.dataset.sourcePath ?? "";
    const hidden = isTrackHidden(trackSettingsRef.current, trackId);
    const canRenderClip =
      activeClip.sourcePath === loadedSourcePath && !hidden;

    setVideoVisibility((current) =>
      current[trackId] === canRenderClip
        ? current
        : { ...current, [trackId]: canRenderClip },
    );

    if (activeClip.sourcePath !== loadedSourcePath) {
      activeVideoClipIdRefs.current[trackId] = null;
      video.pause();
      return;
    }

    if (hidden) {
      activeVideoClipIdRefs.current[trackId] = null;
      video.pause();
      return;
    }

    const expectedSourceTime = timelineTimeToSourceTime(activeClip, timelineTime);
    const maxSourceTime = Number.isFinite(video.duration)
      ? video.duration
      : activeClip.sourceDuration ?? sourceDurationRef.current;
    const safeSourceTime = Math.max(
      0,
      Math.min(maxSourceTime || expectedSourceTime, expectedSourceTime),
    );
    const clipChanged =
      activeVideoClipIdRefs.current[trackId] !== activeClip.id;

    if (clipChanged || forceSeek) {
      try {
        video.currentTime = safeSourceTime;
      } catch (error) {
        console.error(`${trackId} seek failed:`, error);
      }
    }

    activeVideoClipIdRefs.current[trackId] = activeClip.id;
    syncHighSpeedVideoPreview(
      video,
      activeClip,
      safeSourceTime,
      `${trackId}:${activeClip.id}`,
      clipChanged || forceSeek,
    );

    const seekDrivenPlayback = isFreezeFrameClip(activeClip) || isReverseVideoClip(activeClip);
    if (shouldPlay && !seekDrivenPlayback) {
      if (video.paused) {
        void video.play().catch((error) => {
          console.error(`${trackId} playback failed:`, error);
        });
      }
    } else if (!video.paused) {
      video.pause();
    }
  };

  const syncAudioTrackToTimeline = (
    audioTrackId: AudioTrackId,
    timelineTime: number,
    shouldPlay: boolean,
    forceSeek = false,
  ) => {
    const audio = audioElementForTrack(audioTrackId);
    const linkedVideoTrackId = trackSettingsRef.current[audioTrackId]?.linkedTrackId;
    const linkedVideoClip = linkedVideoTrackId && /^video-\d+$/.test(linkedVideoTrackId)
      ? findActiveVideoClip(videoClipsRef.current, timelineTime, linkedVideoTrackId)
      : null;
    const standaloneClip = linkedVideoClip
      ? null
      : findActiveAudioClip(audioClipsRef.current, timelineTime, audioTrackId);
    const activeClip = linkedVideoClip ?? standaloneClip;

    if (!audio || !activeClip || trackSettingsRef.current[audioTrackId]?.deleted) {
      activeAudioClipIdRefs.current[audioTrackId] = null;
      audio?.pause();
      return;
    }

    const loadedSourcePath = audio.dataset.sourcePath ?? "";
    if (loadedSourcePath !== activeClip.sourcePath) {
      activeAudioClipIdRefs.current[audioTrackId] = null;
      audio.pause();
      return;
    }
    if (audio.readyState < HTMLMediaElement.HAVE_METADATA) return;

    const expectedSourceTime = timelineTimeToSourceTime(activeClip, timelineTime);
    const maxSourceTime = Number.isFinite(audio.duration)
      ? audio.duration
      : activeClip.sourceDuration ?? activeClip.sourceOut;
    const safeSourceTime = Math.max(0, Math.min(maxSourceTime || expectedSourceTime, expectedSourceTime));
    const clipChanged = activeAudioClipIdRefs.current[audioTrackId] !== activeClip.id;
    if (clipChanged || forceSeek) {
      try {
        audio.currentTime = safeSourceTime;
      } catch (error) {
        console.error(`${audioTrackId} seek failed:`, error);
      }
    }

    const trackMuted = isTrackMuted(trackSettingsRef.current, audioTrackId);
    const soloMuted =
      hasSoloAudioTrack(trackSettingsRef.current) &&
      trackSettingsRef.current[audioTrackId]?.solo !== true;
    const specialVideoPlaybackMuted = linkedVideoClip
      ? isFreezeFrameClip(linkedVideoClip) || isReverseVideoClip(linkedVideoClip)
      : false;
    const clipMuted = linkedVideoClip
      ? (linkedVideoClip.audioMuted ?? false) || specialVideoPlaybackMuted
      : standaloneClip?.muted ?? false;
    const clipDuration = Math.max(0.001, activeClip.timelineEnd - activeClip.timelineStart);
    const fadeInDuration = Math.max(
      0,
      Math.min(
        linkedVideoClip ? linkedVideoClip.audioFadeInDuration ?? 0 : standaloneClip?.fadeInDuration ?? 0,
        clipDuration,
      ),
    );
    const fadeOutDuration = Math.max(
      0,
      Math.min(
        linkedVideoClip ? linkedVideoClip.audioFadeOutDuration ?? 0 : standaloneClip?.fadeOutDuration ?? 0,
        clipDuration,
      ),
    );
    const localTime = Math.max(0, timelineTime - activeClip.timelineStart);
    const timeToEnd = Math.max(0, activeClip.timelineEnd - timelineTime);
    const fadeInGain = fadeInDuration > 0 ? Math.min(1, localTime / fadeInDuration) : 1;
    const fadeOutGain = fadeOutDuration > 0 ? Math.min(1, timeToEnd / fadeOutDuration) : 1;
    const fadeGain = Math.max(0, Math.min(1, fadeInGain, fadeOutGain));
    const volumePercent = linkedVideoClip
      ? linkedVideoClip.audioVolume ?? 100
      : standaloneClip?.volume ?? 100;
    audio.volume = Math.max(0, Math.min(1, (Math.max(0, Math.min(100, volumePercent)) / 100) * fadeGain));
    audio.muted = trackMuted || soloMuted || clipMuted;
    audio.playbackRate = linkedVideoClip ? videoPlaybackRate(linkedVideoClip) : 1;
    audio.preservesPitch = true;

    if (audio.muted) {
      activeAudioClipIdRefs.current[audioTrackId] = null;
      audio.pause();
      return;
    }

    activeAudioClipIdRefs.current[audioTrackId] = activeClip.id;
    if (shouldPlay) {
      if (audio.paused) {
        void audio.play().catch((error) => console.error(`${audioTrackId} playback failed:`, error));
      }
    } else if (!audio.paused) {
      audio.pause();
    }
  };

  const syncAllMediaToTimeline = (
    timelineTime: number,
    shouldPlay: boolean,
    forceSeek = false,
  ) => {
    for (const trackId of videoTrackIdsRef.current) {
      syncVideoTrackToTimeline(trackId, timelineTime, shouldPlay, forceSeek);
      syncSameTrackDissolve(trackId, timelineTime, shouldPlay, forceSeek);
    }
    for (const audioTrackId of audioTrackIdsRef.current) {
      syncAudioTrackToTimeline(audioTrackId, timelineTime, shouldPlay, forceSeek);
    }
  };

  const seekTo = (time: number) => {
    if (!Number.isFinite(time)) {
      return;
    }

    const maxDuration = Math.max(0, timelineDurationRef.current || 0);
    const nextTime = Math.max(0, Math.min(maxDuration, time));

    currentTimeRef.current = nextTime;
    playbackAnchorTimelineRef.current = nextTime;
    playbackAnchorPerformanceRef.current = performance.now();

    onTimeChangeRef.current?.(nextTime);
    syncAllMediaToTimeline(nextTime, isPlayingRef.current, true);
  };

  const jumpBy = (seconds: number) => {
    seekTo(currentTimeRef.current + seconds);
  };

  const togglePlayPause = () => {
    if (isPlayingRef.current) {
      isPlayingRef.current = false;
      setIsPlaying(false);
      (Object.values(videoRefs.current) as Array<HTMLVideoElement | null>).forEach((element) => element?.pause());
      (Object.values(dissolveOutgoingRefs.current) as Array<HTMLVideoElement | null>).forEach((element) => element?.pause());
      (Object.values(dissolveIncomingRefs.current) as Array<HTMLVideoElement | null>).forEach((element) => element?.pause());
      (Object.values(audioRefs.current) as Array<HTMLAudioElement | null>).forEach((element) => element?.pause());
      return;
    }

    const maxDuration = Math.max(0, timelineDurationRef.current || 0);

    if (maxDuration <= 0) {
      return;
    }

    let playbackStart = currentTimeRef.current;

    if (playbackStart >= maxDuration) {
      playbackStart = 0;
      currentTimeRef.current = 0;
      onTimeChangeRef.current?.(0);
    }

    playbackAnchorTimelineRef.current = playbackStart;
    playbackAnchorPerformanceRef.current = performance.now();

    setProgramTransformClipId(null);
    setCropModeClipId(null);
    cropStartRef.current = null;
    setProgramSnapGuides([]);
    setSkimPreviewTime(null);
    isPlayingRef.current = true;
    setIsPlaying(true);
    syncAllMediaToTimeline(playbackStart, true, true);
  };

  useEffect(() => {
    setDuration(0);
    setIsPlaying(false);
    setSkimPreviewTime(null);
    setVideoVisibility({});

    (Object.values(videoRefs.current) as Array<HTMLVideoElement | null>).forEach((element) => element?.pause());
    (Object.values(audioRefs.current) as Array<HTMLAudioElement | null>).forEach((element) => element?.pause());

    isPlayingRef.current = false;
    currentTimeRef.current = 0;
    activeVideoClipIdRefs.current = {};
    activeAudioClipIdRefs.current = {};
    highSpeedPreviewSeekAtRef.current = {};
    playbackAnchorTimelineRef.current = 0;
    playbackAnchorPerformanceRef.current = 0;

    onTimeChangeRef.current?.(0);
    onDurationChangeRef.current?.(0);
  }, [videoPath]);

  useEffect(() => {
    if (isPlaying) {
      return;
    }

    syncAllMediaToTimeline(displayTime, false, true);
  }, [displayTime, isPlaying, videoClips, audioClips, videoPath, duration, trackSettings]);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }

    playbackAnchorTimelineRef.current = currentTimeRef.current;
    playbackAnchorPerformanceRef.current = performance.now();

    let animationFrameId = 0;

    const tick = (now: number) => {
      if (!isPlayingRef.current) {
        return;
      }

      const maxDuration = Math.max(0, timelineDurationRef.current || 0);

      if (maxDuration <= 0) {
        isPlayingRef.current = false;
        setIsPlaying(false);
        syncAllMediaToTimeline(0, false);
        return;
      }

      const elapsedSeconds =
        (now - playbackAnchorPerformanceRef.current) / 1000;
      const nextTime = Math.min(
        maxDuration,
        playbackAnchorTimelineRef.current + elapsedSeconds,
      );

      currentTimeRef.current = nextTime;
      onTimeChangeRef.current?.(nextTime);
      syncAllMediaToTimeline(nextTime, true);

      if (nextTime >= maxDuration) {
        isPlayingRef.current = false;
        setIsPlaying(false);
        syncAllMediaToTimeline(maxDuration, false);
        return;
      }

      animationFrameId = window.requestAnimationFrame(tick);
    };

    animationFrameId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [isPlaying]);

  const handleVideoLoadedMetadata = (trackId: VideoTrackId) => {
    const video = videoElementForTrack(trackId);

    if (video?.videoWidth && video.videoHeight) {
      setVideoDimensions((current) => ({
        ...current,
        [trackId]: {
          width: video.videoWidth,
          height: video.videoHeight,
        },
      }));
    }

    activeVideoClipIdRefs.current[trackId] = null;
    syncVideoTrackToTimeline(
      trackId,
      isPlayingRef.current ? currentTimeRef.current : displayTimeRef.current,
      isPlayingRef.current,
      true,
    );
  };

  const handleAudioLoadedMetadata = (audioTrackId: AudioTrackId) => {
    activeAudioClipIdRefs.current[audioTrackId] = null;
    syncAudioTrackToTimeline(
      audioTrackId,
      isPlayingRef.current ? currentTimeRef.current : displayTimeRef.current,
      isPlayingRef.current,
      true,
    );
  };

  const handlePrimaryMetadataLoaded = () => {
    const audio = primaryMetadataAudioRef.current;

    if (!audio || !Number.isFinite(audio.duration)) {
      return;
    }

    setDuration(audio.duration);
    sourceDurationRef.current = audio.duration;
    onDurationChangeRef.current?.(audio.duration);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;

      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      if (event.code === "Escape") {
        setProgramTransformClipId(null);
        setProgramSnapGuides([]);
      }

      if (event.code === "Space") {
        event.preventDefault();
        togglePlayPause();
      }

      if (event.code === "ArrowLeft") {
        event.preventDefault();
        jumpBy(-skipSeconds);
      }

      if (event.code === "ArrowRight") {
        event.preventDefault();
        jumpBy(skipSeconds);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!seekRequest) {
      return;
    }

    seekTo(seekRequest.time);
  }, [seekRequest]);

  const monitorDuration = Math.max(0, timelineDuration || 0);
  const visibleActiveClips = videoTrackIds
    .map((trackId) => activeClipsByTrack[trackId])
    .filter(
      (clip): clip is VideoTimelineClip =>
        !!clip && !isTrackHidden(trackSettings, clip.trackId),
    )
    .sort((a, b) => videoTrackIndex(a.trackId) - videoTrackIndex(b.trackId));
  const topVisualClip = visibleActiveClips[visibleActiveClips.length - 1] ?? null;
  const subtitleVideoTimeOffset = topVisualClip
    ? topVisualClip.timelineStart - topVisualClip.sourceIn
    : 0;
  const subtitleVideoSourceKey = topVisualClip?.sourcePath ?? videoPath ?? "";
  const visibleSubtitles = subtitles.filter(
    (subtitle) => !isTrackHidden(trackSettings, getSubtitleTrackId(subtitle)),
  );

  const selectedActiveClip = selectedVideoClipId
    ? visibleActiveClips.find((clip) => clip.id === selectedVideoClipId) ??
      videoClips.find(
        (clip) =>
          clip.id === selectedVideoClipId &&
          currentTime >= clip.timelineStart &&
          currentTime < clip.timelineEnd,
      ) ??
      null
    : null;

  const selectedDisplayClip = selectedActiveClip
    ? withEvaluatedVideoTransform(selectedActiveClip, displayTime)
    : null;

  const selectedTrackId = selectedActiveClip?.trackId as VideoTrackId | undefined;
  const selectedTrackVisible =
    !!selectedActiveClip &&
    !!selectedTrackId &&
    !!videoVisibility[selectedTrackId] &&
    !isTrackHidden(trackSettings, selectedTrackId);
  const selectedTrackLocked =
    !!selectedTrackId && (trackSettings[selectedTrackId]?.locked ?? false);

  const selectedVideoSize = selectedTrackId
    ? videoDimensions[selectedTrackId] ?? { width: 16, height: 9 }
    : { width: 16, height: 9 };

  const fittedVideoRect = useMemo(() => {
    const shellWidth = shellDimensions.width;
    const shellHeight = shellDimensions.height;
    const sourceWidth = Math.max(1, selectedVideoSize.width);
    const sourceHeight = Math.max(1, selectedVideoSize.height);

    if (shellWidth <= 0 || shellHeight <= 0) {
      return { left: 0, top: 0, width: 0, height: 0 };
    }

    const scale = Math.min(shellWidth / sourceWidth, shellHeight / sourceHeight);
    const width = sourceWidth * scale;
    const height = sourceHeight * scale;

    return {
      left: (shellWidth - width) / 2,
      top: (shellHeight - height) / 2,
      width,
      height,
    };
  }, [
    shellDimensions.width,
    shellDimensions.height,
    selectedVideoSize.width,
    selectedVideoSize.height,
  ]);

  const beginMoveTransform = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Transform gestures are primary-button only. A right-click fires
    // pointerdown before contextmenu, so without this guard the native
    // Opacity menu can leave a move gesture armed until the next click.
    if (event.button !== 0 || !event.isPrimary) {
      return;
    }

    if (
      !selectedActiveClip ||
      selectedTrackLocked ||
      !onVideoTransformChange ||
      shellDimensions.width <= 0 ||
      shellDimensions.height <= 0
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const startPositionX = (selectedDisplayClip ?? selectedActiveClip).positionX ?? 0;
    const startPositionY = (selectedDisplayClip ?? selectedActiveClip).positionY ?? 0;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) {
        return;
      }

      // If pointerup was swallowed by a native context menu/window transition,
      // do not let a stale listener move the clip with the mouse button up.
      if ((moveEvent.buttons & 1) === 0) {
        handlePointerUp();
        return;
      }

      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;

      const rawPositionX = startPositionX + (deltaX / shellDimensions.width) * 100;
      const rawPositionY = startPositionY + (deltaY / shellDimensions.height) * 100;

      const movingClip = {
        ...(selectedDisplayClip ?? selectedActiveClip),
        positionX: rawPositionX,
        positionY: rawPositionY,
        // Snap geometry must use the in-progress pointer values, not re-evaluate
        // the clip's persisted animation channel at the same playhead time.
        transformKeyframes: undefined,
      };

      const movingBounds = programBoundsForClip(
        movingClip,
        selectedVideoSize,
        shellDimensions,
        displayTime,
      );

      const otherVisibleBounds: ProgramBounds[] = [];

      for (const otherClip of visibleActiveClips) {
        if (
          otherClip.id === selectedActiveClip.id ||
          !videoVisibility[otherClip.trackId] ||
          isTrackHidden(trackSettings, otherClip.trackId)
        ) {
          continue;
        }

        otherVisibleBounds.push(
          programBoundsForClip(
            otherClip,
            videoDimensions[otherClip.trackId] ?? { width: 16, height: 9 },
            shellDimensions,
            displayTime,
          ),
        );
      }

      const objectSnapX = snapProgramBoundsToBounds(
        movingBounds,
        otherVisibleBounds,
        shellDimensions.width,
        "x",
        PROGRAM_OBJECT_SNAP_THRESHOLD_PX,
      );
      const objectSnapY = snapProgramBoundsToBounds(
        movingBounds,
        otherVisibleBounds,
        shellDimensions.height,
        "y",
        PROGRAM_OBJECT_SNAP_THRESHOLD_PX,
      );

      // Object-to-object snapping gets priority. If there is no nearby visible
      // clip edge/center, fall back to the Program layout guides.
      const layoutSnapX = snapProgramPercent(
        50 + rawPositionX,
        shellDimensions.width,
        "x",
      );
      const layoutSnapY = snapProgramPercent(
        50 + rawPositionY,
        shellDimensions.height,
        "y",
      );

      const nextPositionX = objectSnapX.guide
        ? rawPositionX + (objectSnapX.deltaPx / shellDimensions.width) * 100
        : layoutSnapX.value - 50;
      const nextPositionY = objectSnapY.guide
        ? rawPositionY + (objectSnapY.deltaPx / shellDimensions.height) * 100
        : layoutSnapY.value - 50;

      setProgramSnapGuides(
        [
          objectSnapX.guide ?? layoutSnapX.guide,
          objectSnapY.guide ?? layoutSnapY.guide,
        ].filter((guide): guide is ProgramSnapGuide => guide !== null),
      );

      onVideoTransformChange(selectedActiveClip.id, {
        positionX: nextPositionX,
        positionY: nextPositionY,
      });
    };

    const handlePointerUp = () => {
      setProgramSnapGuides([]);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  const beginScaleTransform = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary) {
      return;
    }

    setProgramSnapGuides([]);
    if (
      !selectedActiveClip ||
      selectedTrackLocked ||
      !onVideoTransformChange
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const transformBox = event.currentTarget.closest(
      ".program-transform-box",
    ) as HTMLElement | null;
    const shell = shellRef.current;

    if (!transformBox || !shell) {
      return;
    }

    const cornerNames = [
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
    ] as const;
    type CornerName = (typeof cornerNames)[number];

    const draggedCorner = cornerNames.find((corner) =>
      event.currentTarget.classList.contains(corner),
    );

    if (!draggedCorner) {
      return;
    }

    const oppositeCorner: Record<CornerName, CornerName> = {
      "top-left": "bottom-right",
      "top-right": "bottom-left",
      "bottom-left": "top-right",
      "bottom-right": "top-left",
    };

    const oppositeHandle = transformBox.querySelector(
      `.program-transform-handle.corner.${oppositeCorner[draggedCorner]}`,
    ) as HTMLElement | null;

    if (!oppositeHandle) {
      return;
    }

    // Use the actual on-screen handle centres. This automatically accounts for
    // the clip's current scale and rotation, while the opposite corner becomes
    // the fixed anchor for the entire resize gesture.
    const draggedRect = event.currentTarget.getBoundingClientRect();
    const oppositeRect = oppositeHandle.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();

    const movingCornerX = draggedRect.left + draggedRect.width / 2;
    const movingCornerY = draggedRect.top + draggedRect.height / 2;
    const anchorX = oppositeRect.left + oppositeRect.width / 2;
    const anchorY = oppositeRect.top + oppositeRect.height / 2;

    const startVectorX = movingCornerX - anchorX;
    const startVectorY = movingCornerY - anchorY;
    const startVectorLengthSquared = Math.max(
      1,
      startVectorX * startVectorX + startVectorY * startVectorY,
    );

    // Preserve the exact point inside the handle where the user grabbed it, so
    // beginning a resize never causes the corner to jump under the cursor.
    const pointerOffsetX = event.clientX - movingCornerX;
    const pointerOffsetY = event.clientY - movingCornerY;

    const startScale = Math.max(10, Math.min(400, (selectedDisplayClip ?? selectedActiveClip).scale ?? 100));
    const startPositionX = (selectedDisplayClip ?? selectedActiveClip).positionX ?? 0;
    const startPositionY = (selectedDisplayClip ?? selectedActiveClip).positionY ?? 0;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const pointerCornerX = moveEvent.clientX - pointerOffsetX;
      const pointerCornerY = moveEvent.clientY - pointerOffsetY;
      const pointerVectorX = pointerCornerX - anchorX;
      const pointerVectorY = pointerCornerY - anchorY;

      // Project the pointer onto the original diagonal. This gives proportional
      // scaling even when the clip is rotated, without distorting its aspect
      // ratio or letting sideways pointer movement create erratic scale jumps.
      const requestedRatio =
        (pointerVectorX * startVectorX + pointerVectorY * startVectorY) /
        startVectorLengthSquared;
      const requestedScale = startScale * requestedRatio;
      const nextScale = Math.max(10, Math.min(400, requestedScale));
      const appliedRatio = nextScale / startScale;

      // The opposite corner must remain fixed in Program space. Scaling around
      // the clip centre would move that corner, so shift the centre by half of
      // the diagonal's size change. positionX/Y are stored as Program-shell
      // percentages, hence the conversion using the shell dimensions below.
      const centerShiftX = (startVectorX * (appliedRatio - 1)) / 2;
      const centerShiftY = (startVectorY * (appliedRatio - 1)) / 2;

      const nextPositionX =
        startPositionX +
        (centerShiftX / Math.max(1, shellRect.width)) * 100;
      const nextPositionY =
        startPositionY +
        (centerShiftY / Math.max(1, shellRect.height)) * 100;

      onVideoTransformChange(selectedActiveClip.id, {
        scale: nextScale,
        positionX: nextPositionX,
        positionY: nextPositionY,
      });
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  const beginRotateTransform = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary) {
      return;
    }

    setProgramSnapGuides([]);
    if (
      !selectedActiveClip ||
      selectedTrackLocked ||
      !onVideoTransformChange
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const transformBox = event.currentTarget.closest(
      ".program-transform-box",
    ) as HTMLElement | null;
    const rect = transformBox?.getBoundingClientRect();

    if (!rect) {
      return;
    }

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const startPointerAngle = pointerAngleDegrees(
      event.clientX,
      event.clientY,
      centerX,
      centerY,
    );
    const startRotation = (selectedDisplayClip ?? selectedActiveClip).rotation ?? 0;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextPointerAngle = pointerAngleDegrees(
        moveEvent.clientX,
        moveEvent.clientY,
        centerX,
        centerY,
      );

      const rawRotation = normalizeRotation(
        startRotation + (nextPointerAngle - startPointerAngle),
      );

      onVideoTransformChange(selectedActiveClip.id, {
        rotation: snapRotation(rawRotation),
      });
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  const isCropModeActive =
    !!selectedActiveClip && cropModeClipId === selectedActiveClip.id;

  const enterCropMode = () => {
    if (!selectedActiveClip || selectedTrackLocked || !onVideoTransformChange) {
      return;
    }

    cropStartRef.current = {
      clipId: selectedActiveClip.id,
      cropTop: selectedActiveClip.cropTop ?? 0,
      cropRight: selectedActiveClip.cropRight ?? 0,
      cropBottom: selectedActiveClip.cropBottom ?? 0,
      cropLeft: selectedActiveClip.cropLeft ?? 0,
    };
    setProgramTransformClipId(selectedActiveClip.id);
    setCropModeClipId(selectedActiveClip.id);
    setProgramSnapGuides([]);
  };

  const finishCropMode = () => {
    cropStartRef.current = null;
    setCropModeClipId(null);
  };

  const cancelCropMode = () => {
    const snapshot = cropStartRef.current;
    if (snapshot && onVideoTransformChange) {
      onVideoTransformChange(snapshot.clipId, {
        cropTop: snapshot.cropTop,
        cropRight: snapshot.cropRight,
        cropBottom: snapshot.cropBottom,
        cropLeft: snapshot.cropLeft,
      });
    }
    cropStartRef.current = null;
    setCropModeClipId(null);
  };

  const resetSelectedCrop = () => {
    if (!selectedActiveClip || selectedTrackLocked || !onVideoTransformChange) {
      return;
    }
    onVideoTransformChange(selectedActiveClip.id, {
      cropTop: 0,
      cropRight: 0,
      cropBottom: 0,
      cropLeft: 0,
    });
  };

  const beginCropTransform = (
    event: ReactPointerEvent<HTMLButtonElement>,
    edge: "top" | "right" | "bottom" | "left",
  ) => {
    if (event.button !== 0 || !event.isPrimary) {
      return;
    }

    if (
      !selectedActiveClip ||
      selectedTrackLocked ||
      !onVideoTransformChange ||
      fittedVideoRect.width <= 0 ||
      fittedVideoRect.height <= 0
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const startTop = Math.max(0, Math.min(49, selectedActiveClip.cropTop ?? 0));
    const startRight = Math.max(0, Math.min(49, selectedActiveClip.cropRight ?? 0));
    const startBottom = Math.max(0, Math.min(49, selectedActiveClip.cropBottom ?? 0));
    const startLeft = Math.max(0, Math.min(49, selectedActiveClip.cropLeft ?? 0));
    const rotationRadians = (((selectedDisplayClip ?? selectedActiveClip).rotation ?? 0) * Math.PI) / 180;
    const clipScale = Math.max(0.1, Math.min(4, ((selectedDisplayClip ?? selectedActiveClip).scale ?? 100) / 100));
    const cos = Math.cos(rotationRadians);
    const sin = Math.sin(rotationRadians);

    const clampCrop = (value: number) => Math.max(0, Math.min(49, value));

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const screenDx = moveEvent.clientX - startX;
      const screenDy = moveEvent.clientY - startY;

      // Convert screen-space motion back into the clip's unrotated local axes.
      const localDx = (screenDx * cos + screenDy * sin) / clipScale;
      const localDy = (-screenDx * sin + screenDy * cos) / clipScale;
      const deltaXPct = (localDx / fittedVideoRect.width) * 100;
      const deltaYPct = (localDy / fittedVideoRect.height) * 100;

      if (edge === "left") {
        onVideoTransformChange(selectedActiveClip.id, {
          cropLeft: clampCrop(startLeft + deltaXPct),
        });
      } else if (edge === "right") {
        onVideoTransformChange(selectedActiveClip.id, {
          cropRight: clampCrop(startRight - deltaXPct),
        });
      } else if (edge === "top") {
        onVideoTransformChange(selectedActiveClip.id, {
          cropTop: clampCrop(startTop + deltaYPct),
        });
      } else {
        onVideoTransformChange(selectedActiveClip.id, {
          cropBottom: clampCrop(startBottom - deltaYPct),
        });
      }
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  useEffect(() => {
    if (!cropModeClipId) {
      return;
    }

    const handleCropKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        finishCropMode();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelCropMode();
      }
    };

    window.addEventListener("keydown", handleCropKeyDown, true);
    return () => window.removeEventListener("keydown", handleCropKeyDown, true);
  }, [cropModeClipId, onVideoTransformChange]);

  const handleProgramClipPointerDown = (
    event: ReactPointerEvent<HTMLVideoElement>,
    clip: VideoTimelineClip | null,
  ) => {
    // Selection/transform activation happens on the primary button only.
    // Right-click selection is handled by handleProgramClipContextMenu.
    if (event.button !== 0 || !event.isPrimary) {
      return;
    }

    if (!clip) {
      return;
    }

    event.stopPropagation();
    onVideoClipSelect?.(clip.id);

    if (!isProgramVideoClipInteractive(clip)) {
      setProgramTransformClipId(null);
      setProgramSnapGuides([]);
      cropStartRef.current = null;
      setCropModeClipId(null);
      setOpacityEditor(null);
      return;
    }

    if (cropModeClipId && cropModeClipId !== clip.id) {
      finishCropMode();
    }
    setProgramTransformClipId(clip.id);
  };

  const openOpacityEditor = (
    clip: VideoTimelineClip,
    clientX: number,
    clientY: number,
  ) => {
    setOpacityEditor({ clipId: clip.id, clientX, clientY });
  };

  const handleProgramClipContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    clip: VideoTimelineClip | null,
  ) => {
    if (!clip) return;

    event.preventDefault();
    event.stopPropagation();

    onVideoClipSelect?.(clip.id);

    if (!isProgramVideoClipInteractive(clip)) {
      setProgramTransformClipId(null);
      setProgramSnapGuides([]);
      cropStartRef.current = null;
      setCropModeClipId(null);
      setOpacityEditor(null);
      return;
    }

    if (cropModeClipId && cropModeClipId !== clip.id) {
      finishCropMode();
    }

    setProgramTransformClipId(clip.id);

    const clientX = event.clientX;
    const clientY = event.clientY;
    const locked = trackSettings[clip.trackId]?.locked ?? false;

    if (!canShowNativeContextMenu()) {
      if (!locked) openOpacityEditor(clip, clientX, clientY);
      return;
    }

    void showNativeContextMenu([
      {
        id: `program-video.${clip.id}.opacity`,
        text: "Opacity…",
        enabled: !locked,
        action: () => openOpacityEditor(clip, clientX, clientY),
      },
    ]).catch((error) => {
      console.error("Failed to show Program Monitor video menu:", error);
    });
  };

  const isProgramTransformActive =
    !!selectedActiveClip && programTransformClipId === selectedActiveClip.id;

  const transformOverlayStyle: CSSProperties | undefined = selectedDisplayClip
    ? (() => {
        const clipScale =
          Math.max(10, Math.min(400, (selectedDisplayClip ?? selectedActiveClip).scale ?? 100)) / 100;
        const clipRotation = Math.max(
          -180,
          Math.min(180, (selectedDisplayClip ?? selectedActiveClip).rotation ?? 0),
        );

        return {
          transform: `translate3d(${(selectedDisplayClip ?? selectedActiveClip).positionX ?? 0}%, ${
            (selectedDisplayClip ?? selectedActiveClip).positionY ?? 0
          }%, 0) scale(${clipScale}) rotate(${clipRotation}deg)`,
          transformOrigin: "center center",
          "--program-control-inverse-scale": `${1 / clipScale}`,
          "--program-control-counter-rotation": `${-clipRotation}deg`,
        } as CSSProperties;
      })()
    : undefined;

  const selectedCropInsets = selectedActiveClip
    ? {
        left: Math.max(0, Math.min(49, selectedActiveClip.cropLeft ?? 0)),
        top: Math.max(0, Math.min(49, selectedActiveClip.cropTop ?? 0)),
        right: Math.max(0, Math.min(49, selectedActiveClip.cropRight ?? 0)),
        bottom: Math.max(0, Math.min(49, selectedActiveClip.cropBottom ?? 0)),
      }
    : null;

  const cropWindowStyle: CSSProperties | undefined = selectedCropInsets
    ? {
        left: `${selectedCropInsets.left}%`,
        top: `${selectedCropInsets.top}%`,
        right: `${selectedCropInsets.right}%`,
        bottom: `${selectedCropInsets.bottom}%`,
      }
    : undefined;

  /*
   * Outside crop-edit mode the transform frame should hug the pixels that are
   * actually visible after crop, not the original uncropped source bounds.
   * During crop mode we intentionally expand back to the full fitted source so
   * the discarded regions remain visible/dimmed and can be restored by dragging.
   */
  const opacityEditorClip = opacityEditor
    ? videoClips.find(
        (clip) =>
          clip.id === opacityEditor.clipId &&
          isProgramVideoClipInteractive(clip),
      ) ?? null
    : null;
  const opacityEditorValue = opacityEditorClip
    ? evaluateVideoTransformProperty(opacityEditorClip, "opacity", displayTime)
    : 100;
  const opacityEditorLocked = opacityEditorClip
    ? trackSettings[opacityEditorClip.trackId]?.locked ?? false
    : false;

  const opacityEditorStyle: CSSProperties | undefined = opacityEditor
    ? {
        left: Math.max(10, Math.min(window.innerWidth - 250, opacityEditor.clientX)),
        top: Math.max(10, Math.min(window.innerHeight - 92, opacityEditor.clientY)),
      }
    : undefined;

  const transformBoxRect = (() => {
    if (!selectedCropInsets || isCropModeActive) {
      return fittedVideoRect;
    }

    const visibleWidthRatio = Math.max(
      0.02,
      1 - (selectedCropInsets.left + selectedCropInsets.right) / 100,
    );
    const visibleHeightRatio = Math.max(
      0.02,
      1 - (selectedCropInsets.top + selectedCropInsets.bottom) / 100,
    );

    return {
      left:
        fittedVideoRect.left +
        fittedVideoRect.width * (selectedCropInsets.left / 100),
      top:
        fittedVideoRect.top +
        fittedVideoRect.height * (selectedCropInsets.top / 100),
      width: fittedVideoRect.width * visibleWidthRatio,
      height: fittedVideoRect.height * visibleHeightRatio,
    };
  })();

  return (
    <div className="video-player">
      <div className="video-player-toolbar">
        {!isSkimPreviewActive && selectedActiveClip && selectedTrackVisible && (
          <div className="program-crop-toolbar" aria-label="Video crop controls">
            {!isCropModeActive ? (
              <button
                type="button"
                className="program-crop-button"
                onClick={enterCropMode}
                disabled={selectedTrackLocked}
              >
                Crop {videoTrackLabel(selectedActiveClip.trackId)}
              </button>
            ) : (
              <>
                <button type="button" className="program-crop-button primary" onClick={finishCropMode}>
                  Done
                </button>
                <button
                  type="button"
                  className="program-crop-button"
                  onClick={() => onApplyVideoCropToTrack?.(selectedActiveClip.id)}
                >
                  Apply to {videoTrackLabel(selectedActiveClip.trackId)}
                </button>
                <button type="button" className="program-crop-button" onClick={resetSelectedCrop}>
                  Reset Crop
                </button>
                <button type="button" className="program-crop-button" onClick={cancelCropMode}>
                  Cancel
                </button>
              </>
            )}
          </div>
        )}

        <button
          className="video-file-button"
          onClick={() => void onChooseVideo?.()}
        >
          {primaryVideoUrl ? "Change video" : "Choose video"}
        </button>

        {videoName && (
          <span className="video-name" title={videoName}>
            {videoName}
          </span>
        )}
      </div>

      {primaryVideoUrl ? (
        <div className="video-monitor">
          <div
            ref={shellRef}
            className="video-shell"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) {
                if (cropModeClipId) {
                  finishCropMode();
                }
                setProgramTransformClipId(null);
                setProgramSnapGuides([]);
              }
            }}
          >
            {videoTrackIds.map((trackId) => {
              const dissolve = dissolvesByTrack[trackId];
              if (!dissolve || isTrackHidden(trackSettings, trackId)) return null;

              const zIndex = videoTrackIndex(trackId);
              return (
                <div key={`dissolve:${trackId}`} className="program-dissolve-pair">
                  <video
                    key={`${trackId}-dissolve-out:${dissolve.outgoing.id}`}
                    ref={(element) => { dissolveOutgoingRefs.current[trackId] = element; }}
                    src={convertFileSrc(
                      proxyPathsBySource[dissolve.outgoing.sourcePath] ?? dissolve.outgoing.sourcePath,
                    )}
                    data-source-path={dissolve.outgoing.sourcePath}
                    data-preview-proxy={proxyPathsBySource[dissolve.outgoing.sourcePath] ? "true" : "false"}
                    className="video-element video-track-layer program-dissolve-layer"
                    muted
                    preload="auto"
                    style={{
                      zIndex,
                      ...videoTransformStyle(
                        dissolve.outgoing,
                        videoDimensions[trackId] ?? { width: 16, height: 9 },
                        shellDimensions,
                        displayTime,
                      ),
                      filter: adjustmentCssFilter(
                        adjustmentLayersAffectingVideoTrack(
                          adjustmentLayers, displayTime, trackId, trackSettings,
                        ),
                        displayTime,
                      ) || undefined,
                      opacity:
                        (1 - dissolve.progress) *
                        videoOpacityFadeFactor(dissolve.outgoing, displayTime) *
                        (evaluateVideoTransformProperty(dissolve.outgoing, "opacity", displayTime) / 100),
                    }}
                    onLoadedMetadata={() =>
                      syncSameTrackDissolve(
                        trackId,
                        isPlayingRef.current ? currentTimeRef.current : displayTimeRef.current,
                        isPlayingRef.current,
                        true,
                      )
                    }
                  />
                  <video
                    key={`${trackId}-dissolve-in:${dissolve.incoming.id}`}
                    ref={(element) => { dissolveIncomingRefs.current[trackId] = element; }}
                    src={convertFileSrc(
                      proxyPathsBySource[dissolve.incoming.sourcePath] ?? dissolve.incoming.sourcePath,
                    )}
                    data-source-path={dissolve.incoming.sourcePath}
                    data-preview-proxy={proxyPathsBySource[dissolve.incoming.sourcePath] ? "true" : "false"}
                    className="video-element video-track-layer program-dissolve-layer incoming"
                    muted
                    preload="auto"
                    style={{
                      zIndex,
                      ...videoTransformStyle(
                        dissolve.incoming,
                        videoDimensions[trackId] ?? { width: 16, height: 9 },
                        shellDimensions,
                        displayTime,
                      ),
                      filter: adjustmentCssFilter(
                        adjustmentLayersAffectingVideoTrack(
                          adjustmentLayers, displayTime, trackId, trackSettings,
                        ),
                        displayTime,
                      ) || undefined,
                      opacity:
                        dissolve.progress *
                        videoOpacityFadeFactor(dissolve.incoming, displayTime) *
                        (evaluateVideoTransformProperty(dissolve.incoming, "opacity", displayTime) / 100),
                    }}
                    onLoadedMetadata={() =>
                      syncSameTrackDissolve(
                        trackId,
                        isPlayingRef.current ? currentTimeRef.current : displayTimeRef.current,
                        isPlayingRef.current,
                        true,
                      )
                    }
                  />
                </div>
              );
            })}

            {videoTrackIds.map((trackId) => {
              const clip = activeClipsByTrack[trackId];
              const sourceUrl = sourceUrlsByTrack[trackId];
              if (!clip || !sourceUrl || dissolvesByTrack[trackId]) return null;

              return (
                <video
                  key={`${trackId}:${clip.id}:${clip.sourcePath}`}
                  ref={(element) => { videoRefs.current[trackId] = element; }}
                  src={sourceUrl}
                  data-source-path={clip.sourcePath}
                  data-preview-proxy={proxyPathsBySource[clip.sourcePath] ? "true" : "false"}
                  className="video-element video-track-layer"
                  muted
                  preload="auto"
                  style={{
                    zIndex: videoTrackIndex(trackId),
                    visibility:
                      videoVisibility[trackId] && !isTrackHidden(trackSettings, trackId)
                        ? "visible"
                        : "hidden",
                    ...videoTransformStyle(
                      clip,
                      videoDimensions[trackId] ?? { width: 16, height: 9 },
                      shellDimensions,
                      displayTime,
                    ),
                    ...adjustedVideoTransitionStyle(
                      clip,
                      displayTime,
                      adjustmentLayers,
                      trackSettings,
                    ),
                  }}
                  onLoadedMetadata={() => handleVideoLoadedMetadata(trackId)}
                  onPointerDown={(event) =>
                    handleProgramClipPointerDown(event, clip)
                  }
                  onContextMenu={(event) =>
                    handleProgramClipContextMenu(event, clip)
                  }
                />
              );
            })}

            {programSnapGuides.length > 0 && (
              <div className="program-snap-guide-layer" aria-hidden="true">
                {programSnapGuides.map((guide) => (
                  <span
                    key={`${guide.axis}-${guide.percent}`}
                    className={`program-snap-guide ${guide.axis}`}
                    style={
                      guide.axis === "x"
                        ? { left: `${guide.percent}%` }
                        : { top: `${guide.percent}%` }
                    }
                  />
                ))}
              </div>
            )}

            {!isSkimPreviewActive && isProgramTransformActive && selectedActiveClip && selectedTrackVisible && (
              <div
                className={[
                  "program-transform-layer",
                  selectedTrackLocked ? "locked" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={transformOverlayStyle}
              >
                <div
                  className={`program-transform-box ${isCropModeActive ? "crop-mode" : ""}`}
                  style={{
                    left: transformBoxRect.left,
                    top: transformBoxRect.top,
                    width: transformBoxRect.width,
                    height: transformBoxRect.height,
                  }}
                  onPointerDown={isCropModeActive ? undefined : beginMoveTransform}
                  onContextMenu={(event) =>
                    handleProgramClipContextMenu(event, selectedActiveClip)
                  }
                >
                  <span className="program-transform-track-badge">
                    {videoTrackLabel(selectedActiveClip.trackId)}
                  </span>

                  {!selectedTrackLocked && (
                    isCropModeActive ? (
                      <div className="program-crop-window" style={cropWindowStyle}>
                        <button
                          type="button"
                          className="program-crop-handle top"
                          onPointerDown={(event) => beginCropTransform(event, "top")}
                          aria-label="Crop top edge"
                        />
                        <button
                          type="button"
                          className="program-crop-handle right"
                          onPointerDown={(event) => beginCropTransform(event, "right")}
                          aria-label="Crop right edge"
                        />
                        <button
                          type="button"
                          className="program-crop-handle bottom"
                          onPointerDown={(event) => beginCropTransform(event, "bottom")}
                          aria-label="Crop bottom edge"
                        />
                        <button
                          type="button"
                          className="program-crop-handle left"
                          onPointerDown={(event) => beginCropTransform(event, "left")}
                          aria-label="Crop left edge"
                        />
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="program-transform-handle corner top-left"
                          onPointerDown={beginScaleTransform}
                          aria-label="Scale clip from top left"
                        />
                        <button
                          type="button"
                          className="program-transform-handle corner top-right"
                          onPointerDown={beginScaleTransform}
                          aria-label="Scale clip from top right"
                        />
                        <button
                          type="button"
                          className="program-transform-handle corner bottom-left"
                          onPointerDown={beginScaleTransform}
                          aria-label="Scale clip from bottom left"
                        />
                        <button
                          type="button"
                          className="program-transform-handle corner bottom-right"
                          onPointerDown={beginScaleTransform}
                          aria-label="Scale clip from bottom right"
                        />

                        <span className="program-transform-rotation-stem" />
                        <button
                          type="button"
                          className="program-transform-handle rotation"
                          onPointerDown={beginRotateTransform}
                          aria-label={`Rotate clip, ${formatRotation(
                            (selectedDisplayClip ?? selectedActiveClip).rotation ?? 0,
                          )}`}
                          title="Drag to rotate · snaps every 45°"
                        >
                          ↻
                        </button>
                        <span
                          className="program-transform-angle-readout"
                          aria-hidden="true"
                        >
                          {formatRotation((selectedDisplayClip ?? selectedActiveClip).rotation ?? 0)}
                        </span>
                      </>
                    )
                  )}
                </div>
              </div>
            )}

            {audioTrackIds.map((audioTrackId) => {
              const sourcePath = audioSourcesByTrack[audioTrackId];
              const previewPath = sourcePath
                ? proxyPathsBySource[sourcePath] ?? sourcePath
                : null;
              return (
                <audio
                  key={`${audioTrackId}:${previewPath ?? "gap"}`}
                  ref={(element) => { audioRefs.current[audioTrackId] = element; }}
                  src={previewPath ? convertFileSrc(previewPath) : undefined}
                  data-source-path={sourcePath ?? ""}
                  data-preview-proxy={sourcePath && proxyPathsBySource[sourcePath] ? "true" : "false"}
                  preload="auto"
                  hidden
                  onLoadedMetadata={() => handleAudioLoadedMetadata(audioTrackId)}
                />
              );
            })}

            <audio
              key={`primary-metadata:${videoPath ?? ""}`}
              ref={primaryMetadataAudioRef}
              src={primaryVideoUrl}
              preload="metadata"
              hidden
              onLoadedMetadata={handlePrimaryMetadataLoaded}
            />

            <VideoSubtitleOverlay
              subtitles={visibleSubtitles}
              currentTime={displayTime}
              videoTimeOffset={subtitleVideoTimeOffset}
              videoSourceKey={subtitleVideoSourceKey}
              selectedSubtitleId={selectedSubtitleId}
              interactiveSubtitleIds={interactiveSubtitleIds}
              shellRef={shellRef}
              onSubtitleSelect={onSubtitleSelect}
              onSubtitlePositionChange={onSubtitlePositionChange}
              onSubtitleTextChange={onSubtitleTextChange}
              onSubtitleStyleChange={onSubtitleStyleChange}
              onAllSubtitleStylesChange={onAllSubtitleStylesChange}
            />
          </div>

          {opacityEditor && opacityEditorClip && opacityEditorStyle && (
        <div
          ref={opacityEditorRef}
          className="program-opacity-popover"
          style={opacityEditorStyle}
          role="dialog"
          aria-label="Video opacity"
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="program-opacity-popover-header">
            <span>Opacity</span>
            <strong>{Math.round(opacityEditorValue)}%</strong>
          </div>
          <input
            className="program-opacity-slider"
            type="range"
            min={0}
            max={100}
            step={1}
            value={opacityEditorValue}
            disabled={opacityEditorLocked}
            aria-label="Video opacity"
            onChange={(event) =>
              onVideoTransformChange?.(opacityEditorClip.id, {
                opacity: Number(event.target.value),
              })
            }
          />
          {opacityEditorLocked && (
            <span className="program-opacity-locked">Track locked</span>
          )}
        </div>
      )}

      <VideoControls
            currentTime={currentTime}
            duration={monitorDuration}
            isPlaying={isPlaying}
            skipSeconds={skipSeconds}
            onTogglePlayPause={togglePlayPause}
            onJumpBy={jumpBy}
            onSeekTo={seekTo}
          />
        </div>
      ) : (
        <button
          className="video-placeholder"
          onClick={() => void onChooseVideo?.()}
        >
          <span className="video-placeholder-icon">▶</span>
          <span>Choose a video to begin</span>
        </button>
      )}
    </div>
  );
});

export default VideoPlayer;
