import {
  useEffect,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";

import type { Subtitle } from "../../types/subtitle";
import type { TimelineMarker } from "../../types/timeline";
import type {
  TimelineTrack as TimelineTrackModel,
  VideoTimelineClip,
} from "../../types/timelineModel";

import { buildTimelineModel } from "../../utils/timelineModel";

import SubtitleTrack from "./SubtitleTrack";
import TimelineRuler from "./TimelineRuler";
import VideoTrack from "./VideoTrack";
import WaveformTrack from "./WaveformTrack";

import "./Timeline.css";

type TimelineProps = {
  duration: number;
  currentTime: number;
  waveformsBySource: Record<string, number[]>;
  videoClips: VideoTimelineClip[];
  subtitles: Subtitle[];
  markers: TimelineMarker[];
  zoom: number;

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
};

export const MIN_TIMELINE_ZOOM = 1;
export const MAX_TIMELINE_ZOOM = 12;
export const TIMELINE_ZOOM_STEP = 0.25;

export function clampTimelineZoom(value: number) {
  return Math.max(MIN_TIMELINE_ZOOM, Math.min(MAX_TIMELINE_ZOOM, value));
}

function Timeline({
  duration,
  currentTime,
  waveformsBySource,
  videoClips,
  subtitles,
  markers,
  zoom,
  selectedSubtitleId,
  selectedSubtitleIds,
  selectedVideoClipId,
  onSeek,
  onClearSubtitleSelection,
  onVideoClipSelect,
  onVideoClipMove,
  onVideoClipResize,
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
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const previousZoomRef = useRef(zoom);

  const playheadPosition = duration > 0 ? (currentTime / duration) * 100 : 0;

  const markerTimes = useMemo(
    () => markers.map((marker) => marker.time).sort((a, b) => a - b),
    [markers],
  );

  const timelineTracks = useMemo(
    () =>
      buildTimelineModel({
        duration,
        videoClips,
        subtitles,
      }),
    [
      duration,
      videoClips,
      subtitles,
    ],
  );

  const setTimelineZoom = (nextZoom: number) => {
    onZoomChange?.(clampTimelineZoom(nextZoom));
  };

  useEffect(() => {
    const scroll = scrollRef.current;
    const previousZoom = previousZoomRef.current;

    previousZoomRef.current = zoom;

    if (!scroll || previousZoom === zoom) {
      return;
    }

    const previousContentWidth =
      zoom > 0 ? (scroll.scrollWidth * previousZoom) / zoom : scroll.scrollWidth;
    const viewportCenter = scroll.scrollLeft + scroll.clientWidth / 2;
    const centerRatio = previousContentWidth > 0 ? viewportCenter / previousContentWidth : 0;

    window.requestAnimationFrame(() => {
      const nextContentWidth = scroll.scrollWidth;
      scroll.scrollLeft = Math.max(
        0,
        centerRatio * nextContentWidth - scroll.clientWidth / 2,
      );
    });
  }, [zoom]);

  const zoomOut = () => setTimelineZoom(zoom - TIMELINE_ZOOM_STEP);
  const zoomIn = () => setTimelineZoom(zoom + TIMELINE_ZOOM_STEP);

  const addMarker = (time: number) => {
    if (duration <= 0) {
      return;
    }

    const safeTime = Math.max(0, Math.min(duration, time));
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
    if (duration <= 0) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const labelWidth = 86;
    const trackWidth = Math.max(1, rect.width - labelWidth);
    const ratio = (event.clientX - rect.left - labelWidth) / trackWidth;

    addMarker(ratio * duration);
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
  }, [currentTime, duration, markers]);

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
            duration={duration}
            currentTime={currentTime}
            track={track}
            selectedVideoClipId={selectedVideoClipId}
            onSeek={onSeek}
            onSelect={onVideoClipSelect}
            onMove={onVideoClipMove}
            onResize={onVideoClipResize}
          />
        );

      case "subtitle":
        return (
          <SubtitleTrack
            key={track.id}
            duration={duration}
            track={track}
            subtitles={subtitles}
            selectedSubtitleId={selectedSubtitleId}
            selectedSubtitleIds={selectedSubtitleIds}
            markerTimes={markerTimes}
            playheadTime={currentTime}
            onSubtitleSelect={onSubtitleSelect}
            onSubtitleMove={onSubtitleMove}
            onSubtitleGroupMove={onSubtitleGroupMove}
            onSubtitleResize={onSubtitleResize}
            onSeek={onSeek}
          />
        );

      case "audio":
        return (
          <WaveformTrack
            key={track.id}
            duration={duration}
            track={track}
            waveformsBySource={waveformsBySource}
            onSeek={onSeek}
          />
        );

      default:
        return null;
    }
  };


  return (
    <section className="timeline-panel">
      <div className="timeline-header">
        <div className="timeline-title-group">
          <h2>Timeline</h2>
          <span className="timeline-help">
            V1 editable · A1 linked · split · trim · move · copy · paste · duplicate
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
            max={MAX_TIMELINE_ZOOM}
            step={TIMELINE_ZOOM_STEP}
            value={zoom}
            onChange={(event) => setTimelineZoom(Number(event.target.value))}
            aria-label="Timeline zoom"
          />

          <button
            type="button"
            className="timeline-zoom-button"
            onClick={zoomIn}
            disabled={zoom >= MAX_TIMELINE_ZOOM}
            aria-label="Zoom timeline in"
          >
            +
          </button>

          <span className="timeline-zoom-label">{Math.round(zoom * 100)}%</span>
        </div>
      </div>

      <div ref={scrollRef} className="timeline-scroll" onWheel={handleWheel}>
        <div
          className="timeline-content"
          style={{
            width: `${zoom * 100}%`,
          }}
        >
          <TimelineRuler duration={duration} zoom={zoom} />

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
                    left: `${duration > 0 ? (marker.time / duration) * 100 : 0}%`,
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
                left: `calc(86px + (100% - 86px) * ${playheadPosition / 100})`,
              }}
              aria-hidden="true"
            >
              <span className="timeline-playhead-cap" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default Timeline;
