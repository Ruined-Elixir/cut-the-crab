import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import type { Subtitle } from "../../types/subtitle";
import type { TimelineMarker } from "../../types/timeline";
import type {
  TimelineTrack as TimelineTrackModel,
  TimelineTrackId,
  TimelineTrackKind,
  TimelineTrackSettings,
  VideoTimelineClip,
  VideoTransitionType,
} from "../../types/timelineModel";

import { useVideoClipFrames } from "../../hooks/useVideoClipFrames";
import { buildTimelineModel } from "../../utils/timelineModel";

import SubtitleTrack from "./SubtitleTrack";
import TimelineRuler from "./TimelineRuler";
import TimelineTrackLabel from "./TimelineTrackLabel";
import VideoTrack, { type VideoMoveSnapTarget } from "./VideoTrack";
import WaveformTrack from "./WaveformTrack";

import "./Timeline.css";

type TimelineProps = {
  duration: number;
  scaleDuration: number;
  currentTime: number;
  waveformsBySource: Record<string, number[]>;
  videoClips: VideoTimelineClip[];
  subtitles: Subtitle[];
  markers: TimelineMarker[];
  zoom: number;
  trackSettings: TimelineTrackSettings;

  selectedSubtitleId: string | null;
  selectedSubtitleIds: string[];
  selectedVideoClipId: string | null;

  onSeek?: (time: number) => void;
  onSkimPreviewChange?: (time: number | null) => void;
  onAddTrack?: (kind: TimelineTrackKind) => void;
  onClearSubtitleSelection?: () => void;

  onVideoClipSelect?: (id: string) => void;
  onVideoClipMove?: (
    id: string,
    newTimelineStart: number,
  ) => void;
  onVideoClipResize?: (
    id: string,
    newTimelineStart: number,
    newTimelineEnd: number,
  ) => void;
  onVideoClipMoveToTrack?: (
    id: string,
    targetTrackId: TimelineTrackId,
    newTimelineStart: number,
  ) => void;
  onMediaDrop?: (
    assetId: string,
    targetTrackId: TimelineTrackId,
    timelineTime: number,
  ) => void;
  onCopyVideoClip?: () => void;
  onPasteVideoClip?: () => void;
  onDuplicateVideoClip?: () => void;
  canPasteVideoClip?: boolean;

  onSubtitleSelect?: (
    id: string,
    mode?: "single" | "toggle" | "range",
  ) => void;
  onSubtitleMove?: (id: string, newStartTime: number) => void;
  onSubtitleGroupMove?: (
    ids: string[],
    anchorId: string,
    newAnchorStartTime: number,
  ) => void;
  onSubtitleResize?: (
    id: string,
    newStartTime: number,
    newEndTime: number,
  ) => void;
  onMarkersChange?: (markers: TimelineMarker[]) => void;
  onZoomChange?: (zoom: number) => void;
  onToggleTrackLock?: (trackId: TimelineTrackId) => void;
  onToggleTrackMute?: (trackId: TimelineTrackId) => void;
  onToggleTrackHidden?: (trackId: TimelineTrackId) => void;
  onVideoTransitionChange?: (
    id: string,
    edge: "in" | "out",
    transition: { type?: VideoTransitionType; duration?: number },
  ) => void;
  onVideoFadeChange?: (id: string, edge: "in" | "out", duration: number) => void;
  onAudioFadeChange?: (id: string, edge: "in" | "out", duration: number) => void;
  onAudioVolumeChange?: (id: string, volume: number) => void;
};

export const MIN_TIMELINE_ZOOM = 1;
export const MAX_TIMELINE_ZOOM = 12;
export const TIMELINE_ZOOM_STEP = 0.25;

const HALF_SECOND_RULER_THRESHOLD_SECONDS = 10;

const MIN_TRAILING_WORKSPACE_SECONDS = 10;
const MAX_TRAILING_WORKSPACE_SECONDS = 120;
const TRAILING_WORKSPACE_RATIO = 0.25;

function trailingWorkspaceDuration(contentDuration: number) {
  if (!Number.isFinite(contentDuration) || contentDuration <= 0) {
    return 30;
  }

  return Math.max(
    MIN_TRAILING_WORKSPACE_SECONDS,
    Math.min(
      MAX_TRAILING_WORKSPACE_SECONDS,
      contentDuration * TRAILING_WORKSPACE_RATIO,
    ),
  );
}

export function clampTimelineZoom(value: number) {
  return Math.max(MIN_TIMELINE_ZOOM, Math.min(MAX_TIMELINE_ZOOM, value));
}

function Timeline({
  duration,
  scaleDuration,
  currentTime,
  waveformsBySource,
  videoClips,
  subtitles,
  markers,
  zoom,
  trackSettings,
  selectedSubtitleId,
  selectedSubtitleIds,
  selectedVideoClipId,
  onSeek,
  onSkimPreviewChange,
  onAddTrack,
  onClearSubtitleSelection,
  onVideoClipSelect,
  onVideoClipMove,
  onVideoClipResize,
  onVideoClipMoveToTrack,
  onMediaDrop,
  onCopyVideoClip,
  onPasteVideoClip,
  onDuplicateVideoClip,
  canPasteVideoClip = false,
  onSubtitleSelect,
  onSubtitleMove,
  onSubtitleGroupMove,
  onSubtitleResize,
  onMarkersChange,
  onZoomChange,
  onToggleTrackLock,
  onToggleTrackMute,
  onToggleTrackHidden,
  onVideoTransitionChange,
  onVideoFadeChange,
  onAudioFadeChange,
  onAudioVolumeChange,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const skimmerRef = useRef<HTMLDivElement | null>(null);
  const skimmerTimeRef = useRef<HTMLSpanElement | null>(null);
  const skimmerFrameRef = useRef<number | null>(null);
  const snapGuideRef = useRef<HTMLDivElement | null>(null);
  const rangeDragRef = useRef<{
    anchorTime: number;
    startClientX: number;
    moved: boolean;
  } | null>(null);
  const suppressRangeClickRef = useRef(false);
  const previousZoomRef = useRef(zoom);
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(0);
  const [timelineScrollLeft, setTimelineScrollLeft] = useState(0);
  const [workspaceDuration, setWorkspaceDuration] = useState(30);
  const [addTrackMenuOpen, setAddTrackMenuOpen] = useState(false);
  const [timelineRange, setTimelineRange] = useState<{
    start: number;
    end: number;
  } | null>(null);


  /*
   * Timeline scale is expressed as pixels per second. `scaleDuration` is the
   * stable project/source duration supplied by App, so moving or trimming clips
   * cannot alter visual scale. Workspace duration only controls how much blank
   * timeline exists to the right.
   */
  const scaleReferenceDuration = Math.max(1, scaleDuration || duration || 1);

  /*
   * Do not let normal projects zoom far enough for the ruler to switch from
   * 1-second major labels to 0.5-second labels. Besides being more useful for
   * editing, this bounds thumbnail density at the most expensive zoom level.
   *
   * TimelineRuler switches to 0.5 s once visibleDuration <= 10 s. Round the
   * cap down to our existing 0.25 zoom increments so we remain safely on the
   * 1-second side of that boundary. Very short projects may already be below
   * 10 seconds at 100%, in which case 100% remains the minimum/maximum.
   */
  const oneSecondRulerZoomLimit =
    scaleReferenceDuration > HALF_SECOND_RULER_THRESHOLD_SECONDS
      ? Math.max(
          MIN_TIMELINE_ZOOM,
          Math.floor(
            (scaleReferenceDuration /
              (HALF_SECOND_RULER_THRESHOLD_SECONDS + 0.001)) /
              TIMELINE_ZOOM_STEP,
          ) * TIMELINE_ZOOM_STEP,
        )
      : MIN_TIMELINE_ZOOM;
  const effectiveMaxZoom = Math.max(
    MIN_TIMELINE_ZOOM,
    Math.min(MAX_TIMELINE_ZOOM, oneSecondRulerZoomLimit),
  );

  const baseTrackWidthPx = Math.max(1, timelineViewportWidth);
  const pixelsPerSecondAt100 = baseTrackWidthPx / scaleReferenceDuration;
  const pixelsPerSecond = pixelsPerSecondAt100 * zoom;
  const timelineTrackWidthPx = Math.max(1, workspaceDuration * pixelsPerSecond);

  const workspaceWidthRatio = workspaceDuration / scaleReferenceDuration;
  const playheadPosition =
    workspaceDuration > 0 ? (currentTime / workspaceDuration) * 100 : 0;
  const visibleTimelineStart =
    pixelsPerSecond > 0 ? timelineScrollLeft / pixelsPerSecond : 0;
  const visibleTimelineEnd =
    pixelsPerSecond > 0
      ? (timelineScrollLeft + timelineViewportWidth) / pixelsPerSecond
      : workspaceDuration;

  const framesByClipId = useVideoClipFrames(
    videoClips,
    pixelsPerSecond,
    visibleTimelineStart,
    visibleTimelineEnd,
  );

  const markerTimes = useMemo(
    () => markers.map((marker) => marker.time).sort((a, b) => a - b),
    [markers],
  );

  const videoMoveSnapTargets = useMemo<VideoMoveSnapTarget[]>(() => {
    const clipTargets = videoClips.flatMap((clip) => [
      { time: clip.timelineStart, kind: "clip" as const, clipId: clip.id },
      { time: clip.timelineEnd, kind: "clip" as const, clipId: clip.id },
    ]);

    const markerTargets = markers.map((marker) => ({
      time: marker.time,
      kind: "marker" as const,
    }));

    return [
      { time: 0, kind: "timeline" as const },
      ...clipTargets,
      ...markerTargets,
      { time: currentTime, kind: "playhead" as const },
    ];
  }, [currentTime, markers, videoClips]);

  const timelineTracks = useMemo(
    () =>
      buildTimelineModel({
        duration: workspaceDuration,
        videoClips,
        subtitles,
        trackSettings,
      }),
    [
      workspaceDuration,
      videoClips,
      subtitles,
      trackSettings,
    ],
  );

  const setTimelineZoom = (nextZoom: number) => {
    const clamped = Math.max(
      MIN_TIMELINE_ZOOM,
      Math.min(effectiveMaxZoom, nextZoom),
    );
    onZoomChange?.(clamped);
  };

  useEffect(() => {
    if (zoom > effectiveMaxZoom + 0.0001) {
      onZoomChange?.(effectiveMaxZoom);
    }
  }, [effectiveMaxZoom, onZoomChange, zoom]);

  useEffect(() => {
    const stableDuration = Math.max(0, scaleDuration || duration || 0);

    if (stableDuration <= 0) {
      setWorkspaceDuration(30);
      return;
    }

    setWorkspaceDuration((current) => {
      const reserve = trailingWorkspaceDuration(stableDuration);
      const minimumWorkspace = stableDuration + reserve;
      const contentNeeds = Math.max(duration, stableDuration);
      const growThreshold = current - Math.max(4, reserve * 0.25);

      if (current < minimumWorkspace) {
        return minimumWorkspace;
      }

      if (contentNeeds >= growThreshold) {
        return Math.max(current, contentNeeds + reserve);
      }

      return current;
    });
  }, [duration, scaleDuration]);

  useEffect(() => {
    const scroll = scrollRef.current;

    if (!scroll) {
      return;
    }

    const updateViewportMetrics = () => {
      setTimelineViewportWidth(scroll.clientWidth);
      setTimelineScrollLeft(scroll.scrollLeft);
    };

    updateViewportMetrics();

    const handleScroll = () => setTimelineScrollLeft(scroll.scrollLeft);
    scroll.addEventListener("scroll", handleScroll, { passive: true });

    const observer = new ResizeObserver(updateViewportMetrics);
    observer.observe(scroll);

    return () => {
      observer.disconnect();
      scroll.removeEventListener("scroll", handleScroll);
    };
  }, []);

  useEffect(() => {
    const scroll = scrollRef.current;
    const previousZoom = previousZoomRef.current;

    previousZoomRef.current = zoom;

    if (!scroll || previousZoom === zoom || pixelsPerSecondAt100 <= 0) {
      return;
    }

    const previousPixelsPerSecond = pixelsPerSecondAt100 * previousZoom;
    const viewportCenterX = scroll.scrollLeft + scroll.clientWidth / 2;
    const centerTime = Math.max(
      0,
      viewportCenterX / Math.max(0.0001, previousPixelsPerSecond),
    );

    window.requestAnimationFrame(() => {
      const nextCenterX = centerTime * pixelsPerSecond;
      scroll.scrollLeft = Math.max(
        0,
        nextCenterX - scroll.clientWidth / 2,
      );
    });
  }, [zoom, pixelsPerSecond, pixelsPerSecondAt100]);

  const zoomOut = () => setTimelineZoom(zoom - TIMELINE_ZOOM_STEP);
  const zoomIn = () => setTimelineZoom(zoom + TIMELINE_ZOOM_STEP);

  const addMarker = (time: number) => {
    if (workspaceDuration <= 0) {
      return;
    }

    const safeTime = Math.max(0, Math.min(workspaceDuration, time));
    const existing = markers.find((marker) => Math.abs(marker.time - safeTime) < 0.05);

    if (existing) {
      return;
    }

    onMarkersChange?.(
      [...markers, { id: crypto.randomUUID(), time: safeTime }].sort(
        (a, b) => a.time - b.time,
      ),
    );
  };

  const addMarkerAtEvent = (event: ReactMouseEvent<HTMLElement>) => {
    if (workspaceDuration <= 0) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);

    addMarker(ratio * workspaceDuration);
  };

  const removeMarker = (id: string) => {
    onMarkersChange?.(markers.filter((marker) => marker.id !== id));
  };

  const removeNearestMarkerAtPlayhead = () => {
    if (markers.length === 0) {
      return;
    }

    const nearest = markers.reduce((best, marker) =>
      Math.abs(marker.time - currentTime) < Math.abs(best.time - currentTime)
        ? marker
        : best,
    );

    // Only remove a marker that is reasonably close to the playhead.
    // 0.5 seconds keeps Shift+M predictable rather than deleting a distant marker.
    if (Math.abs(nearest.time - currentTime) <= 0.5) {
      removeMarker(nearest.id);
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;

      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }

      if (event.key === "Escape" && timelineRange) {
        event.preventDefault();
        setTimelineRange(null);
        return;
      }

      if (event.key.toLowerCase() === "m") {
        event.preventDefault();

        if (event.shiftKey) {
          removeNearestMarkerAtPlayhead();
        } else {
          addMarker(currentTime);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [currentTime, workspaceDuration, markers, timelineRange]);

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.metaKey && !event.ctrlKey) {
      return;
    }

    event.preventDefault();
    setTimelineZoom(zoom + (event.deltaY < 0 ? TIMELINE_ZOOM_STEP : -TIMELINE_ZOOM_STEP));
  };

  const formatSkimmerTime = (time: number) => {
    const safeTime = Math.max(0, Number.isFinite(time) ? time : 0);
    const minutes = Math.floor(safeTime / 60);
    const seconds = safeTime - minutes * 60;

    return `${String(minutes).padStart(2, "0")}:${seconds
      .toFixed(1)
      .padStart(4, "0")}`;
  };

  const timelineTimeFromClientX = (clientX: number, element: HTMLElement) => {
    if (workspaceDuration <= 0) {
      return 0;
    }

    const rect = element.getBoundingClientRect();
    const ratio = Math.max(
      0,
      Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)),
    );

    return ratio * workspaceDuration;
  };

  const setSnapGuideTime = (time: number | null) => {
    const guide = snapGuideRef.current;

    if (!guide) {
      return;
    }

    if (time === null || workspaceDuration <= 0) {
      guide.hidden = true;
      return;
    }

    const safeTime = Math.max(0, Math.min(workspaceDuration, time));
    guide.hidden = false;
    guide.style.left = `${(safeTime / workspaceDuration) * 100}%`;
  };

  const startRangeHandleDrag = (
    event: ReactMouseEvent<HTMLButtonElement>,
    edge: "in" | "out",
  ) => {
    if (!timelineRange || workspaceDuration <= 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    hideSkimmer();

    const content = event.currentTarget.closest(
      ".timeline-content",
    ) as HTMLElement | null;

    if (!content) {
      return;
    }

    const fixedStart = timelineRange.start;
    const fixedEnd = timelineRange.end;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const time = timelineTimeFromClientX(moveEvent.clientX, content);

      setTimelineRange(
        edge === "in"
          ? { start: Math.min(time, fixedEnd), end: fixedEnd }
          : { start: fixedStart, end: Math.max(time, fixedStart) },
      );
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleRangeMouseDownCapture = (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0 || workspaceDuration <= 0) {
      return;
    }

    const target = event.target as HTMLElement;
    const editableSurface = target.closest(
      ".timeline-ruler-scale, .video-track, .subtitle-track, .waveform-track",
    );

    if (!editableSurface) {
      return;
    }

    if (
      target.closest(
        ".timeline-video-clip, .subtitle-clip, .audio-clip-label, .timeline-user-marker, .timeline-range-handle, button, input",
      )
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const content = event.currentTarget;
    const anchorTime = timelineTimeFromClientX(event.clientX, content);
    rangeDragRef.current = {
      anchorTime,
      startClientX: event.clientX,
      moved: false,
    };
    suppressRangeClickRef.current = true;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const drag = rangeDragRef.current;

      if (!drag) {
        return;
      }

      if (!drag.moved && Math.abs(moveEvent.clientX - drag.startClientX) < 4) {
        return;
      }

      drag.moved = true;
      hideSkimmer();
      moveEvent.preventDefault();

      const current = timelineTimeFromClientX(moveEvent.clientX, content);
      setTimelineRange({
        start: Math.min(drag.anchorTime, current),
        end: Math.max(drag.anchorTime, current),
      });
    };

    const handleMouseUp = (upEvent: MouseEvent) => {
      const drag = rangeDragRef.current;

      if (drag) {
        if (drag.moved) {
          const current = timelineTimeFromClientX(upEvent.clientX, content);
          setTimelineRange({
            start: Math.min(drag.anchorTime, current),
            end: Math.max(drag.anchorTime, current),
          });
        } else {
          onSeek?.(drag.anchorTime);
        }
      }

      rangeDragRef.current = null;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);

      window.setTimeout(() => {
        suppressRangeClickRef.current = false;
      }, 0);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleRangeClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressRangeClickRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  };

  const hideSkimmer = () => {
    if (skimmerFrameRef.current !== null) {
      window.cancelAnimationFrame(skimmerFrameRef.current);
      skimmerFrameRef.current = null;
    }

    if (skimmerRef.current) {
      skimmerRef.current.hidden = true;
    }

    onSkimPreviewChange?.(null);
  };

  const handleSkimmerMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (workspaceDuration <= 0 || event.buttons !== 0) {
      hideSkimmer();
      return;
    }

    const content = event.currentTarget;
    const rect = content.getBoundingClientRect();
    const ratio = Math.max(
      0,
      Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)),
    );
    const time = ratio * workspaceDuration;

    if (skimmerFrameRef.current !== null) {
      window.cancelAnimationFrame(skimmerFrameRef.current);
    }

    skimmerFrameRef.current = window.requestAnimationFrame(() => {
      skimmerFrameRef.current = null;

      const skimmer = skimmerRef.current;
      const label = skimmerTimeRef.current;

      if (!skimmer || !label) {
        return;
      }

      skimmer.hidden = false;
      skimmer.style.left = `${ratio * 100}%`;
      label.textContent = formatSkimmerTime(time);

      // Keep the time badge inside the visible timeline at the extreme edges.
      if (ratio < 0.045) {
        label.style.transform = "translateX(6px)";
      } else if (ratio > 0.955) {
        label.style.transform = "translateX(calc(-100% - 6px))";
      } else {
        label.style.transform = "translateX(-50%)";
      }

      onSkimPreviewChange?.(time);
    });
  };

  useEffect(() => {
    return () => {
      if (skimmerFrameRef.current !== null) {
        window.cancelAnimationFrame(skimmerFrameRef.current);
      }
      onSkimPreviewChange?.(null);
    };
  }, [onSkimPreviewChange]);

  const renderTimelineTrack = (
    track: TimelineTrackModel,
  ) => {
    switch (track.kind) {
      case "video":
        return (
          <VideoTrack
            key={track.id}
            duration={workspaceDuration}
            currentTime={currentTime}
            track={track}
            selectedVideoClipId={selectedVideoClipId}
            framesByClipId={framesByClipId}
            showLabel={false}
            onSeek={onSeek}
            onSelect={onVideoClipSelect}
            onMove={onVideoClipMove}
            onMoveToTrack={onVideoClipMoveToTrack}
            onMediaDrop={onMediaDrop}
            onResize={onVideoClipResize}
            onToggleLock={onToggleTrackLock}
            onToggleHidden={onToggleTrackHidden}
            onTransitionChange={onVideoTransitionChange}
            onFadeChange={onVideoFadeChange}
            snapTargets={videoMoveSnapTargets}
            onSnapGuideChange={setSnapGuideTime}
          />
        );

      case "subtitle":
        return (
          <SubtitleTrack
            key={track.id}
            duration={workspaceDuration}
            track={track}
            subtitles={subtitles}
            selectedSubtitleId={selectedSubtitleId}
            selectedSubtitleIds={selectedSubtitleIds}
            markerTimes={markerTimes}
            playheadTime={currentTime}
            showLabel={false}
            onSubtitleSelect={onSubtitleSelect}
            onSubtitleMove={onSubtitleMove}
            onSubtitleGroupMove={onSubtitleGroupMove}
            onSubtitleResize={onSubtitleResize}
            onSeek={onSeek}
            onToggleLock={onToggleTrackLock}
            onToggleHidden={onToggleTrackHidden}
          />
        );

      case "audio":
        return (
          <WaveformTrack
            key={track.id}
            duration={workspaceDuration}
            track={track}
            waveformsBySource={waveformsBySource}
            showLabel={false}
            onSeek={onSeek}
            onToggleMute={onToggleTrackMute}
            onFadeChange={onAudioFadeChange}
            onVolumeChange={onAudioVolumeChange}
          />
        );

      default:
        return null;
    }
  };

  useEffect(() => {
    if (!addTrackMenuOpen) return;

    const close = () => setAddTrackMenuOpen(false);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [addTrackMenuOpen]);

  const renderFixedTrackLabel = (track: TimelineTrackModel) => {
    const rowClass =
      track.kind === "video"
        ? "timeline-video-row"
        : track.kind === "subtitle"
          ? "timeline-subtitle-row"
          : "timeline-waveform-row";

    return (
      <div key={`label-${track.id}`} className={`timeline-fixed-label-row ${rowClass}`}>
        <TimelineTrackLabel
          shortLabel={track.shortLabel}
          name={track.name}
          locked={track.locked}
          muted={track.muted}
          hidden={track.hidden}
          canMute={track.kind === "audio"}
          canHide={track.kind !== "audio"}
          onToggleLock={
            track.kind !== "audio"
              ? () => onToggleTrackLock?.(track.id)
              : undefined
          }
          onToggleMute={
            track.kind === "audio"
              ? () => onToggleTrackMute?.(track.id)
              : undefined
          }
          onToggleHidden={
            track.kind !== "audio"
              ? () => onToggleTrackHidden?.(track.id)
              : undefined
          }
        />
      </div>
    );
  };



  return (
    <section className="timeline-panel">
      <div className="timeline-header">
        <div className="timeline-title-group">
          <div className="timeline-title-with-add">
            <h2>Timeline</h2>
            <div
              className="timeline-add-track-wrap"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="timeline-add-track-button"
                aria-label="Add timeline track"
                aria-haspopup="menu"
                aria-expanded={addTrackMenuOpen}
                title="Add track"
                onClick={() => setAddTrackMenuOpen((current) => !current)}
              >
                +
              </button>

              {addTrackMenuOpen && (
                <div className="timeline-add-track-menu" role="menu">
                  {[
                    ["video", "Add Video Track", "V"],
                    ["audio", "Add Audio Track", "A"],
                    ["subtitle", "Add Subtitle Track", "S"],
                  ].map(([kind, label, badge]) => (
                    <button
                      key={kind}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAddTrack?.(kind as TimelineTrackKind);
                        setAddTrackMenuOpen(false);
                      }}
                    >
                      <span className={`timeline-add-track-badge ${kind}`}>{badge}</span>
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <span className="timeline-help">
            Dynamic video, subtitle, and audio tracks · drag media or clips between video tracks
          </span>
        </div>

        <div className="timeline-controls">
          {timelineRange && (
            <div className="timeline-range-summary" title="Selected timeline range">
              <span>
                {formatSkimmerTime(timelineRange.start)}–{formatSkimmerTime(timelineRange.end)}
                <strong>{(timelineRange.end - timelineRange.start).toFixed(2)}s</strong>
              </span>
              <button
                type="button"
                onClick={() => setTimelineRange(null)}
                aria-label="Clear timeline range"
                title="Clear range (Esc)"
              >
                ×
              </button>
            </div>
          )}

          <div className="timeline-edit-actions" aria-label="Video clip actions">
            <button
              type="button"
              className="timeline-action-button"
              onClick={onCopyVideoClip}
              disabled={!selectedVideoClipId}
              title="Copy selected video clip (⌘C / Ctrl+C)"
            >
              Copy
            </button>

            <button
              type="button"
              className="timeline-action-button"
              onClick={onPasteVideoClip}
              disabled={!canPasteVideoClip}
              title="Paste video clip at playhead (⌘V / Ctrl+V)"
            >
              Paste
            </button>

            <button
              type="button"
              className="timeline-action-button"
              onClick={onDuplicateVideoClip}
              disabled={!selectedVideoClipId}
              title="Duplicate selected video clip (⌘D / Ctrl+D)"
            >
              Duplicate
            </button>
          </div>

          <button
            type="button"
            className="timeline-zoom-button"
            onClick={zoomOut}
            disabled={zoom <= MIN_TIMELINE_ZOOM}
            aria-label="Zoom timeline out"
          >
            −
          </button>

          <input
            className="timeline-zoom-slider"
            type="range"
            min={MIN_TIMELINE_ZOOM}
            max={effectiveMaxZoom}
            step={TIMELINE_ZOOM_STEP}
            value={zoom}
            onChange={(event) => setTimelineZoom(Number(event.target.value))}
            aria-label="Timeline zoom"
          />

          <button
            type="button"
            className="timeline-zoom-button"
            onClick={zoomIn}
            disabled={zoom >= effectiveMaxZoom - 0.0001}
            aria-label="Zoom timeline in"
          >
            +
          </button>

          <span className="timeline-zoom-label">{Math.round(zoom * 100)}%</span>
        </div>
      </div>

      <div className="timeline-body">
        <div className="timeline-fixed-column" aria-label="Timeline tracks">
          <div className="timeline-fixed-ruler-spacer" />
          <div className="timeline-fixed-track-stack">
            {timelineTracks.map(renderFixedTrackLabel)}
          </div>
        </div>

        <div ref={scrollRef} className="timeline-scroll" onWheel={handleWheel}>
          <div
            className="timeline-content"
            style={{
              width: `${timelineTrackWidthPx}px`,
            }}
            onMouseMove={handleSkimmerMouseMove}
            onMouseLeave={hideSkimmer}
            onMouseDownCapture={handleRangeMouseDownCapture}
            onClickCapture={handleRangeClickCapture}
          >
            <TimelineRuler
              duration={workspaceDuration}
              zoom={zoom * workspaceWidthRatio}
              currentTime={currentTime}
              onSeek={onSeek}
              showLabelSpacer={false}
            />

            <div
              ref={skimmerRef}
              className="timeline-skimmer"
              hidden
              aria-hidden="true"
            >
              <span className="timeline-skimmer-cap" />
              <span ref={skimmerTimeRef} className="timeline-skimmer-time" />
            </div>

            {timelineRange && workspaceDuration > 0 && (
              <div
                className="timeline-range-selection"
                style={{
                  left: `${(timelineRange.start / workspaceDuration) * 100}%`,
                  width: `${
                    ((timelineRange.end - timelineRange.start) / workspaceDuration) * 100
                  }%`,
                }}
                aria-label={`Selected range ${timelineRange.start.toFixed(2)} to ${timelineRange.end.toFixed(2)} seconds`}
              >
                <button
                  type="button"
                  className="timeline-range-handle in"
                  onMouseDown={(event) => startRangeHandleDrag(event, "in")}
                  aria-label="Adjust range in point"
                />
                <span className="timeline-range-duration">
                  {(timelineRange.end - timelineRange.start).toFixed(2)}s
                </span>
                <button
                  type="button"
                  className="timeline-range-handle out"
                  onMouseDown={(event) => startRangeHandleDrag(event, "out")}
                  aria-label="Adjust range out point"
                />
              </div>
            )}

            <div
              className="timeline-track-stack"
              onDoubleClick={addMarkerAtEvent}
              onMouseDown={(event) => {
                const target = event.target as HTMLElement;

                if (
                  target.closest(".subtitle-clip") ||
                  target.closest(".timeline-user-marker") ||
                  target.closest("button") ||
                  target.closest("input")
                ) {
                  return;
                }

                onClearSubtitleSelection?.();
              }}
            >
              {timelineTracks.map(renderTimelineTrack)}

              <div className="timeline-marker-layer" aria-hidden="true">
                {markers.map((marker) => (
                  <button
                    key={marker.id}
                    type="button"
                    className="timeline-user-marker"
                    style={{
                      left: `${
                        workspaceDuration > 0
                          ? (marker.time / workspaceDuration) * 100
                          : 0
                      }%`,
                    }}
                    title={`Marker ${marker.time.toFixed(2)}s — click to remove`}
                    onClick={(event) => {
                      event.stopPropagation();
                      removeMarker(marker.id);
                    }}
                  >
                    <span className="timeline-user-marker-cap" />
                  </button>
                ))}
              </div>

              <div
                ref={snapGuideRef}
                className="timeline-video-snap-guide"
                hidden
                aria-hidden="true"
              >
                <span />
              </div>

              <div
                className="timeline-playhead"
                style={{
                  left: `${playheadPosition}%`,
                }}
                aria-hidden="true"
              >
                <span className="timeline-playhead-cap" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default Timeline;
