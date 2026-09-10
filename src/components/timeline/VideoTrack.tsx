import {
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import type {
  TimelineTrack,
  VideoTimelineClip,
} from "../../types/timelineModel";

import TimelineTrackLabel from "./TimelineTrackLabel";

type VideoTrackProps = {
  duration: number;
  currentTime: number;
  track: TimelineTrack;
  selectedVideoClipId: string | null;

  onSeek?: (time: number) => void;
  onSelect?: (id: string) => void;
  onMove?: (
    id: string,
    newTimelineStart: number,
  ) => void;
  onResize?: (
    id: string,
    newTimelineStart: number,
    newTimelineEnd: number,
  ) => void;
};

const MIN_VIDEO_CLIP_DURATION = 0.1;

function VideoTrack({
  duration,
  currentTime,
  track,
  selectedVideoClipId,
  onSeek,
  onSelect,
  onMove,
  onResize,
}: VideoTrackProps) {
  const [draggingClipId, setDraggingClipId] =
    useState<string | null>(null);

  const videoClips = track.clips.filter(
    (clip): clip is VideoTimelineClip =>
      clip.kind === "video",
  );

  const handleTrackClick = (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    if (
      duration <= 0 ||
      (event.target as HTMLElement).closest(
        ".timeline-video-clip",
      )
    ) {
      return;
    }

    const rect =
      event.currentTarget.getBoundingClientRect();

    const ratio =
      (event.clientX - rect.left) / rect.width;

    onSeek?.(
      Math.max(
        0,
        Math.min(duration, ratio * duration),
      ),
    );
  };

  const startMove = (
    event: ReactMouseEvent<HTMLDivElement>,
    clip: VideoTimelineClip,
  ) => {
    if (
      (event.target as HTMLElement).closest(
        ".video-resize-handle",
      )
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const trackElement =
      event.currentTarget.parentElement;

    if (!trackElement || duration <= 0) {
      return;
    }

    onSelect?.(clip.id);
    setDraggingClipId(clip.id);

    const startX = event.clientX;
    const originalStart = clip.timelineStart;
    const width =
      trackElement.getBoundingClientRect().width;

    const handleMouseMove = (
      moveEvent: MouseEvent,
    ) => {
      const deltaTime =
        ((moveEvent.clientX - startX) / width) *
        duration;

      onMove?.(
        clip.id,
        originalStart + deltaTime,
      );
    };

    const handleMouseUp = () => {
      setDraggingClipId(null);

      window.removeEventListener(
        "mousemove",
        handleMouseMove,
      );
      window.removeEventListener(
        "mouseup",
        handleMouseUp,
      );
    };

    window.addEventListener(
      "mousemove",
      handleMouseMove,
    );
    window.addEventListener(
      "mouseup",
      handleMouseUp,
    );
  };

  const startResize = (
    event: ReactMouseEvent<HTMLDivElement>,
    clip: VideoTimelineClip,
    edge: "left" | "right",
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const trackElement =
      event.currentTarget.parentElement?.parentElement;

    if (!trackElement || duration <= 0) {
      return;
    }

    onSelect?.(clip.id);
    setDraggingClipId(clip.id);

    const startX = event.clientX;
    const originalStart = clip.timelineStart;
    const originalEnd = clip.timelineEnd;
    const width =
      trackElement.getBoundingClientRect().width;

    const handleMouseMove = (
      moveEvent: MouseEvent,
    ) => {
      const deltaTime =
        ((moveEvent.clientX - startX) / width) *
        duration;

      if (edge === "left") {
        const nextStart = Math.max(
          0,
          Math.min(
            originalEnd -
              MIN_VIDEO_CLIP_DURATION,
            originalStart + deltaTime,
          ),
        );

        onResize?.(
          clip.id,
          nextStart,
          originalEnd,
        );
        return;
      }

      const nextEnd = Math.max(
        originalStart +
          MIN_VIDEO_CLIP_DURATION,
        originalEnd + deltaTime,
      );

      onResize?.(
        clip.id,
        originalStart,
        nextEnd,
      );
    };

    const handleMouseUp = () => {
      setDraggingClipId(null);

      window.removeEventListener(
        "mousemove",
        handleMouseMove,
      );
      window.removeEventListener(
        "mouseup",
        handleMouseUp,
      );
    };

    window.addEventListener(
      "mousemove",
      handleMouseMove,
    );
    window.addEventListener(
      "mouseup",
      handleMouseUp,
    );
  };

  return (
    <div className="timeline-row timeline-video-row">
      <TimelineTrackLabel
        shortLabel={track.shortLabel}
        name={track.name}
        locked={track.locked}
      />

      <div
        className="video-track"
        onClick={handleTrackClick}
      >
        {videoClips.map((clip) => {
          const left =
            duration > 0
              ? (clip.timelineStart / duration) *
                100
              : 0;

          const width =
            duration > 0
              ? ((clip.timelineEnd -
                  clip.timelineStart) /
                  duration) *
                100
              : 0;

          const isSelected =
            clip.id === selectedVideoClipId;
          const isDragging =
            clip.id === draggingClipId;

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
              )}–${clip.sourceOut.toFixed(2)} s`}
              onMouseDown={(event) =>
                startMove(event, clip)
              }
              onClick={(event) => {
                event.stopPropagation();
                onSelect?.(clip.id);
                onSeek?.(clip.timelineStart);
              }}
            >
              <div
                className="video-resize-handle left"
                onMouseDown={(event) =>
                  startResize(event, clip, "left")
                }
              />

              <div className="timeline-video-filmstrip">
                {Array.from({
                  length: Math.max(
                    4,
                    Math.min(
                      14,
                      Math.ceil(
                        clip.timelineEnd -
                          clip.timelineStart,
                      ),
                    ),
                  ),
                }).map((_, index) => (
                  <span key={index} />
                ))}
              </div>

              <span className="timeline-video-clip-name">
                {clip.sourceName}
              </span>

              {currentTime >= clip.timelineStart &&
                currentTime <= clip.timelineEnd && (
                  <span className="timeline-video-active-dot" />
                )}

              <div
                className="video-resize-handle right"
                onMouseDown={(event) =>
                  startResize(event, clip, "right")
                }
              />
            </div>
          );
        })}

        {videoClips.length === 0 && (
          <span className="timeline-empty-track">
            Empty video track
          </span>
        )}
      </div>
    </div>
  );
}

export default VideoTrack;
