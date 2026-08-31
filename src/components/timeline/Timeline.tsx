import { useState } from "react";

import type { Subtitle } from "../../types/subtitle";
import TimelineRuler from "./TimelineRuler";
import WaveformTrack from "./WaveformTrack";
import SubtitleTrack from "./SubtitleTrack";
import "./Timeline.css";

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
    newEndTime: number
  ) => void;
};

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

  return (
    <section className="timeline-panel">
      <div className="timeline-header">
        <h2>Timeline</h2>

        <div className="timeline-controls">
          <button onClick={() => setZoom((value) => Math.max(1, value - 0.5))}>
            -
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((value) => Math.min(8, value + 0.5))}>
            +
          </button>
        </div>
      </div>

      <div className="timeline-scroll">
        <div
          className="timeline-content"
          style={{ width: `${zoom * 100}%` }}
        >
          <TimelineRuler duration={duration} zoom={zoom} />

          <WaveformTrack
            duration={duration}
            currentTime={currentTime}
            videoName={videoName}
            waveform={waveform}
            zoom={zoom}
            onSeek={onSeek}
          />

          <SubtitleTrack
            duration={duration}
            subtitles={subtitles}
            selectedSubtitleId={selectedSubtitleId}
            onSubtitleSelect={onSubtitleSelect}
            onSubtitleMove={onSubtitleMove}
            onSubtitleResize={onSubtitleResize}
            onSeek={onSeek}
          />
        </div>
      </div>
    </section>
  );
}

export default Timeline;
