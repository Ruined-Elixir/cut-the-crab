import type { MouseEvent as ReactMouseEvent } from "react";

import type { Subtitle } from "../../types/subtitle";

export type SubtitleSelectionMode =
  | "single"
  | "toggle"
  | "range";

type SubtitleTrackProps = {
  duration: number;
  subtitles: Subtitle[];
  selectedSubtitleId: string | null;
  selectedSubtitleIds: string[];
  markerTimes: number[];

  onSeek?: (time: number) => void;
  onSubtitleSelect?: (
    id: string,
    mode?: SubtitleSelectionMode,
  ) => void;
  onSubtitleMove?: (
    id: string,
    newStartTime: number,
  ) => void;
  onSubtitleGroupMove?: (
    ids: string[],
    anchorId: string,
    newAnchorStartTime: number,
  ) => void;
  onSubtitleResize?: (
    id: string,
    newStartTime: number,
    newEndTime: number,
  ) => void;
};

const MIN_SUBTITLE_DURATION = 0.1;
const SNAP_TOLERANCE_PX = 12;

function getSnapTolerance(
  trackWidth: number,
  duration: number,
) {
  if (trackWidth <= 0 || duration <= 0) {
    return 0;
  }

  return (SNAP_TOLERANCE_PX / trackWidth) * duration;
}

function snapTime(
  value: number,
  markerTimes: number[],
  tolerance: number,
) {
  let best = value;
  let bestDistance = tolerance;

  for (const markerTime of markerTimes) {
    const distance = Math.abs(markerTime - value);

    if (distance <= bestDistance) {
      best = markerTime;
      bestDistance = distance;
    }
  }

  return best;
}

function getOtherSubtitles(
  subtitles: Subtitle[],
  id: string,
) {
  return subtitles
    .filter((subtitle) => subtitle.id !== id)
    .sort((a, b) => a.startTime - b.startTime);
}

function clampMoveAgainstCollisions(
  subtitles: Subtitle[],
  id: string,
  requestedStart: number,
  subtitleDuration: number,
  duration: number,
) {
  let start = Math.max(
    0,
    Math.min(duration - subtitleDuration, requestedStart),
  );

  const others = getOtherSubtitles(subtitles, id);

  for (const other of others) {
    const end = start + subtitleDuration;

    if (
      end <= other.startTime ||
      start >= other.endTime
    ) {
      continue;
    }

    const pushLeft =
      other.startTime - subtitleDuration;
    const pushRight = other.endTime;

    start =
      Math.abs(requestedStart - pushLeft) <=
      Math.abs(requestedStart - pushRight)
        ? pushLeft
        : pushRight;

    start = Math.max(
      0,
      Math.min(duration - subtitleDuration, start),
    );
  }

  return start;
}

function clampGroupMove(
  subtitles: Subtitle[],
  selectedIds: string[],
  anchorId: string,
  requestedAnchorStart: number,
  duration: number,
) {
  const selectedSet = new Set(selectedIds);
  const selected = subtitles.filter((subtitle) =>
    selectedSet.has(subtitle.id),
  );

  const anchor = selected.find(
    (subtitle) => subtitle.id === anchorId,
  );

  if (!anchor || selected.length === 0) {
    return requestedAnchorStart;
  }

  const requestedDelta =
    requestedAnchorStart - anchor.startTime;

  const minStart = Math.min(
    ...selected.map((subtitle) => subtitle.startTime),
  );
  const maxEnd = Math.max(
    ...selected.map((subtitle) => subtitle.endTime),
  );

  let minimumDelta = -minStart;
  let maximumDelta = duration - maxEnd;

  const unselected = subtitles.filter(
    (subtitle) => !selectedSet.has(subtitle.id),
  );

  if (requestedDelta > 0) {
    for (const moving of selected) {
      for (const obstacle of unselected) {
        if (obstacle.startTime >= moving.endTime) {
          maximumDelta = Math.min(
            maximumDelta,
            obstacle.startTime - moving.endTime,
          );
        }
      }
    }
  } else if (requestedDelta < 0) {
    for (const moving of selected) {
      for (const obstacle of unselected) {
        if (obstacle.endTime <= moving.startTime) {
          minimumDelta = Math.max(
            minimumDelta,
            obstacle.endTime - moving.startTime,
          );
        }
      }
    }
  }

  const safeDelta = Math.max(
    minimumDelta,
    Math.min(maximumDelta, requestedDelta),
  );

  return anchor.startTime + safeDelta;
}

function selectionModeFromEvent(
  event: ReactMouseEvent,
): SubtitleSelectionMode {
  if (event.shiftKey) {
    return "range";
  }

  if (event.metaKey || event.ctrlKey) {
    return "toggle";
  }

  return "single";
}

function SubtitleTrack({
  duration,
  subtitles,
  selectedSubtitleId,
  selectedSubtitleIds,
  markerTimes,
  onSeek,
  onSubtitleSelect,
  onSubtitleMove,
  onSubtitleGroupMove,
  onSubtitleResize,
}: SubtitleTrackProps) {
  const startMove = (
    event: ReactMouseEvent<HTMLDivElement>,
    subtitle: Subtitle,
  ) => {
    if (
      (event.target as HTMLElement).closest(
        ".subtitle-resize-handle",
      )
    ) {
      return;
    }

    /*
     * Modifier-click is a selection gesture, not a drag gesture.
     * Waiting for the click keeps Cmd/Ctrl toggle and Shift range
     * selection predictable.
     */
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const track = event.currentTarget.parentElement;

    if (!track || duration <= 0) {
      return;
    }

    const isAlreadySelected =
      selectedSubtitleIds.includes(subtitle.id);

    const groupIds =
      isAlreadySelected && selectedSubtitleIds.length > 1
        ? selectedSubtitleIds
        : [subtitle.id];

    if (!isAlreadySelected) {
      onSubtitleSelect?.(subtitle.id, "single");
    }

    const startX = event.clientX;
    const originalStart = subtitle.startTime;
    const subtitleDuration =
      subtitle.endTime - subtitle.startTime;
    const trackWidth =
      track.getBoundingClientRect().width;
    const snapTolerance = getSnapTolerance(
      trackWidth,
      duration,
    );

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaTime =
        ((moveEvent.clientX - startX) / trackWidth) *
        duration;

      let newStart = originalStart + deltaTime;

      const snappedStart = snapTime(
        newStart,
        markerTimes,
        snapTolerance,
      );
      const snappedEnd = snapTime(
        newStart + subtitleDuration,
        markerTimes,
        snapTolerance,
      );

      if (
        Math.abs(snappedStart - newStart) <=
        Math.abs(
          snappedEnd -
            (newStart + subtitleDuration),
        )
      ) {
        newStart = snappedStart;
      } else if (
        snappedEnd !==
        newStart + subtitleDuration
      ) {
        newStart =
          snappedEnd - subtitleDuration;
      }

      if (groupIds.length > 1) {
        const safeAnchorStart = clampGroupMove(
          subtitles,
          groupIds,
          subtitle.id,
          newStart,
          duration,
        );

        onSubtitleGroupMove?.(
          groupIds,
          subtitle.id,
          safeAnchorStart,
        );

        return;
      }

      newStart = clampMoveAgainstCollisions(
        subtitles,
        subtitle.id,
        newStart,
        subtitleDuration,
        duration,
      );

      onSubtitleMove?.(
        subtitle.id,
        newStart,
      );
    };

    const handleMouseUp = () => {
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
    subtitle: Subtitle,
    edge: "left" | "right",
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const track =
      event.currentTarget.parentElement?.parentElement;

    if (!track || duration <= 0) {
      return;
    }

    onSubtitleSelect?.(
      subtitle.id,
      "single",
    );

    const startX = event.clientX;
    const originalStart = subtitle.startTime;
    const originalEnd = subtitle.endTime;
    const trackWidth =
      track.getBoundingClientRect().width;
    const snapTolerance = getSnapTolerance(
      trackWidth,
      duration,
    );

    const others = getOtherSubtitles(
      subtitles,
      subtitle.id,
    );

    const previousSubtitle = [...others]
      .filter(
        (item) =>
          item.endTime <= originalStart,
      )
      .sort(
        (a, b) => b.endTime - a.endTime,
      )[0];

    const nextSubtitle = others
      .filter(
        (item) =>
          item.startTime >= originalEnd,
      )
      .sort(
        (a, b) => a.startTime - b.startTime,
      )[0];

    const handleMouseMove = (
      moveEvent: MouseEvent,
    ) => {
      const deltaTime =
        ((moveEvent.clientX - startX) /
          trackWidth) *
        duration;

      if (edge === "left") {
        let newStart =
          originalStart + deltaTime;

        newStart = snapTime(
          newStart,
          markerTimes,
          snapTolerance,
        );

        newStart = Math.max(
          previousSubtitle?.endTime ?? 0,
          newStart,
        );

        newStart = Math.min(
          originalEnd - MIN_SUBTITLE_DURATION,
          newStart,
        );

        onSubtitleResize?.(
          subtitle.id,
          newStart,
          originalEnd,
        );

        return;
      }

      let newEnd = originalEnd + deltaTime;

      newEnd = snapTime(
        newEnd,
        markerTimes,
        snapTolerance,
      );

      newEnd = Math.min(
        nextSubtitle?.startTime ?? duration,
        newEnd,
      );

      newEnd = Math.max(
        originalStart + MIN_SUBTITLE_DURATION,
        newEnd,
      );

      onSubtitleResize?.(
        subtitle.id,
        originalStart,
        newEnd,
      );
    };

    const handleMouseUp = () => {
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

  const handleTrackClick = (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    if (
      duration <= 0 ||
      event.detail > 1
    ) {
      return;
    }

    const rect =
      event.currentTarget.getBoundingClientRect();

    const ratio =
      (event.clientX - rect.left) /
      rect.width;

    onSeek?.(
      Math.max(
        0,
        Math.min(duration, ratio * duration),
      ),
    );
  };

  return (
    <div className="timeline-row timeline-subtitle-row">
      <div className="timeline-row-label">
        Subtitles
      </div>

      <div
        className="subtitle-track"
        onClick={handleTrackClick}
      >
        {subtitles.map((subtitle) => {
          const left =
            duration > 0
              ? (subtitle.startTime / duration) *
                100
              : 0;

          const width =
            duration > 0
              ? ((subtitle.endTime -
                  subtitle.startTime) /
                  duration) *
                100
              : 0;

          const isSelected =
            selectedSubtitleIds.includes(
              subtitle.id,
            );

          const isPrimary =
            selectedSubtitleId === subtitle.id;

          return (
            <div
              key={subtitle.id}
              className={[
                "subtitle-clip",
                isSelected ? "selected" : "",
                isPrimary ? "primary-selected" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                left: `${left}%`,
                width: `${width}%`,
              }}
              title={subtitle.text}
              onClick={(event) => {
                event.stopPropagation();

                onSubtitleSelect?.(
                  subtitle.id,
                  selectionModeFromEvent(event),
                );

                if (
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.shiftKey
                ) {
                  onSeek?.(
                    subtitle.startTime,
                  );
                }
              }}
              onMouseDown={(event) =>
                startMove(event, subtitle)
              }
            >
              <div
                className="subtitle-resize-handle left"
                onMouseDown={(event) =>
                  startResize(
                    event,
                    subtitle,
                    "left",
                  )
                }
              />

              <span className="subtitle-clip-text">
                {subtitle.text}
              </span>

              <div
                className="subtitle-resize-handle right"
                onMouseDown={(event) =>
                  startResize(
                    event,
                    subtitle,
                    "right",
                  )
                }
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default SubtitleTrack;
