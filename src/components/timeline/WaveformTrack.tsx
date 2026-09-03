import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";

type WaveformTrackProps = {
  duration: number;
  videoName: string | null;
  waveform: number[];
  onSeek?: (time: number) => void;
};

function WaveformTrack({
  duration,
  videoName,
  waveform,
  onSeek,
}: WaveformTrackProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const draw = () => {
      const context = canvas.getContext("2d");

      if (!context) {
        return;
      }

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const scale = window.devicePixelRatio || 1;

      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));

      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, width, height);

      if (waveform.length === 0) {
        return;
      }

      const centerY = height / 2;
      const barWidth = width / waveform.length;

      context.fillStyle = "rgba(220, 220, 220, 0.76)";

      waveform.forEach((value, index) => {
        const amplitude = Math.max(1, value * height * 0.82);
        const x = index * barWidth;
        const y = centerY - amplitude / 2;

        context.fillRect(x, y, Math.max(1, barWidth * 0.72), amplitude);
      });
    };

    draw();

    const observer = new ResizeObserver(draw);
    observer.observe(canvas);

    return () => {
      observer.disconnect();
    };
  }, [waveform]);

  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (duration <= 0 || event.detail > 1) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const percentage = (event.clientX - rect.left) / rect.width;
    const newTime = Math.max(0, Math.min(duration, percentage * duration));

    onSeek?.(newTime);
  };

  return (
    <div className="timeline-row timeline-waveform-row">
      <div className="timeline-row-label">Audio</div>

      <div className="waveform-track" onClick={handleClick}>
        <span className="timeline-video-name">
          {videoName ?? "No video selected"}
        </span>

        <canvas ref={canvasRef} className="waveform-canvas" />
      </div>
    </div>
  );
}

export default WaveformTrack;
