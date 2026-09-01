import {
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";

type WaveformTrackProps = {
  duration: number;
  currentTime: number;
  videoName: string | null;
  waveform: number[];
  zoom: number;

  onSeek?: (time: number) => void;
};

function WaveformTrack({
  duration,
  currentTime,
  videoName,
  waveform,
  zoom,
  onSeek,
}: WaveformTrackProps) {
  const canvasRef =
    useRef<HTMLCanvasElement | null>(null);

  const playheadPosition =
    duration > 0
      ? (currentTime / duration) * 100
      : 0;

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const draw = () => {
      const context =
        canvas.getContext("2d");

      if (!context) {
        return;
      }

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const scale =
        window.devicePixelRatio || 1;

      canvas.width = Math.max(
        1,
        Math.round(width * scale)
      );

      canvas.height = Math.max(
        1,
        Math.round(height * scale)
      );

      context.setTransform(
        scale,
        0,
        0,
        scale,
        0,
        0
      );

      context.clearRect(
        0,
        0,
        width,
        height
      );

      if (waveform.length === 0) {
        return;
      }

      const centerY = height / 2;
      const barWidth =
        width / waveform.length;

      context.fillStyle = "#aaa";

      waveform.forEach(
        (value, index) => {
          const amplitude = Math.max(
            1,
            value * height * 0.9
          );

          const x = index * barWidth;
          const y =
            centerY - amplitude / 2;

          context.fillRect(
            x,
            y,
            Math.max(1, barWidth),
            amplitude
          );
        }
      );
    };

    draw();

    const observer =
      new ResizeObserver(draw);

    observer.observe(canvas);

    return () => {
      observer.disconnect();
    };
  }, [waveform, zoom]);

  const handleClick = (
    event: ReactMouseEvent<HTMLDivElement>
  ) => {
    if (duration <= 0) {
      return;
    }

    const rect =
      event.currentTarget.getBoundingClientRect();

    const percentage =
      (event.clientX - rect.left) /
      rect.width;

    const newTime = Math.max(
      0,
      Math.min(
        duration,
        percentage * duration
      )
    );

    onSeek?.(newTime);
  };

  return (
    <div
      className="timeline-track"
      onClick={handleClick}
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
  );
}

export default WaveformTrack;