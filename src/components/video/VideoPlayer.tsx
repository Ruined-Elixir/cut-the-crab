import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import { formatPlaybackTime } from "../../utils/time";
import type { Subtitle } from "../../types/subtitle";

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

  subtitles: Subtitle[];
  currentTime: number;

  onSubtitleSelect?: (id: string) => void;
  selectedSubtitleId?: string | null;

  onSubtitlePositionChange?: (
    id: string,
    positionX: number,
    positionY: number
  ) => void;

  onSubtitleTextChange?: (
    id: string,
    text: string
  ) => void;
};

function VideoPlayer({
  onDurationChange,
  onTimeChange,
  onVideoNameChange,
  onVideoPathChange,
  seekRequest,

  subtitles,
  currentTime,

  onSubtitleSelect,
  selectedSubtitleId,
  onSubtitlePositionChange,
  onSubtitleTextChange,
}: VideoPlayerProps) {
  const [videoUrl, setVideoUrl] =
    useState<string | null>(null);

  const [videoName, setVideoName] =
    useState<string | null>(null);

  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const [editingSubtitleId, setEditingSubtitleId] =
    useState<string | null>(null);

  const [editingText, setEditingText] = useState("");

  const videoRef =
    useRef<HTMLVideoElement | null>(null);

  const shellRef =
    useRef<HTMLDivElement | null>(null);

  const subtitleButtonRef =
    useRef<HTMLButtonElement | null>(null);

  const subtitleTextareaRef =
    useRef<HTMLTextAreaElement | null>(null);

  const skipSeconds = 10;

  const activeSubtitle = subtitles.find(
    (subtitle) =>
      currentTime >= subtitle.startTime &&
      currentTime <= subtitle.endTime
  );

  const editingSubtitle = subtitles.find(
    (subtitle) => subtitle.id === editingSubtitleId
  );

  // ---------------------------------------------------------------------------
  // Video loading
  // ---------------------------------------------------------------------------

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

    const name =
      selected.split(/[\\/]/).pop() ?? "Unknown video";

    setVideoName(name);
    setVideoUrl(convertFileSrc(selected));

    setDuration(0);
    setIsPlaying(false);

    setEditingSubtitleId(null);
    setEditingText("");

    onVideoNameChange?.(name);
    onTimeChange?.(0);
    onDurationChange?.(0);

    await onVideoPathChange?.(selected);
  };

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------

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
      Math.min(
        video.duration,
        video.currentTime + seconds
      )
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

    if (!video) {
      return;
    }

    onTimeChange?.(video.currentTime);
  };

  // ---------------------------------------------------------------------------
  // Subtitle dragging
  // ---------------------------------------------------------------------------

  const handleSubtitlePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>
  ) => {
    if (!activeSubtitle || !shellRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    onSubtitleSelect?.(activeSubtitle.id);

    const shell = shellRef.current;

    const handlePointerMove = (
      moveEvent: PointerEvent
    ) => {
      const shellRect =
        shell.getBoundingClientRect();

      const subtitleRect =
        subtitleButtonRef.current?.getBoundingClientRect();

      let x =
        ((moveEvent.clientX - shellRect.left) /
          shellRect.width) *
        100;

      let y =
        ((moveEvent.clientY - shellRect.top) /
          shellRect.height) *
        100;

      if (subtitleRect) {
        const halfWidthPercent =
          (subtitleRect.width / shellRect.width) * 50;

        const halfHeightPercent =
          (subtitleRect.height / shellRect.height) * 50;

        x = Math.max(
          halfWidthPercent,
          Math.min(
            100 - halfWidthPercent,
            x
          )
        );

        y = Math.max(
          halfHeightPercent,
          Math.min(
            100 - halfHeightPercent,
            y
          )
        );
      }

      onSubtitlePositionChange?.(
        activeSubtitle.id,
        x,
        y
      );
    };

    const handlePointerUp = () => {
      window.removeEventListener(
        "pointermove",
        handlePointerMove
      );

      window.removeEventListener(
        "pointerup",
        handlePointerUp
      );
    };

    window.addEventListener(
      "pointermove",
      handlePointerMove
    );

    window.addEventListener(
      "pointerup",
      handlePointerUp
    );
  };

  // ---------------------------------------------------------------------------
  // Subtitle text editing
  // ---------------------------------------------------------------------------

  const startEditingSubtitle = () => {
    if (!activeSubtitle) {
      return;
    }

    onSubtitleSelect?.(activeSubtitle.id);

    setEditingSubtitleId(activeSubtitle.id);
    setEditingText(activeSubtitle.text);
  };

  const finishEditingSubtitle = () => {
    if (!editingSubtitle) {
      setEditingSubtitleId(null);
      return;
    }

    onSubtitleTextChange?.(
      editingSubtitle.id,
      editingText
    );

    setEditingSubtitleId(null);
  };

  const cancelEditingSubtitle = () => {
    setEditingText(editingSubtitle?.text ?? "");
    setEditingSubtitleId(null);
  };

  // ---------------------------------------------------------------------------
  // Keyboard playback shortcuts
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const handleKeyDown = (
      event: KeyboardEvent
    ) => {
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

    window.addEventListener(
      "keydown",
      handleKeyDown
    );

    return () => {
      window.removeEventListener(
        "keydown",
        handleKeyDown
      );
    };
  }, []);

  // ---------------------------------------------------------------------------
  // External seek requests
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="video-player">
      <div className="video-player-toolbar">
        <button
          className="video-file-button"
          onClick={chooseVideo}
        >
          {videoUrl
            ? "Change video"
            : "Choose video"}
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
        <div
          ref={shellRef}
          className="video-shell"
        >
          <video
            ref={videoRef}
            src={videoUrl}
            className="video-element"
            onLoadedMetadata={
              handleLoadedMetadata
            }
            onTimeUpdate={
              handleTimeUpdate
            }
            onPlay={() =>
              setIsPlaying(true)
            }
            onPause={() =>
              setIsPlaying(false)
            }
            onEnded={() =>
              setIsPlaying(false)
            }
            onClick={togglePlayPause}
          />

          {activeSubtitle && (
            <div className="video-subtitle-layer">
              {editingSubtitleId ===
              activeSubtitle.id ? (
                <textarea
                  ref={subtitleTextareaRef}
                  className="video-subtitle-preview editing"
                  style={{
                    left: `${
                      activeSubtitle.positionX ?? 50
                    }%`,
                    top: `${
                      activeSubtitle.positionY ?? 80
                    }%`,
                  }}
                  value={editingText}
                  autoFocus
                  onChange={(event) => {
                    setEditingText(
                      event.target.value
                    );
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey
                    ) {
                      event.preventDefault();
                      finishEditingSubtitle();
                    }

                    if (
                      event.key === "Escape"
                    ) {
                      event.preventDefault();
                      cancelEditingSubtitle();
                    }
                  }}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                />
              ) : (
                <button
                  ref={subtitleButtonRef}
                  className={[
                    "video-subtitle-preview",
                    selectedSubtitleId ===
                    activeSubtitle.id
                      ? "selected"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{
                    left: `${
                      activeSubtitle.positionX ?? 50
                    }%`,
                    top: `${
                      activeSubtitle.positionY ?? 80
                    }%`,
                  }}
                  onPointerDown={
                    handleSubtitlePointerDown
                  }
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    startEditingSubtitle();
                  }}
                  type="button"
                >
                  {activeSubtitle.text}
                </button>
              )}
            </div>
          )}

          <div className="video-controls-overlay">
            <div className="video-controls-row">
              <button
                className="video-control-button"
                onClick={() =>
                  jumpBy(-skipSeconds)
                }
                aria-label="Skip back 10 seconds"
                title="Back 10 seconds"
              >
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
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
                aria-label={
                  isPlaying
                    ? "Pause"
                    : "Play"
                }
                title={
                  isPlaying
                    ? "Pause"
                    : "Play"
                }
              >
                {isPlaying ? (
                  <svg
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path d="M8 6v12M16 6v12" />
                  </svg>
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path d="m9 6 9 6-9 6Z" />
                  </svg>
                )}
              </button>

              <button
                className="video-control-button"
                onClick={() =>
                  jumpBy(skipSeconds)
                }
                aria-label="Skip forward 10 seconds"
                title="Forward 10 seconds"
              >
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
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
                {formatPlaybackTime(
                  currentTime
                )}
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
                  seekTo(
                    Number(
                      event.target.value
                    )
                  )
                }
                className="video-scrubber"
                aria-label="Video position"
              />

              <span className="video-time">
                {formatPlaybackTime(
                  duration
                )}
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