import type {
  MouseEvent as ReactMouseEvent,
} from "react";

import type { Subtitle } from "../../types/subtitle";

type SubtitleTrackProps = {
  duration: number;
  subtitles: Subtitle[];

  selectedSubtitleId: string | null;

  onSeek?: (time: number) => void;
  onSubtitleSelect?: (id: string) => void;

  onSubtitleMove?: (
    id: string,
    newStartTime: number
  ) => void;

  onSubtitleResize?: (
    id: string,
    newStartTime: number,
    newEndTime: number
  ) => void;
};

function getTrackWidth(
  element: HTMLElement
) {
  return element.getBoundingClientRect().width;
}

function SubtitleTrack({
  duration,
  subtitles,
  selectedSubtitleId,
  onSeek,
  onSubtitleSelect,
  onSubtitleMove,
  onSubtitleResize,
}: SubtitleTrackProps) {
  const startMove = (
    event: ReactMouseEvent<HTMLDivElement>,
    subtitle: Subtitle
  ) => {
    event.stopPropagation();

    const track =
      event.currentTarget.parentElement;

    if (!track || duration <= 0) {
      return;
    }

    const startX = event.clientX;
    const originalStart =
      subtitle.startTime;

    const subtitleDuration =
      subtitle.endTime -
      subtitle.startTime;

    const trackWidth =
      getTrackWidth(track);

    const handleMouseMove = (
      moveEvent: MouseEvent
    ) => {
      const deltaTime =
        ((moveEvent.clientX - startX) /
          trackWidth) *
        duration;

      const newStart = Math.max(
        0,
        Math.min(
          duration - subtitleDuration,
          originalStart + deltaTime
        )
      );

      onSubtitleMove?.(
        subtitle.id,
        newStart
      );
    };

    const handleMouseUp = () => {
      window.removeEventListener(
        "mousemove",
        handleMouseMove
      );

      window.removeEventListener(
        "mouseup",
        handleMouseUp
      );
    };

    window.addEventListener(
      "mousemove",
      handleMouseMove
    );

    window.addEventListener(
      "mouseup",
      handleMouseUp
    );
  };

  const startResize = (
    event: ReactMouseEvent<HTMLDivElement>,
    subtitle: Subtitle,
    edge: "left" | "right"
  ) => {
    event.stopPropagation();

    const track =
      event.currentTarget
        .parentElement
        ?.parentElement;

    if (!track || duration <= 0) {
      return;
    }

    const startX = event.clientX;

    const originalStart =
      subtitle.startTime;

    const originalEnd =
      subtitle.endTime;

    const trackWidth =
      getTrackWidth(track);

    const handleMouseMove = (
      moveEvent: MouseEvent
    ) => {
      const deltaTime =
        ((moveEvent.clientX - startX) /
          trackWidth) *
        duration;

      if (edge === "left") {
        const newStart = Math.max(
          0,
          Math.min(
            originalEnd - 0.1,
            originalStart + deltaTime
          )
        );

        onSubtitleResize?.(
          subtitle.id,
          newStart,
          originalEnd
        );

        return;
      }

      const newEnd = Math.max(
        originalStart + 0.1,
        Math.min(
          duration,
          originalEnd + deltaTime
        )
      );

      onSubtitleResize?.(
        subtitle.id,
        originalStart,
        newEnd
      );
    };

    const handleMouseUp = () => {
      window.removeEventListener(
        "mousemove",
        handleMouseMove
      );

      window.removeEventListener(
        "mouseup",
        handleMouseUp
      );
    };

    window.addEventListener(
      "mousemove",
      handleMouseMove
    );

    window.addEventListener(
      "mouseup",
      handleMouseUp
    );
  };

  return (
    <div className="subtitle-track">
      {subtitles.map((subtitle) => {
        const left =
          duration > 0
            ? (
                subtitle.startTime /
                duration
              ) * 100
            : 0;

        const width =
          duration > 0
            ? (
                (
                  subtitle.endTime -
                  subtitle.startTime
                ) /
                duration
              ) * 100
            : 0;

        const isSelected =
          selectedSubtitleId ===
          subtitle.id;

        return (
          <div
            key={subtitle.id}
            className={[
              "subtitle-clip",
              isSelected
                ? "selected"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{
              left: `${left}%`,
              width: `${width}%`,
            }}
            onClick={(event) => {
              event.stopPropagation();

              onSubtitleSelect?.(
                subtitle.id
              );

              onSeek?.(
                subtitle.startTime
              );
            }}
            onMouseDown={(event) =>
              startMove(
                event,
                subtitle
              )
            }
          >
            <div
              className="subtitle-resize-handle left"
              onMouseDown={(event) =>
                startResize(
                  event,
                  subtitle,
                  "left"
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
                  "right"
                )
              }
            />
          </div>
        );
      })}
    </div>
  );
}

export default SubtitleTrack;