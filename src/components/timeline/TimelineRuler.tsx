import type { PointerEvent as ReactPointerEvent } from "react";

import { formatPlaybackTime } from "../../utils/time";

type TimelineRulerProps = {
  duration: number;
  zoom: number;
  currentTime: number;
  onSeek?: (time: number) => void;
  showLabelSpacer?: boolean;
};

function getMarkerInterval(duration: number, zoom: number) {
  const visibleDuration = duration / zoom;

  if (visibleDuration <= 10) return 0.5;
  if (visibleDuration <= 20) return 1;
  if (visibleDuration <= 45) return 2;
  if (visibleDuration <= 90) return 5;
  if (visibleDuration <= 180) return 10;
  if (visibleDuration <= 600) return 30;

  return 60;
}

function formatRulerTime(time: number, interval: number) {
  if (interval < 1) {
    const seconds = time % 60;
    const minutes = Math.floor(time / 60);
    return `${minutes.toString().padStart(2, "0")}:${seconds
      .toFixed(1)
      .padStart(4, "0")}`;
  }

  return formatPlaybackTime(time);
}

function TimelineRuler({
  duration,
  zoom,
  currentTime,
  onSeek,
  showLabelSpacer = true,
}: TimelineRulerProps) {
  const interval = getMarkerInterval(duration, zoom);
  const markerTimes: number[] = [];

  for (let time = 0; time <= duration; time += interval) {
    markerTimes.push(time);
  }

  const lastMarker = markerTimes[markerTimes.length - 1];

  if (
    duration > 0 &&
    (lastMarker === undefined || Math.abs(lastMarker - duration) > 0.001)
  ) {
    markerTimes.push(duration);
  }

  const seekFromPointer = (element: HTMLElement, clientX: number) => {
    if (duration <= 0) {
      return;
    }

    const rect = element.getBoundingClientRect();
    const ratio = Math.max(
      0,
      Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)),
    );

    onSeek?.(ratio * duration);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (duration <= 0 || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFromPointer(event.currentTarget, event.clientX);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }

    event.preventDefault();
    seekFromPointer(event.currentTarget, event.clientX);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const playheadPosition =
    duration > 0
      ? Math.max(0, Math.min(100, (currentTime / duration) * 100))
      : 0;

  return (
    <div
      className={`timeline-ruler ${showLabelSpacer ? "" : "track-only"}`.trim()}
    >
      {showLabelSpacer && <div className="timeline-ruler-label-spacer" />}

      <div
        className="timeline-ruler-scale"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        title="Click or drag to move the playhead"
      >
        {markerTimes.map((time, index) => {
          const position = duration > 0 ? (time / duration) * 100 : 0;

          return (
            <div
              key={`${time}-${index}`}
              className="timeline-ruler-marker"
              style={{ left: `${position}%` }}
            >
              <span className="timeline-ruler-time">
                {formatRulerTime(time, interval)}
              </span>
              <span className="timeline-ruler-tick" />
            </div>
          );
        })}

        <div
          className="timeline-ruler-playhead"
          style={{ left: `${playheadPosition}%` }}
          aria-hidden="true"
        >
          <span className="timeline-ruler-playhead-handle" />
        </div>
      </div>
    </div>
  );
}

export default TimelineRuler;
