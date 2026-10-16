import { hitTestLayers, type HitTestLayer } from "../../utils/programHitTest";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { convertFileSrc } from "@tauri-apps/api/core";

import {
  setPlaybackClockPlaying,
  usePlaybackClockTime,
} from "../../utils/playbackClock";
import { useMediaSupervisor } from "../../hooks/useMediaSupervisor";

import {
  canShowNativeContextMenu,
  showNativeContextMenu,
} from "../../services/nativeContextMenu";

import {
  getSubtitleTrackId,
  type Subtitle,
} from "../../types/subtitle";
import type {
  AdjustmentLayerClip,
  AudioTimelineClip,
  TimelineTrackId,
  TimelineTrackSettings,
  VideoBlendMode,
  VideoMask,
  VideoTimelineClip,
} from "../../types/timelineModel";

import {
  adjustmentCssFilter,
  adjustmentLayerStrength,
  adjustmentLayersAffectingVideoTrack,
} from "../../utils/adjustmentLayers";
import {
  VIDEO_BLEND_MODES,
  VIDEO_BLEND_MODE_LABELS,
  cssBlendMode,
  isNormalBlendMode,
  normalizeVideoBlendMode,
} from "../../utils/blendModes";

import VideoControls from "./VideoControls";
import VideoSubtitleOverlay from "./VideoSubtitleOverlay";
import ProgramLayersPanel from "./ProgramLayersPanel";
import ProgramSnapOverlay from "./ProgramSnapOverlay";
import VideoEffectFilterDefs from "../effects/VideoEffectFilterDefs";
import ProgramMaskEditor from "../masks/ProgramMaskEditor";
import {
  isFreezeFrameClip,
  isReverseVideoClip,
  sourceTimeToTimelineTime,
  timelineTimeToSourceTime,
  videoPlaybackRate,
} from "../../utils/videoRetime";
import {
  PROGRAM_FRAME_SNAP_THRESHOLD_PX,
  PROGRAM_OBJECT_SNAP_THRESHOLD_PX,
  programFrameSnapLines,
  programLayoutSnapLines,
  snapProgramBoundsToBounds,
  snapProgramBoundsToLines,
  snapProgramPointToLines,
  type ProgramBounds,
  type ProgramSnapGuide,
} from "../../utils/programSnapping";
import {
  combinedVignette,
  enabledVideoEffects,
  hasRasterVideoEffects,
  videoEffectFilterDomId,
  videoEffectsForClipAtTime,
} from "../../utils/videoEffects";
import {
  activeVideoMask,
  videoMaskCssStyle,
  type VideoMaskGeometry,
} from "../../utils/videoMasks";
import {
  evaluateVideoTransform,
  evaluateVideoTransformProperty,
  withEvaluatedVideoTransform,
} from "../../utils/videoTransformKeyframes";
import {
  effectiveAdjustmentLayer,
  effectiveVideoLayer,
  programStackRankMap,
  displayLayerNumber,
} from "../../utils/videoLayers";
import { TIMELINE_GAP_BRIDGE_EPSILON } from "../../utils/timelineFrames";
import { traceCut } from "../../utils/cutTrace";

import "./VideoPlayer.css";

type SeekRequest = {
  time: number;
  id: number;
};

export type VideoPlayerHandle = {
  setSkimPreviewTime: (time: number | null) => void;
  /** Current Program Monitor editing-canvas size in CSS pixels. */
  getProgramPreviewSize: () => { width: number; height: number } | null;
  /** Suggested Program-space mask geometry for the clip at the current frame. */
  getVideoMaskDefaultGeometry: (clipId: string) => VideoMaskGeometry | null;
};

type VideoPlayerProps = {
  videoPath: string | null;
  videoName: string | null;
  onChooseVideo?: () => void | Promise<void>;

  onDurationChange?: (duration: number) => void;
  onTimeChange?: (currentTime: number) => void;
  locked?: boolean;

  seekRequest?: SeekRequest | null;

  videoClips: VideoTimelineClip[];
  audioClips: AudioTimelineClip[];
  adjustmentLayers: AdjustmentLayerClip[];
  timelineDuration: number;
  trackSettings: TimelineTrackSettings;
  selectedVideoClipId?: string | null;
  interactiveVideoClipIds?: string[];
  onVideoClipSelect?: (id: string) => void;
  onVideoLayerChange?: (
    id: string,
    direction: "forward" | "backward",
    atTime: number,
  ) => void;
  onVideoLayerReorder?: (
    orderedClipIdsTopToBottom: string[],
    atTime: number,
  ) => boolean | void;
  onOpenVideoEffects?: (id: string) => void;
  onOpenVideoMasks?: (id: string) => void;
  editingMask?: {
    ownerKind: "video" | "adjustment";
    ownerId: string;
    mask: VideoMask;
    locked: boolean;
    label: string;
  } | null;
  onEditingMaskChange?: (mask: VideoMask) => void;
  onVideoMaskChange?: (id: string, mask: VideoMask | undefined) => void;
  onVideoBlendModeChange?: (id: string, blendMode: VideoBlendMode) => void;
  onMaskEditStart?: () => void;
  onMaskEditEnd?: () => void;
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

  selectedSubtitleId?: string | null;
  interactiveSubtitleIds?: string[];
  onSubtitleSelect?: (id: string) => void;

  onSubtitlePositionChange?: (
    id: string,
    positionX: number,
    positionY: number,
  ) => void;

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
const PREWARM_FRAME_FALLBACK_MS = 360;
const PREWARM_NO_RVFC_DELAY_MS = 90;
const PREWARM_MAX_SOURCE_DRIFT_SECONDS = 0.05;
const PREWARM_NEAR_CUT_REFRESH_SECONDS = 0.75;
const PREWARM_REWIND_TOLERANCE_SECONDS = 0.008;
const PREBUFFER_LOOKAHEAD_SECONDS = 3;
const PROXY_PROMOTION_GUARD_SECONDS = 1.5;

function videoPreviewPlaybackRate(clip: VideoTimelineClip, hasProxy: boolean) {
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

    const requestedDuration =
      outEnabled && inEnabled
        ? Math.min(
            outgoing.transitionOutDuration ?? 0.5,
            incoming.transitionInDuration ?? 0.5,
          )
        : outEnabled
          ? (outgoing.transitionOutDuration ?? 0.5)
          : (incoming.transitionInDuration ?? 0.5);

    const outgoingDuration = outgoing.timelineEnd - outgoing.timelineStart;
    const incomingDuration = incoming.timelineEnd - incoming.timelineStart;
    const sourceDuration = outgoing.sourceDuration ?? outgoing.sourceOut;
    const outgoingPostHandle =
      Math.max(0, sourceDuration - outgoing.sourceOut) /
      videoPlaybackRate(outgoing);
    const incomingPreHandle =
      Math.max(0, incoming.sourceIn) / videoPlaybackRate(incoming);

    // A true centered dissolve needs media handles on both sides of the edit.
    // If either clip has no handle, the ordinary per-clip transition preview
    // remains the fallback instead of inventing/freeze-framing media.
    const maxHandleDuration =
      2 * Math.min(outgoingPostHandle, incomingPreHandle);
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

function findActiveVideoClips(
  videoClips: VideoTimelineClip[],
  timelineTime: number,
  trackId: VideoTrackId,
) {
  return videoClips
    .filter(
      (clip) =>
        clip.trackId === trackId &&
        timelineTime >= clip.timelineStart &&
        timelineTime < clip.timelineEnd,
    )
    .sort(
      (a, b) =>
        effectiveVideoLayer(a) - effectiveVideoLayer(b) ||
        a.timelineStart - b.timelineStart ||
        a.id.localeCompare(b.id),
    );
}

function findActiveVideoClip(
  videoClips: VideoTimelineClip[],
  timelineTime: number,
  trackId: VideoTrackId,
) {
  const trackClips = videoClips
    .filter((clip) => clip.trackId === trackId)
    .sort((a, b) => a.timelineStart - b.timelineStart);
  const exact = findActiveVideoClips(videoClips, timelineTime, trackId);
  if (exact.length > 0) return exact[exact.length - 1];

  // Edit operations are quantized to 30 fps, but legacy projects and floating
  // point retimes can still contain a sub-frame gap. Treat a gap shorter than
  // one output frame as adjacency and hold the outgoing frame until the next
  // clip begins instead of exposing the black viewer background.
  const previous = [...trackClips]
    .reverse()
    .find((clip) => clip.timelineEnd <= timelineTime);
  const next = trackClips.find((clip) => clip.timelineStart > timelineTime);
  if (
    previous &&
    next &&
    next.timelineStart - previous.timelineEnd <= TIMELINE_GAP_BRIDGE_EPSILON &&
    timelineTime - previous.timelineEnd <= TIMELINE_GAP_BRIDGE_EPSILON
  ) {
    return previous;
  }
  return null;
}

function findUpcomingVideoClips(
  videoClips: VideoTimelineClip[],
  timelineTime: number,
  trackId: VideoTrackId,
  activeClip: VideoTimelineClip | null,
  count = 4,
) {
  const threshold = activeClip
    ? activeClip.timelineEnd - TIMELINE_GAP_BRIDGE_EPSILON
    : timelineTime - 0.001;
  const candidates = videoClips
    .filter(
      (clip) =>
        clip.trackId === trackId &&
        clip.id !== activeClip?.id &&
        clip.timelineStart >= threshold,
    )
    .sort((a, b) => a.timelineStart - b.timelineStart);

  if (candidates.length === 0) return [];

  // Always keep the immediate next edit mounted, even when it is far away.
  // Additional clips enter the media graph by time horizon rather than by the
  // active clip changing. This prevents React from creating a new decoder at
  // the exact A -> B cut just because the old fixed-size window shifted.
  const selected = [
    candidates[0],
    ...candidates.filter(
      (clip) =>
        clip.id !== candidates[0].id &&
        clip.timelineStart <= timelineTime + PREBUFFER_LOOKAHEAD_SECONDS,
    ),
  ];

  return selected.slice(0, Math.max(1, count));
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
  return (
    clips.find(
      (clip) =>
        clip.trackId === trackId &&
        timelineTime >= clip.timelineStart &&
        timelineTime < clip.timelineEnd,
    ) ?? null
  );
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
      shellSize.width - (fittedLeft + (1 - cropRight / 100) * fittedWidth);
    const bottomPx =
      shellSize.height - (fittedTop + (1 - cropBottom / 100) * fittedHeight);
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

function videoOpacityFadeFactor(clip: VideoTimelineClip, timelineTime: number) {
  const clipDuration = Math.max(0.1, clip.timelineEnd - clip.timelineStart);
  const maxFadeDuration = clipDuration;
  const fadeIn = Math.max(
    0,
    Math.min(maxFadeDuration, clip.videoFadeInDuration ?? 0),
  );
  const fadeOut = Math.max(
    0,
    Math.min(maxFadeDuration, clip.videoFadeOutDuration ?? 0),
  );
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

  let opacity =
    evaluateVideoTransformProperty(clip, "opacity", timelineTime) / 100;
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
      effectiveVideoLayer(clip),
    ),
    timelineTime,
  );

  return {
    ...baseStyle,
    filter:
      [baseStyle.filter, adjustmentFilter].filter(Boolean).join(" ") ||
      undefined,
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

function videoVignetteOverlayStyle(
  clip: VideoTimelineClip,
  effects: ReturnType<typeof videoEffectsForClipAtTime>,
  sourceSize: VideoDimensions,
  shellSize: ShellDimensions,
  timelineTime: number,
): CSSProperties | null {
  const vignette = combinedVignette(effects);
  if (
    !vignette ||
    vignette.amount <= 0.001 ||
    shellSize.width <= 0 ||
    shellSize.height <= 0
  ) {
    return null;
  }

  const sourceWidth = Math.max(1, sourceSize.width);
  const sourceHeight = Math.max(1, sourceSize.height);
  const fitScale = Math.min(
    shellSize.width / sourceWidth,
    shellSize.height / sourceHeight,
  );
  const fittedWidth = sourceWidth * fitScale;
  const fittedHeight = sourceHeight * fitScale;
  const fittedLeft = (shellSize.width - fittedWidth) / 2;
  const fittedTop = (shellSize.height - fittedHeight) / 2;
  const softness = Math.max(0, Math.min(100, vignette.softness)) / 100;
  const clearStop = 18 + softness * 55;
  const edgeAlpha = Math.max(0, Math.min(1, vignette.amount / 100));

  return {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    ...videoTransformStyle(clip, sourceSize, shellSize, timelineTime),
    backgroundImage: `radial-gradient(ellipse at center, rgba(0,0,0,0) ${clearStop.toFixed(1)}%, rgba(0,0,0,${edgeAlpha.toFixed(4)}) 100%)`,
    backgroundSize: `${fittedWidth}px ${fittedHeight}px`,
    backgroundPosition: `${fittedLeft}px ${fittedTop}px`,
    backgroundRepeat: "no-repeat",
  };
}

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  function VideoPlayer(
    {
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
      onVideoLayerChange,
      onVideoLayerReorder,
      onOpenVideoEffects,
      onOpenVideoMasks,
      editingMask,
      onEditingMaskChange,
      onVideoMaskChange,
      onVideoBlendModeChange,
      onMaskEditStart,
      onMaskEditEnd,
      onVideoTransformChange,
      onApplyVideoCropToTrack,
      proxyPathsBySource = {},
      locked = false,
      subtitles,
      selectedSubtitleId,
      interactiveSubtitleIds,
      onSubtitleSelect,
      onSubtitlePositionChange,
    },
    ref,
  ) {
    const currentTime = usePlaybackClockTime();
    const [duration, setDuration] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);

    // Publish transport state so background decode work (filmstrips, etc.) can
    // yield immediately while Program Monitor playback is active.
    useEffect(() => {
      setPlaybackClockPlaying(isPlaying);
    }, [isPlaying]);

    useEffect(() => {
      return () => setPlaybackClockPlaying(false);
    }, []);
    const [presentedFrameTimelineTime, setPresentedFrameTimelineTime] =
      useState<{ clipId: string; time: number } | null>(null);
    // Keep the concrete media element used by libass in React state. Refs are
    // assigned after render, so reading videoRefsByClipId.current during render
    // can briefly return null for a newly-created Ripple/Freeze fragment and
    // leave the subtitle renderer unbound until some unrelated state change
    // (often pause/play) causes another render. A layout-effect handoff makes
    // the binding deterministic immediately after the <video> ref commits.
    const [subtitleClockVideo, setSubtitleClockVideo] =
      useState<HTMLVideoElement | null>(null);
    const subtitleClockVideoRef = useRef<HTMLVideoElement | null>(null);
    const subtitleClockClipIdRef = useRef<string | null>(null);
    const lastSubtitleClockRenderAtRef = useRef(0);
    const [skimPreviewTime, setSkimPreviewTime] = useState<number | null>(null);
    const [videoVisibility, setVideoVisibility] = useState<VisibilityState>({});
    const [presentedVideoClipIds, setPresentedVideoClipIds] = useState<
      Record<VideoTrackId, string | null>
    >({});
    // Intrinsic media geometry belongs to the clip/media instance, not to the
    // timeline track. Multiple adjacent clips can be mounted on one V-track
    // while prebuffering and may have completely different aspect ratios.
    const [videoDimensions, setVideoDimensions] = useState<
      Record<string, VideoDimensions>
    >({});
    const videoDimensionsRef = useRef<Record<string, VideoDimensions>>({});
    const [shellDimensions, setShellDimensions] = useState<ShellDimensions>({
      width: 0,
      height: 0,
    });
    const [programTransformClipId, setProgramTransformClipId] = useState<
      string | null
    >(null);
    const [cropModeClipId, setCropModeClipId] = useState<string | null>(null);
    const [opacityEditor, setOpacityEditor] =
      useState<OpacityEditorState | null>(null);
    const [layersPanelOpen, setLayersPanelOpen] = useState(false);
    const cropStartRef = useRef<{
      clipId: string;
      cropTop: number;
      cropRight: number;
      cropBottom: number;
      cropLeft: number;
    } | null>(null);
    const [programSnapGuides, setProgramSnapGuides] = useState<
      ProgramSnapGuide[]
    >([]);
    const [programMoveSnappingActive, setProgramMoveSnappingActive] =
      useState(false);

    // Keep normal Program Monitor video elements keyed by clip identity, not track.
    // A layer reorder changes trackId, but the decoded media element can remain alive.
    const videoRefsByClipId = useRef<Record<string, HTMLVideoElement | null>>(
      {},
    );
    // Keep each mounted clip on a stable URL while it is active/presented, but
    // allow an inactive buffered clip to promote to a newly-finished proxy.
    // The previous source-wide latch kept the original file for the entire
    // editor session, so proxies only helped after leaving/reopening a project.
    const latchedPreviewSourceByClipRef = useRef<
      Record<string, { sourcePath: string; previewPath: string; isProxy: boolean }>
    >({});
    // Linked audio follows the video clip when that clip swaps V-tracks. Keep
    // the decoded audio element keyed by clip identity for the same reason.
    const audioRefsByPlaybackKey = useRef<
      Record<string, HTMLAudioElement | null>
    >({});
    const primaryMetadataAudioRef = useRef<HTMLAudioElement | null>(null);
    const shellRef = useRef<HTMLDivElement | null>(null);
    const opacityEditorRef = useRef<HTMLDivElement | null>(null);
    const highSpeedPreviewSeekAtRef = useRef<Record<string, number>>({});
    const presentedVideoClipIdsRef = useRef<
      Record<VideoTrackId, string | null>
    >({});
    const videoReadyByClipIdRef = useRef<Record<string, boolean>>({});
    // When multiple clips from the same V-track overlap, the top-most clip owns
    // normal track transport/audio while lower visual layers are kept in sync
    // as muted supplemental video decks. Track only those decks so leaving an
    // overlap pauses them without interfering with ordinary near-cut prewarm.
    const supplementalPlayingClipIdsRef = useRef(new Set<string>());
    const videoWarmStateByClipIdRef = useRef<
      Record<string, "warming" | "warmed" | undefined>
    >({});
    // True only when a hidden prewarm actually produced a composited video
    // frame. A painted warm deck can be revealed immediately at a hard cut
    // without waiting for another frame callback.
    const videoWarmPaintedByClipIdRef = useRef<Record<string, boolean>>({});
    // A one-shot refresh shortly before an adjacent cut keeps WebKit's hidden
    // incoming decoder/compositor hot. Without it, a deck warmed several
    // seconds earlier can take ~200-300 ms to produce its next frame on resume.
    const videoNearCutRefreshedByClipIdRef = useRef<Record<string, boolean>>({});
    const audioOwnerByTrackRef = useRef<Record<string, string | null>>({});
    const handoffPendingByTrackRef = useRef<Record<string, string | undefined>>({});
    const handoffTimeoutByTrackRef = useRef<Record<string, number | undefined>>({});
    const cutHoldClipIdRef = useRef<string | null>(null);
    const failedMediaIdsRef = useRef<Record<string, string>>({});
    const currentTimeRef = useRef(currentTime);
    const timelineDurationRef = useRef(timelineDuration);
    const sourceDurationRef = useRef(duration);
    const videoClipsRef = useRef(videoClips);
    const audioClipsRef = useRef(audioClips);
    const trackSettingsRef = useRef(trackSettings);
    const isPlayingRef = useRef(false);
    const lockedRef = useRef(locked);
    lockedRef.current = locked;
    const videoTrackIdsRef = useRef<VideoTrackId[]>([]);
    const audioTrackIdsRef = useRef<AudioTrackId[]>([]);
    const displayTimeRef = useRef(currentTime);
    const skimPreviewTimeRef = useRef<number | null>(null);

    /*
     * Timeline skimming is an imperative preview operation. Keep a ref to the
     * media-sync function so hover can seek the actual <video> elements
     * immediately instead of waiting for a later React effect.
     */
    const syncAllMediaToTimelineRef = useRef<
      (timelineTime: number, shouldPlay: boolean, forceSeek?: boolean) => void
    >(() => undefined);

    const interactiveVideoClipIdSet = useMemo(
      () => (interactiveVideoClipIds ? new Set(interactiveVideoClipIds) : null),
      [interactiveVideoClipIds],
    );

    const isProgramVideoClipInteractive = (clip: VideoTimelineClip) =>
      !interactiveVideoClipIdSet || interactiveVideoClipIdSet.has(clip.id);

    videoDimensionsRef.current = videoDimensions;

    const unmaskedAdjustmentLayers = useMemo(
      () =>
        adjustmentLayers.filter(
          (layer) =>
            !activeVideoMask(layer.mask) && isNormalBlendMode(layer.blendMode),
        ),
      [adjustmentLayers],
    );

    const clearSkimPreview = (restorePlayheadFrame: boolean) => {
      if (skimPreviewTimeRef.current === null) return;

      skimPreviewTimeRef.current = null;
      setSkimPreviewTime(null);
      displayTimeRef.current = currentTimeRef.current;

      if (restorePlayheadFrame && !isPlayingRef.current) {
        syncAllMediaToTimelineRef.current(
          currentTimeRef.current,
          false,
          true,
        );
      }
    };

    useImperativeHandle(
      ref,
      () => ({
        setSkimPreviewTime: (time: number | null) => {
          if (isPlayingRef.current) {
            clearSkimPreview(false);
            return;
          }

          if (time === null || !Number.isFinite(time)) {
            // Timeline pointer edits used to send this on every pointermove.
            // If there is no active skim, a repeated null is a complete no-op.
            clearSkimPreview(true);
            return;
          }

          const maxDuration = Math.max(0, timelineDurationRef.current || 0);
          const nextTime = Math.max(0, Math.min(maxDuration, time));

          if (
            skimPreviewTimeRef.current !== null &&
            Math.abs(skimPreviewTimeRef.current - nextTime) < 0.0005
          ) {
            return;
          }

          skimPreviewTimeRef.current = nextTime;
          displayTimeRef.current = nextTime;
          setSkimPreviewTime(nextTime);

          // Skimming is a paused exact-frame operation. Seek immediately, then
          // let loadeddata/seeked/canplay mark the active destination clip
          // ready without requiring requestVideoFrameCallback (which may not
          // fire for a paused hidden element in WKWebView).
          syncAllMediaToTimelineRef.current(nextTime, false, true);
        },
        getProgramPreviewSize: () => {
          const rect = shellRef.current?.getBoundingClientRect();
          if (!rect || rect.width <= 0 || rect.height <= 0) {
            return null;
          }
          return { width: rect.width, height: rect.height };
        },
        getVideoMaskDefaultGeometry: (clipId: string) => {
          const clip = videoClipsRef.current.find((item) => item.id === clipId);
          const rect = shellRef.current?.getBoundingClientRect();

          if (!clip || !rect || rect.width <= 0 || rect.height <= 0) {
            return null;
          }

          const dimensions =
            videoDimensionsRef.current[clip.id] ??
            ({ width: 16, height: 9 } satisfies VideoDimensions);
          const bounds = programBoundsForClip(
            clip,
            dimensions,
            { width: rect.width, height: rect.height },
            displayTimeRef.current,
          );

          const visibleWidth = Math.max(1, bounds.right - bounds.left);
          const visibleHeight = Math.max(1, bounds.bottom - bounds.top);
          const insetScale = 0.7;

          return {
            positionX: (bounds.centerX / rect.width) * 100,
            positionY: (bounds.centerY / rect.height) * 100,
            width: (visibleWidth / rect.width) * 100 * insetScale,
            height: (visibleHeight / rect.height) * 100 * insetScale,
          };
        },
      }),
      [],
    );

    const isSkimPreviewActive = !isPlaying && skimPreviewTime !== null;
    const displayTime = isSkimPreviewActive ? skimPreviewTime : currentTime;
    displayTimeRef.current = displayTime;

    const onTimeChangeRef = useRef(onTimeChange);
    const onDurationChangeRef = useRef(onDurationChange);

    const activeVideoClipIdRefs = useRef<Record<VideoTrackId, string | null>>(
      {},
    );
    const activeAudioClipIdRefs = useRef<Record<AudioTrackId, string | null>>(
      {},
    );

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
        if (/^audio-\d+$/.test(id) && trackSettings[id]?.deleted !== true)
          ids.add(id);
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

    // Transport still has one primary clip per V-track, but Program compositing
    // can legitimately contain more than one clip from the same track when the
    // independent layer order places overlapping clips above/below each other.
    // Keep the full active visual set separate from the transport owner so hit
    // testing and Program layering do not collapse to a single clip per track.
    const activeVisualClipsByTrack = useMemo(() => {
      const result: Record<string, VideoTimelineClip[]> = {};
      for (const trackId of videoTrackIds) {
        result[trackId] = findActiveVideoClips(
          videoClips,
          displayTime,
          trackId,
        );
      }
      return result;
    }, [displayTime, videoClips, videoTrackIds]);

    const bufferedClipsByTrack = useMemo(() => {
      const result: Record<string, VideoTimelineClip[]> = {};

      for (const trackId of videoTrackIds) {
        const activeClip = activeClipsByTrack[trackId] ?? null;
        const upcomingClips = findUpcomingVideoClips(
          videoClips,
          displayTime,
          trackId,
          activeClip,
          4,
        );
        const dissolve = findSameTrackDissolve(videoClips, displayTime, trackId);
        const presentedClipId = presentedVideoClipIds[trackId] ?? null;
        const presentedClip = presentedClipId
          ? (videoClips.find((clip) => clip.id === presentedClipId) ?? null)
          : null;

        const clips = [
          presentedClip,
          ...(activeVisualClipsByTrack[trackId] ?? []),
          activeClip,
          dissolve?.outgoing ?? null,
          dissolve?.incoming ?? null,
          ...upcomingClips,
        ].filter((clip): clip is VideoTimelineClip => !!clip);

        result[trackId] = clips.filter(
          (clip, index) =>
            clips.findIndex((candidate) => candidate.id === clip.id) === index,
        );
      }

      return result;
    }, [
      activeClipsByTrack,
      activeVisualClipsByTrack,
      displayTime,
      presentedVideoClipIds,
      videoClips,
      videoTrackIds,
    ]);

    const dissolvesByTrack = useMemo(() => {
      const result: Record<string, SameTrackDissolve | null> = {};
      for (const trackId of videoTrackIds) {
        result[trackId] = findSameTrackDissolve(
          videoClips,
          displayTime,
          trackId,
        );
      }
      return result;
    }, [displayTime, videoClips, videoTrackIds]);

    const programStackRanks = useMemo(
      () => programStackRankMap(videoClips, adjustmentLayers),
      [adjustmentLayers, videoClips],
    );

    const flatBufferedVideoClips = useMemo(() => {
      const byId = new Map<string, VideoTimelineClip>();
      for (const trackId of videoTrackIds) {
        for (const clip of bufferedClipsByTrack[trackId] ?? []) {
          byId.set(clip.id, clip);
        }
      }
      return [...byId.values()].sort(
        (a, b) =>
          effectiveVideoLayer(a) - effectiveVideoLayer(b) ||
          a.timelineStart - b.timelineStart ||
          a.id.localeCompare(b.id),
      );
    }, [bufferedClipsByTrack, videoTrackIds]);

    const previewSourceForClip = (clip: VideoTimelineClip) => {
      const existing = latchedPreviewSourceByClipRef.current[clip.id];
      const proxyPath = proxyPathsBySource[clip.sourcePath];

      if (!existing || existing.sourcePath !== clip.sourcePath) {
        const resolved = {
          sourcePath: clip.sourcePath,
          previewPath: proxyPath ?? clip.sourcePath,
          isProxy: Boolean(proxyPath),
        };
        latchedPreviewSourceByClipRef.current[clip.id] = resolved;
        return resolved;
      }

      if (!proxyPath || existing.previewPath === proxyPath) return existing;

      const activeNow = activeClipsByTrack[clip.trackId]?.id === clip.id;
      const presentedNow = Object.values(presentedVideoClipIds).includes(clip.id);
      const handoffPending = Object.values(handoffPendingByTrackRef.current).includes(
        clip.id,
      );
      const secondsUntilStart = clip.timelineStart - displayTime;
      const existingVideo = videoRefsByClipId.current[clip.id] ?? null;
      const existingDecoderReady =
        videoReadyByClipIdRef.current[clip.id] === true &&
        !!existingVideo &&
        existingVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        !existingVideo.seeking;
      const preserveReadyDecoderNearCut =
        existingDecoderReady &&
        secondsUntilStart >= 0 &&
        secondsUntilStart < PROXY_PROMOTION_GUARD_SECONDS;

      // Swapping src is safe while a clip is only a background buffer. Never
      // tear down a decoder that is visible/in a handoff, and preserve a ready
      // original if the cut is imminent. If the original is still cold, the
      // completed proxy is the better recovery path even inside the guard.
      if (
        activeNow ||
        presentedNow ||
        handoffPending ||
        preserveReadyDecoderNearCut
      ) {
        return existing;
      }

      const promoted = {
        sourcePath: clip.sourcePath,
        previewPath: proxyPath,
        isProxy: true,
      };
      latchedPreviewSourceByClipRef.current[clip.id] = promoted;
      delete videoReadyByClipIdRef.current[clip.id];
      delete videoWarmStateByClipIdRef.current[clip.id];
      delete videoWarmPaintedByClipIdRef.current[clip.id];
      delete videoNearCutRefreshedByClipIdRef.current[clip.id];
      traceCut("preview-proxy-promote", {
        clipId: clip.id,
        sourcePath: clip.sourcePath,
        proxyPath,
        secondsUntilStart,
      });
      return promoted;
    };

    const audioSourcesByTrack = useMemo(() => {
      const result: Record<string, string | null> = {};
      for (const audioTrackId of audioTrackIds) {
        const linkedVideoTrackId = trackSettings[audioTrackId]?.linkedTrackId;
        if (linkedVideoTrackId && /^video-\d+$/.test(linkedVideoTrackId)) {
          result[audioTrackId] =
            activeClipsByTrack[linkedVideoTrackId]?.sourcePath ?? null;
        } else {
          result[audioTrackId] =
            findActiveAudioClip(audioClips, displayTime, audioTrackId)
              ?.sourcePath ?? null;
        }
      }
      return result;
    }, [
      activeClipsByTrack,
      audioClips,
      audioTrackIds,
      displayTime,
      trackSettings,
    ]);

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
        current && !interactiveVideoClipIdSet.has(current.clipId)
          ? null
          : current,
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

    const videoElementForTrack = (
      trackId: VideoTrackId,
      timelineTime = displayTimeRef.current,
    ) => {
      const activeClip = findActiveVideoClip(
        videoClipsRef.current,
        timelineTime,
        trackId,
      );

      return activeClip
        ? (videoRefsByClipId.current[activeClip.id] ?? null)
        : null;
    };

    const audioPlaybackKeyForTrack = (
      trackId: AudioTrackId,
      timelineTime = displayTimeRef.current,
    ) => {
      const linkedVideoTrackId =
        trackSettingsRef.current[trackId]?.linkedTrackId;
      const linkedVideoClip =
        linkedVideoTrackId && /^video-\d+$/.test(linkedVideoTrackId)
          ? findActiveVideoClip(
              videoClipsRef.current,
              timelineTime,
              linkedVideoTrackId,
            )
          : null;

      if (linkedVideoClip) return `video:${linkedVideoClip.id}`;

      const standaloneClip = findActiveAudioClip(
        audioClipsRef.current,
        timelineTime,
        trackId,
      );
      return standaloneClip ? `audio:${standaloneClip.id}` : null;
    };

    const audioElementForTrack = (
      trackId: AudioTrackId,
      timelineTime = displayTimeRef.current,
    ) => {
      const playbackKey = audioPlaybackKeyForTrack(trackId, timelineTime);
      return playbackKey
        ? (audioRefsByPlaybackKey.current[playbackKey] ?? null)
        : null;
    };


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

      if (!dissolve) return false;

      const pairs = [
        {
          element: videoRefsByClipId.current[dissolve.outgoing.id] ?? null,
          clip: dissolve.outgoing,
          gain: 1 - dissolve.progress,
        },
        {
          element: videoRefsByClipId.current[dissolve.incoming.id] ?? null,
          clip: dissolve.incoming,
          gain: dissolve.progress,
        },
      ];

      for (const { element, clip, gain } of pairs) {
        if (!element || element.dataset.sourcePath !== clip.sourcePath) continue;

        const rawSourceTime = timelineTimeToSourceTime(clip, timelineTime);
        const sourceMin = Math.min(clip.sourceIn, clip.sourceOut);
        const sourceMax = Math.max(clip.sourceIn, clip.sourceOut);
        const safeSourceTime = Math.max(
          sourceMin,
          Math.min(sourceMax, rawSourceTime),
        );

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
        configureVideoElementAudio(element, clip, trackId, timelineTime);
        if (!element.muted) element.volume *= Math.max(0, Math.min(1, gain));

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

      activeVideoClipIdRefs.current[trackId] =
        dissolve.progress >= 0.5 ? dissolve.incoming.id : dissolve.outgoing.id;
      setVideoVisibility((current) =>
        current[trackId] ? current : { ...current, [trackId]: true },
      );
      return true;
    };

    const linkedAudioTrackForVideoTrack = (
      videoTrackId: VideoTrackId,
    ): AudioTrackId | null =>
      (audioTrackIdsRef.current.find(
        (audioTrackId) =>
          trackSettingsRef.current[audioTrackId]?.deleted !== true &&
          trackSettingsRef.current[audioTrackId]?.linkedTrackId ===
            videoTrackId,
      ) as AudioTrackId | undefined) ?? null;

    const configureVideoElementAudio = (
      video: HTMLVideoElement,
      clip: VideoTimelineClip,
      videoTrackId: VideoTrackId,
      timelineTime: number,
    ) => {
      const audioTrackId = linkedAudioTrackForVideoTrack(videoTrackId);

      // Normal forward linked clips use the visible video element's own audio.
      // That makes picture + sound share one decoder/media clock instead of
      // trying to synchronize separate <video> and <audio> elements.
      if (
        !audioTrackId ||
        isFreezeFrameClip(clip) ||
        isReverseVideoClip(clip)
      ) {
        video.muted = true;
        video.volume = 0;
        if (audioOwnerByTrackRef.current[videoTrackId] === clip.id) {
          traceCut("audio-owner-change", {
            trackId: videoTrackId,
            from: clip.id,
            to: null,
            timelineTime,
          });
          audioOwnerByTrackRef.current[videoTrackId] = null;
        }
        return;
      }

      video.muted = false;

      const trackMuted = isTrackMuted(
        trackSettingsRef.current,
        audioTrackId,
      );
      const soloMuted =
        hasSoloAudioTrack(trackSettingsRef.current) &&
        trackSettingsRef.current[audioTrackId]?.solo !== true;
      const clipMuted = clip.audioMuted ?? false;

      const clipDuration = Math.max(
        0.001,
        clip.timelineEnd - clip.timelineStart,
      );
      const fadeInDuration = Math.max(
        0,
        Math.min(clip.audioFadeInDuration ?? 0, clipDuration),
      );
      const fadeOutDuration = Math.max(
        0,
        Math.min(clip.audioFadeOutDuration ?? 0, clipDuration),
      );
      const localTime = Math.max(0, timelineTime - clip.timelineStart);
      const timeToEnd = Math.max(0, clip.timelineEnd - timelineTime);
      const fadeInGain =
        fadeInDuration > 0 ? Math.min(1, localTime / fadeInDuration) : 1;
      const fadeOutGain =
        fadeOutDuration > 0 ? Math.min(1, timeToEnd / fadeOutDuration) : 1;
      const fadeGain = Math.max(0, Math.min(1, fadeInGain, fadeOutGain));
      const volumePercent = clip.audioVolume ?? 100;
      const gain =
        trackMuted || soloMuted || clipMuted
          ? 0
          : (Math.max(0, Math.min(100, volumePercent)) / 100) * fadeGain;

      video.volume = Math.max(0, Math.min(1, gain));
      video.preservesPitch = true;

      const previousOwner = audioOwnerByTrackRef.current[videoTrackId] ?? null;
      if (previousOwner !== clip.id) {
        traceCut("audio-owner-change", {
          trackId: videoTrackId,
          from: previousOwner,
          to: clip.id,
          timelineTime,
          gain: video.volume,
        });
        audioOwnerByTrackRef.current[videoTrackId] = clip.id;
      }
    };

    const setPresentedVideoClip = (
      trackId: VideoTrackId,
      clipId: string | null,
    ) => {
      if (presentedVideoClipIdsRef.current[trackId] === clipId) {
        return;
      }

      presentedVideoClipIdsRef.current[trackId] = clipId;
      setPresentedVideoClipIds((current) =>
        current[trackId] === clipId
          ? current
          : { ...current, [trackId]: clipId },
      );
    };

    const primeBufferedVideoClip = (
      trackId: VideoTrackId,
      clipId: string,
    ) => {
      const video = videoRefsByClipId.current[clipId] ?? null;
      const clip =
        videoClipsRef.current.find((candidate) => candidate.id === clipId) ??
        null;

      if (!video || !clip || video.readyState < HTMLMediaElement.HAVE_METADATA) {
        return;
      }

      const activeVisualClips = findActiveVideoClips(
        videoClipsRef.current,
        displayTimeRef.current,
        trackId,
      );
      if (activeVisualClips.some((candidate) => candidate.id === clipId)) return;

      video.pause();
      video.muted = true;
      video.volume = 0;

      const targetTime = timelineTimeToSourceTime(
        clip,
        Math.max(clip.timelineStart, clip.timelineStart + 0.0001),
      );
      const maxSourceTime = Number.isFinite(video.duration)
        ? video.duration
        : (clip.sourceDuration ?? targetTime);
      const safeTargetTime = Math.max(
        0,
        Math.min(maxSourceTime || targetTime, targetTime),
      );

      if (Math.abs(video.currentTime - safeTargetTime) > 0.01) {
        videoReadyByClipIdRef.current[clipId] = false;
        delete videoWarmStateByClipIdRef.current[clipId];
        delete videoWarmPaintedByClipIdRef.current[clipId];
        try {
          video.currentTime = safeTargetTime;
        } catch (error) {
          console.error(`${trackId} preload seek failed:`, error);
        }
      } else if (
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        !video.seeking
      ) {
        videoReadyByClipIdRef.current[clipId] = true;
        warmBufferedVideoClip(trackId, clipId);
      }
    };

    const warmBufferedVideoClip = (
      trackId: VideoTrackId,
      clipId: string,
    ) => {
      const video = videoRefsByClipId.current[clipId] ?? null;
      const clip =
        videoClipsRef.current.find((candidate) => candidate.id === clipId) ??
        null;
      if (
        !video ||
        !clip ||
        isFreezeFrameClip(clip) ||
        isReverseVideoClip(clip) ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        video.seeking
      ) {
        return;
      }

      const timelineTime = isPlayingRef.current
        ? currentTimeRef.current
        : displayTimeRef.current;
      const activeVisualClips = findActiveVideoClips(
        videoClipsRef.current,
        timelineTime,
        trackId,
      );
      if (activeVisualClips.some((candidate) => candidate.id === clipId)) {
        delete videoNearCutRefreshedByClipIdRef.current[clipId];
        return;
      }

      const warmState = videoWarmStateByClipIdRef.current[clipId];
      const secondsUntilStart = clip.timelineStart - timelineTime;
      const shouldRefreshNearCut =
        isPlayingRef.current &&
        warmState === "warmed" &&
        secondsUntilStart > 0 &&
        secondsUntilStart <= PREWARM_NEAR_CUT_REFRESH_SECONDS &&
        videoNearCutRefreshedByClipIdRef.current[clipId] !== true;

      if (warmState && !shouldRefreshNearCut) return;

      const targetTime = timelineTimeToSourceTime(
        clip,
        Math.max(clip.timelineStart, clip.timelineStart + 0.0001),
      );
      const maxSourceTime = Number.isFinite(video.duration)
        ? video.duration
        : (clip.sourceDuration ?? targetTime);
      const safeTargetTime = Math.max(
        0,
        Math.min(maxSourceTime || targetTime, targetTime),
      );

      if (shouldRefreshNearCut) {
        videoNearCutRefreshedByClipIdRef.current[clipId] = true;
        delete videoWarmStateByClipIdRef.current[clipId];
        delete videoWarmPaintedByClipIdRef.current[clipId];
        video.pause();
        video.muted = true;
        video.volume = 0;

        const sourceDrift = Math.abs(video.currentTime - safeTargetTime);
        traceCut("near-cut-rewarm", {
          trackId,
          clipId,
          secondsUntilStart,
          sourceDrift,
          readyState: video.readyState,
          seeking: video.seeking,
        });

        // The earlier warm normally leaves the deck on its first decoded frame.
        // Rewind that tiny drift before the final near-cut pulse so the pulse
        // can wake the decoder/compositor without moving the logical source-in.
        if (sourceDrift > PREWARM_REWIND_TOLERANCE_SECONDS) {
          videoReadyByClipIdRef.current[clipId] = false;
          try {
            video.currentTime = safeTargetTime;
            return;
          } catch (error) {
            console.error(`${trackId} near-cut prewarm rewind failed:`, error);
          }
        }
      }

      // Warm exactly one decoded/composited frame. The old timer-based warm-up
      // played for 60 ms and then sought back to source-in, which could put the
      // incoming deck back into SEEKING immediately before the edit point.
      // requestVideoFrameCallback is safe here because transport never waits on
      // it; it only tells us that this hidden, *playing* deck has actually
      // painted a frame and can be revealed instantly later.
      videoWarmStateByClipIdRef.current[clipId] = "warming";
      videoWarmPaintedByClipIdRef.current[clipId] = false;
      video.muted = true;
      video.volume = 0;
      video.preservesPitch = true;

      let finished = false;
      let fallbackTimer: number | null = null;
      const warmStartedAt = performance.now();

      const finishWarm = (painted: boolean) => {
        if (finished) return;
        finished = true;
        if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);

        const currentVideo = videoRefsByClipId.current[clipId] ?? null;
        if (!currentVideo) {
          delete videoWarmStateByClipIdRef.current[clipId];
          delete videoWarmPaintedByClipIdRef.current[clipId];
          return;
        }

        const nowTimeline = isPlayingRef.current
          ? currentTimeRef.current
          : displayTimeRef.current;
        const nowActiveVisuals = findActiveVideoClips(
          videoClipsRef.current,
          nowTimeline,
          trackId,
        );
        if (nowActiveVisuals.some((candidate) => candidate.id === clipId)) {
          videoWarmStateByClipIdRef.current[clipId] = "warmed";
          videoWarmPaintedByClipIdRef.current[clipId] = painted;
          syncVideoTrackToTimeline(
            trackId,
            nowTimeline,
            isPlayingRef.current,
            false,
          );
          syncSupplementalVideoLayers(
            trackId,
            nowTimeline,
            isPlayingRef.current,
            false,
          );
          return;
        }

        currentVideo.pause();
        const sourceDrift = Math.abs(currentVideo.currentTime - safeTargetTime);
        traceCut("prewarm-ready", {
          trackId,
          clipId,
          ms: performance.now() - warmStartedAt,
          painted,
          nearCutRefresh: shouldRefreshNearCut,
          mediaTime: currentVideo.currentTime,
          sourceDrift,
          readyState: currentVideo.readyState,
        });
        if (
          currentVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          !currentVideo.seeking &&
          sourceDrift <= PREWARM_MAX_SOURCE_DRIFT_SECONDS
        ) {
          videoReadyByClipIdRef.current[clipId] = true;
          videoWarmStateByClipIdRef.current[clipId] = "warmed";
          videoWarmPaintedByClipIdRef.current[clipId] = painted;
          return;
        }

        // Only reset when the warm-up genuinely ran too far. This is an
        // exceptional fallback, not the normal path; seeked/canplay will prime
        // the deck again afterward.
        delete videoWarmStateByClipIdRef.current[clipId];
        delete videoWarmPaintedByClipIdRef.current[clipId];
        videoReadyByClipIdRef.current[clipId] = false;
        try {
          currentVideo.currentTime = safeTargetTime;
        } catch (error) {
          console.error(`${trackId} prewarm reset failed:`, error);
        }
      };

      type WarmFrameVideo = HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      };
      const frameVideo = video as WarmFrameVideo;

      if (typeof frameVideo.requestVideoFrameCallback === "function") {
        frameVideo.requestVideoFrameCallback(() => finishWarm(true));
        // Do not call a readyState-only timeout a "painted" warm frame. The
        // old 42 ms fallback could fire long before WebKit produced a frame,
        // making the cut logic reveal a deck that was technically buffered but
        // whose compositor still needed ~200-300 ms to wake up. Let rVFC prove
        // the first frame instead and only give up after a generous timeout.
        fallbackTimer = window.setTimeout(
          () => finishWarm(false),
          PREWARM_FRAME_FALLBACK_MS,
        );
      } else {
        fallbackTimer = window.setTimeout(() => {
          const currentVideo = videoRefsByClipId.current[clipId] ?? null;
          finishWarm(
            !!currentVideo &&
              currentVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
              !currentVideo.seeking,
          );
        }, PREWARM_NO_RVFC_DELAY_MS);
      }

      void video.play().catch((error) => {
        if (finished) return;
        finished = true;
        if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
        delete videoWarmStateByClipIdRef.current[clipId];
        delete videoWarmPaintedByClipIdRef.current[clipId];
        console.error(`${trackId} prewarm playback failed:`, error);
      });
    };

    const markBufferedVideoReady = (
      trackId: VideoTrackId,
      clipId: string,
    ) => {
      const video = videoRefsByClipId.current[clipId] ?? null;
      if (
        !video ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        video.seeking
      ) {
        return;
      }

      videoReadyByClipIdRef.current[clipId] = true;
      const timelineTime =
        skimPreviewTimeRef.current ??
        (isPlayingRef.current ? currentTimeRef.current : displayTimeRef.current);
      const activeClip = findActiveVideoClip(
        videoClipsRef.current,
        timelineTime,
        trackId,
      );
      const activeVisualClips = findActiveVideoClips(
        videoClipsRef.current,
        timelineTime,
        trackId,
      );

      if (activeVisualClips.some((candidate) => candidate.id === clipId)) {
        syncVideoTrackToTimeline(
          trackId,
          timelineTime,
          isPlayingRef.current,
          false,
        );
        syncSupplementalVideoLayers(
          trackId,
          timelineTime,
          isPlayingRef.current,
          false,
        );
      } else {
        const immediateUpcoming = findUpcomingVideoClips(
          videoClipsRef.current,
          timelineTime,
          trackId,
          activeClip,
          1,
        )[0];
        if (immediateUpcoming?.id === clipId) {
          warmBufferedVideoClip(trackId, clipId);
        }
      }
    };

    const handleMediaRebuild = (clipId: string, reason: string) => {
      const clip = videoClipsRef.current.find((item) => item.id === clipId);
      if (!clip) return;

      const element = videoRefsByClipId.current[clipId] ?? null;
      element?.pause();
      delete latchedPreviewSourceByClipRef.current[clip.id];
      delete videoReadyByClipIdRef.current[clipId];
      delete videoWarmStateByClipIdRef.current[clipId];
      delete videoWarmPaintedByClipIdRef.current[clipId];
      delete videoNearCutRefreshedByClipIdRef.current[clipId];

      console.warn(`Rebuilding Program media ${clipId} after ${reason}.`);
    };

    const {
      epochs: mediaEpochByClipId,
      report: reportMedia,
      failedIds: failedMediaIds,
    } = useMediaSupervisor({
        getElements: () => {
          const timelineTime = currentTimeRef.current;
          const activeIds = new Set<string>();

          for (const trackId of videoTrackIdsRef.current) {
            if (isTrackHidden(trackSettingsRef.current, trackId)) continue;
            const activeClip = findActiveVideoClip(
              videoClipsRef.current,
              timelineTime,
              trackId,
            );
            if (activeClip) activeIds.add(activeClip.id);
          }

          return Object.entries(videoRefsByClipId.current).map(
            ([clipId, element]) => {
              const clip = videoClipsRef.current.find(
                (candidate) => candidate.id === clipId,
              );
              return {
                id: clipId,
                element,
                active: activeIds.has(clipId),
                shouldAdvance:
                  !!clip &&
                  !isFreezeFrameClip(clip) &&
                  !isReverseVideoClip(clip),
              };
            },
          );
        },
        isPlaying: () => isPlayingRef.current,
        getClock: () => ({
          time: currentTimeRef.current,
          resync: () => {
            const timelineTime = currentTimeRef.current;
            playbackAnchorTimelineRef.current = timelineTime;
            playbackAnchorPerformanceRef.current = performance.now();
            syncAllMediaToTimelineRef.current(
              timelineTime,
              isPlayingRef.current,
              true,
            );
          },
        }),
        onRebuild: handleMediaRebuild,
      });

    useEffect(() => {
      failedMediaIdsRef.current = failedMediaIds;
    }, [failedMediaIds]);

    const commitVisualHandoff = (trackId: VideoTrackId, clipId: string) => {
      if (handoffPendingByTrackRef.current[trackId] !== clipId) return;
      const previousPresentedClipId = presentedVideoClipIdsRef.current[trackId] ?? null;
      const incomingClip = videoClipsRef.current.find(
        (candidate) => candidate.id === clipId,
      );
      const incomingVideo = videoRefsByClipId.current[clipId] ?? null;
      const timelineTime = currentTimeRef.current;
      const expectedSourceTime = incomingClip
        ? timelineTimeToSourceTime(incomingClip, timelineTime)
        : null;

      traceCut("promote", {
        trackId,
        clipId,
        previousPresentedClipId,
        readyState: incomingVideo?.readyState ?? null,
        seeking: incomingVideo?.seeking ?? null,
        mediaTime: incomingVideo?.currentTime ?? null,
        expectedSourceTime,
        isPlaying: isPlayingRef.current,
        warmState: videoWarmStateByClipIdRef.current[clipId] ?? null,
        warmPainted: videoWarmPaintedByClipIdRef.current[clipId] ?? false,
      });

      if (incomingVideo) {
        const requestFrame = (incomingVideo as HTMLVideoElement & {
          requestVideoFrameCallback?: (
            callback: (now: number, metadata: { mediaTime: number }) => void,
          ) => number;
        }).requestVideoFrameCallback;
        if (requestFrame) {
          const startedAt = performance.now();
          requestFrame.call(incomingVideo, (_now, metadata) => {
            traceCut("first-frame-after-promote", {
              clipId,
              trackId,
              ms: performance.now() - startedAt,
              mediaTime: metadata.mediaTime,
            });
          });
        }
      }
      handoffPendingByTrackRef.current[trackId] = undefined;
      const timeoutId = handoffTimeoutByTrackRef.current[trackId];
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      handoffTimeoutByTrackRef.current[trackId] = undefined;

      setPresentedVideoClip(trackId, clipId);
      setVideoVisibility((current) =>
        current[trackId] ? current : { ...current, [trackId]: true },
      );

      if (previousPresentedClipId && previousPresentedClipId !== clipId) {
        const previous = videoRefsByClipId.current[previousPresentedClipId];
        previous?.pause();
        if (previous) {
          previous.muted = true;
          previous.volume = 0;
        }
      }
    };

    const scheduleVisualHandoff = (
      trackId: VideoTrackId,
      clipId: string,
      video: HTMLVideoElement,
      revealImmediately = false,
    ) => {
      if (handoffPendingByTrackRef.current[trackId] === clipId) return;
      handoffPendingByTrackRef.current[trackId] = clipId;

      // If prewarm already proved that this deck produced a composited frame,
      // there is nothing left to wait for at the edit point. Revealing it in
      // this same transport tick removes the last held-frame hitch between
      // ordinary adjacent clips.
      if (revealImmediately) {
        commitVisualHandoff(trackId, clipId);
        return;
      }

      const fallback = window.setTimeout(
        () => commitVisualHandoff(trackId, clipId),
        120,
      );
      handoffTimeoutByTrackRef.current[trackId] = fallback;

      type FrameVideo = HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      };
      const frameVideo = video as FrameVideo;
      if (typeof frameVideo.requestVideoFrameCallback === "function") {
        frameVideo.requestVideoFrameCallback(() =>
          commitVisualHandoff(trackId, clipId),
        );
      } else {
        requestAnimationFrame(() => commitVisualHandoff(trackId, clipId));
      }
    };

    const syncVideoTrackToTimeline = (
      trackId: VideoTrackId,
      timelineTime: number,
      shouldPlay: boolean,
      forceSeek = false,
    ) => {
      const video = videoElementForTrack(trackId, timelineTime);
      const activeClip = findActiveVideoClip(
        videoClipsRef.current,
        timelineTime,
        trackId,
      );
      const hasTrueDissolve =
        findSameTrackDissolve(videoClipsRef.current, timelineTime, trackId) !==
        null;

      if (hasTrueDissolve) {
        // The dissolve reuses the ordinary clip-owned media decks. Never hide
        // or replace them with cold-mounted transition-specific <video>s.
        setVideoVisibility((current) =>
          current[trackId] ? current : { ...current, [trackId]: true },
        );
        return;
      }

      if (!activeClip) {
        activeVideoClipIdRefs.current[trackId] = null;
        video?.pause();
        setPresentedVideoClip(trackId, null);
        setVideoVisibility((current) =>
          current[trackId] ? { ...current, [trackId]: false } : current,
        );
        return;
      }

      // Once the clip has actually crossed its edit point, allow a fresh
      // near-cut warm-up the next time transport comes around to this cut.
      delete videoNearCutRefreshedByClipIdRef.current[activeClip.id];

      if (!video) {
        // On an explicit jump React may not have mounted the destination clip's
        // media element yet. Keep the last decoded frame on screen instead of
        // clearing the Program Monitor; metadata/seek callbacks will take over
        // as soon as the destination element exists.
        activeVideoClipIdRefs.current[trackId] = null;
        return;
      }

      const loadedSourcePath = video.dataset.sourcePath ?? "";
      const hidden = isTrackHidden(trackSettingsRef.current, trackId);

      if (activeClip.sourcePath !== loadedSourcePath) {
        activeVideoClipIdRefs.current[trackId] = null;
        video.pause();
        return;
      }

      if (hidden) {
        activeVideoClipIdRefs.current[trackId] = null;
        video.pause();
        setPresentedVideoClip(trackId, null);
        setVideoVisibility((current) =>
          current[trackId] ? { ...current, [trackId]: false } : current,
        );
        return;
      }

      const expectedSourceTime = timelineTimeToSourceTime(
        activeClip,
        timelineTime,
      );
      const mediaMax = Number.isFinite(video.duration)
        ? video.duration
        : (activeClip.sourceDuration ?? sourceDurationRef.current);
      const sourceMin = Math.max(0, Math.min(activeClip.sourceIn, activeClip.sourceOut));
      const sourceMax = Math.min(
        mediaMax || Math.max(activeClip.sourceIn, activeClip.sourceOut),
        Math.max(activeClip.sourceIn, activeClip.sourceOut),
      );
      const safeSourceTime = Math.max(
        sourceMin,
        Math.min(sourceMax, expectedSourceTime),
      );
      const previousActiveClipId = activeVideoClipIdRefs.current[trackId];
      const clipChanged = previousActiveClipId !== activeClip.id;
      const sourceTimeDrift = Math.abs(video.currentTime - safeSourceTime);
      const prebufferedFrameReady =
        videoReadyByClipIdRef.current[activeClip.id] === true;
      const clipChangeSeekThreshold = prebufferedFrameReady ? 0.05 : 0.015;
      const shouldSeek =
        forceSeek
          ? sourceTimeDrift > 0.015
          : clipChanged && sourceTimeDrift > clipChangeSeekThreshold;

      if (shouldSeek) {
        videoReadyByClipIdRef.current[activeClip.id] = false;
        delete videoWarmStateByClipIdRef.current[activeClip.id];
        delete videoWarmPaintedByClipIdRef.current[activeClip.id];
        try {
          video.currentTime = safeSourceTime;
        } catch (error) {
          console.error(`${trackId} seek failed:`, error);
        }
      }

      const frameReady =
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        !video.seeking &&
        ((!forceSeek && !clipChanged) ||
          Math.abs(video.currentTime - safeSourceTime) <=
            (forceSeek ? 0.03 : 0.09));
      const previousPresentedClipId =
        presentedVideoClipIdsRef.current[trackId] ?? null;

      if (!frameReady) {
        const presentedClipId =
          presentedVideoClipIdsRef.current[trackId] ?? null;
        const presentedVideo = presentedClipId
          ? (videoRefsByClipId.current[presentedClipId] ?? null)
          : null;

        // Hold the outgoing decoded frame instead of exposing the Program
        // Monitor's black background while the incoming clip finishes its seek.
        presentedVideo?.pause();
        if (shouldPlay && !isFreezeFrameClip(activeClip) && !isReverseVideoClip(activeClip)) {
          video.muted = true;
          video.volume = 0;
          if (video.paused && !video.seeking) {
            void video.play().catch(() => undefined);
          }
        } else if (!video.paused) {
          video.pause();
        }

        setVideoVisibility((current) =>
          current[trackId] ? current : { ...current, [trackId]: true },
        );
        return;
      }

      videoReadyByClipIdRef.current[activeClip.id] = true;
      activeVideoClipIdRefs.current[trackId] = activeClip.id;
      syncHighSpeedVideoPreview(
        video,
        activeClip,
        safeSourceTime,
        `${trackId}:${activeClip.id}`,
        shouldSeek,
      );
      configureVideoElementAudio(video, activeClip, trackId, timelineTime);

      const immediateUpcoming = findUpcomingVideoClips(
        videoClipsRef.current,
        timelineTime,
        trackId,
        activeClip,
        1,
      )[0];
      if (
        immediateUpcoming &&
        videoReadyByClipIdRef.current[immediateUpcoming.id] === true
      ) {
        warmBufferedVideoClip(trackId, immediateUpcoming.id);
      }

      const seekDrivenPlayback =
        isFreezeFrameClip(activeClip) || isReverseVideoClip(activeClip);
      const needsVisualHandoff =
        shouldPlay &&
        !seekDrivenPlayback &&
        previousPresentedClipId !== null &&
        previousPresentedClipId !== activeClip.id;

      if (needsVisualHandoff) {
        // Freeze the outgoing picture/audio at the logical edit point while the
        // incoming deck starts underneath it. This prevents a trimmed outgoing
        // clip from continuing to play (and briefly overlapping audio) during
        // the visual rVFC handoff window.
        const previousVideo = previousPresentedClipId
          ? (videoRefsByClipId.current[previousPresentedClipId] ?? null)
          : null;
        if (previousVideo && previousVideo !== video) {
          previousVideo.pause();
          previousVideo.muted = true;
          previousVideo.volume = 0;
        }

        // Start decoding/playing the incoming clip underneath the held outgoing
        // frame. The transport never waits on rVFC; it only controls the visual
        // swap, with a bounded fallback for WebKit.
        const canRevealWarmFrameImmediately =
          videoWarmStateByClipIdRef.current[activeClip.id] === "warmed" &&
          videoWarmPaintedByClipIdRef.current[activeClip.id] === true &&
          videoReadyByClipIdRef.current[activeClip.id] === true &&
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          !video.seeking;

        if (video.paused) {
          void video.play().catch((error) => {
            console.error(`${trackId} handoff playback failed:`, error);
          });
        }
        scheduleVisualHandoff(
          trackId,
          activeClip.id,
          video,
          canRevealWarmFrameImmediately,
        );
        setVideoVisibility((current) =>
          current[trackId] ? current : { ...current, [trackId]: true },
        );
        return;
      }

      setPresentedVideoClip(trackId, activeClip.id);
      setVideoVisibility((current) =>
        current[trackId] ? current : { ...current, [trackId]: true },
      );

      if (previousPresentedClipId && previousPresentedClipId !== activeClip.id) {
        const previousVideo = videoRefsByClipId.current[previousPresentedClipId] ?? null;
        previousVideo?.pause();
      }

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

    const syncSupplementalVideoLayers = (
      trackId: VideoTrackId,
      timelineTime: number,
      shouldPlay: boolean,
      forceSeek = false,
    ) => {
      const activeVisuals = findActiveVideoClips(
        videoClipsRef.current,
        timelineTime,
        trackId,
      );
      const primary = activeVisuals[activeVisuals.length - 1] ?? null;
      const nextSupplementalIds = new Set<string>();

      for (const clip of activeVisuals) {
        if (clip.id === primary?.id) continue;

        const video = videoRefsByClipId.current[clip.id] ?? null;
        if (
          !video ||
          video.dataset.sourcePath !== clip.sourcePath ||
          video.readyState < HTMLMediaElement.HAVE_METADATA ||
          isTrackHidden(trackSettingsRef.current, trackId)
        ) {
          continue;
        }

        nextSupplementalIds.add(clip.id);
        video.muted = true;
        video.volume = 0;
        video.preservesPitch = true;

        const expectedSourceTime = timelineTimeToSourceTime(clip, timelineTime);
        const mediaMax = Number.isFinite(video.duration)
          ? video.duration
          : (clip.sourceDuration ?? Math.max(clip.sourceIn, clip.sourceOut));
        const sourceMin = Math.max(0, Math.min(clip.sourceIn, clip.sourceOut));
        const sourceMax = Math.min(
          mediaMax || Math.max(clip.sourceIn, clip.sourceOut),
          Math.max(clip.sourceIn, clip.sourceOut),
        );
        const safeSourceTime = Math.max(
          sourceMin,
          Math.min(sourceMax, expectedSourceTime),
        );
        const seekDriven =
          isFreezeFrameClip(clip) || isReverseVideoClip(clip);
        const drift = Math.abs(video.currentTime - safeSourceTime);
        const shouldSeek =
          seekDriven || forceSeek || drift > (shouldPlay ? 0.12 : 0.025);

        if (shouldSeek && !video.seeking) {
          try {
            video.currentTime = safeSourceTime;
          } catch (error) {
            console.error(`${trackId} supplemental seek failed:`, error);
          }
        }

        if (seekDriven) {
          if (!video.paused) video.pause();
          continue;
        }

        video.playbackRate = videoPreviewPlaybackRate(
          clip,
          video.dataset.previewProxy === "true",
        );

        if (shouldPlay) {
          if (video.paused && !video.seeking) {
            void video.play().catch((error) => {
              console.error(`${trackId} supplemental playback failed:`, error);
            });
          }
        } else if (!video.paused) {
          video.pause();
        }
      }

      for (const clipId of supplementalPlayingClipIdsRef.current) {
        if (nextSupplementalIds.has(clipId)) continue;
        const video = videoRefsByClipId.current[clipId] ?? null;
        if (video && !video.paused) video.pause();
      }

      supplementalPlayingClipIdsRef.current = nextSupplementalIds;
    };

    const syncAudioTrackToTimeline = (
      audioTrackId: AudioTrackId,
      timelineTime: number,
      shouldPlay: boolean,
      forceSeek = false,
    ) => {
      const audio = audioElementForTrack(audioTrackId, timelineTime);
      const linkedVideoTrackId =
        trackSettingsRef.current[audioTrackId]?.linkedTrackId;
      const linkedVideoClip =
        linkedVideoTrackId && /^video-\d+$/.test(linkedVideoTrackId)
          ? findActiveVideoClip(
              videoClipsRef.current,
              timelineTime,
              linkedVideoTrackId,
            )
          : null;
      const standaloneClip = linkedVideoClip
        ? null
        : findActiveAudioClip(
            audioClipsRef.current,
            timelineTime,
            audioTrackId,
          );
      const activeClip = linkedVideoClip ?? standaloneClip;

      const visibleLinkedVideoOwnsAudio =
        linkedVideoClip !== null &&
        typeof linkedVideoTrackId === "string" &&
        /^video-\d+$/.test(linkedVideoTrackId) &&
        !isTrackHidden(trackSettingsRef.current, linkedVideoTrackId) &&
        !isFreezeFrameClip(linkedVideoClip) &&
        !isReverseVideoClip(linkedVideoClip);

      if (visibleLinkedVideoOwnsAudio) {
        // The matching visible <video> element outputs this linked clip's
        // audio, so keep the duplicate hidden <audio> path stopped.
        activeAudioClipIdRefs.current[audioTrackId] = null;
        audio?.pause();
        return;
      }

      if (
        !audio ||
        !activeClip ||
        trackSettingsRef.current[audioTrackId]?.deleted
      ) {
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

      const expectedSourceTime = timelineTimeToSourceTime(
        activeClip,
        timelineTime,
      );
      const maxSourceTime = Number.isFinite(audio.duration)
        ? audio.duration
        : (activeClip.sourceDuration ?? activeClip.sourceOut);
      const safeSourceTime = Math.max(
        0,
        Math.min(maxSourceTime || expectedSourceTime, expectedSourceTime),
      );
      const clipChanged =
        activeAudioClipIdRefs.current[audioTrackId] !== activeClip.id;
      const sourceTimeDrift = Math.abs(audio.currentTime - safeSourceTime);
      const shouldSeek = (clipChanged || forceSeek) && sourceTimeDrift > 0.015;
      if (shouldSeek) {
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
        ? isFreezeFrameClip(linkedVideoClip) ||
          isReverseVideoClip(linkedVideoClip)
        : false;
      const clipMuted = linkedVideoClip
        ? (linkedVideoClip.audioMuted ?? false) || specialVideoPlaybackMuted
        : (standaloneClip?.muted ?? false);
      const clipDuration = Math.max(
        0.001,
        activeClip.timelineEnd - activeClip.timelineStart,
      );
      const fadeInDuration = Math.max(
        0,
        Math.min(
          linkedVideoClip
            ? (linkedVideoClip.audioFadeInDuration ?? 0)
            : (standaloneClip?.fadeInDuration ?? 0),
          clipDuration,
        ),
      );
      const fadeOutDuration = Math.max(
        0,
        Math.min(
          linkedVideoClip
            ? (linkedVideoClip.audioFadeOutDuration ?? 0)
            : (standaloneClip?.fadeOutDuration ?? 0),
          clipDuration,
        ),
      );
      const localTime = Math.max(0, timelineTime - activeClip.timelineStart);
      const timeToEnd = Math.max(0, activeClip.timelineEnd - timelineTime);
      const fadeInGain =
        fadeInDuration > 0 ? Math.min(1, localTime / fadeInDuration) : 1;
      const fadeOutGain =
        fadeOutDuration > 0 ? Math.min(1, timeToEnd / fadeOutDuration) : 1;
      const fadeGain = Math.max(0, Math.min(1, fadeInGain, fadeOutGain));
      const volumePercent = linkedVideoClip
        ? (linkedVideoClip.audioVolume ?? 100)
        : (standaloneClip?.volume ?? 100);
      audio.volume = Math.max(
        0,
        Math.min(
          1,
          (Math.max(0, Math.min(100, volumePercent)) / 100) * fadeGain,
        ),
      );
      audio.muted = trackMuted || soloMuted || clipMuted;
      audio.playbackRate = linkedVideoClip
        ? videoPlaybackRate(linkedVideoClip)
        : 1;
      audio.preservesPitch = true;

      if (audio.muted) {
        activeAudioClipIdRefs.current[audioTrackId] = null;
        audio.pause();
        return;
      }

      activeAudioClipIdRefs.current[audioTrackId] = activeClip.id;
      if (shouldPlay) {
        if (audio.paused) {
          void audio
            .play()
            .catch((error) =>
              console.error(`${audioTrackId} playback failed:`, error),
            );
        }
      } else if (!audio.paused) {
        audio.pause();
      }
    };

    const blockingHardCut = (fromTime: number, toTime: number) => {
      let blocker: {
        trackId: VideoTrackId;
        clipId: string;
        cutTime: number;
        readyState: number | null;
        seeking: boolean | null;
      } | null = null;

      for (const trackId of videoTrackIdsRef.current) {
        if (isTrackHidden(trackSettingsRef.current, trackId)) continue;

        const clips = videoClipsRef.current
          .filter((clip) => clip.trackId === trackId)
          .sort((a, b) => a.timelineStart - b.timelineStart);

        for (let index = 1; index < clips.length; index += 1) {
          const previous = clips[index - 1];
          const incoming = clips[index];
          const gap = incoming.timelineStart - previous.timelineEnd;
          if (Math.abs(gap) > TIMELINE_GAP_BRIDGE_EPSILON) continue;

          const cutTime = incoming.timelineStart;
          if (
            cutTime < fromTime - TIMELINE_GAP_BRIDGE_EPSILON ||
            cutTime > toTime + TIMELINE_GAP_BRIDGE_EPSILON
          ) {
            continue;
          }

          if (failedMediaIdsRef.current[incoming.id]) continue;

          const video = videoRefsByClipId.current[incoming.id] ?? null;
          const hasDecodedFrame =
            videoReadyByClipIdRef.current[incoming.id] === true &&
            !!video &&
            video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            !video.seeking;
          if (hasDecodedFrame) continue;

          if (!blocker || cutTime < blocker.cutTime) {
            blocker = {
              trackId,
              clipId: incoming.id,
              cutTime,
              readyState: video?.readyState ?? null,
              seeking: video?.seeking ?? null,
            };
          }
        }
      }

      return blocker;
    };

    const syncAllMediaToTimeline = (
      timelineTime: number,
      shouldPlay: boolean,
      forceSeek = false,
    ) => {
      for (const trackId of videoTrackIdsRef.current) {
        syncVideoTrackToTimeline(trackId, timelineTime, shouldPlay, forceSeek);
        syncSupplementalVideoLayers(
          trackId,
          timelineTime,
          shouldPlay,
          forceSeek,
        );
        syncSameTrackDissolve(trackId, timelineTime, shouldPlay, forceSeek);
      }
      for (const audioTrackId of audioTrackIdsRef.current) {
        syncAudioTrackToTimeline(
          audioTrackId,
          timelineTime,
          shouldPlay,
          forceSeek,
        );
      }
    };

    // Keep the imperative skim path pointed at the current render's media
    // graph and track state.
    syncAllMediaToTimelineRef.current = syncAllMediaToTimeline;

    const seekTo = (time: number) => {
      if (lockedRef.current) return;
      if (!Number.isFinite(time)) return;

      skimPreviewTimeRef.current = null;
      setSkimPreviewTime(null);

      const maxDuration = Math.max(0, timelineDurationRef.current || 0);
      const nextTime = Math.max(0, Math.min(maxDuration, time));
      const shouldResume = isPlayingRef.current;
      cutHoldClipIdRef.current = null;
      displayTimeRef.current = nextTime;

      // A real seek is authoritative immediately. Media is repositioned once,
      // but no readiness event is allowed to hold the editor clock hostage.
      for (const element of Object.values(videoRefsByClipId.current)) {
        element?.pause();
      }
      for (const element of Object.values(audioRefsByPlaybackKey.current)) {
        element?.pause();
      }

      currentTimeRef.current = nextTime;
      playbackAnchorTimelineRef.current = nextTime;
      playbackAnchorPerformanceRef.current = performance.now();
      onTimeChangeRef.current?.(nextTime);
      syncAllMediaToTimeline(nextTime, shouldResume, true);

      if (shouldResume) {
        requestAnimationFrame(() => {
          if (!isPlayingRef.current) return;
          playbackAnchorTimelineRef.current = nextTime;
          playbackAnchorPerformanceRef.current = performance.now();
          syncAllMediaToTimelineRef.current(nextTime, true, false);
        });
      }
    };

    const jumpBy = (seconds: number) => {
      if (lockedRef.current) return;
      seekTo(currentTimeRef.current + seconds);
    };

    const pausePlayback = () => {
      if (!isPlayingRef.current) return;
      isPlayingRef.current = false;
      setIsPlaying(false);
      cutHoldClipIdRef.current = null;
      (Object.values(videoRefsByClipId.current) as Array<HTMLVideoElement | null>)
        .forEach((element) => element?.pause());
      (Object.values(audioRefsByPlaybackKey.current) as Array<HTMLAudioElement | null>)
        .forEach((element) => element?.pause());
    };

    const togglePlayPause = () => {
      if (lockedRef.current) return;
      if (isPlayingRef.current) {
        pausePlayback();
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
      skimPreviewTimeRef.current = null;
      setSkimPreviewTime(null);
      cutHoldClipIdRef.current = null;
      isPlayingRef.current = true;
      setIsPlaying(true);
      syncAllMediaToTimeline(playbackStart, true, true);
    };

    useEffect(() => {
      if (locked) pausePlayback();
    }, [locked]);

    useEffect(() => {
      setDuration(0);
      setIsPlaying(false);
      skimPreviewTimeRef.current = null;
      setSkimPreviewTime(null);
      setVideoVisibility({});

      (
        Object.values(
          videoRefsByClipId.current,
        ) as Array<HTMLVideoElement | null>
      ).forEach((element) => element?.pause());
      (
        Object.values(
          audioRefsByPlaybackKey.current,
        ) as Array<HTMLAudioElement | null>
      ).forEach((element) => element?.pause());

      isPlayingRef.current = false;
      currentTimeRef.current = 0;
      activeVideoClipIdRefs.current = {};
      activeAudioClipIdRefs.current = {};
      highSpeedPreviewSeekAtRef.current = {};
      presentedVideoClipIdsRef.current = {};
      videoReadyByClipIdRef.current = {};
      supplementalPlayingClipIdsRef.current.clear();
      videoWarmStateByClipIdRef.current = {};
      videoWarmPaintedByClipIdRef.current = {};
      videoNearCutRefreshedByClipIdRef.current = {};
      latchedPreviewSourceByClipRef.current = {};
      cutHoldClipIdRef.current = null;
      failedMediaIdsRef.current = {};
      setPresentedVideoClipIds({});
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
    }, [
      displayTime,
      isPlaying,
      videoClips,
      audioClips,
      videoPath,
      duration,
      trackSettings,
    ]);

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
        const candidateTime = Math.min(
          maxDuration,
          playbackAnchorTimelineRef.current + elapsedSeconds,
        );
        const blocker = blockingHardCut(currentTimeRef.current, candidateTime);
        const nextTime = blocker?.cutTime ?? candidateTime;

        if (blocker) {
          // Never let the editor clock run several seconds into the incoming
          // clip while its first frame is still unavailable. Holding exactly
          // on the cut preserves preview/export timing and gives the already-
          // mounted buffer deck time to finish its seek/decode.
          playbackAnchorTimelineRef.current = blocker.cutTime;
          playbackAnchorPerformanceRef.current = now;
          if (cutHoldClipIdRef.current !== blocker.clipId) {
            cutHoldClipIdRef.current = blocker.clipId;
            traceCut("hard-cut-hold", blocker);
          }
        } else if (cutHoldClipIdRef.current !== null) {
          traceCut("hard-cut-release", {
            clipId: cutHoldClipIdRef.current,
            timelineTime: candidateTime,
          });
          cutHoldClipIdRef.current = null;
        }

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

    const handleVideoLoadedMetadata = (
      trackId: VideoTrackId,
      clipId: string,
    ) => {
      const video = videoRefsByClipId.current[clipId] ?? null;

      if (video?.videoWidth && video.videoHeight) {
        setVideoDimensions((current) => ({
          ...current,
          [clipId]: {
            width: video.videoWidth,
            height: video.videoHeight,
          },
        }));
      }

      const timelineTime = isPlayingRef.current
        ? currentTimeRef.current
        : displayTimeRef.current;
      const activeClip = findActiveVideoClip(
        videoClipsRef.current,
        timelineTime,
        trackId,
      );

      if (activeClip?.id === clipId) {
        activeVideoClipIdRefs.current[trackId] = null;
        syncVideoTrackToTimeline(
          trackId,
          timelineTime,
          isPlayingRef.current,
          true,
        );
      } else {
        primeBufferedVideoClip(trackId, clipId);
      }
    };

    // A clip can move between V-tracks without remounting its decoded element.
    // Refresh dimensions by clip identity so portrait/landscape clips mounted
    // together during prebuffering never overwrite each other's geometry.
    useEffect(() => {
      setVideoDimensions((current) => {
        let next = current;
        let changed = false;

        for (const clip of videoClips) {
          const video = videoRefsByClipId.current[clip.id];
          if (!video?.videoWidth || !video.videoHeight) continue;

          const previous = current[clip.id];
          if (
            previous?.width === video.videoWidth &&
            previous?.height === video.videoHeight
          ) {
            continue;
          }

          if (!changed) {
            next = { ...current };
            changed = true;
          }
          next[clip.id] = {
            width: video.videoWidth,
            height: video.videoHeight,
          };
        }

        return changed ? next : current;
      });
    }, [videoClips]);

    const handleAudioLoadedMetadata = (
      audioTrackId: AudioTrackId,
      playbackKey: string,
    ) => {
      if (!audioRefsByPlaybackKey.current[playbackKey]) return;
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
      .flatMap((trackId) => activeVisualClipsByTrack[trackId] ?? [])
      .filter((clip) => !isTrackHidden(trackSettings, clip.trackId))
      .sort(
        (a, b) =>
          effectiveVideoLayer(a) - effectiveVideoLayer(b) ||
          a.timelineStart - b.timelineStart ||
          a.id.localeCompare(b.id),
      );
    const programLayerItems = visibleActiveClips
      .filter((clip) => isProgramVideoClipInteractive(clip))
      .slice()
      .reverse()
      .map((clip) => ({
        clip,
        trackLabel: `Layer ${displayLayerNumber(effectiveVideoLayer(clip))} · ${videoTrackLabel(clip.trackId)}`,
        locked: trackSettings[clip.trackId]?.locked ?? false,
      }));
    const visiblePresentedClips = videoTrackIds
      .flatMap((trackId) => {
        if (isTrackHidden(trackSettings, trackId)) return [];

        const activeVisuals = activeVisualClipsByTrack[trackId] ?? [];
        if (activeVisuals.length === 0) {
          // A stale presented ID can survive for a render while a track becomes
          // empty. Never let an ended clip remain the subtitle clock.
          return [];
        }

        if (activeVisuals.length > 1) {
          return activeVisuals;
        }

        const onlyActive = activeVisuals[0];
        const presentedClipId = presentedVideoClipIds[trackId] ?? null;
        const presentedClip = presentedClipId
          ? (videoClips.find((clip) => clip.id === presentedClipId) ?? null)
          : null;
        const handoffIncomingId =
          handoffPendingByTrackRef.current[trackId] ?? null;

        // During a hard-cut handoff the outgoing decoded frame intentionally
        // stays visible for a few milliseconds. Follow it until promotion, but
        // otherwise prefer the clip that is actually active at displayTime.
        if (
          presentedClip &&
          presentedClip.id !== onlyActive.id &&
          handoffIncomingId === onlyActive.id
        ) {
          return [presentedClip];
        }

        return [onlyActive];
      })
      .sort(
        (a, b) =>
          effectiveVideoLayer(a) - effectiveVideoLayer(b) ||
          a.timelineStart - b.timelineStart ||
          a.id.localeCompare(b.id),
      );

    // Subtitles must follow the frame the Program Monitor is actually showing,
    // not merely the logical clip under the playhead. During a buffered handoff
    // these can differ for a few frames, and using the presented clip keeps
    // preview timing aligned with the visible picture/export semantics.
    const topVisualClip =
      visiblePresentedClips[visiblePresentedClips.length - 1] ??
      visibleActiveClips[visibleActiveClips.length - 1] ??
      null;
    const topVisualTrackHasDissolve = topVisualClip
      ? dissolvesByTrack[topVisualClip.trackId] !== null
      : false;
    const subtitleVideoSourceKey = topVisualClip
      ? `${topVisualClip.id}:${topVisualClip.sourcePath}`
      : (videoPath ?? "");

    let subtitleClockClip: VideoTimelineClip | null = topVisualClip;

    if (topVisualClip) {
      const dissolve = dissolvesByTrack[topVisualClip.trackId];

      if (dissolve) {
        const incoming = videoRefsByClipId.current[dissolve.incoming.id] ?? null;
        const outgoing = videoRefsByClipId.current[dissolve.outgoing.id] ?? null;

        if (incoming && incoming.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          subtitleClockClip = dissolve.incoming;
        } else if (outgoing) {
          subtitleClockClip = dissolve.outgoing;
        }
      }
    }

    const subtitleClockMediaEpoch = subtitleClockClip
      ? (mediaEpochByClipId[subtitleClockClip.id] ?? 0)
      : 0;

    subtitleClockClipIdRef.current = subtitleClockClip?.id ?? null;

    useLayoutEffect(() => {
      const nextVideo = subtitleClockClip
        ? (videoRefsByClipId.current[subtitleClockClip.id] ?? null)
        : null;

      if (subtitleClockVideoRef.current !== nextVideo) {
        subtitleClockVideoRef.current = nextVideo;
        setSubtitleClockVideo(nextVideo);
      }
    }, [subtitleClockClip?.id, subtitleClockMediaEpoch]);

    /*
     * Subtitle preview clock
     * ----------------------
     * App.currentTime is driven from performance.now() so the editor remains
     * responsive, but WebKit can present a decoded video frame a little later
     * than that clock. Driving libass from App.currentTime therefore makes the
     * subtitle appear a few frames early even though export timing is correct.
     *
     * While normal video is playing, sample the timestamp of the frame WebKit
     * actually presents and map that source-media time back into timeline time.
     * The subtitle renderer then uses this value as its single clock.
     *
     * Paused/seeking/scrubbing and freeze clips deliberately continue to use
     * displayTime directly because there is no continuously advancing decoded
     * video frame to follow in those cases.
     */
    useEffect(() => {
      if (!isPlaying || !topVisualClip || isFreezeFrameClip(topVisualClip)) {
        setPresentedFrameTimelineTime(null);
        return;
      }

      let clockClip = topVisualClip;
      let video: HTMLVideoElement | null = null;

      if (topVisualTrackHasDissolve) {
        const dissolve = findSameTrackDissolve(
          videoClipsRef.current,
          currentTimeRef.current,
          topVisualClip.trackId,
        );

        if (dissolve) {
          // Either side of the dissolve represents the same timeline instant.
          // Prefer the incoming frame when available, otherwise use outgoing.
          const incoming = videoRefsByClipId.current[dissolve.incoming.id] ?? null;
          const outgoing = videoRefsByClipId.current[dissolve.outgoing.id] ?? null;

          if (incoming && incoming.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            video = incoming;
            clockClip = dissolve.incoming;
          } else if (outgoing) {
            video = outgoing;
            clockClip = dissolve.outgoing;
          }
        }
      } else {
        video = videoRefsByClipId.current[topVisualClip.id] ?? null;
      }

      if (!video) {
        setPresentedFrameTimelineTime(null);
        return;
      }

      let cancelled = false;
      let videoFrameCallbackId: number | null = null;
      let animationFrameId: number | null = null;

      const publishMediaTime = (mediaTime: number) => {
        if (cancelled || !Number.isFinite(mediaTime)) {
          return;
        }

        const mappedTime = sourceTimeToTimelineTime(clockClip, mediaTime);
        const clampedTime = Math.max(
          clockClip.timelineStart,
          Math.min(clockClip.timelineEnd, mappedTime),
        );

        const now = performance.now();
        if (now - lastSubtitleClockRenderAtRef.current < 32) return;
        lastSubtitleClockRenderAtRef.current = now;
        setPresentedFrameTimelineTime((previous) =>
          previous?.clipId === clockClip.id &&
          Math.abs(previous.time - clampedTime) < 0.001
            ? previous
            : { clipId: clockClip.id, time: clampedTime },
        );
      };

      type VideoFrameMetadataLike = { mediaTime: number };
      type VideoWithFrameCallbacks = HTMLVideoElement & {
        requestVideoFrameCallback?: (
          callback: (now: number, metadata: VideoFrameMetadataLike) => void,
        ) => number;
        cancelVideoFrameCallback?: (id: number) => void;
      };

      const frameVideo = video as VideoWithFrameCallbacks;

      if (typeof frameVideo.requestVideoFrameCallback === "function") {
        const scheduleNextPresentedFrame = () => {
          if (cancelled) {
            return;
          }

          videoFrameCallbackId = frameVideo.requestVideoFrameCallback!(
            (_now, metadata) => {
              publishMediaTime(metadata.mediaTime);
              scheduleNextPresentedFrame();
            },
          );
        };

        scheduleNextPresentedFrame();
      } else {
        // Older WebKit fallback: its native media clock is still preferable to
        // the editor's performance clock for subtitle/video synchronization.
        const sampleNativeMediaClock = () => {
          if (cancelled) {
            return;
          }

          publishMediaTime(video.currentTime);
          animationFrameId = window.requestAnimationFrame(
            sampleNativeMediaClock,
          );
        };

        animationFrameId = window.requestAnimationFrame(sampleNativeMediaClock);
      }

      return () => {
        cancelled = true;

        if (
          videoFrameCallbackId !== null &&
          typeof frameVideo.cancelVideoFrameCallback === "function"
        ) {
          frameVideo.cancelVideoFrameCallback(videoFrameCallbackId);
        }

        if (animationFrameId !== null) {
          window.cancelAnimationFrame(animationFrameId);
        }
      };
    }, [
      isPlaying,
      topVisualClip?.id,
      topVisualClip?.trackId,
      topVisualClip?.timelineStart,
      topVisualClip?.timelineEnd,
      topVisualClip?.sourceIn,
      topVisualClip?.sourceOut,
      topVisualClip?.playbackRate,
      topVisualClip?.playbackDirection,
      topVisualClip?.freezeFrameSourceTime,
      topVisualTrackHasDissolve,
    ]);

    const subtitlePreviewTime =
      isPlaying &&
      presentedFrameTimelineTime !== null &&
      subtitleClockClip !== null &&
      presentedFrameTimelineTime.clipId === subtitleClockClip.id
        ? presentedFrameTimelineTime.time
        : displayTime;
    const visibleSubtitles = useMemo(
      () =>
        subtitles.filter(
          (subtitle) =>
            !isTrackHidden(trackSettings, getSubtitleTrackId(subtitle)),
        ),
      [subtitles, trackSettings],
    );

    const selectedActiveClip = selectedVideoClipId
      ? (visibleActiveClips.find((clip) => clip.id === selectedVideoClipId) ??
        videoClips.find(
          (clip) =>
            clip.id === selectedVideoClipId &&
            displayTime >= clip.timelineStart &&
            displayTime < clip.timelineEnd,
        ) ??
        null)
      : null;

    const selectedDisplayClip = selectedActiveClip
      ? withEvaluatedVideoTransform(selectedActiveClip, displayTime)
      : null;

    const selectedTrackId = selectedActiveClip?.trackId as
      VideoTrackId | undefined;
    const selectedTrackVisible =
      !!selectedActiveClip &&
      !!selectedTrackId &&
      !!videoVisibility[selectedTrackId] &&
      !isTrackHidden(trackSettings, selectedTrackId);
    const selectedTrackLocked =
      !!selectedTrackId && (trackSettings[selectedTrackId]?.locked ?? false);

    const selectedVideoSize = selectedActiveClip
      ? (videoDimensions[selectedActiveClip.id] ?? { width: 16, height: 9 })
      : { width: 16, height: 9 };

    const fittedVideoRect = useMemo(() => {
      const shellWidth = shellDimensions.width;
      const shellHeight = shellDimensions.height;
      const sourceWidth = Math.max(1, selectedVideoSize.width);
      const sourceHeight = Math.max(1, selectedVideoSize.height);

      if (shellWidth <= 0 || shellHeight <= 0) {
        return { left: 0, top: 0, width: 0, height: 0 };
      }

      const scale = Math.min(
        shellWidth / sourceWidth,
        shellHeight / sourceHeight,
      );
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

    /**
     * Begin a Program Monitor move for an explicit clip.
     *
     * Takes the clip as a parameter instead of reading render-time selection
     * state, so a press directly on the video can select AND start dragging
     * in the same gesture (the selection only becomes visible, as an overlay,
     * on the NEXT render -- a separate click-then-drag was required without
     * this, which is exactly the "sometimes can't move/resize" symptom).
     */
    const startProgramMove = (
      clip: VideoTimelineClip,
      event: {
        button: number;
        isPrimary: boolean;
        pointerId: number;
        clientX: number;
        clientY: number;
        metaKey: boolean;
        preventDefault: () => void;
        stopPropagation: () => void;
      },
    ) => {
      // Transform gestures are primary-button only. A right-click fires
      // pointerdown before contextmenu, so without this guard the native
      // Opacity menu can leave a move gesture armed until the next click.
      if (event.button !== 0 || !event.isPrimary) {
        return;
      }

      const clipTrackLocked = trackSettings[clip.trackId]?.locked ?? false;

      if (
        clipTrackLocked ||
        !onVideoTransformChange ||
        shellDimensions.width <= 0 ||
        shellDimensions.height <= 0
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const displayClip = withEvaluatedVideoTransform(clip, displayTime);
      const clipVideoSize = videoDimensions[clip.id] ?? { width: 16, height: 9 };
      // Ignore sub-threshold jitter so a plain click that only selects does
      // not also nudge the clip or create a spurious undo step.
      const DRAG_START_THRESHOLD_PX = 3;
      let dragStarted = false;

      setProgramSnapGuides([]);

      const startX = event.clientX;
      const startY = event.clientY;
      const startPositionX = displayClip.positionX ?? 0;
      const startPositionY = displayClip.positionY ?? 0;
      // Masks v1.1: a normal Program move carries the clip mask by the exact
      // same snapped translation, preserving its placement relative to the
      // footage. Hold Command when the drag begins to move only the video.
      const startFollowingMask =
        clip.mask && !event.metaKey && onVideoMaskChange
          ? { ...clip.mask }
          : null;

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

        if (!dragStarted) {
          if (Math.hypot(deltaX, deltaY) < DRAG_START_THRESHOLD_PX) {
            return;
          }
          dragStarted = true;
          setProgramMoveSnappingActive(true);
        }

        const rawPositionX =
          startPositionX + (deltaX / shellDimensions.width) * 100;
        const rawPositionY =
          startPositionY + (deltaY / shellDimensions.height) * 100;

        const movingClip = {
          ...displayClip,
          positionX: rawPositionX,
          positionY: rawPositionY,
          // Snap geometry must use the in-progress pointer values, not re-evaluate
          // the clip's persisted animation channel at the same playhead time.
          transformKeyframes: undefined,
        };

        const movingBounds = programBoundsForClip(
          movingClip,
          clipVideoSize,
          shellDimensions,
          displayTime,
        );

        const otherVisibleBounds: ProgramBounds[] = [];

        for (const otherClip of visibleActiveClips) {
          if (
            otherClip.id === clip.id ||
            !videoVisibility[otherClip.trackId] ||
            isTrackHidden(trackSettings, otherClip.trackId)
          ) {
            continue;
          }

          otherVisibleBounds.push(
            programBoundsForClip(
              otherClip,
              videoDimensions[otherClip.id] ?? { width: 16, height: 9 },
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

        // Snapping v2: object-to-object remains the strongest target. Next,
        // softly attract the moving clip's edges to the visible aspect-ratio
        // frames and to the Program Monitor edge. Existing layout points remain
        // a final fallback so centre/thirds snapping is preserved.
        const frameSnapX = snapProgramBoundsToLines(
          movingBounds,
          programFrameSnapLines(
            shellDimensions.width,
            shellDimensions.height,
            "x",
          ),
          shellDimensions.width,
          "x",
          PROGRAM_FRAME_SNAP_THRESHOLD_PX,
        );
        const frameSnapY = snapProgramBoundsToLines(
          movingBounds,
          programFrameSnapLines(
            shellDimensions.width,
            shellDimensions.height,
            "y",
          ),
          shellDimensions.height,
          "y",
          PROGRAM_FRAME_SNAP_THRESHOLD_PX,
        );

        const layoutSnapX = snapProgramPointToLines(
          movingBounds.centerX,
          programLayoutSnapLines(0, shellDimensions.width),
          shellDimensions.width,
          "x",
        );
        const layoutSnapY = snapProgramPointToLines(
          movingBounds.centerY,
          programLayoutSnapLines(0, shellDimensions.height),
          shellDimensions.height,
          "y",
        );

        const chosenSnapX = objectSnapX.guide
          ? objectSnapX
          : frameSnapX.guide
            ? frameSnapX
            : layoutSnapX;
        const chosenSnapY = objectSnapY.guide
          ? objectSnapY
          : frameSnapY.guide
            ? frameSnapY
            : layoutSnapY;

        const nextPositionX =
          rawPositionX + (chosenSnapX.deltaPx / shellDimensions.width) * 100;
        const nextPositionY =
          rawPositionY + (chosenSnapY.deltaPx / shellDimensions.height) * 100;

        setProgramSnapGuides(
          [chosenSnapX.guide, chosenSnapY.guide].filter(
            (guide): guide is ProgramSnapGuide => guide !== null,
          ),
        );

        onVideoTransformChange(clip.id, {
          positionX: nextPositionX,
          positionY: nextPositionY,
        });

        if (startFollowingMask && onVideoMaskChange) {
          onVideoMaskChange(clip.id, {
            ...startFollowingMask,
            positionX: Math.max(
              -100,
              Math.min(
                200,
                startFollowingMask.positionX + nextPositionX - startPositionX,
              ),
            ),
            positionY: Math.max(
              -100,
              Math.min(
                200,
                startFollowingMask.positionY + nextPositionY - startPositionY,
              ),
            ),
          });
        }
      };

      const handlePointerUp = () => {
        setProgramSnapGuides([]);
        setProgramMoveSnappingActive(false);
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    };

    const beginMoveTransform = (event: ReactPointerEvent<HTMLDivElement>) => {
      if (selectedActiveClip) {
        startProgramMove(selectedActiveClip, event);
      }
    };

    const beginScaleTransform = (
      event: ReactPointerEvent<HTMLButtonElement>,
    ) => {
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

      const startScale = Math.max(
        10,
        Math.min(400, (selectedDisplayClip ?? selectedActiveClip).scale ?? 100),
      );
      const startPositionX =
        (selectedDisplayClip ?? selectedActiveClip).positionX ?? 0;
      const startPositionY =
        (selectedDisplayClip ?? selectedActiveClip).positionY ?? 0;

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
          startPositionX + (centerShiftX / Math.max(1, shellRect.width)) * 100;
        const nextPositionY =
          startPositionY + (centerShiftY / Math.max(1, shellRect.height)) * 100;

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

    const beginRotateTransform = (
      event: ReactPointerEvent<HTMLButtonElement>,
    ) => {
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
      const startRotation =
        (selectedDisplayClip ?? selectedActiveClip).rotation ?? 0;

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
      if (
        !selectedActiveClip ||
        selectedTrackLocked ||
        !onVideoTransformChange
      ) {
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
      if (
        !selectedActiveClip ||
        selectedTrackLocked ||
        !onVideoTransformChange
      ) {
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
      const startTop = Math.max(
        0,
        Math.min(49, selectedActiveClip.cropTop ?? 0),
      );
      const startRight = Math.max(
        0,
        Math.min(49, selectedActiveClip.cropRight ?? 0),
      );
      const startBottom = Math.max(
        0,
        Math.min(49, selectedActiveClip.cropBottom ?? 0),
      );
      const startLeft = Math.max(
        0,
        Math.min(49, selectedActiveClip.cropLeft ?? 0),
      );
      const rotationRadians =
        (((selectedDisplayClip ?? selectedActiveClip).rotation ?? 0) *
          Math.PI) /
        180;
      const clipScale = Math.max(
        0.1,
        Math.min(
          4,
          ((selectedDisplayClip ?? selectedActiveClip).scale ?? 100) / 100,
        ),
      );
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
      return () =>
        window.removeEventListener("keydown", handleCropKeyDown, true);
    }, [cropModeClipId, onVideoTransformChange]);

    // Alt+click cycles through all geometrically visible video layers.
    const selectProgramLayerBelow = (event: ReactPointerEvent<HTMLDivElement>): boolean => {
      const shell = shellRef.current;
      if (!shell || shellDimensions.width <= 0 || shellDimensions.height <= 0) return false;
      const rect = shell.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const layers: HitTestLayer[] = programLayerItems.map(({ clip }) => {
        const evaluated = withEvaluatedVideoTransform(clip, displayTime);
        const size = videoDimensions[clip.id] ?? { width: 16, height: 9 };
        return {
          id: clip.id, sourceWidth: size.width, sourceHeight: size.height,
          positionX: evaluated.positionX ?? 0, positionY: evaluated.positionY ?? 0,
          scale: evaluated.scale ?? 100, rotation: evaluated.rotation ?? 0,
          cropTop: clip.cropTop ?? 0, cropRight: clip.cropRight ?? 0,
          cropBottom: clip.cropBottom ?? 0, cropLeft: clip.cropLeft ?? 0,
        };
      });
      const hits = hitTestLayers(point, shellDimensions, layers);
      if (!hits.length) return false;
      const index = selectedVideoClipId ? hits.indexOf(selectedVideoClipId) : -1;
      const nextId = hits[(index + 1) % hits.length];
      if (cropModeClipId && cropModeClipId !== nextId) finishCropMode();
      onVideoClipSelect?.(nextId);
      setProgramTransformClipId(nextId);
      return true;
    };

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

      // Press-and-drag directly on the picture: select the clip and start
      // moving it in the same gesture. (Crop mode owns the pointer itself.)
      if (cropModeClipId !== clip.id) {
        startProgramMove(clip, event);
      }
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

      // CTC's real compositing order is the V-track number:
      // V1 behind V2 behind V3, etc. programLayerItems is the same stack shown
      // in the Layers panel, ordered FRONT -> BACK. Use the selected clip's
      // actual position in that stack to disable impossible one-step moves.
      const programLayerIndex = programLayerItems.findIndex(
        (item) => item.clip.id === clip.id,
      );
      const hasMultipleProgramLayers =
        programLayerItems.length > 1 && programLayerIndex >= 0;
      const forwardNeighbor =
        programLayerIndex > 0 ? programLayerItems[programLayerIndex - 1] : null;
      const backwardNeighbor =
        programLayerIndex >= 0 &&
        programLayerIndex < programLayerItems.length - 1
          ? programLayerItems[programLayerIndex + 1]
          : null;
      const canUseLayerCommands =
        !locked && hasMultipleProgramLayers && !!onVideoLayerChange;
      const canBringForward =
        canUseLayerCommands && !!forwardNeighbor && !forwardNeighbor.locked;
      const canSendBackward =
        canUseLayerCommands && !!backwardNeighbor && !backwardNeighbor.locked;

      const reorderOneStep = (direction: "forward" | "backward") => {
        onVideoLayerChange?.(clip.id, direction, displayTime);
      };

      void showNativeContextMenu([
        {
          id: `program-video.${clip.id}.opacity`,
          text: "Opacity…",
          enabled: !locked,
          action: () => openOpacityEditor(clip, clientX, clientY),
        },
        {
          id: `program-video.${clip.id}.effects`,
          text: "Effects…",
          enabled: !!onOpenVideoEffects,
          action: () => onOpenVideoEffects?.(clip.id),
        },
        {
          id: `program-video.${clip.id}.masks`,
          text: "Masks…",
          enabled: !!onOpenVideoMasks,
          action: () => onOpenVideoMasks?.(clip.id),
        },
        {
          id: `program-video.${clip.id}.layer`,
          text: "Layer",
          enabled: canBringForward || canSendBackward,
          items: [
            {
              id: `program-video.${clip.id}.layer.forward`,
              text: "Bring Forward",
              enabled: canBringForward,
              action: () => reorderOneStep("forward"),
            },
            {
              id: `program-video.${clip.id}.layer.backward`,
              text: "Send Backward",
              enabled: canSendBackward,
              action: () => reorderOneStep("backward"),
            },
          ],
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
            Math.max(
              10,
              Math.min(
                400,
                (selectedDisplayClip ?? selectedActiveClip).scale ?? 100,
              ),
            ) / 100;
          const clipRotation = Math.max(
            -180,
            Math.min(
              180,
              (selectedDisplayClip ?? selectedActiveClip).rotation ?? 0,
            ),
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
      ? (videoClips.find(
          (clip) =>
            clip.id === opacityEditor.clipId &&
            isProgramVideoClipInteractive(clip),
        ) ?? null)
      : null;
    const opacityEditorValue = opacityEditorClip
      ? evaluateVideoTransformProperty(
          opacityEditorClip,
          "opacity",
          displayTime,
        )
      : 100;
    const opacityEditorLocked = opacityEditorClip
      ? (trackSettings[opacityEditorClip.trackId]?.locked ?? false)
      : false;

    const opacityEditorStyle: CSSProperties | undefined = opacityEditor
      ? {
          left: Math.max(
            10,
            Math.min(window.innerWidth - 250, opacityEditor.clientX),
          ),
          top: Math.max(
            10,
            Math.min(window.innerHeight - 92, opacityEditor.clientY),
          ),
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
          {!isSkimPreviewActive &&
            selectedActiveClip &&
            selectedTrackVisible && (
              <div
                className="program-crop-toolbar"
                aria-label="Video crop controls"
              >
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
                    <button
                      type="button"
                      className="program-crop-button primary"
                      onClick={finishCropMode}
                    >
                      Done
                    </button>
                    <button
                      type="button"
                      className="program-crop-button"
                      onClick={() =>
                        onApplyVideoCropToTrack?.(selectedActiveClip.id)
                      }
                    >
                      Apply to {videoTrackLabel(selectedActiveClip.trackId)}
                    </button>
                    <button
                      type="button"
                      className="program-crop-button"
                      onClick={resetSelectedCrop}
                    >
                      Reset Crop
                    </button>
                    <button
                      type="button"
                      className="program-crop-button"
                      onClick={cancelCropMode}
                    >
                      Cancel
                    </button>
                  </>
                )}
              </div>
            )}

          {primaryVideoUrl && selectedActiveClip && (
            <button
              type="button"
              className="program-effects-button"
              onClick={() => onOpenVideoEffects?.(selectedActiveClip.id)}
              title="Open Effects for selected video"
            >
              Effects
              {selectedActiveClip.effects?.length
                ? ` · ${selectedActiveClip.effects.length}`
                : ""}
            </button>
          )}

          {primaryVideoUrl && selectedActiveClip && (
            <button
              type="button"
              className="program-effects-button"
              onClick={() => onOpenVideoMasks?.(selectedActiveClip.id)}
              title="Open Masks for selected video"
            >
              Masks{selectedActiveClip.mask ? " · 1" : ""}
            </button>
          )}

          {primaryVideoUrl && selectedActiveClip && (
            <label
              className="program-blend-control"
              title="Blend selected video with layers below"
            >
              <span>Blend</span>
              <select
                value={normalizeVideoBlendMode(selectedActiveClip.blendMode)}
                disabled={selectedTrackLocked || !onVideoBlendModeChange}
                onChange={(event) =>
                  onVideoBlendModeChange?.(
                    selectedActiveClip.id,
                    event.target.value as VideoBlendMode,
                  )
                }
                aria-label="Video blend mode"
              >
                {VIDEO_BLEND_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {VIDEO_BLEND_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
            </label>
          )}

          {primaryVideoUrl && (
            <button
              type="button"
              className={`program-layers-button ${layersPanelOpen ? "active" : ""}`.trim()}
              onClick={() => setLayersPanelOpen((current) => !current)}
              aria-pressed={layersPanelOpen}
              title="Show video layers at the current playhead"
            >
              Layers
            </button>
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
              onPointerEnter={() => {
                // A fast exit from the timeline can miss its pointerleave and
                // leave skimPreviewTime latched. Transform controls are hidden
                // while a skim is active, so always terminate a real skim when
                // the pointer returns to the Program Monitor.
                clearSkimPreview(true);
              }}
              onPointerDownCapture={(event) => {
                clearSkimPreview(true);
                if (event.altKey && event.button === 0 && event.isPrimary) {
                  const target = event.target as Element | null;
                  if (target?.closest?.(".program-transform-handle, .program-crop-handle")) return;
                  if (selectProgramLayerBelow(event)) {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                }
              }}
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
              {/*
               * Keep SVG filter resources outside the isolated blend stack.
               * WebKit can otherwise fail to resolve/update url(#filter) on a
               * media element nested inside mix-blend-mode + paint containment.
               */}
              {flatBufferedVideoClips.map((clip) => {
                const previewEffects = videoEffectsForClipAtTime(
                  clip,
                  unmaskedAdjustmentLayers,
                  displayTime,
                  trackSettings,
                );
                return (
                  <VideoEffectFilterDefs
                    key={`clip-fx-defs:${clip.id}`}
                    filterId={videoEffectFilterDomId(clip.id)}
                    effects={previewEffects}
                    previewScale={Math.max(0.05, shellDimensions.height / 1080)}
                  />
                );
              })}

              <div className="program-video-composite-stack">
                {flatBufferedVideoClips.map((clip) => {
                  const trackId = clip.trackId as VideoTrackId;
                  const activeClip = activeClipsByTrack[trackId] ?? null;
                  const activeVisualClips =
                    activeVisualClipsByTrack[trackId] ?? [];
                  const presentedClipId =
                    presentedVideoClipIds[trackId] ?? activeClip?.id ?? null;
                  const isActive = activeClip?.id === clip.id;
                  const isPresented = presentedClipId === clip.id;
                  const isTimelineActive = activeVisualClips.some(
                    (candidate) => candidate.id === clip.id,
                  );
                  const hasSameTrackOverlap = activeVisualClips.length > 1;
                  // Program hit-testing belongs to the actual visual layer, not
                  // to the track's single transport owner. This is what lets a
                  // front/back layer remain selectable after layer reordering,
                  // including when two clips happen to overlap on one V-track.
                  const programInteractionClip = isTimelineActive ? clip : null;
                  const dissolve = dissolvesByTrack[trackId] ?? null;
                  const isDissolveOutgoing = dissolve?.outgoing.id === clip.id;
                  const isDissolveIncoming = dissolve?.incoming.id === clip.id;
                  const isDissolveParticipant =
                    isDissolveOutgoing || isDissolveIncoming;
                  const trackEnabled =
                    !isTrackHidden(trackSettings, trackId) &&
                    videoVisibility[trackId] !== false;
                  const trackVisible =
                    trackEnabled &&
                    (isDissolveParticipant ||
                      (hasSameTrackOverlap && isTimelineActive) ||
                      (!dissolve && isPresented));
                  const renderTime = isDissolveParticipant
                    ? displayTime
                    : isActive
                      ? displayTime
                      : isPresented
                        ? Math.max(
                            clip.timelineStart,
                            Math.min(
                              Math.max(clip.timelineStart, clip.timelineEnd - 0.0001),
                              displayTime,
                            ),
                          )
                        : clip.timelineStart;
                  const previewSource = previewSourceForClip(clip);
                  const sourceUrl = convertFileSrc(previewSource.previewPath);
                  const linkedAudioTrackIdForRender =
                    linkedAudioTrackForVideoTrack(trackId);
                  const renderSoloMuted =
                    linkedAudioTrackIdForRender !== null &&
                    hasSoloAudioTrack(trackSettings) &&
                    trackSettings[linkedAudioTrackIdForRender]?.solo !== true;
                  const renderVideoMuted =
                    !trackVisible ||
                    (hasSameTrackOverlap && isTimelineActive && !isActive) ||
                    linkedAudioTrackIdForRender === null ||
                    isFreezeFrameClip(clip) ||
                    isReverseVideoClip(clip) ||
                    (clip.audioMuted ?? false) ||
                    (linkedAudioTrackIdForRender !== null &&
                      isTrackMuted(trackSettings, linkedAudioTrackIdForRender)) ||
                    renderSoloMuted;
                  const previewEffects = videoEffectsForClipAtTime(
                    clip,
                    unmaskedAdjustmentLayers,
                    renderTime,
                    trackSettings,
                  );
                  const effectFilterId = videoEffectFilterDomId(clip.id);
                  const effectFilter = hasRasterVideoEffects(previewEffects)
                    ? `url(#${effectFilterId})`
                    : "";
                  const transitionStyle = isDissolveParticipant
                    ? {
                        filter: adjustmentCssFilter(
                          adjustmentLayersAffectingVideoTrack(
                            unmaskedAdjustmentLayers,
                            renderTime,
                            trackId,
                            trackSettings,
                            effectiveVideoLayer(clip),
                          ),
                          renderTime,
                        ) || undefined,
                      }
                    : adjustedVideoTransitionStyle(
                        clip,
                        renderTime,
                        unmaskedAdjustmentLayers,
                        trackSettings,
                      );
                  const {
                    filter: transitionFilter,
                    opacity: ordinaryTransitionOpacity,
                    ...transitionVisualStyle
                  } = transitionStyle;
                  const previewFilter = [effectFilter, transitionFilter]
                    .filter(Boolean)
                    .join(" ") || undefined;
                  const dissolveOpacity = isDissolveOutgoing
                    ? (1 - (dissolve?.progress ?? 0)) *
                      videoOpacityFadeFactor(clip, renderTime) *
                      (evaluateVideoTransformProperty(clip, "opacity", renderTime) / 100)
                    : isDissolveIncoming
                      ? (dissolve?.progress ?? 0) *
                        videoOpacityFadeFactor(clip, renderTime) *
                        (evaluateVideoTransformProperty(clip, "opacity", renderTime) / 100)
                      : null;
                  const visualOpacity = trackVisible
                    ? dissolveOpacity ??
                      (typeof ordinaryTransitionOpacity === "number"
                        ? ordinaryTransitionOpacity
                        : 1)
                    : 0;
                  const vignetteStyle = videoVignetteOverlayStyle(
                    clip,
                    previewEffects,
                    videoDimensions[clip.id] ?? { width: 16, height: 9 },
                    shellDimensions,
                    renderTime,
                  );
                  const epoch = mediaEpochByClipId[clip.id] ?? 0;

                  return (
                    <div
                      key={`${clip.id}:${epoch}`}
                      className="program-video-blend-layer"
                      aria-hidden={!trackVisible}
                      style={{
                        zIndex: programStackRanks.get(`video:${clip.id}`) ?? 10,
                        visibility: "visible",
                        opacity: visualOpacity,
                        pointerEvents: "none",
                        mixBlendMode: cssBlendMode(clip.blendMode),
                      }}
                    >
                      <div
                        className="program-video-mask-wrapper"
                        style={videoMaskCssStyle(
                          clip.mask,
                          shellDimensions.width / Math.max(1, shellDimensions.height),
                        )}
                      >
                        <div
                          className="program-video-effect-layer"
                          style={{ filter: previewFilter }}
                        >
                          <video
                            ref={(element) => {
                              videoRefsByClipId.current[clip.id] = element;

                              // Ref attachment itself is not a React state
                              // change. If the subtitle-clock clip mounted after
                              // the render that selected it, bind libass here so
                              // we do not wait for pause/play or another random
                              // render to discover the new media element.
                              if (
                                element &&
                                subtitleClockClipIdRef.current === clip.id &&
                                subtitleClockVideoRef.current !== element
                              ) {
                                subtitleClockVideoRef.current = element;
                                setSubtitleClockVideo(element);
                              }
                            }}
                            src={sourceUrl}
                            data-source-path={clip.sourcePath}
                            data-preview-proxy={previewSource.isProxy ? "true" : "false"}
                            className="video-element video-track-layer"
                            muted={renderVideoMuted}
                            preload="auto"
                            style={{
                              ...videoTransformStyle(
                                clip,
                                videoDimensions[clip.id] ?? { width: 16, height: 9 },
                                shellDimensions,
                                renderTime,
                              ),
                              ...transitionVisualStyle,
                              pointerEvents: trackEnabled && programInteractionClip ? "auto" : "none",
                            }}
                            onLoadStart={() => {
                              videoReadyByClipIdRef.current[clip.id] = false;
                              reportMedia(clip.id, "loadstart");
                              delete videoWarmStateByClipIdRef.current[clip.id];
                              delete videoWarmPaintedByClipIdRef.current[clip.id];
                              delete videoNearCutRefreshedByClipIdRef.current[clip.id];
                            }}
                            onLoadedMetadata={() =>
                              handleVideoLoadedMetadata(trackId, clip.id)
                            }
                            onLoadedData={() =>
                              markBufferedVideoReady(trackId, clip.id)
                            }
                            onSeeking={() => {
                              reportMedia(clip.id, "seeking");
                              delete videoWarmStateByClipIdRef.current[clip.id];
                              delete videoWarmPaintedByClipIdRef.current[clip.id];
                            }}
                            onSeeked={() => {
                              reportMedia(
                                clip.id,
                                "seeked",
                                videoRefsByClipId.current[clip.id]?.currentTime ?? 0,
                              );
                              markBufferedVideoReady(trackId, clip.id);
                            }}
                            onCanPlay={() =>
                              markBufferedVideoReady(trackId, clip.id)
                            }
                            onPlaying={(event) =>
                              reportMedia(
                                clip.id,
                                "playing",
                                event.currentTarget.currentTime,
                              )
                            }
                            onError={() => reportMedia(clip.id, "error")}
                            onEmptied={() => reportMedia(clip.id, "emptied")}
                            onAbort={() => reportMedia(clip.id, "abort")}
                            onStalled={(event) =>
                              reportMedia(
                                clip.id,
                                "stalled",
                                event.currentTarget.currentTime,
                              )
                            }
                            onWaiting={(event) =>
                              reportMedia(
                                clip.id,
                                "waiting",
                                event.currentTarget.currentTime,
                              )
                            }
                            onPointerDown={(event) => {
                              if (programInteractionClip) {
                                handleProgramClipPointerDown(
                                  event,
                                  programInteractionClip,
                                );
                              }
                            }}
                            onDoubleClick={(event) => {
                              if (!programInteractionClip) return;
                              event.preventDefault();
                              event.stopPropagation();
                              onVideoClipSelect?.(programInteractionClip.id);
                              if (
                                isProgramVideoClipInteractive(
                                  programInteractionClip,
                                )
                              ) {
                                setProgramTransformClipId(
                                  programInteractionClip.id,
                                );
                              }
                            }}
                            onContextMenu={(event) => {
                              if (programInteractionClip) {
                                handleProgramClipContextMenu(
                                  event,
                                  programInteractionClip,
                                );
                              }
                            }}
                          />
                        </div>
                        {vignetteStyle && (
                          <div
                            className="program-video-vignette"
                            aria-hidden="true"
                            style={{ ...vignetteStyle, opacity: visualOpacity }}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}

                {adjustmentLayers
                  .filter(
                    (layer) =>
                      (!!activeVideoMask(layer.mask) ||
                        !isNormalBlendMode(layer.blendMode)) &&
                      layer.enabled !== false &&
                      displayTime >= layer.timelineStart &&
                      displayTime <= layer.timelineEnd &&
                      trackSettings[layer.trackId]?.deleted !== true &&
                      trackSettings[layer.trackId]?.hidden !== true,
                  )
                  .sort(
                    (a, b) =>
                      effectiveAdjustmentLayer(a) - effectiveAdjustmentLayer(b) ||
                      a.timelineStart - b.timelineStart,
                  )
                  .map((layer) => {
                    const previewScale = Math.max(
                      0.05,
                      shellDimensions.height / 1080,
                    );
                    const effectFunctions = enabledVideoEffects(
                      layer.effects,
                    ).flatMap((effect) => {
                      if (effect.kind === "gaussian-blur")
                        return [
                          `blur(${Math.max(0, effect.radius) * previewScale}px)`,
                        ];
                      if (effect.kind === "sharpen")
                        return [
                          `contrast(${(1 + Math.max(0, Math.min(100, effect.amount)) * 0.0025).toFixed(4)})`,
                        ];
                      return [];
                    });
                    const vignette = combinedVignette(layer.effects);
                    const layerStrength = adjustmentLayerStrength(
                      layer,
                      displayTime,
                    );
                    const fullStrengthKeyframes = layer.keyframes
                      ? (Object.fromEntries(
                          Object.entries(layer.keyframes).filter(
                            ([property]) => property !== "opacity",
                          ),
                        ) as AdjustmentLayerClip["keyframes"])
                      : undefined;
                    const fullStrengthLayer: AdjustmentLayerClip = {
                      ...layer,
                      opacity: 100,
                      keyframes: fullStrengthKeyframes,
                    };
                    const colorFilter = adjustmentCssFilter(
                      [fullStrengthLayer],
                      displayTime,
                    );
                    const backdropFilter = [colorFilter, ...effectFunctions]
                      .filter(Boolean)
                      .join(" ");
                    const vignetteSoftness = vignette
                      ? Math.max(0, Math.min(100, vignette.softness)) / 100
                      : 0;
                    const vignetteClearStop = 18 + vignetteSoftness * 55;
                    const vignetteAlpha = vignette
                      ? Math.max(0, Math.min(1, vignette.amount / 100))
                      : 0;
                    return (
                      <div
                        key={`masked-adjustment:${layer.id}`}
                        className="program-masked-adjustment-layer"
                        aria-hidden="true"
                        style={{
                          zIndex: programStackRanks.get(`adjustment:${layer.id}`) ?? 5,
                          mixBlendMode: cssBlendMode(layer.blendMode),
                          opacity: layerStrength,
                          ...(activeVideoMask(layer.mask)
                            ? videoMaskCssStyle(
                                layer.mask,
                                shellDimensions.width /
                                  Math.max(1, shellDimensions.height),
                              )
                            : {}),
                          WebkitBackdropFilter: backdropFilter || undefined,
                          backdropFilter: backdropFilter || undefined,
                          backgroundImage:
                            vignetteAlpha > 0.001
                              ? `radial-gradient(ellipse at center, rgba(0,0,0,0) ${vignetteClearStop.toFixed(1)}%, rgba(0,0,0,${vignetteAlpha.toFixed(4)}) 100%)`
                              : undefined,
                        }}
                      />
                    );
                  })}
              </div>

              {editingMask && (
                <ProgramMaskEditor
                  mask={editingMask.mask}
                  width={shellDimensions.width}
                  height={shellDimensions.height}
                  disabled={editingMask.locked}
                  label={
                    editingMask.ownerKind === "adjustment"
                      ? `Adjustment · ${editingMask.label}`
                      : editingMask.label
                  }
                  onChange={(mask) => onEditingMaskChange?.(mask)}
                  onBeginChange={onMaskEditStart}
                  onEndChange={onMaskEditEnd}
                />
              )}

              <ProgramSnapOverlay
                width={shellDimensions.width}
                height={shellDimensions.height}
                activeGuides={programSnapGuides}
                show={programMoveSnappingActive}
              />

              {!isSkimPreviewActive &&
                isProgramTransformActive &&
                selectedActiveClip &&
                selectedTrackVisible && (
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
                      onPointerDown={
                        isCropModeActive ? undefined : beginMoveTransform
                      }
                      onContextMenu={(event) =>
                        handleProgramClipContextMenu(event, selectedActiveClip)
                      }
                    >
                      <span className="program-transform-track-badge">
                        {videoTrackLabel(selectedActiveClip.trackId)}
                      </span>

                      {!selectedTrackLocked &&
                        (isCropModeActive ? (
                          <div
                            className="program-crop-window"
                            style={cropWindowStyle}
                          >
                            <button
                              type="button"
                              className="program-crop-handle top"
                              onPointerDown={(event) =>
                                beginCropTransform(event, "top")
                              }
                              aria-label="Crop top edge"
                            />
                            <button
                              type="button"
                              className="program-crop-handle right"
                              onPointerDown={(event) =>
                                beginCropTransform(event, "right")
                              }
                              aria-label="Crop right edge"
                            />
                            <button
                              type="button"
                              className="program-crop-handle bottom"
                              onPointerDown={(event) =>
                                beginCropTransform(event, "bottom")
                              }
                              aria-label="Crop bottom edge"
                            />
                            <button
                              type="button"
                              className="program-crop-handle left"
                              onPointerDown={(event) =>
                                beginCropTransform(event, "left")
                              }
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
                                (selectedDisplayClip ?? selectedActiveClip)
                                  .rotation ?? 0,
                              )}`}
                              title="Drag to rotate · snaps every 45°"
                            >
                              ↻
                            </button>
                            <span
                              className="program-transform-angle-readout"
                              aria-hidden="true"
                            >
                              {formatRotation(
                                (selectedDisplayClip ?? selectedActiveClip)
                                  .rotation ?? 0,
                              )}
                            </span>
                          </>
                        ))}
                    </div>
                  </div>
                )}

              {audioTrackIds.map((audioTrackId) => {
                const linkedVideoTrackId =
                  trackSettings[audioTrackId]?.linkedTrackId;
                const linkedVideoClip =
                  linkedVideoTrackId && /^video-\d+$/.test(linkedVideoTrackId)
                    ? (activeClipsByTrack[linkedVideoTrackId] ?? null)
                    : null;
                const visibleLinkedVideoOwnsAudio =
                  !!linkedVideoClip &&
                  !!linkedVideoTrackId &&
                  !isTrackHidden(trackSettings, linkedVideoTrackId) &&
                  !isFreezeFrameClip(linkedVideoClip) &&
                  !isReverseVideoClip(linkedVideoClip);
                const sourcePath = visibleLinkedVideoOwnsAudio
                  ? null
                  : audioSourcesByTrack[audioTrackId];
                const previewPath = sourcePath
                  ? (proxyPathsBySource[sourcePath] ?? sourcePath)
                  : null;
                const standaloneClip = linkedVideoClip
                  ? null
                  : findActiveAudioClip(audioClips, displayTime, audioTrackId);
                const playbackKey = linkedVideoClip
                  ? `video:${linkedVideoClip.id}`
                  : standaloneClip
                    ? `audio:${standaloneClip.id}`
                    : `gap:${audioTrackId}`;

                return (
                  <audio
                    key={playbackKey}
                    ref={(element) => {
                      audioRefsByPlaybackKey.current[playbackKey] = element;
                    }}
                    src={previewPath ? convertFileSrc(previewPath) : undefined}
                    data-source-path={sourcePath ?? ""}
                    data-preview-proxy={
                      sourcePath && proxyPathsBySource[sourcePath]
                        ? "true"
                        : "false"
                    }
                    preload="auto"
                    hidden
                    onLoadedMetadata={() =>
                      handleAudioLoadedMetadata(audioTrackId, playbackKey)
                    }
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
                currentTime={subtitlePreviewTime}
                isPlaying={isPlaying}
                videoSourceKey={subtitleVideoSourceKey}
                clockVideo={subtitleClockVideo}
                selectedSubtitleId={selectedSubtitleId}
                interactiveSubtitleIds={interactiveSubtitleIds}
                shellRef={shellRef}
                onSubtitleSelect={onSubtitleSelect}
                onSubtitlePositionChange={onSubtitlePositionChange}
              />
            </div>

            <ProgramLayersPanel
              open={layersPanelOpen}
              items={programLayerItems}
              selectedClipId={
                selectedActiveClip?.id ?? selectedVideoClipId ?? null
              }
              onClose={() => setLayersPanelOpen(false)}
              onSelect={(id) => onVideoClipSelect?.(id)}
              onReorder={(orderedIds) =>
                onVideoLayerReorder?.(orderedIds, displayTime)
              }
            />

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
              disabled={locked}
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
  },
);

export default VideoPlayer;
