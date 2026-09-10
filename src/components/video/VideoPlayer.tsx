import { useEffect, useMemo, useRef, useState } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";

import type { Subtitle, SubtitleStyle } from "../../types/subtitle";
import type { VideoTimelineClip } from "../../types/timelineModel";

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

  videoClips: VideoTimelineClip[];
  timelineDuration: number;

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

function findActiveVideoClip(
  videoClips: VideoTimelineClip[],
  timelineTime: number,
) {
  return (
    videoClips.find(
      (clip) =>
        timelineTime >= clip.timelineStart &&
        timelineTime < clip.timelineEnd,
    ) ?? null
  );
}

function timelineTimeToSourceTime(
  clip: VideoTimelineClip,
  timelineTime: number,
) {
  return clip.sourceIn + (timelineTime - clip.timelineStart);
}

function VideoPlayer({
  videoPath,
  videoName,
  onChooseVideo,
  onDurationChange,
  onTimeChange,
  seekRequest,
  videoClips,
  timelineDuration,
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
  const [isVideoVisible, setIsVideoVisible] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

  const currentTimeRef = useRef(currentTime);
  const timelineDurationRef = useRef(timelineDuration);
  const sourceDurationRef = useRef(duration);
  const videoClipsRef = useRef(videoClips);
  const isPlayingRef = useRef(false);

  const onTimeChangeRef = useRef(onTimeChange);
  const onDurationChangeRef = useRef(onDurationChange);

  const activeClipIdRef = useRef<string | null>(null);
  const playbackAnchorTimelineRef = useRef(currentTime);
  const playbackAnchorPerformanceRef = useRef(0);

  const skipSeconds = 10;

  const activeVideoClip = useMemo(
    () => findActiveVideoClip(videoClips, currentTime),
    [videoClips, currentTime],
  );

  const visualSourcePath = activeVideoClip?.sourcePath ?? videoPath;

  const videoUrl = useMemo(
    () => (visualSourcePath ? convertFileSrc(visualSourcePath) : null),
    [visualSourcePath],
  );

  const primaryVideoUrl = useMemo(
    () => (videoPath ? convertFileSrc(videoPath) : null),
    [videoPath],
  );

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    timelineDurationRef.current = timelineDuration;
  }, [timelineDuration]);

  useEffect(() => {
    sourceDurationRef.current = duration;
  }, [duration]);

  useEffect(() => {
    videoClipsRef.current = videoClips;
  }, [videoClips]);

  useEffect(() => {
    onTimeChangeRef.current = onTimeChange;
  }, [onTimeChange]);

  useEffect(() => {
    onDurationChangeRef.current = onDurationChange;
  }, [onDurationChange]);

  const syncNativeVideoToTimeline = (
    timelineTime: number,
    shouldPlay: boolean,
    forceSeek = false,
  ) => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    const activeClip = findActiveVideoClip(
      videoClipsRef.current,
      timelineTime,
    );

    const loadedSourcePath = video.dataset.sourcePath ?? "";
    const canRenderClip =
      !!activeClip && activeClip.sourcePath === loadedSourcePath;

    setIsVideoVisible(canRenderClip);

    if (!activeClip || !canRenderClip) {
      activeClipIdRef.current = null;

      if (!video.paused) {
        video.pause();
      }

      return;
    }

    const expectedSourceTime = timelineTimeToSourceTime(
      activeClip,
      timelineTime,
    );

    const maxSourceTime = Number.isFinite(video.duration)
      ? video.duration
      : sourceDurationRef.current;

    const safeSourceTime = Math.max(
      0,
      Math.min(maxSourceTime || expectedSourceTime, expectedSourceTime),
    );

    const clipChanged = activeClipIdRef.current !== activeClip.id;

    /*
     * Do not continuously chase the timeline clock with native video seeks.
     * Seeking while media is already playing flushes/rebuffers the decoder and
     * produces broken, intermittent audio.
     *
     * We only seek when:
     * - the playhead enters a different timeline clip, or
     * - the user explicitly seeks/scrubs/jumps, or
     * - metadata has just loaded and we need to establish the correct frame.
     *
     * Once a clip is playing, let the native media element run continuously.
     * The editor timeline still advances from the playback controller clock.
     */
    if (clipChanged || forceSeek) {
      video.currentTime = safeSourceTime;
    }

    activeClipIdRef.current = activeClip.id;

    if (shouldPlay) {
      if (video.paused) {
        void video.play().catch((error) => {
          console.error("Timeline video playback failed:", error);
        });
      }
    } else if (!video.paused) {
      video.pause();
    }
  };


  const syncAudioToTimeline = (
    timelineTime: number,
    shouldPlay: boolean,
    forceSeek = false,
  ) => {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    const sourceDuration = Number.isFinite(audio.duration)
      ? audio.duration
      : sourceDurationRef.current;

    const hasAudioAtTime =
      sourceDuration > 0 &&
      timelineTime >= 0 &&
      timelineTime < sourceDuration;

    if (!hasAudioAtTime) {
      if (!audio.paused) {
        audio.pause();
      }

      return;
    }

    if (forceSeek) {
      const safeAudioTime = Math.max(
        0,
        Math.min(sourceDuration, timelineTime),
      );

      try {
        audio.currentTime = safeAudioTime;
      } catch (error) {
        console.error("Timeline audio seek failed:", error);
      }
    }

    if (shouldPlay) {
      if (audio.paused) {
        void audio.play().catch((error) => {
          console.error("Timeline audio playback failed:", error);
        });
      }
    } else if (!audio.paused) {
      audio.pause();
    }
  };

  const seekTo = (time: number) => {
    if (!Number.isFinite(time)) {
      return;
    }

    const maxDuration = Math.max(0, timelineDurationRef.current || 0);
    const nextTime = Math.max(0, Math.min(maxDuration, time));

    currentTimeRef.current = nextTime;
    playbackAnchorTimelineRef.current = nextTime;
    playbackAnchorPerformanceRef.current = performance.now();

    onTimeChangeRef.current?.(nextTime);

    syncNativeVideoToTimeline(nextTime, isPlayingRef.current, true);
    syncAudioToTimeline(nextTime, isPlayingRef.current, true);
  };

  const jumpBy = (seconds: number) => {
    seekTo(currentTimeRef.current + seconds);
  };

  const togglePlayPause = () => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    if (isPlayingRef.current) {
      isPlayingRef.current = false;
      setIsPlaying(false);
      video.pause();
      audioRef.current?.pause();
      return;
    }

    const maxDuration = Math.max(0, timelineDurationRef.current || 0);

    if (maxDuration <= 0) {
      return;
    }

    let playbackStart = currentTimeRef.current;

    if (playbackStart >= maxDuration) {
      playbackStart = 0;
      currentTimeRef.current = 0;
      onTimeChangeRef.current?.(0);
    }

    playbackAnchorTimelineRef.current = playbackStart;
    playbackAnchorPerformanceRef.current = performance.now();

    isPlayingRef.current = true;
    setIsPlaying(true);

    syncNativeVideoToTimeline(playbackStart, true, true);
    syncAudioToTimeline(playbackStart, true, true);
  };

  useEffect(() => {
    /*
     * Reset playback state only when the selected source video changes.
     * App.currentTime is timeline time; native video.currentTime is source time.
     */
    setDuration(0);
    setIsPlaying(false);
    setIsVideoVisible(false);

    videoRef.current?.pause();
    audioRef.current?.pause();

    isPlayingRef.current = false;
    currentTimeRef.current = 0;
    activeClipIdRef.current = null;
    playbackAnchorTimelineRef.current = 0;
    playbackAnchorPerformanceRef.current = 0;

    onTimeChangeRef.current?.(0);
    onDurationChangeRef.current?.(0);
  }, [videoPath]);

  useEffect(() => {
    if (isPlaying) {
      return;
    }

    syncNativeVideoToTimeline(currentTime, false, true);
    syncAudioToTimeline(currentTime, false, true);
  }, [currentTime, isPlaying, videoClips, videoPath, duration]);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }

    playbackAnchorTimelineRef.current = currentTimeRef.current;
    playbackAnchorPerformanceRef.current = performance.now();

    let animationFrameId = 0;

    const tick = (now: number) => {
      if (!isPlayingRef.current) {
        return;
      }

      const maxDuration = Math.max(0, timelineDurationRef.current || 0);

      if (maxDuration <= 0) {
        isPlayingRef.current = false;
        setIsPlaying(false);
        syncNativeVideoToTimeline(0, false);
        syncAudioToTimeline(0, false);
        return;
      }

      const elapsedSeconds =
        (now - playbackAnchorPerformanceRef.current) / 1000;

      const nextTime = Math.min(
        maxDuration,
        playbackAnchorTimelineRef.current + elapsedSeconds,
      );

      currentTimeRef.current = nextTime;
      onTimeChangeRef.current?.(nextTime);

      syncNativeVideoToTimeline(nextTime, true);
      syncAudioToTimeline(nextTime, true);

      if (nextTime >= maxDuration) {
        isPlayingRef.current = false;
        setIsPlaying(false);
        syncNativeVideoToTimeline(maxDuration, false);
        syncAudioToTimeline(maxDuration, false);
        return;
      }

      animationFrameId = window.requestAnimationFrame(tick);
    };

    animationFrameId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [isPlaying]);

  const handleLoadedMetadata = () => {
    const video = videoRef.current;

    if (!video || !Number.isFinite(video.duration)) {
      return;
    }

    syncNativeVideoToTimeline(
      currentTimeRef.current,
      isPlayingRef.current,
      true,
    );
  };

  const handlePrimaryAudioLoadedMetadata = () => {
    const audio = audioRef.current;

    if (!audio || !Number.isFinite(audio.duration)) {
      return;
    }

    setDuration(audio.duration);
    sourceDurationRef.current = audio.duration;
    onDurationChangeRef.current?.(audio.duration);

    syncAudioToTimeline(
      currentTimeRef.current,
      isPlayingRef.current,
      true,
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

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!seekRequest) {
      return;
    }

    seekTo(seekRequest.time);
  }, [seekRequest]);

  const monitorDuration = Math.max(0, timelineDuration || 0);

  const subtitleVideoTimeOffset = activeVideoClip
    ? activeVideoClip.timelineStart - activeVideoClip.sourceIn
    : 0;

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

      {primaryVideoUrl ? (
        <div className="video-monitor">
          <div ref={shellRef} className="video-shell">
            <video
              key={visualSourcePath ?? undefined}
              ref={videoRef}
              src={videoUrl ?? undefined}
              data-source-path={visualSourcePath ?? ""}
              className="video-element"
              muted
              style={{ visibility: isVideoVisible ? "visible" : "hidden" }}
              onLoadedMetadata={handleLoadedMetadata}
              onClick={togglePlayPause}
            />

            <audio
              key={`audio:${videoPath ?? ""}`}
              ref={audioRef}
              src={primaryVideoUrl ?? undefined}
              preload="auto"
              hidden
              onLoadedMetadata={handlePrimaryAudioLoadedMetadata}
            />

            <VideoSubtitleOverlay
              subtitles={subtitles}
              currentTime={currentTime}
              videoTimeOffset={subtitleVideoTimeOffset}
              videoSourceKey={visualSourcePath ?? ""}
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
            duration={monitorDuration}
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
