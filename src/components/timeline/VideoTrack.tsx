import {
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import type {
  TimelineTrack,
  TimelineTrackId,
  VideoTimelineClip,
  VideoTransitionType,
} from "../../types/timelineModel";
import type { VideoClipFrames } from "../../hooks/useVideoClipFrames";
import { getActiveMediaDrag } from "../../utils/mediaDrag";

import TimelineTrackLabel from "./TimelineTrackLabel";

type VideoTrackProps = {
  duration: number;
  currentTime: number;
  track: TimelineTrack;
  selectedVideoClipId: string | null;
  framesByClipId: VideoClipFrames;

  onSeek?: (time: number) => void;
  onSelect?: (id: string) => void;
  onMove?: (
    id: string,
    newTimelineStart: number,
  ) => void;
  onMoveToTrack?: (
    id: string,
    targetTrackId: TimelineTrackId,
    newTimelineStart: number,
  ) => void;
  onMediaDrop?: (
    assetId: string,
    targetTrackId: TimelineTrackId,
    timelineTime: number,
  ) => void;
  onResize?: (
    id: string,
    newTimelineStart: number,
    newTimelineEnd: number,
  ) => void;
  onToggleLock?: (trackId: TimelineTrackId) => void;
  onToggleHidden?: (trackId: TimelineTrackId) => void;
  onTransitionChange?: (
    id: string,
    edge: "in" | "out",
    transition: { type?: VideoTransitionType; duration?: number },
  ) => void;
};

const MIN_VIDEO_CLIP_DURATION = 0.1;

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
  selectedVideoClipId,
  framesByClipId,
  onSeek,
  onSelect,
  onMove,
  onMoveToTrack,
  onMediaDrop,
  onResize,
  onToggleLock,
  onToggleHidden,
  onTransitionChange,
}: VideoTrackProps) {
  const [draggingClipId, setDraggingClipId] =
    useState<string | null>(null);
  const [mediaDropPreview, setMediaDropPreview] = useState<{
    timelineStart: number;
    duration: number;
  } | null>(null);

  const videoClips = track.clips.filter(
    (clip): clip is VideoTimelineClip => clip.kind === "video",
  );

  const timeFromClientX = (
    clientX: number,
    element: HTMLElement,
  ) => {
    if (duration <= 0) {
      return 0;
    }

    const rect = element.getBoundingClientRect();
    const ratio = (clientX - rect.left) / Math.max(1, rect.width);

    return Math.max(0, Math.min(duration, ratio * duration));
  };

  const handleTrackClick = (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    if (
      duration <= 0 ||
      (event.target as HTMLElement).closest(".timeline-video-clip")
    ) {
      return;
    }

    onSeek?.(timeFromClientX(event.clientX, event.currentTarget));
  };

  const startMove = (
    event: ReactMouseEvent<HTMLDivElement>,
    clip: VideoTimelineClip,
  ) => {
    if (
      track.locked ||
      (event.target as HTMLElement).closest(".video-resize-handle")
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const trackElement = event.currentTarget.parentElement;

    if (!trackElement || duration <= 0) {
      return;
    }

    onSelect?.(clip.id);
    setDraggingClipId(clip.id);

    const startX = event.clientX;
    const originalStart = clip.timelineStart;
    const clipDuration = clip.timelineEnd - clip.timelineStart;
    const width = trackElement.getBoundingClientRect().width;
    let latestTimelineStart = originalStart;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaTime =
        ((moveEvent.clientX - startX) / width) * duration;

      latestTimelineStart = Math.max(0, originalStart + deltaTime);
      onMove?.(clip.id, latestTimelineStart);

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
        const targetLocked =
          targetTrackElement.dataset.trackLocked === "true";

        if (
          targetTrackId &&
          targetTrackId !== track.id &&
          !targetLocked
        ) {
          onMoveToTrack?.(
            clip.id,
            targetTrackId,
            latestTimelineStart,
          );
        }
      }

      clearExternalTrackPreview();
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

    onSelect?.(clip.id);
    setDraggingClipId(clip.id);

    const startX = event.clientX;
    const originalStart = clip.timelineStart;
    const originalEnd = clip.timelineEnd;
    const width = trackElement.getBoundingClientRect().width;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaTime =
        ((moveEvent.clientX - startX) / width) * duration;

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

      const nextEnd = Math.min(
        duration,
        Math.max(
          originalStart + MIN_VIDEO_CLIP_DURATION,
          originalEnd + deltaTime,
        ),
      );

      onResize?.(clip.id, originalStart, nextEnd);
    };

    const handleMouseUp = () => {
      setDraggingClipId(null);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleMediaDragOver = (
    event: ReactDragEvent<HTMLDivElement>,
  ) => {
    const payload = getActiveMediaDrag();

    if (!payload || payload.duration <= 0 || track.locked) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";

    setMediaDropPreview({
      timelineStart: timeFromClientX(event.clientX, event.currentTarget),
      duration: payload.duration,
    });
  };

  const handleMediaDragLeave = (
    event: ReactDragEvent<HTMLDivElement>,
  ) => {
    const related = event.relatedTarget;

    if (
      related instanceof Node &&
      event.currentTarget.contains(related)
    ) {
      return;
    }

    setMediaDropPreview(null);
  };

  const handleMediaDrop = (
    event: ReactDragEvent<HTMLDivElement>,
  ) => {
    const payload = getActiveMediaDrag();

    if (!payload || track.locked) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const timelineTime = timeFromClientX(
      event.clientX,
      event.currentTarget,
    );

    setMediaDropPreview(null);
    onMediaDrop?.(payload.assetId, track.id, timelineTime);
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
          ? clip.transitionInDuration ?? 0.5
          : clip.transitionOutDuration ?? 0.5,
      ),
    );
    const startX = event.clientX;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaSeconds =
        ((moveEvent.clientX - startX) / Math.max(1, rect.width)) * clipDuration;
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

  return (
    <div className="timeline-row timeline-video-row">
      <TimelineTrackLabel
        shortLabel={track.shortLabel}
        name={track.name}
        locked={track.locked}
        hidden={track.hidden}
        canHide
        onToggleLock={() => onToggleLock?.(track.id)}
        onToggleHidden={() => onToggleHidden?.(track.id)}
      />

      <div
        className={[
          "video-track",
          track.locked ? "locked" : "",
          track.hidden ? "track-hidden" : "",
          mediaDropPreview ? "media-drag-target" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-video-track-id={track.id}
        data-track-locked={track.locked ? "true" : "false"}
        onClick={handleTrackClick}
        onDragOver={handleMediaDragOver}
        onDragLeave={handleMediaDragLeave}
        onDrop={handleMediaDrop}
      >
        {mediaDropPreview && duration > 0 && (
          <div
            className="timeline-drop-preview"
            style={{
              left: `${(mediaDropPreview.timelineStart / duration) * 100}%`,
              width: `${Math.max(
                0.6,
                (mediaDropPreview.duration / duration) * 100,
              )}%`,
            }}
            aria-hidden="true"
          />
        )}

        {videoClips.map((clip) => {
          const left =
            duration > 0
              ? (clip.timelineStart / duration) * 100
              : 0;

          const width =
            duration > 0
              ? ((clip.timelineEnd - clip.timelineStart) / duration) * 100
              : 0;

          const isSelected = clip.id === selectedVideoClipId;
          const isDragging = clip.id === draggingClipId;
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
          const transitionInWidth = Math.min(50, (transitionInDuration / clipDuration) * 100);
          const transitionOutWidth = Math.min(50, (transitionOutDuration / clipDuration) * 100);

          return (
            <div
              key={clip.id}
              className={[
                "timeline-video-clip",
                isSelected ? "selected" : "",
                isDragging ? "dragging" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                left: `${left}%`,
                width: `${width}%`,
              }}
              title={`${clip.sourceName} · ${clip.sourceIn.toFixed(
                2,
              )}–${clip.sourceOut.toFixed(2)} s · ${track.shortLabel}`}
              onMouseDown={(event) => startMove(event, clip)}
              onClick={(event) => {
                event.stopPropagation();
                onSelect?.(clip.id);
                onSeek?.(clip.timelineStart);
              }}
            >
              <div
                className="video-resize-handle left"
                onMouseDown={(event) => startResize(event, clip, "left")}
              />

              <div className="timeline-video-clip-header">
                <span className="timeline-video-clip-name">
                  {clip.sourceName}
                </span>

                {currentTime >= clip.timelineStart &&
                  currentTime <= clip.timelineEnd && (
                    <span className="timeline-video-active-dot" />
                  )}
              </div>

              {(clip.transitionInType ?? "none") !== "none" && (
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
                      onMouseDown={(event) => startTransitionResize(event, clip, "in")}
                      aria-label="Adjust transition in duration"
                    />
                  )}
                </div>
              )}

              {(clip.transitionOutType ?? "none") !== "none" && (
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
                      onMouseDown={(event) => startTransitionResize(event, clip, "out")}
                      aria-label="Adjust transition out duration"
                    />
                  )}
                </div>
              )}

              <div className="timeline-video-clip-frame-area">
                {frames.length > 0 ? (
                  <div
                    className="timeline-video-frame-strip"
                    aria-hidden="true"
                  >
                    {frames.map((frame, index) => (
                      <img
                        key={`${clip.id}-frame-${index}`}
                        src={frame}
                        alt=""
                        draggable={false}
                      />
                    ))}
                  </div>
                ) : (
                  <div
                    className="timeline-video-filmstrip"
                    aria-hidden="true"
                  >
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
