import { useEffect, useMemo, useRef, useState } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";

import type { Subtitle, SubtitleStyle } from "../../types/subtitle";

import VideoControls from "./VideoControls";
import VideoSubtitleOverlay from "./VideoSubtitleOverlay";

import "./VideoPlayer.css";

type SeekRequest = {
  time: number;
  id: number;
};

type VideoPlayerProps = {
  videoPath: string | null;
  videoName: string | null;
  onChooseVideo?: () => void | Promise<void>;

  onDurationChange?: (duration: number) => void;
  onTimeChange?: (currentTime: number) => void;

  seekRequest?: SeekRequest | null;

  subtitles: Subtitle[];
  currentTime: number;

  selectedSubtitleId?: string | null;
  onSubtitleSelect?: (id: string) => void;

  onSubtitlePositionChange?: (
    id: string,
    positionX: number,
    positionY: number,
  ) => void;

  onSubtitleTextChange?: (id: string, text: string) => void;

  onSubtitleStyleChange?: (id: string, style: SubtitleStyle) => void;

  onAllSubtitleStylesChange?: (style: SubtitleStyle) => void;
};

function VideoPlayer({
  videoPath,
  videoName,
  onChooseVideo,
  onDurationChange,
  onTimeChange,
  seekRequest,
  subtitles,
  currentTime,
  selectedSubtitleId,
  onSubtitleSelect,
  onSubtitlePositionChange,
  onSubtitleTextChange,
  onSubtitleStyleChange,
  onAllSubtitleStylesChange,
}: VideoPlayerProps) {
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

  const skipSeconds = 10;

  const videoUrl = useMemo(
    () => (videoPath ? convertFileSrc(videoPath) : null),
    [videoPath],
  );

  useEffect(() => {
    setDuration(0);
    setIsPlaying(false);

    onTimeChange?.(0);
    onDurationChange?.(0);
  }, [videoPath, onDurationChange, onTimeChange]);

  // Playback
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
      Math.min(video.duration, video.currentTime + seconds),
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

    const nextTime = Math.max(0, Math.min(maxDuration || 0, time));

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

    if (!video) {
      return;
    }

    onTimeChange?.(video.currentTime);
  };

  // Keyboard shortcuts
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

  // External seek requests
  useEffect(() => {
    const video = videoRef.current;

    if (!video || !seekRequest) {
      return;
    }

    const nextTime = Math.max(
      0,
      Math.min(
        Number.isFinite(video.duration) ? video.duration : seekRequest.time,
        seekRequest.time,
      ),
    );

    video.currentTime = nextTime;

    onTimeChange?.(nextTime);
  }, [seekRequest, onTimeChange]);

  return (
    <div className="video-player">
      <div className="video-player-toolbar">
        <button
          className="video-file-button"
          onClick={() => void onChooseVideo?.()}
        >
          {videoUrl ? "Change video" : "Choose video"}
        </button>

        {videoName && (
          <span className="video-name" title={videoName}>
            {videoName}
          </span>
        )}
      </div>

      {videoUrl ? (
        <div className="video-monitor">
          <div ref={shellRef} className="video-shell">
            <video
              key={videoPath ?? undefined}
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

            <VideoSubtitleOverlay
              subtitles={subtitles}
              currentTime={currentTime}
              selectedSubtitleId={selectedSubtitleId}
              shellRef={shellRef}
              onSubtitleSelect={onSubtitleSelect}
              onSubtitlePositionChange={onSubtitlePositionChange}
              onSubtitleTextChange={onSubtitleTextChange}
              onSubtitleStyleChange={onSubtitleStyleChange}
              onAllSubtitleStylesChange={onAllSubtitleStylesChange}
            />
          </div>

          <VideoControls
            currentTime={currentTime}
            duration={duration}
            isPlaying={isPlaying}
            skipSeconds={skipSeconds}
            onTogglePlayPause={togglePlayPause}
            onJumpBy={jumpBy}
            onSeekTo={seekTo}
          />
        </div>
      ) : (
        <button
          className="video-placeholder"
          onClick={() => void onChooseVideo?.()}
        >
          <span className="video-placeholder-icon">▶</span>
          <span>Choose a video to begin</span>
        </button>
      )}
    </div>
  );
}

export default VideoPlayer;
