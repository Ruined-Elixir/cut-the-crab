import { useState, type MouseEvent as ReactMouseEvent } from "react";

import type {
  AdjustmentLayerClip,
  TimelineTrack,
  TimelineTrackId,
  VideoTimelineClip,
  VideoTransitionType,
} from "../../types/timelineModel";
import type { VideoClipFrames } from "../../hooks/useVideoClipFrames";
import {
  canShowNativeContextMenu,
  showNativeContextMenu,
} from "../../services/nativeContextMenu";
import { videoPlaybackRate } from "../../utils/videoRetime";
import { allVideoTransformKeyframeTimes } from "../../utils/videoTransformKeyframes";
import {
  ADJUSTMENT_KEYFRAME_EPSILON,
  adjustmentLayerKeyframeCountAtTime,
  allAdjustmentLayerKeyframeTimes,
} from "../../utils/adjustmentLayers";

import TimelineTrackLabel from "./TimelineTrackLabel";

import {
  captureTimelineDragScroll,
  timelineDragDeltaSeconds,
} from "./timelineDrag";

export type VideoMoveSnapTarget = {
  time: number;
  kind: "clip" | "playhead" | "marker" | "timeline";
  clipId?: string;
};

type VideoTrackProps = {
  duration: number;
  currentTime: number;
  track: TimelineTrack;
  adjustmentLayers: AdjustmentLayerClip[];
  selectedAdjustmentLayerId: string | null;
  onAdjustmentLayerSelect?: (id: string) => void;
  onAdjustmentLayerOpen?: (id: string) => void;
  onAdjustmentLayerEditStart?: (id: string) => boolean | void;
  onAdjustmentLayerEditEnd?: () => void;
  onAdjustmentLayerMove?: (id: string, newTimelineStart: number) => void;
  onAdjustmentLayerResize?: (
    id: string,
    newTimelineStart: number,
    newTimelineEnd: number,
  ) => void;
  selectedVideoClipId: string | null;
  selectedVideoClipIds: string[];
  framesByClipId: VideoClipFrames;
  showLabel?: boolean;

  onSeek?: (time: number) => void;
  onSelect?: (id: string, mode?: "single" | "toggle" | "focus") => void;
  onMoveStart?: (id: string) => boolean | void;
  onMoveEnd?: () => void;
  onMove?: (id: string, newTimelineStart: number) => void;
  onMoveToTrack?: (
    id: string,
    targetTrackId: TimelineTrackId,
    newTimelineStart: number,
  ) => void;
  onResizeStart?: (id: string) => boolean | void;
  onResize?: (
    id: string,
    newTimelineStart: number,
    newTimelineEnd: number,
  ) => void;
  onResizeEnd?: () => void;
  onToggleLock?: (trackId: TimelineTrackId) => void;
  onToggleHidden?: (trackId: TimelineTrackId) => void;
  onTransitionChange?: (
    id: string,
    edge: "in" | "out",
    transition: { type?: VideoTransitionType; duration?: number },
  ) => void;
  onFadeChange?: (id: string, edge: "in" | "out", duration: number) => void;
  onFadeResizeStart?: () => void;
  onFadeResizeEnd?: () => void;
  onPasteTargetChange?: (trackId: TimelineTrackId, time: number) => void;
  snapTargets?: VideoMoveSnapTarget[];
  onSnapGuideChange?: (time: number | null) => void;
  onRevealClip?: (clip: VideoTimelineClip) => void;
  onRegenerateMissingSubtitles?: (clip: VideoTimelineClip) => void | Promise<void>;
  onOpenCompound?: (compoundId: string) => void;
  expandedCompoundId?: string | null;
};

const MIN_VIDEO_CLIP_DURATION = 0.1;
const VIDEO_MOVE_SNAP_THRESHOLD_PX = 6;

function clearExternalTrackPreview() {
  document
    .querySelectorAll<HTMLElement>(".video-track.clip-drag-target")
    .forEach((element) => {
      element.classList.remove("clip-drag-target");
      element.style.removeProperty("--clip-drag-left");
      element.style.removeProperty("--clip-drag-width");
    });
}

function setExternalTrackPreview(
  target: HTMLElement,
  timelineStart: number,
  clipDuration: number,
  timelineDuration: number,
) {
  clearExternalTrackPreview();

  const left =
    timelineDuration > 0 ? (timelineStart / timelineDuration) * 100 : 0;
  const width =
    timelineDuration > 0 ? (clipDuration / timelineDuration) * 100 : 0;

  target.classList.add("clip-drag-target");
  target.style.setProperty("--clip-drag-left", `${left}%`);
  target.style.setProperty("--clip-drag-width", `${Math.max(width, 0.6)}%`);
}

function VideoTrack({
  duration,
  currentTime,
  track,
  adjustmentLayers,
  selectedAdjustmentLayerId,
  onAdjustmentLayerSelect,
  onAdjustmentLayerOpen,
  onAdjustmentLayerEditStart,
  onAdjustmentLayerEditEnd,
  onAdjustmentLayerMove,
  onAdjustmentLayerResize,
  selectedVideoClipId,
  selectedVideoClipIds,
  framesByClipId,
  onSeek,
  onSelect,
  onMoveStart,
  onMoveEnd,
  onMove,
  onMoveToTrack,
  onResizeStart,
  onResize,
  onResizeEnd,
  onToggleLock,
  onToggleHidden,
  onTransitionChange,
  onFadeChange,
  onFadeResizeStart,
  onFadeResizeEnd,
  onPasteTargetChange,
  snapTargets = [],
  onSnapGuideChange,
  onRevealClip,
  onRegenerateMissingSubtitles,
  onOpenCompound,
  expandedCompoundId = null,
  showLabel = true,
}: VideoTrackProps) {
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
  const [draggingAdjustmentId, setDraggingAdjustmentId] = useState<
    string | null
  >(null);
  const [adjustmentGestureMode, setAdjustmentGestureMode] = useState<
    "move" | "resize-left" | "resize-right" | null
  >(null);
  const [fadeDrag, setFadeDrag] = useState<{
    clipId: string;
    edge: "in" | "out";
    duration: number;
  } | null>(null);

  const videoClips = track.clips.filter(
    (clip): clip is VideoTimelineClip => clip.kind === "video",
  );

  const timeFromClientX = (clientX: number, element: HTMLElement) => {
    if (duration <= 0) {
      return 0;
    }

    const rect = element.getBoundingClientRect();
    const ratio = (clientX - rect.left) / Math.max(1, rect.width);

    return Math.max(0, Math.min(duration, ratio * duration));
  };

  const handleTrackClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (
      duration <= 0 ||
      (event.target as HTMLElement).closest(
        ".timeline-video-clip, .timeline-adjustment-layer",
      )
    ) {
      return;
    }

    const time = timeFromClientX(event.clientX, event.currentTarget);
    onPasteTargetChange?.(track.id, time);
    onSeek?.(time);
  };

  const startMove = (
    event: ReactMouseEvent<HTMLDivElement>,
    clip: VideoTimelineClip,
  ) => {
    if (event.button !== 0) return;

    if (
      (event.target as HTMLElement).closest(".video-resize-handle") ||
      (event.target as HTMLElement).closest(".clip-fade-handle")
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      onSelect?.(clip.id, "toggle");
      return;
    }

    if (!selectedVideoClipIds.includes(clip.id)) {
      onSelect?.(clip.id, "single");
    } else {
      onSelect?.(clip.id, "focus");
    }

    if (track.locked) {
      return;
    }

    const trackElement = event.currentTarget.parentElement;

    if (!trackElement || duration <= 0) {
      return;
    }

    if (onMoveStart?.(clip.id) === false) {
      return;
    }

    setDraggingClipId(clip.id);

    const startX = event.clientX;
    const dragScroll = captureTimelineDragScroll(trackElement);
    const originalStart = clip.timelineStart;
    const clipDuration = clip.timelineEnd - clip.timelineStart;
    const width = trackElement.getBoundingClientRect().width;
    const snapThresholdSeconds =
      (VIDEO_MOVE_SNAP_THRESHOLD_PX / Math.max(1, width)) * duration;
    let latestTimelineStart = originalStart;
    let moveFrameId: number | null = null;
    let pendingMoveStart = originalStart;
    let lastCommittedMoveStart = originalStart;

    const flushPendingMove = () => {
      if (moveFrameId !== null) {
        window.cancelAnimationFrame(moveFrameId);
        moveFrameId = null;
      }
      if (Math.abs(pendingMoveStart - lastCommittedMoveStart) <= 0.000001) {
        return;
      }
      lastCommittedMoveStart = pendingMoveStart;
      onMove?.(clip.id, pendingMoveStart);
    };

    const scheduleMove = () => {
      if (moveFrameId !== null) return;
      moveFrameId = window.requestAnimationFrame(() => {
        moveFrameId = null;
        if (Math.abs(pendingMoveStart - lastCommittedMoveStart) <= 0.000001) {
          return;
        }
        lastCommittedMoveStart = pendingMoveStart;
        onMove?.(clip.id, pendingMoveStart);
      });
    };

    const resolveSnappedStart = (rawStart: number) => {
      const rawEnd = rawStart + clipDuration;
      let bestDistance = snapThresholdSeconds + Number.EPSILON;
      let bestStart = rawStart;
      let bestTargetTime: number | null = null;

      for (const target of snapTargets) {
        if (target.clipId && selectedVideoClipIds.includes(target.clipId)) {
          continue;
        }

        const startDistance = Math.abs(rawStart - target.time);
        if (startDistance < bestDistance) {
          const candidateStart = rawStart + (target.time - rawStart);
          if (candidateStart >= 0) {
            bestDistance = startDistance;
            bestStart = candidateStart;
            bestTargetTime = target.time;
          }
        }

        const endDistance = Math.abs(rawEnd - target.time);
        if (endDistance < bestDistance) {
          const candidateStart = rawStart + (target.time - rawEnd);
          if (candidateStart >= 0) {
            bestDistance = endDistance;
            bestStart = candidateStart;
            bestTargetTime = target.time;
          }
        }
      }

      if (bestDistance <= snapThresholdSeconds) {
        return { start: bestStart, targetTime: bestTargetTime };
      }

      return { start: rawStart, targetTime: null };
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaTime = timelineDragDeltaSeconds(
        moveEvent.clientX,
        startX,
        width,
        duration,
        dragScroll,
      );

      const rawStart = Math.max(0, originalStart + deltaTime);
      const snapped = resolveSnappedStart(rawStart);
      latestTimelineStart = snapped.start;
      pendingMoveStart = latestTimelineStart;
      onSnapGuideChange?.(snapped.targetTime);
      // Native mousemove can outrun React/WebKit while Ripple is rebuilding
      // topology. One preview commit per animation frame keeps the clip and its
      // linked subtitles visually locked without queuing dozens of stale state
      // updates. Mouseup flushes the final pointer position synchronously.
      scheduleMove();

      const elements = document.elementsFromPoint(
        moveEvent.clientX,
        moveEvent.clientY,
      );

      const targetTrackElement = elements.find((element) =>
        element instanceof HTMLElement
          ? element.matches(".video-track[data-video-track-id]")
          : false,
      );

      if (
        !clip.compoundDisplay &&
        selectedVideoClipIds.length <= 1 &&
        targetTrackElement instanceof HTMLElement &&
        targetTrackElement.dataset.trackLocked !== "true" &&
        targetTrackElement.dataset.videoTrackId !== track.id
      ) {
        setExternalTrackPreview(
          targetTrackElement,
          latestTimelineStart,
          clipDuration,
          duration,
        );
      } else {
        clearExternalTrackPreview();
      }
    };

    const handleMouseUp = (upEvent: MouseEvent) => {
      flushPendingMove();
      setDraggingClipId(null);

      const elements = document.elementsFromPoint(
        upEvent.clientX,
        upEvent.clientY,
      );

      const targetTrackElement = elements.find((element) =>
        element instanceof HTMLElement
          ? element.matches(".video-track[data-video-track-id]")
          : false,
      );

      if (targetTrackElement instanceof HTMLElement) {
        const targetTrackId = targetTrackElement.dataset.videoTrackId;
        const targetLocked = targetTrackElement.dataset.trackLocked === "true";

        if (
          !clip.compoundDisplay &&
          selectedVideoClipIds.length <= 1 &&
          targetTrackId &&
          targetTrackId !== track.id &&
          !targetLocked
        ) {
          onMoveToTrack?.(clip.id, targetTrackId, latestTimelineStart);
        }
      }

      onSnapGuideChange?.(null);
      clearExternalTrackPreview();
      onMoveEnd?.();
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const startResize = (
    event: ReactMouseEvent<HTMLDivElement>,
    clip: VideoTimelineClip,
    edge: "left" | "right",
  ) => {
    if (track.locked) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const trackElement = event.currentTarget.parentElement?.parentElement;

    if (!trackElement || duration <= 0) {
      return;
    }

    // Start the edit guard before selection. Selecting a clip can trigger the
    // timeline's reveal-selection effect, so doing this in the opposite order
    // could horizontally shift the viewport at the instant a trim begins.
    if (onResizeStart?.(clip.id) === false) {
      return;
    }
    onSelect?.(clip.id, "single");
    setDraggingClipId(clip.id);

    const startX = event.clientX;
    const dragScroll = captureTimelineDragScroll(trackElement);
    const originalStart = clip.timelineStart;
    const originalEnd = clip.timelineEnd;
    const width = trackElement.getBoundingClientRect().width;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaTime = timelineDragDeltaSeconds(
        moveEvent.clientX,
        startX,
        width,
        duration,
        dragScroll,
      );

      if (edge === "left") {
        const nextStart = Math.max(
          0,
          Math.min(
            originalEnd - MIN_VIDEO_CLIP_DURATION,
            originalStart + deltaTime,
          ),
        );

        onResize?.(clip.id, nextStart, originalEnd);
        return;
      }

      const nextEnd = Math.max(
        originalStart + MIN_VIDEO_CLIP_DURATION,
        originalEnd + deltaTime,
      );

      /*
       * Do not clamp to the current visual workspace. If the user drags a
       * previously-trimmed edge farther right, the clip grows at the current
       * pixels-per-second scale and Timeline expands its canvas as needed.
       * Source-media limits are still enforced by the timeline model/hook.
       */
      onResize?.(clip.id, originalStart, nextEnd);
    };

    const handleMouseUp = () => {
      setDraggingClipId(null);
      onResizeEnd?.();
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const startFadeResize = (
    event: ReactMouseEvent<HTMLButtonElement>,
    clip: VideoTimelineClip,
    edge: "in" | "out",
  ) => {
    if (!onFadeChange || track.locked) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const clipElement = event.currentTarget.closest(
      ".timeline-video-clip",
    ) as HTMLElement | null;

    if (!clipElement) {
      return;
    }

    onFadeResizeStart?.();
    onSelect?.(clip.id);

    const rect = clipElement.getBoundingClientRect();
    const clipDuration = Math.max(
      MIN_VIDEO_CLIP_DURATION,
      clip.timelineEnd - clip.timelineStart,
    );
    const maxDuration = clipDuration;
    const originalDuration = Math.max(
      0,
      Math.min(
        maxDuration,
        edge === "in"
          ? (clip.videoFadeInDuration ?? 0)
          : (clip.videoFadeOutDuration ?? 0),
      ),
    );
    const startX = event.clientX;
    const dragScroll = captureTimelineDragScroll(clipElement);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaSeconds = timelineDragDeltaSeconds(
        moveEvent.clientX,
        startX,
        rect.width,
        clipDuration,
        dragScroll,
      );
      const nextDuration = Math.max(
        0,
        Math.min(
          maxDuration,
          edge === "in"
            ? originalDuration + deltaSeconds
            : originalDuration - deltaSeconds,
        ),
      );

      setFadeDrag({ clipId: clip.id, edge, duration: nextDuration });
      onFadeChange(clip.id, edge, nextDuration);
    };

    const handleMouseUp = () => {
      setFadeDrag(null);
      onFadeResizeEnd?.();
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const startTransitionResize = (
    event: ReactMouseEvent<HTMLButtonElement>,
    clip: VideoTimelineClip,
    edge: "in" | "out",
  ) => {
    if (!onTransitionChange || track.locked) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const clipElement = event.currentTarget.closest(
      ".timeline-video-clip",
    ) as HTMLElement | null;

    if (!clipElement) {
      return;
    }

    const rect = clipElement.getBoundingClientRect();
    const clipDuration = Math.max(
      MIN_VIDEO_CLIP_DURATION,
      clip.timelineEnd - clip.timelineStart,
    );
    const maxDuration = Math.max(0.1, Math.min(5, clipDuration / 2));
    const originalDuration = Math.max(
      0.1,
      Math.min(
        maxDuration,
        edge === "in"
          ? (clip.transitionInDuration ?? 0.5)
          : (clip.transitionOutDuration ?? 0.5),
      ),
    );
    const startX = event.clientX;
    const dragScroll = captureTimelineDragScroll(clipElement);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaSeconds = timelineDragDeltaSeconds(
        moveEvent.clientX,
        startX,
        rect.width,
        clipDuration,
        dragScroll,
      );
      const nextDuration = Math.max(
        0.1,
        Math.min(
          maxDuration,
          edge === "in"
            ? originalDuration + deltaSeconds
            : originalDuration - deltaSeconds,
        ),
      );

      onTransitionChange(clip.id, edge, { duration: nextDuration });
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const startAdjustmentMove = (
    event: ReactMouseEvent<HTMLDivElement>,
    layer: AdjustmentLayerClip,
  ) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".adjustment-resize-handle"))
      return;

    event.preventDefault();
    event.stopPropagation();
    onAdjustmentLayerSelect?.(layer.id);
    if (track.locked || onAdjustmentLayerEditStart?.(layer.id) === false)
      return;

    const trackElement = event.currentTarget.parentElement;
    if (!trackElement || duration <= 0) return;

    setDraggingAdjustmentId(layer.id);
    setAdjustmentGestureMode("move");
    const startX = event.clientX;
    const dragScroll = captureTimelineDragScroll(trackElement);
    const originalStart = layer.timelineStart;
    const layerDuration = Math.max(
      MIN_VIDEO_CLIP_DURATION,
      layer.timelineEnd - layer.timelineStart,
    );
    const width = trackElement.getBoundingClientRect().width;
    const snapThresholdSeconds =
      (VIDEO_MOVE_SNAP_THRESHOLD_PX / Math.max(1, width)) * duration;

    const handleMove = (moveEvent: MouseEvent) => {
      // If mouseup was swallowed by a native menu/window transition, never
      // leave the Adjustment Layer attached to the cursor.
      if ((moveEvent.buttons & 1) === 0) {
        finishGesture();
        return;
      }

      const delta = timelineDragDeltaSeconds(
        moveEvent.clientX,
        startX,
        width,
        duration,
        dragScroll,
      );
      const rawStart = Math.max(0, originalStart + delta);
      const rawEnd = rawStart + layerDuration;
      let bestStart = rawStart;
      let bestDistance = snapThresholdSeconds + Number.EPSILON;
      let bestTarget: number | null = null;

      for (const target of snapTargets) {
        if (target.clipId === layer.id) continue;
        for (const edge of [rawStart, rawEnd]) {
          const distance = Math.abs(edge - target.time);
          if (distance < bestDistance) {
            const candidate = rawStart + (target.time - edge);
            if (candidate >= 0) {
              bestDistance = distance;
              bestStart = candidate;
              bestTarget = target.time;
            }
          }
        }
      }

      if (bestDistance > snapThresholdSeconds) {
        bestStart = rawStart;
        bestTarget = null;
      }

      onSnapGuideChange?.(bestTarget);
      onAdjustmentLayerMove?.(layer.id, bestStart);
    };

    const finishGesture = () => {
      setDraggingAdjustmentId(null);
      setAdjustmentGestureMode(null);
      onSnapGuideChange?.(null);
      onAdjustmentLayerEditEnd?.();
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      window.removeEventListener("blur", finishGesture);
    };

    const handleUp = () => finishGesture();

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    window.addEventListener("blur", finishGesture);
  };

  const startAdjustmentResize = (
    event: ReactMouseEvent<HTMLDivElement>,
    layer: AdjustmentLayerClip,
    edge: "left" | "right",
  ) => {
    if (event.button !== 0 || track.locked) return;
    event.preventDefault();
    event.stopPropagation();
    onAdjustmentLayerSelect?.(layer.id);
    if (onAdjustmentLayerEditStart?.(layer.id) === false) return;

    const trackElement = event.currentTarget.parentElement?.parentElement;
    if (!trackElement || duration <= 0) return;

    setDraggingAdjustmentId(layer.id);
    setAdjustmentGestureMode(edge === "left" ? "resize-left" : "resize-right");

    const width = trackElement.getBoundingClientRect().width;
    const startX = event.clientX;
    const dragScroll = captureTimelineDragScroll(trackElement);
    const originalStart = layer.timelineStart;
    const originalEnd = layer.timelineEnd;
    const snapThresholdSeconds =
      (VIDEO_MOVE_SNAP_THRESHOLD_PX / Math.max(1, width)) * duration;

    const resolveSnappedEdge = (rawTime: number) => {
      let bestTime = rawTime;
      let bestDistance = snapThresholdSeconds + Number.EPSILON;
      let bestTarget: number | null = null;

      for (const target of snapTargets) {
        if (target.clipId === layer.id) continue;
        const distance = Math.abs(rawTime - target.time);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestTime = target.time;
          bestTarget = target.time;
        }
      }

      if (bestDistance > snapThresholdSeconds) {
        return { time: rawTime, target: null as number | null };
      }

      return { time: bestTime, target: bestTarget };
    };

    const handleMove = (moveEvent: MouseEvent) => {
      // Native/context interactions can occasionally swallow mouseup. Stop the
      // trim immediately if the primary button is no longer held.
      if ((moveEvent.buttons & 1) === 0) {
        finishGesture();
        return;
      }

      const delta = timelineDragDeltaSeconds(
        moveEvent.clientX,
        startX,
        width,
        duration,
        dragScroll,
      );

      if (edge === "left") {
        const rawStart = Math.max(
          0,
          Math.min(
            originalEnd - MIN_VIDEO_CLIP_DURATION,
            originalStart + delta,
          ),
        );
        const snapped = resolveSnappedEdge(rawStart);
        const nextStart = Math.max(
          0,
          Math.min(originalEnd - MIN_VIDEO_CLIP_DURATION, snapped.time),
        );
        onSnapGuideChange?.(
          snapped.target === nextStart ? snapped.target : null,
        );
        onAdjustmentLayerResize?.(layer.id, nextStart, originalEnd);
        return;
      }

      const rawEnd = Math.max(
        originalStart + MIN_VIDEO_CLIP_DURATION,
        originalEnd + delta,
      );
      const snapped = resolveSnappedEdge(rawEnd);
      const nextEnd = Math.max(
        originalStart + MIN_VIDEO_CLIP_DURATION,
        snapped.time,
      );
      onSnapGuideChange?.(snapped.target === nextEnd ? snapped.target : null);
      onAdjustmentLayerResize?.(layer.id, originalStart, nextEnd);
    };

    const finishGesture = () => {
      setDraggingAdjustmentId(null);
      setAdjustmentGestureMode(null);
      onSnapGuideChange?.(null);
      onAdjustmentLayerEditEnd?.();
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      window.removeEventListener("blur", finishGesture);
    };

    const handleUp = () => finishGesture();

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    window.addEventListener("blur", finishGesture);
  };

  return (
    <div
      className={`timeline-row timeline-video-row ${showLabel ? "" : "track-only"}`.trim()}
    >
      {showLabel && (
        <TimelineTrackLabel
          shortLabel={track.shortLabel}
          name={track.name}
          locked={track.locked}
          hidden={track.hidden}
          canHide
          onToggleLock={() => onToggleLock?.(track.id)}
          onToggleHidden={() => onToggleHidden?.(track.id)}
        />
      )}

      <div
        className={[
          "video-track",
          track.locked ? "locked" : "",
          track.hidden ? "track-hidden" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-video-track-id={track.id}
        data-track-locked={track.locked ? "true" : "false"}
        onClick={handleTrackClick}
      >
        {adjustmentLayers.map((layer) => {
          const left =
            duration > 0 ? (layer.timelineStart / duration) * 100 : 0;
          const width =
            duration > 0
              ? ((layer.timelineEnd - layer.timelineStart) / duration) * 100
              : 0;
          const selected = selectedAdjustmentLayerId === layer.id;
          const dragging = draggingAdjustmentId === layer.id;

          return (
            <div
              key={layer.id}
              className={[
                "timeline-adjustment-layer",
                selected ? "selected" : "",
                dragging ? "dragging" : "",
                dragging && adjustmentGestureMode?.startsWith("resize")
                  ? "resizing"
                  : "",
                dragging && adjustmentGestureMode === "resize-left"
                  ? "resizing-left"
                  : "",
                dragging && adjustmentGestureMode === "resize-right"
                  ? "resizing-right"
                  : "",
                layer.enabled === false ? "disabled" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ left: `${left}%`, width: `${width}%` }}
              data-adjustment-layer-id={layer.id}
              title={`${layer.name} · drag to move · drag either edge to trim · double-click for controls`}
              onMouseDown={(event) => startAdjustmentMove(event, layer)}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onAdjustmentLayerOpen?.(layer.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onAdjustmentLayerSelect?.(layer.id);
                if (!canShowNativeContextMenu()) {
                  onAdjustmentLayerOpen?.(layer.id);
                  return;
                }
                void showNativeContextMenu([
                  {
                    id: `adjustment.${layer.id}.controls`,
                    text: "Open Adjustment Controls",
                    action: () => onAdjustmentLayerOpen?.(layer.id),
                  },
                ]).catch((error) => {
                  console.error(
                    "Failed to show adjustment layer context menu:",
                    error,
                  );
                });
              }}
            >
              <div
                className="adjustment-resize-handle left"
                onMouseDown={(event) =>
                  startAdjustmentResize(event, layer, "left")
                }
              />
              <div className="timeline-adjustment-layer-header">
                <span className="timeline-adjustment-icon" aria-hidden="true">
                  ◇
                </span>
                <strong>{layer.name}</strong>
                <span className="timeline-adjustment-badge">
                  {layer.enabled === false ? "OFF" : "ADJ"}
                </span>
              </div>
              <div className="timeline-adjustment-summary">
                <span>
                  {Math.max(0, layer.timelineEnd - layer.timelineStart).toFixed(
                    2,
                  )}
                  s
                </span>
                <span>Opacity {Math.round(layer.opacity)}%</span>
                <span>
                  Exp {layer.exposure > 0 ? "+" : ""}
                  {layer.exposure.toFixed(1)}
                </span>
                <span>Sat {Math.round(layer.saturation)}%</span>
              </div>
              {dragging && adjustmentGestureMode && (
                <div className="adjustment-edit-readout" aria-hidden="true">
                  {adjustmentGestureMode === "move"
                    ? `${layer.timelineStart.toFixed(2)}s → ${layer.timelineEnd.toFixed(2)}s`
                    : `${(layer.timelineEnd - layer.timelineStart).toFixed(2)}s`}
                </div>
              )}
              {allAdjustmentLayerKeyframeTimes(layer).length > 0 && (
                <div
                  className="adjustment-keyframe-strip"
                  aria-label={`${layer.name} keyframes`}
                >
                  {allAdjustmentLayerKeyframeTimes(layer).map(
                    (relativeTime) => {
                      const absoluteTime = layer.timelineStart + relativeTime;
                      const markerLeft =
                        layer.timelineEnd > layer.timelineStart
                          ? (relativeTime /
                              (layer.timelineEnd - layer.timelineStart)) *
                            100
                          : 0;
                      const count = adjustmentLayerKeyframeCountAtTime(
                        layer,
                        relativeTime,
                      );
                      const active =
                        Math.abs(currentTime - absoluteTime) <=
                        ADJUSTMENT_KEYFRAME_EPSILON;
                      return (
                        <button
                          type="button"
                          key={relativeTime}
                          className={`adjustment-keyframe-marker ${active ? "active" : ""}`.trim()}
                          style={{ left: `${markerLeft}%` }}
                          title={`${count} keyframe${count === 1 ? "" : "s"} at ${absoluteTime.toFixed(2)}s`}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onAdjustmentLayerSelect?.(layer.id);
                            onSeek?.(absoluteTime);
                          }}
                        >
                          ◆
                        </button>
                      );
                    },
                  )}
                </div>
              )}
              <div
                className="adjustment-resize-handle right"
                onMouseDown={(event) =>
                  startAdjustmentResize(event, layer, "right")
                }
              />
            </div>
          );
        })}

        {videoClips.map((clip) => {
          const left = duration > 0 ? (clip.timelineStart / duration) * 100 : 0;

          const width =
            duration > 0
              ? ((clip.timelineEnd - clip.timelineStart) / duration) * 100
              : 0;

          const isSelected = selectedVideoClipIds.includes(clip.id);
          const isPrimarySelected = clip.id === selectedVideoClipId;
          const isDragging = clip.id === draggingClipId;
          const isGroupDragging = draggingClipId !== null && isSelected;
          const frames = framesByClipId[clip.id] ?? [];
          const clipDuration = Math.max(
            MIN_VIDEO_CLIP_DURATION,
            clip.timelineEnd - clip.timelineStart,
          );
          const transitionInDuration = Math.min(
            clipDuration / 2,
            clip.transitionInDuration ?? 0.5,
          );
          const transitionOutDuration = Math.min(
            clipDuration / 2,
            clip.transitionOutDuration ?? 0.5,
          );
          const transitionInWidth = Math.min(
            50,
            (transitionInDuration / clipDuration) * 100,
          );
          const transitionOutWidth = Math.min(
            50,
            (transitionOutDuration / clipDuration) * 100,
          );
          const videoFadeInDuration = Math.max(
            0,
            Math.min(clipDuration, clip.videoFadeInDuration ?? 0),
          );
          const videoFadeOutDuration = Math.max(
            0,
            Math.min(clipDuration, clip.videoFadeOutDuration ?? 0),
          );
          const videoFadeInWidth = (videoFadeInDuration / clipDuration) * 100;
          const videoFadeOutWidth = (videoFadeOutDuration / clipDuration) * 100;
          const isExpandedCompoundMember =
            !!expandedCompoundId && clip.compoundId === expandedCompoundId;
          const transformKeyframeTimes =
            isSelected && !clip.compoundDisplay
              ? allVideoTransformKeyframeTimes(clip)
              : [];

          return (
            <div
              key={clip.id}
              className={[
                "timeline-video-clip",
                isSelected ? "selected" : "",
                isPrimarySelected ? "primary-selected" : "",
                isDragging ? "dragging" : "",
                isGroupDragging && !isDragging ? "group-dragging" : "",
                clip.compoundDisplay ? "compound-clip" : "",
                isExpandedCompoundMember ? "compound-member" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                left: `${left}%`,
                width: `${width}%`,
              }}
              data-video-clip-id={clip.id}
              data-compound-id={
                clip.compoundDisplay ? clip.compoundId : undefined
              }
              onDoubleClick={(event) => {
                if (!clip.compoundDisplay || !clip.compoundId) return;
                event.preventDefault();
                event.stopPropagation();
                onOpenCompound?.(clip.compoundId);
              }}
              onContextMenu={(event) => {
                if (!onRevealClip || !canShowNativeContextMenu()) return;
                event.preventDefault();
                event.stopPropagation();
                // Context-menu actions target `clip` directly. Do not change
                // selection here: selection reveal can horizontally scroll the
                // timeline just from opening the menu, which feels like the clip
                // moved underneath the pointer.
                void showNativeContextMenu([
                  {
                    id: `video-clip.${clip.id}.reveal`,
                    text: "Reveal in Timeline",
                    action: () => onRevealClip(clip),
                  },
                  {
                    id: `video-clip.${clip.id}.restore-subtitles`,
                    text: "Restore Missing Subtitles",
                    enabled:
                      !clip.compoundDisplay &&
                      clip.freezeFrameSourceTime === undefined &&
                      !!onRegenerateMissingSubtitles,
                    action: () => {
                      void onRegenerateMissingSubtitles?.(clip);
                    },
                  },
                ]).catch((error) => {
                  console.error(
                    "Failed to show native video clip context menu:",
                    error,
                  );
                });
              }}
              title={
                clip.compoundDisplay
                  ? `${clip.sourceName} · ${clip.compoundMemberCount ?? 0} members · double-click to open`
                  : `${clip.sourceName} · ${clip.sourceIn.toFixed(2)}–${clip.sourceOut.toFixed(2)} s · ${videoPlaybackRate(clip)}× · ${track.shortLabel}`
              }
              onMouseDown={(event) => startMove(event, clip)}
              onClick={(event) => {
                event.stopPropagation();

                if (event.shiftKey) {
                  return;
                }

                const trackElement = event.currentTarget.parentElement;
                const time = trackElement
                  ? timeFromClientX(event.clientX, trackElement)
                  : clip.timelineStart;

                onPasteTargetChange?.(track.id, time);
                onSeek?.(time);
              }}
            >
              {transformKeyframeTimes.length > 0 && (
                <div className="timeline-video-keyframes" aria-hidden="true">
                  {transformKeyframeTimes.map((time) => (
                    <span
                      key={`${clip.id}-keyframe-${time.toFixed(4)}`}
                      className="timeline-video-keyframe-marker"
                      style={{
                        left: `${Math.max(0, Math.min(100, (time / clipDuration) * 100))}%`,
                      }}
                    />
                  ))}
                </div>
              )}

              <div
                className="video-resize-handle left"
                onMouseDown={(event) => startResize(event, clip, "left")}
              />

              <div className="timeline-video-clip-header">
                {clip.compoundDisplay ? (
                  <div className="timeline-compound-header">
                    <span
                      className="timeline-compound-stack-icon"
                      aria-hidden="true"
                    >
                      <svg viewBox="0 0 20 20">
                        <path d="M4.5 7.2 10 4l5.5 3.2L10 10.4 4.5 7.2Z" />
                        <path d="m4.5 10.1 5.5 3.2 5.5-3.2" />
                        <path d="m4.5 13 5.5 3.2 5.5-3.2" />
                      </svg>
                    </span>
                    <span className="timeline-compound-title">
                      {clip.sourceName}
                    </span>
                    <span className="timeline-video-speed-badge compound-badge">
                      CMPD
                    </span>
                  </div>
                ) : (
                  <span className="timeline-video-clip-name">
                    {clip.sourceName}
                  </span>
                )}

                {!clip.compoundDisplay &&
                  (clip.freezeFrameSourceTime !== undefined ? (
                    <span className="timeline-video-speed-badge">HOLD</span>
                  ) : (
                    <>
                      {clip.playbackDirection === "reverse" && (
                        <span className="timeline-video-speed-badge">REV</span>
                      )}
                      {Math.abs(videoPlaybackRate(clip) - 1) > 0.0001 && (
                        <span className="timeline-video-speed-badge">
                          {videoPlaybackRate(clip)}×
                        </span>
                      )}
                    </>
                  ))}

                {currentTime >= clip.timelineStart &&
                  currentTime <= clip.timelineEnd && (
                    <span className="timeline-video-active-dot" />
                  )}
              </div>

              <div className="timeline-video-fade-layer" aria-hidden="true">
                {!clip.compoundDisplay && videoFadeInDuration > 0 && (
                  <div
                    className="clip-fade-region video in"
                    style={{ width: `${videoFadeInWidth}%` }}
                  >
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                      <path d="M0 100 C22 100 38 0 100 0" />
                    </svg>
                  </div>
                )}
                {!clip.compoundDisplay && videoFadeOutDuration > 0 && (
                  <div
                    className="clip-fade-region video out"
                    style={{ width: `${videoFadeOutWidth}%` }}
                  >
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                      <path d="M0 0 C62 0 78 100 100 100" />
                    </svg>
                  </div>
                )}
              </div>

              {!clip.compoundDisplay && !track.locked && onFadeChange && (
                <>
                  <button
                    type="button"
                    className={[
                      "clip-fade-handle",
                      "video",
                      "in",
                      fadeDrag?.clipId === clip.id && fadeDrag.edge === "in"
                        ? "active"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{
                      left: `${videoFadeInWidth}%`,
                    }}
                    onMouseDown={(event) => startFadeResize(event, clip, "in")}
                    onClick={(event) => event.stopPropagation()}
                    title={`Video fade in · ${videoFadeInDuration.toFixed(2)}s`}
                    aria-label="Adjust video fade in"
                  />
                  <button
                    type="button"
                    className={[
                      "clip-fade-handle",
                      "video",
                      "out",
                      fadeDrag?.clipId === clip.id && fadeDrag.edge === "out"
                        ? "active"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{
                      right: `${videoFadeOutWidth}%`,
                    }}
                    onMouseDown={(event) => startFadeResize(event, clip, "out")}
                    onClick={(event) => event.stopPropagation()}
                    title={`Video fade out · ${videoFadeOutDuration.toFixed(2)}s`}
                    aria-label="Adjust video fade out"
                  />
                </>
              )}

              {!clip.compoundDisplay && fadeDrag?.clipId === clip.id && (
                <span
                  className={`clip-fade-duration-label ${fadeDrag.edge}`}
                  style={
                    fadeDrag.edge === "in"
                      ? { left: `${(fadeDrag.duration / clipDuration) * 100}%` }
                      : {
                          right: `${(fadeDrag.duration / clipDuration) * 100}%`,
                        }
                  }
                >
                  {fadeDrag.duration.toFixed(2)}s
                </span>
              )}

              {!clip.compoundDisplay &&
                (clip.transitionInType ?? "none") !== "none" && (
                  <div
                    className={`timeline-video-transition-region in ${clip.transitionInType}`}
                    style={{ width: `${transitionInWidth}%` }}
                    title={`${clip.transitionInType === "fade-black" ? "Fade from Black" : "Cross Dissolve"} · ${transitionInDuration.toFixed(1)}s`}
                    onMouseDown={(event) => event.stopPropagation()}
                  >
                    <span className="timeline-video-transition-label">
                      {clip.transitionInType === "fade-black" ? "B" : "D"}
                    </span>
                    {!track.locked && (
                      <button
                        type="button"
                        className="timeline-video-transition-handle in"
                        onMouseDown={(event) =>
                          startTransitionResize(event, clip, "in")
                        }
                        aria-label="Adjust transition in duration"
                      />
                    )}
                  </div>
                )}

              {!clip.compoundDisplay &&
                (clip.transitionOutType ?? "none") !== "none" && (
                  <div
                    className={`timeline-video-transition-region out ${clip.transitionOutType}`}
                    style={{ width: `${transitionOutWidth}%` }}
                    title={`${clip.transitionOutType === "fade-black" ? "Fade to Black" : "Cross Dissolve"} · ${transitionOutDuration.toFixed(1)}s`}
                    onMouseDown={(event) => event.stopPropagation()}
                  >
                    <span className="timeline-video-transition-label">
                      {clip.transitionOutType === "fade-black" ? "B" : "D"}
                    </span>
                    {!track.locked && (
                      <button
                        type="button"
                        className="timeline-video-transition-handle out"
                        onMouseDown={(event) =>
                          startTransitionResize(event, clip, "out")
                        }
                        aria-label="Adjust transition out duration"
                      />
                    )}
                  </div>
                )}

              <div className="timeline-video-clip-frame-area">
                {clip.compoundDisplay ? (
                  <div className="timeline-compound-summary" aria-hidden="true">
                    <span className="timeline-compound-member-count">
                      {clip.compoundMemberCount ?? 0} items
                    </span>
                    <span className="timeline-compound-separator">•</span>
                    <small>Double-click to open</small>
                  </div>
                ) : frames.length > 0 ? (
                  <div
                    className="timeline-video-frame-strip"
                    aria-hidden="true"
                  >
                    {frames.map((frame, index) => (
                      <span
                        key={`${clip.id}-frame-${index}`}
                        className="timeline-video-frame-slot"
                        style={{
                          left: `${frame.leftPercent}%`,
                          width: `${frame.widthPercent}%`,
                        }}
                      >
                        <img
                          className="timeline-video-frame-image"
                          src={frame.url}
                          alt=""
                          draggable={false}
                        />
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="timeline-video-filmstrip" aria-hidden="true">
                    {Array.from({ length: 8 }).map((_, index) => (
                      <span key={index} />
                    ))}
                  </div>
                )}
              </div>

              <div
                className="video-resize-handle right"
                onMouseDown={(event) => startResize(event, clip, "right")}
              />
            </div>
          );
        })}

        {videoClips.length === 0 && (
          <span className="timeline-empty-track">Empty {track.shortLabel}</span>
        )}
      </div>
    </div>
  );
}

export default VideoTrack;
