import { useEffect, useRef } from "react";
import type { Subtitle } from "../types/subtitle";

type TimelineProps = {
  duration: number;
  currentTime: number;
  videoName: string | null;
  
  // Waveform
  waveform: number[];
  zoom: number;
  onSeek?: (time: number) => void;

  // Subtitles
  subtitles: Subtitle[];
  selectedSubtitleId: string | null;
  onSubtitleSelect?: (id: string) => void;
  onSubtitleMove?: (id: string, newStartTime: number) => void; 
  onSubtitleResize?: (
    id: string,
    newStartTime: number,
    newEndTime: number
  ) => void; 
};

function Timeline({
  duration,
  currentTime,
  onSeek,
  videoName,
  waveform,
  zoom,
  subtitles,
  selectedSubtitleId,
  onSubtitleSelect,
  onSubtitleMove,
  onSubtitleResize,
}: TimelineProps) {
  const getMarkerInterval = () => {
    if (zoom >= 6) return 0.5;
    if (zoom >= 4) return 1;
    if (zoom >= 2) return 2;
    return 5;
  };

  const markerInterval = getMarkerInterval();

  const markerTimes: number[] = [];

  for (let time = 0; time <= duration; time += markerInterval) {
    markerTimes.push(time);
  }

  const playheadPosition =
    duration > 0 ? (currentTime / duration) * 100 : 0;

  const handleTimelineClick = (
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    if (duration <= 0) return;

    const rect = event.currentTarget.getBoundingClientRect();

    const clickX = event.clientX - rect.left;

    const percentage = clickX / rect.width;

    const newTime = percentage * duration;

    onSeek?.(newTime);
  };

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    const scale = window.devicePixelRatio || 1;

    canvas.width = width * scale;
    canvas.height = height * scale;

    ctx.scale(scale, scale);
    ctx.clearRect(0, 0, width, height);

    if (waveform.length === 0) return;

    const centerY = height / 2;
    const barWidth = width / waveform.length;

    ctx.fillStyle = "#aaa";

    waveform.forEach((value, index) => {
      const amplitude = Math.max(1, value * height * 0.9);
      const x = index * barWidth;
      const y = centerY - amplitude / 2;

      ctx.fillRect(
        x,
        y,
        Math.max(1, barWidth),
        amplitude
      );
    });
  }, [waveform, zoom]);

  return (
    <div className="timeline-scroll">
      <div
        className="timeline-content"
        style={{
          width: `${zoom * 100}%`,
        }}
      >
        <div className="timeline-ruler">
          {markerTimes.map((time) => {
            const position =
              duration > 0 ? (time / duration) * 100 : 0;

            return (
              <div
                key={time}
                className="timeline-marker"
                style={{
                  left: `${position}%`,
                }}
              >
                <span>{time % 1 === 0 ? `${time}s` : `${time.toFixed(1)}s`}</span>
                <div className="timeline-tick" />
              </div>
            );
          })}
        </div>

        <div
          className="timeline-track"
          onClick={handleTimelineClick}
        >
          <div className="timeline-video-clip">
            <span className="timeline-video-name">
              {videoName ?? "No video selected"}
            </span>

            <canvas
              ref={canvasRef}
              className="waveform-canvas"
            />
          </div>

          <div
            className="timeline-playhead"
            style={{
              left: `${playheadPosition}%`,
            }}
          />
        </div>

        <div className="subtitle-track">
          {subtitles.map((subtitle) => {
            const left =
              duration > 0 ? (subtitle.startTime / duration) * 100 : 0;

            const width =
              duration > 0
                ? ((subtitle.endTime - subtitle.startTime) / duration) * 100
                : 0;

            return (
              <div
                key={subtitle.id}
                className={`subtitle-clip ${
                  selectedSubtitleId === subtitle.id ? "selected" : ""
                }`}
                style={{
                  left: `${left}%`,
                  width: `${width}%`,
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onSubtitleSelect?.(subtitle.id);
                  onSeek?.(subtitle.startTime);
                }}
                onMouseDown={(event) => {
                  event.stopPropagation();

                  const startX = event.clientX;
                  const originalStart = subtitle.startTime;
                  const originalDuration = subtitle.endTime - subtitle.startTime;

                  const timelineElement = event.currentTarget.parentElement;

                  if (!timelineElement || duration <= 0) return;

                  const timelineWidth =
                    timelineElement.getBoundingClientRect().width;

                  const handleMouseMove = (moveEvent: MouseEvent) => {
                    const deltaX = moveEvent.clientX - startX;

                    const deltaTime =
                      (deltaX / timelineWidth) * duration;

                    const newStart = Math.max(
                      0,
                      Math.min(
                        duration - originalDuration,
                        originalStart + deltaTime
                      )
                    );

                    onSubtitleMove?.(subtitle.id, newStart);
                  };

                  const handleMouseUp = () => {
                    window.removeEventListener("mousemove", handleMouseMove);
                    window.removeEventListener("mouseup", handleMouseUp);
                  };

                  window.addEventListener("mousemove", handleMouseMove);
                  window.addEventListener("mouseup", handleMouseUp);
                }}
              >

                <div
                  className="subtitle-resize-handle left"
                  onMouseDown={(event) => {
                    event.stopPropagation();

                    const startX = event.clientX;
                    const originalStart = subtitle.startTime;

                    const timelineElement =
                      event.currentTarget.parentElement?.parentElement;

                    if (!timelineElement || duration <= 0) return;

                    const timelineWidth =
                      timelineElement.getBoundingClientRect().width;

                    const handleMouseMove = (moveEvent: MouseEvent) => {
                      const deltaX = moveEvent.clientX - startX;

                      const deltaTime =
                        (deltaX / timelineWidth) * duration;

                      const newStart = Math.max(
                        0,
                        Math.min(
                          subtitle.endTime - 0.1,
                          originalStart + deltaTime
                        )
                      );

                      onSubtitleResize?.(
                        subtitle.id,
                        newStart,
                        subtitle.endTime
                      );
                    };

                    const handleMouseUp = () => {
                      window.removeEventListener("mousemove", handleMouseMove);
                      window.removeEventListener("mouseup", handleMouseUp);
                    };

                    window.addEventListener("mousemove", handleMouseMove);
                    window.addEventListener("mouseup", handleMouseUp);
                  }}
                />
                
                {subtitle.text}

                <div
                  className="subtitle-resize-handle right"
                  onMouseDown={(event) => {
                    event.stopPropagation();

                    const startX = event.clientX;
                    const originalEnd = subtitle.endTime;

                    const timelineElement =
                      event.currentTarget.parentElement?.parentElement;

                    if (!timelineElement || duration <= 0) return;

                    const timelineWidth =
                      timelineElement.getBoundingClientRect().width;

                    const handleMouseMove = (moveEvent: MouseEvent) => {
                      const deltaX = moveEvent.clientX - startX;
                      const deltaTime =
                        (deltaX / timelineWidth) * duration;

                      const newEnd = Math.max(
                        subtitle.startTime + 0.1,
                        Math.min(duration, originalEnd + deltaTime)
                      );

                      onSubtitleResize?.(
                        subtitle.id,
                        subtitle.startTime,
                        newEnd
                      );
                    };

                    const handleMouseUp = () => {
                      window.removeEventListener("mousemove", handleMouseMove);
                      window.removeEventListener("mouseup", handleMouseUp);
                    };

                    window.addEventListener("mousemove", handleMouseMove);
                    window.addEventListener("mouseup", handleMouseUp);
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default Timeline;