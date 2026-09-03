import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import type { Subtitle } from "../../types/subtitle";

import SubtitleTrack from "./SubtitleTrack";
import TimelineRuler from "./TimelineRuler";
import WaveformTrack from "./WaveformTrack";

import "./Timeline.css";

type TimelineMarker = {
  id: string;
  time: number;
};

type TimelineProps = {
  duration: number;
  currentTime: number;
  videoName: string | null;
  waveform: number[];
  subtitles: Subtitle[];

  selectedSubtitleId: string | null;

  onSeek?: (time: number) => void;
  onSubtitleSelect?: (id: string) => void;
  onSubtitleMove?: (id: string, newStartTime: number) => void;
  onSubtitleResize?: (
    id: string,
    newStartTime: number,
    newEndTime: number,
  ) => void;
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 12;
const ZOOM_STEP = 0.25;

function clampZoom(value: number) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

function Timeline({
  duration,
  currentTime,
  videoName,
  waveform,
  subtitles,
  selectedSubtitleId,
  onSeek,
  onSubtitleSelect,
  onSubtitleMove,
  onSubtitleResize,
}: TimelineProps) {
  const [zoom, setZoom] = useState(1);
  const [markers, setMarkers] = useState<TimelineMarker[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const playheadPosition = duration > 0 ? (currentTime / duration) * 100 : 0;

  const markerTimes = useMemo(
    () => markers.map((marker) => marker.time).sort((a, b) => a - b),
    [markers],
  );

  const setTimelineZoom = (nextZoom: number) => {
    const scroll = scrollRef.current;
    const previousZoom = zoom;
    const clampedZoom = clampZoom(nextZoom);

    if (!scroll || previousZoom === clampedZoom) {
      setZoom(clampedZoom);
      return;
    }

    const viewportCenter = scroll.scrollLeft + scroll.clientWidth / 2;
    const previousContentWidth = scroll.scrollWidth || scroll.clientWidth;
    const centerRatio = previousContentWidth > 0 ? viewportCenter / previousContentWidth : 0;

    setZoom(clampedZoom);

    window.requestAnimationFrame(() => {
      const nextContentWidth = scroll.scrollWidth;
      scroll.scrollLeft = Math.max(
        0,
        centerRatio * nextContentWidth - scroll.clientWidth / 2,
      );
    });
  };

  const zoomOut = () => setTimelineZoom(zoom - ZOOM_STEP);
  const zoomIn = () => setTimelineZoom(zoom + ZOOM_STEP);

  const addMarkerAtEvent = (event: ReactMouseEvent<HTMLElement>) => {
    if (duration <= 0) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const labelWidth = 86;
    const trackWidth = Math.max(1, rect.width - labelWidth);
    const ratio = (event.clientX - rect.left - labelWidth) / trackWidth;
    const time = Math.max(0, Math.min(duration, ratio * duration));

    setMarkers((current) => {
      const existing = current.find((marker) => Math.abs(marker.time - time) < 0.05);

      if (existing) {
        return current;
      }

      return [...current, { id: crypto.randomUUID(), time }].sort(
        (a, b) => a.time - b.time,
      );
    });
  };

  const removeMarker = (id: string) => {
    setMarkers((current) => current.filter((marker) => marker.id !== id));
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.metaKey && !event.ctrlKey) {
      return;
    }

    event.preventDefault();
    setTimelineZoom(zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
  };

  return (
    <section className="timeline-panel">
      <div className="timeline-header">
        <div className="timeline-title-group">
          <h2>Timeline</h2>
          <span className="timeline-help">Double-click to add marker</span>
        </div>

        <div className="timeline-controls">
          <button
            type="button"
            className="timeline-zoom-button"
            onClick={zoomOut}
            disabled={zoom <= MIN_ZOOM}
            aria-label="Zoom timeline out"
          >
            −
          </button>

          <input
            className="timeline-zoom-slider"
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={ZOOM_STEP}
            value={zoom}
            onChange={(event) => setTimelineZoom(Number(event.target.value))}
            aria-label="Timeline zoom"
          />

          <button
            type="button"
            className="timeline-zoom-button"
            onClick={zoomIn}
            disabled={zoom >= MAX_ZOOM}
            aria-label="Zoom timeline in"
          >
            +
          </button>

          <span className="timeline-zoom-label">{Math.round(zoom * 100)}%</span>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="timeline-scroll"
        onWheel={handleWheel}
      >
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
          >
            <WaveformTrack
              duration={duration}
              videoName={videoName}
              waveform={waveform}
              onSeek={onSeek}
            />

            <SubtitleTrack
              duration={duration}
              subtitles={subtitles}
              selectedSubtitleId={selectedSubtitleId}
              markerTimes={markerTimes}
              onSubtitleSelect={onSubtitleSelect}
              onSubtitleMove={onSubtitleMove}
              onSubtitleResize={onSubtitleResize}
              onSeek={onSeek}
            />

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
