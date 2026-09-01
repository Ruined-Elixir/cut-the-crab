import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import { formatPlaybackTime } from "../../utils/time";
import "./VideoPlayer.css";
import type { Subtitle } from "../../types/subtitle";

type SeekRequest = {
  time: number;
  id: number;
};

type VideoPlayerProps = {
  onDurationChange?: (duration: number) => void;
  onTimeChange?: (currentTime: number) => void;
  onVideoNameChange?: (name: string) => void;
  onVideoPathChange?: (path: string) => void | Promise<void>;
  seekRequest?: SeekRequest | null;

  subtitles: Subtitle[];
  currentTime: number;
};

function VideoPlayer({
  onDurationChange,
  onTimeChange,
  onVideoNameChange,
  onVideoPathChange,
  seekRequest,
  subtitles,
  currentTime,
}: VideoPlayerProps) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoName, setVideoName] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);

  const skipSeconds = 10;

  const chooseVideo = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: "Video",
          extensions: ["mp4", "mov", "webm", "mkv"],
        },
      ],
    });

    if (!selected || Array.isArray(selected)) {
      return;
    }

    const name = selected.split(/[\\/]/).pop() ?? "Unknown video";

    setVideoName(name);
    setVideoUrl(convertFileSrc(selected));
    setDuration(0);
    setIsPlaying(false);

    onVideoNameChange?.(name);
    onTimeChange?.(0);
    onDurationChange?.(0);

    await onVideoPathChange?.(selected);
  };

  const togglePlayPause = () => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  };

  const jumpBy = (seconds: number) => {
    const video = videoRef.current;

    if (!video || !Number.isFinite(video.duration)) {
      return;
    }

    const nextTime = Math.max(
      0,
      Math.min(video.duration, video.currentTime + seconds)
    );

    video.currentTime = nextTime;
    onTimeChange?.(nextTime);
  };

  const seekTo = (time: number) => {
    const video = videoRef.current;

    if (!video || !Number.isFinite(time)) {
      return;
    }

    const maxDuration = Number.isFinite(video.duration)
      ? video.duration
      : duration;

    const nextTime = Math.max(
      0,
      Math.min(maxDuration || 0, time)
    );

    video.currentTime = nextTime;
    onTimeChange?.(nextTime);
  };

  const handleLoadedMetadata = () => {
    const video = videoRef.current;

    if (!video || !Number.isFinite(video.duration)) {
      return;
    }

    setDuration(video.duration);
    onDurationChange?.(video.duration);
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;

    if (!video) return;

    onTimeChange?.(video.currentTime);
  };

  const activeSubtitle = subtitles.find(
    (subtitle) =>
      currentTime >= subtitle.startTime &&
      currentTime <= subtitle.endTime
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;

      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        togglePlayPause();
      }

      if (event.code === "ArrowLeft") {
        event.preventDefault();
        jumpBy(-skipSeconds);
      }

      if (event.code === "ArrowRight") {
        event.preventDefault();
        jumpBy(skipSeconds);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;

    if (!video || !seekRequest) {
      return;
    }

    const nextTime = Math.max(
      0,
      Math.min(
        Number.isFinite(video.duration)
          ? video.duration
          : seekRequest.time,
        seekRequest.time
      )
    );

    video.currentTime = nextTime;
    onTimeChange?.(nextTime);
  }, [seekRequest, onTimeChange]);

  return (
    <div className="video-player">
      <div className="video-player-toolbar">
        <button
          className="video-file-button"
          onClick={chooseVideo}
        >
          {videoUrl ? "Change video" : "Choose video"}
        </button>

        {videoName && (
          <span
            className="video-name"
            title={videoName}
          >
            {videoName}
          </span>
        )}
      </div>

      {videoUrl ? (
        <div className="video-shell">
          <video
            ref={videoRef}
            src={videoUrl}
            className="video-element"
            onLoadedMetadata={handleLoadedMetadata}
            onTimeUpdate={handleTimeUpdate}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
            onClick={togglePlayPause}
          />

          {activeSubtitle && (
            <div className="video-subtitle-layer">
              <div className="video-subtitle-preview">
                {activeSubtitle.text}
              </div>
            </div>
          )}

          <div className="video-controls-overlay">
            <div className="video-controls-row">
              <button
                className="video-control-button"
                onClick={() => jumpBy(-skipSeconds)}
                aria-label="Skip back 10 seconds"
                title="Back 10 seconds"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 5a7 7 0 1 1-6.18 3.72" />
                  <path d="M3 5v5h5" />
                </svg>

                <span className="video-skip-number">
                  10
                </span>
              </button>

              <button
                className="video-control-button video-play-button"
                onClick={togglePlayPause}
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
                onClick={() => jumpBy(skipSeconds)}
                aria-label="Skip forward 10 seconds"
                title="Forward 10 seconds"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 5a7 7 0 1 0 6.18 3.72" />
                  <path d="M21 5v5h-5" />
                </svg>

                <span className="video-skip-number">
                  10
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
                value={Math.min(
                  currentTime,
                  duration || 0
                )}
                onChange={(event) =>
                  seekTo(Number(event.target.value))
                }
                className="video-scrubber"
                aria-label="Video position"
              />

              <span className="video-time">
                {formatPlaybackTime(duration)}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <button
          className="video-placeholder"
          onClick={chooseVideo}
        >
          <span className="video-placeholder-icon">
            ▶
          </span>

          <span>
            Choose a video to begin
          </span>
        </button>
      )}
    </div>
  );
}

export default VideoPlayer;