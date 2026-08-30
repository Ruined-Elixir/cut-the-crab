import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";


type VideoPlayerProps = {
  onDurationChange?: (duration: number) => void;
  onTimeChange?: (currentTime: number) => void;
  seekTo?: number;
  onVideoNameChange?: (name: string) => void;

  // Waveforms
  onVideoPathChange?: (path: string) => void;
  
};

function VideoPlayer({
  onDurationChange,
  onTimeChange,
  onVideoNameChange,
  onVideoPathChange,
  seekTo,
}: VideoPlayerProps) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoName, setVideoName] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [skipSeconds] = useState(10);
  

  const videoRef = useRef<HTMLVideoElement | null>(null);

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

    onVideoPathChange?.(selected);

    const name = selected.split(/[\\/]/).pop() ?? "Unknown video";

    setVideoName(name);
    onVideoNameChange?.(name);
    setVideoUrl(convertFileSrc(selected));

    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
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

  const jumpBackward = () => {
    const video = videoRef.current;
    if (!video) return;

    video.currentTime = Math.max(0, video.currentTime - skipSeconds);
  };

  const jumpForward = () => {
    const video = videoRef.current;
    if (!video) return;

    video.currentTime = Math.min(
      video.duration,
      video.currentTime + skipSeconds
    );
  };

  const formatTime = (time: number) => {
    if (!Number.isFinite(time)) {
      return "00:00";
    }

    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);

    return `${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
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
        jumpBackward();
      }

      if (event.code === "ArrowRight") {
        event.preventDefault();
        jumpForward();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [skipSeconds]);

  useEffect(() => {
    if (videoRef.current && seekTo !== undefined) {
      videoRef.current.currentTime = seekTo;
      setCurrentTime(seekTo);
    }
  }, [seekTo]);

  return (
    <section>
      <button onClick={chooseVideo}>
        Choose Video
      </button>

      {videoName && <p>{videoName}</p>}

      {videoUrl && (
        <>
          <video
            ref={videoRef}
            src={videoUrl}
            onTimeUpdate={() => {
                const video = videoRef.current;
                if (!video) return;

                const time = video.currentTime;

                setCurrentTime(time);
                onTimeChange?.(time);
            }}
            onLoadedMetadata={() => {
                if (videoRef.current) {
                    const videoDuration = videoRef.current.duration;

                    setDuration(videoDuration);
                    onDurationChange?.(videoDuration);
                }
            }}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
            style={{
              width: "800px",
              maxWidth: "100%",
              marginTop: "20px",
              display: "block",
            }}
          />

          <div style={{ marginTop: "10px" }}>
            <button onClick={jumpBackward}>
              -{skipSeconds}s
            </button>

            <button onClick={togglePlayPause}>
              {isPlaying ? "Pause" : "Play"}
            </button>

            <button onClick={jumpForward}>
              +{skipSeconds}s
            </button>

            <p>
              {formatTime(currentTime)} / {formatTime(duration)}
            </p>

            <input
              type="range"
              min="0"
              max={duration || 0}
              step="0.1"
              value={currentTime}
              onChange={(event) => {
                const newTime = Number(event.target.value);

                if (videoRef.current) {
                  videoRef.current.currentTime = newTime;
                  setCurrentTime(newTime);
                }
              }}
              style={{
                width: "800px",
                maxWidth: "100%",
              }}
            />
          </div>
        </>
      )}
    </section>
  );
}

export default VideoPlayer;