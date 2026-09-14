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
  TimelineTrackSettings,
  VideoTimelineClip,
  VideoTransitionType,
} from "../../types/timelineModel";

import { useVideoClipFrames } from "../../hooks/useVideoClipFrames";
import { buildTimelineModel } from "../../utils/timelineModel";

import SubtitleTrack from "./SubtitleTrack";
import TimelineRuler from "./TimelineRuler";
import TimelineTrackLabel from "./TimelineTrackLabel";
import VideoTrack from "./VideoTrack";
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
};

export const MIN_TIMELINE_ZOOM = 1;
export const MAX_TIMELINE_ZOOM = 12;
export const TIMELINE_ZOOM_STEP = 0.25;

const MIN_MAJOR_RULER_INTERVAL_SECONDS = 1;
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
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const previousZoomRef = useRef(zoom);
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(0);
  const [timelineScrollLeft, setTimelineScrollLeft] = useState(0);
  const [workspaceDuration, setWorkspaceDuration] = useState(30);


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
  }, [currentTime, workspaceDuration, markers]);

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.metaKey && !event.ctrlKey) {
      return;
    }

    event.preventDefault();
    setTimelineZoom(zoom + (event.deltaY < 0 ? TIMELINE_ZOOM_STEP : -TIMELINE_ZOOM_STEP));
  };

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
          />
        );

      default:
        return null;
    }
  };

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
          <h2>Timeline</h2>
          <span className="timeline-help">
            V1/V2 compositing · linked A1/A2 · drag media or clips between video tracks
          </span>
        </div>

        <div className="timeline-controls">
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
          >
            <TimelineRuler
              duration={workspaceDuration}
              zoom={zoom * workspaceWidthRatio}
              currentTime={currentTime}
              onSeek={onSeek}
              showLabelSpacer={false}
            />

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
