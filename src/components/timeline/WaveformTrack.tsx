import {
  useEffect,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";

import type {
  AudioTimelineClip,
  TimelineTrack,
  TimelineTrackId,
} from "../../types/timelineModel";

import TimelineTrackLabel from "./TimelineTrackLabel";

type WaveformTrackProps = {
  duration: number;
  track: TimelineTrack;
  waveformsBySource: Record<string, number[]>;
  onSeek?: (time: number) => void;
  onToggleMute?: (trackId: TimelineTrackId) => void;
  showLabel?: boolean;
};

function drawWaveformClip(
  context: CanvasRenderingContext2D,
  clip: AudioTimelineClip,
  waveform: number[],
  timelineDuration: number,
  width: number,
  height: number,
) {
  if (
    waveform.length === 0 ||
    timelineDuration <= 0 ||
    clip.timelineEnd <= clip.timelineStart
  ) {
    return;
  }

  const sourceDuration = Math.max(
    clip.sourceDuration ?? clip.sourceOut,
    clip.sourceOut,
    0.001,
  );

  const sourceStartRatio = Math.max(
    0,
    Math.min(1, clip.sourceIn / sourceDuration),
  );
  const sourceEndRatio = Math.max(
    sourceStartRatio,
    Math.min(1, clip.sourceOut / sourceDuration),
  );

  const sourceStartIndex = Math.max(
    0,
    Math.min(
      waveform.length - 1,
      Math.floor(sourceStartRatio * waveform.length),
    ),
  );
  const sourceEndIndex = Math.max(
    sourceStartIndex + 1,
    Math.min(
      waveform.length,
      Math.ceil(sourceEndRatio * waveform.length),
    ),
  );

  const clipLeft = (clip.timelineStart / timelineDuration) * width;
  const clipRight = (clip.timelineEnd / timelineDuration) * width;
  const clipWidth = Math.max(1, clipRight - clipLeft);
  const centerY = height / 2;

  context.save();
  context.beginPath();
  context.rect(clipLeft, 0, clipWidth, height);
  context.clip();

  context.fillStyle = "rgba(255, 255, 255, 0.045)";
  context.fillRect(clipLeft, 0, clipWidth, height);

  const sourceSampleCount = Math.max(1, sourceEndIndex - sourceStartIndex);
  const barCount = Math.max(
    1,
    Math.min(sourceSampleCount, Math.floor(clipWidth / 2)),
  );
  const barWidth = clipWidth / barCount;

  context.fillStyle = "rgba(220, 220, 220, 0.76)";

  for (let barIndex = 0; barIndex < barCount; barIndex += 1) {
    const bucketStart =
      sourceStartIndex +
      Math.floor((barIndex / barCount) * sourceSampleCount);
    const bucketEnd =
      sourceStartIndex +
      Math.max(
        1,
        Math.floor(((barIndex + 1) / barCount) * sourceSampleCount),
      );

    let amplitudeValue = 0;

    for (
      let sampleIndex = bucketStart;
      sampleIndex < Math.min(bucketEnd, sourceEndIndex);
      sampleIndex += 1
    ) {
      amplitudeValue = Math.max(
        amplitudeValue,
        Math.abs(waveform[sampleIndex] ?? 0),
      );
    }

    const positionRatio = barCount <= 1 ? 0 : barIndex / (barCount - 1);
    const clipDuration = Math.max(0.001, clip.timelineEnd - clip.timelineStart);
    const localTime = positionRatio * clipDuration;
    const fadeInDuration = Math.max(0, Math.min(clip.fadeInDuration ?? 0, clipDuration / 2));
    const fadeOutDuration = Math.max(0, Math.min(clip.fadeOutDuration ?? 0, clipDuration / 2));
    const fadeInGain = fadeInDuration > 0 ? Math.min(1, localTime / fadeInDuration) : 1;
    const fadeOutGain = fadeOutDuration > 0 ? Math.min(1, (clipDuration - localTime) / fadeOutDuration) : 1;
    const volumeGain = Math.max(0, Math.min(100, clip.volume ?? 100)) / 100;
    const effectiveGain = clip.muted ? 0.12 : volumeGain * Math.min(fadeInGain, fadeOutGain);
    const amplitude = Math.max(1, amplitudeValue * height * 0.72 * effectiveGain);
    const x = clipLeft + barIndex * barWidth;
    const y = centerY - amplitude / 2;

    context.fillRect(
      x,
      y,
      Math.max(1, barWidth * 0.72),
      amplitude,
    );
  }

  context.strokeStyle = "rgba(255, 255, 255, 0.12)";
  context.lineWidth = 1;
  context.strokeRect(
    Math.round(clipLeft) + 0.5,
    0.5,
    Math.max(0, Math.round(clipWidth) - 1),
    Math.max(0, height - 1),
  );

  context.restore();
}

function WaveformTrack({
  duration,
  track,
  waveformsBySource,
  onSeek,
  onToggleMute,
  showLabel = true,
}: WaveformTrackProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const audioClips = useMemo(
    () =>
      track.clips.filter(
        (clip): clip is AudioTimelineClip => clip.kind === "audio",
      ),
    [track.clips],
  );

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const draw = () => {
      const context = canvas.getContext("2d");

      if (!context) {
        return;
      }

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const scale = window.devicePixelRatio || 1;

      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));

      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, width, height);

      if (duration <= 0) {
        return;
      }

      context.globalAlpha = track.muted ? 0.35 : 1;

      for (const clip of audioClips) {
        const waveform = waveformsBySource[clip.sourcePath] ?? [];

        drawWaveformClip(
          context,
          clip,
          waveform,
          duration,
          width,
          height,
        );
      }

      context.globalAlpha = 1;
    };

    draw();

    const observer = new ResizeObserver(draw);
    observer.observe(canvas);

    return () => {
      observer.disconnect();
    };
  }, [audioClips, duration, waveformsBySource, track.muted]);

  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (duration <= 0 || event.detail > 1) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const percentage = (event.clientX - rect.left) / rect.width;
    const newTime = Math.max(
      0,
      Math.min(duration, percentage * duration),
    );

    onSeek?.(newTime);
  };

  return (
    <div className={`timeline-row timeline-waveform-row ${showLabel ? "" : "track-only"}`.trim()}>
      {showLabel && (
      <TimelineTrackLabel
        shortLabel={track.shortLabel}
        name={track.name}
        locked={track.locked}
        muted={track.muted}
        canMute
        onToggleMute={() => onToggleMute?.(track.id)}
      />
      )}

      <div
        className={[
          "waveform-track",
          track.muted ? "track-muted" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={handleClick}
      >
        <canvas ref={canvasRef} className="waveform-canvas" />

        {audioClips.map((clip) => (
          <span
            key={clip.id}
            className="audio-clip-label"
            style={{
              left: `${
                duration > 0
                  ? (clip.timelineStart / duration) * 100
                  : 0
              }%`,
              width: `${
                duration > 0
                  ? ((clip.timelineEnd - clip.timelineStart) / duration) * 100
                  : 0
              }%`,
            }}
            title={`${clip.sourceName} · linked to ${
              track.id === "audio-2" ? "V2" : "V1"
            } · ${clip.muted ? "Muted" : `${Math.round(clip.volume ?? 100)}%`}`}
          >
            {clip.sourceName}{clip.muted ? " · Muted" : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

export default WaveformTrack;
