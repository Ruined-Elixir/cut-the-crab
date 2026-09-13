import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";

import type { Subtitle, SubtitleStyle } from "../../types/subtitle";
import type {
  TimelineTrackId,
  TimelineTrackSettings,
  VideoTimelineClip,
} from "../../types/timelineModel";

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
  trackSettings: TimelineTrackSettings;

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

type VideoTrackId = "video-1" | "video-2";
type AudioTrackId = "audio-1" | "audio-2";

type VisibilityState = Record<VideoTrackId, boolean>;

function findActiveVideoClip(
  videoClips: VideoTimelineClip[],
  timelineTime: number,
  trackId: VideoTrackId,
) {
  return (
    videoClips.find(
      (clip) =>
        clip.trackId === trackId &&
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

function audioTrackForVideoTrack(trackId: VideoTrackId): AudioTrackId {
  return trackId === "video-2" ? "audio-2" : "audio-1";
}

function isTrackHidden(
  trackSettings: TimelineTrackSettings,
  trackId: TimelineTrackId,
) {
  return trackSettings[trackId]?.hidden ?? false;
}

function isTrackMuted(
  trackSettings: TimelineTrackSettings,
  trackId: TimelineTrackId,
) {
  return trackSettings[trackId]?.muted ?? false;
}

function videoTransformStyle(clip: VideoTimelineClip | null): CSSProperties {
  if (!clip) {
    return {
      transform: "translate3d(0%, 0%, 0) scale(1)",
      transformOrigin: "center center",
    };
  }

  const positionX = clip.positionX ?? 0;
  const positionY = clip.positionY ?? 0;
  const scale = Math.max(10, Math.min(400, clip.scale ?? 100));

  return {
    transform: `translate3d(${positionX}%, ${positionY}%, 0) scale(${scale / 100})`,
    transformOrigin: "center center",
  };
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
  trackSettings,
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
  const [videoVisibility, setVideoVisibility] = useState<VisibilityState>({
    "video-1": false,
    "video-2": false,
  });

  const v1VideoRef = useRef<HTMLVideoElement | null>(null);
  const v2VideoRef = useRef<HTMLVideoElement | null>(null);
  const a1AudioRef = useRef<HTMLAudioElement | null>(null);
  const a2AudioRef = useRef<HTMLAudioElement | null>(null);
  const primaryMetadataAudioRef = useRef<HTMLAudioElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

  const currentTimeRef = useRef(currentTime);
  const timelineDurationRef = useRef(timelineDuration);
  const sourceDurationRef = useRef(duration);
  const videoClipsRef = useRef(videoClips);
  const trackSettingsRef = useRef(trackSettings);
  const isPlayingRef = useRef(false);

  const onTimeChangeRef = useRef(onTimeChange);
  const onDurationChangeRef = useRef(onDurationChange);

  const activeVideoClipIdRefs = useRef<Record<VideoTrackId, string | null>>({
    "video-1": null,
    "video-2": null,
  });
  const activeAudioClipIdRefs = useRef<Record<AudioTrackId, string | null>>({
    "audio-1": null,
    "audio-2": null,
  });

  const playbackAnchorTimelineRef = useRef(currentTime);
  const playbackAnchorPerformanceRef = useRef(0);

  const skipSeconds = 10;

  const activeV1Clip = useMemo(
    () => findActiveVideoClip(videoClips, currentTime, "video-1"),
    [videoClips, currentTime],
  );

  const activeV2Clip = useMemo(
    () => findActiveVideoClip(videoClips, currentTime, "video-2"),
    [videoClips, currentTime],
  );

  const v1SourcePath = activeV1Clip?.sourcePath ?? videoPath;
  const v2SourcePath = activeV2Clip?.sourcePath ?? null;

  const v1VideoUrl = useMemo(
    () => (v1SourcePath ? convertFileSrc(v1SourcePath) : null),
    [v1SourcePath],
  );

  const v2VideoUrl = useMemo(
    () => (v2SourcePath ? convertFileSrc(v2SourcePath) : null),
    [v2SourcePath],
  );

  const a1AudioUrl = useMemo(
    () => (activeV1Clip ? convertFileSrc(activeV1Clip.sourcePath) : null),
    [activeV1Clip?.sourcePath],
  );

  const a2AudioUrl = useMemo(
    () => (activeV2Clip ? convertFileSrc(activeV2Clip.sourcePath) : null),
    [activeV2Clip?.sourcePath],
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
    trackSettingsRef.current = trackSettings;
  }, [trackSettings]);

  useEffect(() => {
    onTimeChangeRef.current = onTimeChange;
  }, [onTimeChange]);

  useEffect(() => {
    onDurationChangeRef.current = onDurationChange;
  }, [onDurationChange]);

  const videoElementForTrack = (trackId: VideoTrackId) =>
    trackId === "video-2" ? v2VideoRef.current : v1VideoRef.current;

  const audioElementForTrack = (trackId: AudioTrackId) =>
    trackId === "audio-2" ? a2AudioRef.current : a1AudioRef.current;

  const syncVideoTrackToTimeline = (
    trackId: VideoTrackId,
    timelineTime: number,
    shouldPlay: boolean,
    forceSeek = false,
  ) => {
    const video = videoElementForTrack(trackId);
    const activeClip = findActiveVideoClip(
      videoClipsRef.current,
      timelineTime,
      trackId,
    );

    if (!video || !activeClip) {
      activeVideoClipIdRefs.current[trackId] = null;
      video?.pause();
      setVideoVisibility((current) =>
        current[trackId] ? { ...current, [trackId]: false } : current,
      );
      return;
    }

    const loadedSourcePath = video.dataset.sourcePath ?? "";
    const hidden = isTrackHidden(trackSettingsRef.current, trackId);
    const canRenderClip =
      activeClip.sourcePath === loadedSourcePath && !hidden;

    setVideoVisibility((current) =>
      current[trackId] === canRenderClip
        ? current
        : { ...current, [trackId]: canRenderClip },
    );

    if (activeClip.sourcePath !== loadedSourcePath) {
      activeVideoClipIdRefs.current[trackId] = null;
      video.pause();
      return;
    }

    if (hidden) {
      activeVideoClipIdRefs.current[trackId] = null;
      video.pause();
      return;
    }

    const expectedSourceTime = timelineTimeToSourceTime(activeClip, timelineTime);
    const maxSourceTime = Number.isFinite(video.duration)
      ? video.duration
      : activeClip.sourceDuration ?? sourceDurationRef.current;
    const safeSourceTime = Math.max(
      0,
      Math.min(maxSourceTime || expectedSourceTime, expectedSourceTime),
    );
    const clipChanged =
      activeVideoClipIdRefs.current[trackId] !== activeClip.id;

    if (clipChanged || forceSeek) {
      try {
        video.currentTime = safeSourceTime;
      } catch (error) {
        console.error(`${trackId} seek failed:`, error);
      }
    }

    activeVideoClipIdRefs.current[trackId] = activeClip.id;

    if (shouldPlay) {
      if (video.paused) {
        void video.play().catch((error) => {
          console.error(`${trackId} playback failed:`, error);
        });
      }
    } else if (!video.paused) {
      video.pause();
    }
  };

  const syncAudioTrackToTimeline = (
    videoTrackId: VideoTrackId,
    timelineTime: number,
    shouldPlay: boolean,
    forceSeek = false,
  ) => {
    const audioTrackId = audioTrackForVideoTrack(videoTrackId);
    const audio = audioElementForTrack(audioTrackId);
    const activeClip = findActiveVideoClip(
      videoClipsRef.current,
      timelineTime,
      videoTrackId,
    );

    if (!audio || !activeClip) {
      activeAudioClipIdRefs.current[audioTrackId] = null;
      audio?.pause();
      return;
    }

    const loadedSourcePath = audio.dataset.sourcePath ?? "";

    if (loadedSourcePath !== activeClip.sourcePath) {
      activeAudioClipIdRefs.current[audioTrackId] = null;
      audio.pause();
      return;
    }

    if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
      return;
    }

    const expectedSourceTime = timelineTimeToSourceTime(activeClip, timelineTime);
    const maxSourceTime = Number.isFinite(audio.duration)
      ? audio.duration
      : activeClip.sourceDuration ?? activeClip.sourceOut;
    const safeSourceTime = Math.max(
      0,
      Math.min(maxSourceTime || expectedSourceTime, expectedSourceTime),
    );
    const clipChanged =
      activeAudioClipIdRefs.current[audioTrackId] !== activeClip.id;

    if (clipChanged || forceSeek) {
      try {
        audio.currentTime = safeSourceTime;
      } catch (error) {
        console.error(`${audioTrackId} seek failed:`, error);
      }
    }

    const muted = isTrackMuted(trackSettingsRef.current, audioTrackId);
    audio.muted = muted;

    if (muted) {
      activeAudioClipIdRefs.current[audioTrackId] = null;
      audio.pause();
      return;
    }

    activeAudioClipIdRefs.current[audioTrackId] = activeClip.id;

    if (shouldPlay) {
      if (audio.paused) {
        void audio.play().catch((error) => {
          console.error(`${audioTrackId} playback failed:`, error);
        });
      }
    } else if (!audio.paused) {
      audio.pause();
    }
  };

  const syncAllMediaToTimeline = (
    timelineTime: number,
    shouldPlay: boolean,
    forceSeek = false,
  ) => {
    syncVideoTrackToTimeline("video-1", timelineTime, shouldPlay, forceSeek);
    syncVideoTrackToTimeline("video-2", timelineTime, shouldPlay, forceSeek);
    syncAudioTrackToTimeline("video-1", timelineTime, shouldPlay, forceSeek);
    syncAudioTrackToTimeline("video-2", timelineTime, shouldPlay, forceSeek);
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
    syncAllMediaToTimeline(nextTime, isPlayingRef.current, true);
  };

  const jumpBy = (seconds: number) => {
    seekTo(currentTimeRef.current + seconds);
  };

  const togglePlayPause = () => {
    if (isPlayingRef.current) {
      isPlayingRef.current = false;
      setIsPlaying(false);
      v1VideoRef.current?.pause();
      v2VideoRef.current?.pause();
      a1AudioRef.current?.pause();
      a2AudioRef.current?.pause();
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
    syncAllMediaToTimeline(playbackStart, true, true);
  };

  useEffect(() => {
    setDuration(0);
    setIsPlaying(false);
    setVideoVisibility({ "video-1": false, "video-2": false });

    v1VideoRef.current?.pause();
    v2VideoRef.current?.pause();
    a1AudioRef.current?.pause();
    a2AudioRef.current?.pause();

    isPlayingRef.current = false;
    currentTimeRef.current = 0;
    activeVideoClipIdRefs.current = { "video-1": null, "video-2": null };
    activeAudioClipIdRefs.current = { "audio-1": null, "audio-2": null };
    playbackAnchorTimelineRef.current = 0;
    playbackAnchorPerformanceRef.current = 0;

    onTimeChangeRef.current?.(0);
    onDurationChangeRef.current?.(0);
  }, [videoPath]);

  useEffect(() => {
    if (isPlaying) {
      return;
    }

    syncAllMediaToTimeline(currentTime, false, true);
  }, [currentTime, isPlaying, videoClips, videoPath, duration, trackSettings]);

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
        syncAllMediaToTimeline(0, false);
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
      syncAllMediaToTimeline(nextTime, true);

      if (nextTime >= maxDuration) {
        isPlayingRef.current = false;
        setIsPlaying(false);
        syncAllMediaToTimeline(maxDuration, false);
        return;
      }

      animationFrameId = window.requestAnimationFrame(tick);
    };

    animationFrameId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [isPlaying]);

  const handleVideoLoadedMetadata = (trackId: VideoTrackId) => {
    activeVideoClipIdRefs.current[trackId] = null;
    syncVideoTrackToTimeline(
      trackId,
      currentTimeRef.current,
      isPlayingRef.current,
      true,
    );
  };

  const handleAudioLoadedMetadata = (videoTrackId: VideoTrackId) => {
    const audioTrackId = audioTrackForVideoTrack(videoTrackId);
    activeAudioClipIdRefs.current[audioTrackId] = null;
    syncAudioTrackToTimeline(
      videoTrackId,
      currentTimeRef.current,
      isPlayingRef.current,
      true,
    );
  };

  const handlePrimaryMetadataLoaded = () => {
    const audio = primaryMetadataAudioRef.current;

    if (!audio || !Number.isFinite(audio.duration)) {
      return;
    }

    setDuration(audio.duration);
    sourceDurationRef.current = audio.duration;
    onDurationChangeRef.current?.(audio.duration);
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
  const v2Visible = !!activeV2Clip && !isTrackHidden(trackSettings, "video-2");
  const topVisualClip = v2Visible ? activeV2Clip : activeV1Clip;
  const subtitleVideoTimeOffset = topVisualClip
    ? topVisualClip.timelineStart - topVisualClip.sourceIn
    : 0;
  const subtitleVideoSourceKey = topVisualClip?.sourcePath ?? v1SourcePath ?? "";
  const visibleSubtitles = isTrackHidden(trackSettings, "subtitle-1")
    ? []
    : subtitles;

  return (
    <div className="video-player">
      <div className="video-player-toolbar">
        <button
          className="video-file-button"
          onClick={() => void onChooseVideo?.()}
        >
          {primaryVideoUrl ? "Change video" : "Choose video"}
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
            {v2Visible && v2VideoUrl && (
              <video
                key={`v2:${v2SourcePath}`}
                ref={v2VideoRef}
                src={v2VideoUrl}
                data-source-path={v2SourcePath ?? ""}
                className="video-element video-track-layer video-track-layer-v2"
                muted
                style={{
                  visibility: videoVisibility["video-2"] ? "visible" : "hidden",
                  ...videoTransformStyle(activeV2Clip),
                }}
                onLoadedMetadata={() => handleVideoLoadedMetadata("video-2")}
                onClick={togglePlayPause}
              />
            )}

            <video
              key={`v1:${v1SourcePath ?? ""}`}
              ref={v1VideoRef}
              src={v1VideoUrl ?? undefined}
              data-source-path={v1SourcePath ?? ""}
              className="video-element video-track-layer video-track-layer-v1"
              muted
              style={{
                visibility:
                  videoVisibility["video-1"] &&
                  !isTrackHidden(trackSettings, "video-1")
                    ? "visible"
                    : "hidden",
                ...videoTransformStyle(activeV1Clip),
              }}
              onLoadedMetadata={() => handleVideoLoadedMetadata("video-1")}
              onClick={togglePlayPause}
            />

            <audio
              key={`a1:${activeV1Clip?.sourcePath ?? "gap"}`}
              ref={a1AudioRef}
              src={a1AudioUrl ?? undefined}
              data-source-path={activeV1Clip?.sourcePath ?? ""}
              preload="auto"
              hidden
              onLoadedMetadata={() => handleAudioLoadedMetadata("video-1")}
            />

            <audio
              key={`a2:${activeV2Clip?.sourcePath ?? "gap"}`}
              ref={a2AudioRef}
              src={a2AudioUrl ?? undefined}
              data-source-path={activeV2Clip?.sourcePath ?? ""}
              preload="auto"
              hidden
              onLoadedMetadata={() => handleAudioLoadedMetadata("video-2")}
            />

            <audio
              key={`primary-metadata:${videoPath ?? ""}`}
              ref={primaryMetadataAudioRef}
              src={primaryVideoUrl}
              preload="metadata"
              hidden
              onLoadedMetadata={handlePrimaryMetadataLoaded}
            />

            <VideoSubtitleOverlay
              subtitles={visibleSubtitles}
              currentTime={currentTime}
              videoTimeOffset={subtitleVideoTimeOffset}
              videoSourceKey={subtitleVideoSourceKey}
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
