import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import { formatPlaybackTime } from "../../utils/time";
import "./VideoPlayer.css";

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
};

function VideoPlayer({
  onDurationChange,
  onTimeChange,
  onVideoNameChange,
  onVideoPathChange,
  seekRequest,
}: VideoPlayerProps) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoName, setVideoName] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
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
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);

    onVideoNameChange?.(name);
    onTimeChange?.(0);
    onDurationChange?.(0);
    await onVideoPathChange?.(selected);
  };

  const togglePlayPause = () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  };

  const jumpBy = (seconds: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;

    video.currentTime = Math.max(
      0,
      Math.min(video.duration, video.currentTime + seconds)
    );
  };

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
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !seekRequest) return;

    video.currentTime = seekRequest.time;
    setCurrentTime(seekRequest.time);
    onTimeChange?.(seekRequest.time);
  }, [seekRequest, onTimeChange]);

  return (
    <section className="video-player">
      <div className="video-player-toolbar">
        <button onClick={chooseVideo}>Choose Video</button>
        {videoName && <span className="video-name">{videoName}</span>}
      </div>

      {videoUrl && (
        <>
          <video
            ref={videoRef}
            className="video-preview"
            src={videoUrl}
            onTimeUpdate={() => {
              const video = videoRef.current;
              if (!video) return;

              const time = video.currentTime;
              setCurrentTime(time);
              onTimeChange?.(time);
            }}
            onLoadedMetadata={() => {
              const video = videoRef.current;
              if (!video) return;

              setDuration(video.duration);
              onDurationChange?.(video.duration);
            }}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
          />

          <div className="video-controls">
            <div className="video-control-buttons">
              <button onClick={() => jumpBy(-skipSeconds)}>
                -{skipSeconds}s
              </button>

              <button onClick={togglePlayPause}>
                {isPlaying ? "Pause" : "Play"}
              </button>

              <button onClick={() => jumpBy(skipSeconds)}>
                +{skipSeconds}s
              </button>
            </div>

            <span className="video-time">
              {formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration)}
            </span>

            <input
              className="video-seek"
              type="range"
              min="0"
              max={duration || 0}
              step="0.1"
              value={currentTime}
              onChange={(event) => {
                const video = videoRef.current;
                if (!video) return;

                const time = Number(event.target.value);
                video.currentTime = time;
                setCurrentTime(time);
                onTimeChange?.(time);
              }}
            />
          </div>
        </>
      )}
    </section>
  );
}

export default VideoPlayer;
