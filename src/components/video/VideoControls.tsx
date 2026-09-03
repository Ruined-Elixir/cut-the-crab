import type { CSSProperties } from "react";

import "./VideoControls.css";

type VideoControlsProps = {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  skipSeconds: number;

  onTogglePlayPause: () => void;
  onJumpBy: (seconds: number) => void;
  onSeekTo: (time: number) => void;
};

function formatMonitorTime(time: number) {
  if (!Number.isFinite(time) || time < 0) {
    return "00:00:00.000";
  }

  const totalMilliseconds = Math.floor(time * 1000);
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;

  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${milliseconds
    .toString()
    .padStart(3, "0")}`;
}

function VideoControls({
  currentTime,
  duration,
  isPlaying,
  skipSeconds,
  onTogglePlayPause,
  onJumpBy,
  onSeekTo,
}: VideoControlsProps) {
  const safeDuration = Math.max(0, duration || 0);
  const safeCurrentTime = Math.max(0, Math.min(currentTime, safeDuration));
  const progress = safeDuration > 0 ? (safeCurrentTime / safeDuration) * 100 : 0;

  const scrubberStyle = {
    "--video-progress": `${progress}%`,
  } as CSSProperties;

  return (
    <div className="video-monitor-controls">
      <div className="video-monitor-scrubber-wrap">
        <input
          type="range"
          min={0}
          max={safeDuration}
          step={0.01}
          value={safeCurrentTime}
          onChange={(event) => onSeekTo(Number(event.target.value))}
          className="video-monitor-scrubber"
          style={scrubberStyle}
          aria-label="Video position"
        />
      </div>

      <div className="video-monitor-control-row">
        <span className="video-monitor-time video-monitor-time-current">
          {formatMonitorTime(safeCurrentTime)}
        </span>

        <div className="video-monitor-transport" aria-label="Playback controls">
          <button
            type="button"
            className="video-monitor-button"
            onClick={() => onSeekTo(0)}
            aria-label="Go to beginning"
            title="Go to beginning"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 5v14" />
              <path d="m18 6-8 6 8 6Z" />
            </svg>
          </button>

          <button
            type="button"
            className="video-monitor-button video-monitor-skip-button"
            onClick={() => onJumpBy(-skipSeconds)}
            aria-label={`Skip back ${skipSeconds} seconds`}
            title={`Back ${skipSeconds} seconds`}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5a7 7 0 1 1-6.18 3.72" />
              <path d="M3 5v5h5" />
            </svg>
            <span>{skipSeconds}</span>
          </button>

          <button
            type="button"
            className="video-monitor-button video-monitor-play-button"
            onClick={onTogglePlayPause}
            aria-label={isPlaying ? "Pause" : "Play"}
            title={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 6v12M16 6v12" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m9 6 9 6-9 6Z" />
              </svg>
            )}
          </button>

          <button
            type="button"
            className="video-monitor-button video-monitor-skip-button"
            onClick={() => onJumpBy(skipSeconds)}
            aria-label={`Skip forward ${skipSeconds} seconds`}
            title={`Forward ${skipSeconds} seconds`}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5a7 7 0 1 0 6.18 3.72" />
              <path d="M21 5v5h-5" />
            </svg>
            <span>{skipSeconds}</span>
          </button>

          <button
            type="button"
            className="video-monitor-button"
            onClick={() => onSeekTo(safeDuration)}
            aria-label="Go to end"
            title="Go to end"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M18 5v14" />
              <path d="m6 6 8 6-8 6Z" />
            </svg>
          </button>
        </div>

        <span className="video-monitor-time video-monitor-time-duration">
          {formatMonitorTime(safeDuration)}
        </span>
      </div>
    </div>
  );
}

export default VideoControls;
