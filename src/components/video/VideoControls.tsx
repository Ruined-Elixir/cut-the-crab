import { formatPlaybackTime } from "../../utils/time";
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

function VideoControls({
  currentTime,
  duration,
  isPlaying,
  skipSeconds,
  onTogglePlayPause,
  onJumpBy,
  onSeekTo,
}: VideoControlsProps) {
  return (
    <div className="video-controls-overlay">
      <div className="video-controls-row">
        <button
          className="video-control-button"
          onClick={() => onJumpBy(-skipSeconds)}
          aria-label={`Skip back ${skipSeconds} seconds`}
          title={`Back ${skipSeconds} seconds`}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5a7 7 0 1 1-6.18 3.72" />
            <path d="M3 5v5h5" />
          </svg>

          <span className="video-skip-number">
            {skipSeconds}
          </span>
        </button>

        <button
          className="video-control-button video-play-button"
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
          className="video-control-button"
          onClick={() => onJumpBy(skipSeconds)}
          aria-label={`Skip forward ${skipSeconds} seconds`}
          title={`Forward ${skipSeconds} seconds`}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5a7 7 0 1 0 6.18 3.72" />
            <path d="M21 5v5h-5" />
          </svg>

          <span className="video-skip-number">
            {skipSeconds}
          </span>
        </button>
      </div>

      <div className="video-scrubber-row">
        <span className="video-time">
          {formatPlaybackTime(currentTime)}
        </span>

        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(currentTime, duration || 0)}
          onChange={(event) =>
            onSeekTo(Number(event.target.value))
          }
          className="video-scrubber"
          aria-label="Video position"
        />

        <span className="video-time">
          {formatPlaybackTime(duration)}
        </span>
      </div>
    </div>
  );
}

export default VideoControls;