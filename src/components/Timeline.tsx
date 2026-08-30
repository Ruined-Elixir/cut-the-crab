import { useEffect, useRef } from "react";

type TimelineProps = {
  duration: number;
  currentTime: number;
  videoName: string | null;
  waveform: number[];
  zoom: number;
  onSeek?: (time: number) => void;
};

function Timeline({
  duration,
  currentTime,
  onSeek,
  videoName,
  waveform,
  zoom,
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
      </div>
    </div>
  );
}

export default Timeline;