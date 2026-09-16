import {
  useEffect,
  useMemo,
  useRef,
  useState,
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
  selectedVideoClipIds?: string[];
  onSeek?: (time: number) => void;
  onToggleMute?: (trackId: TimelineTrackId) => void;
  onFadeChange?: (id: string, edge: "in" | "out", duration: number) => void;
  onVolumeChange?: (id: string, volume: number) => void;
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
    const fadeInDuration = Math.max(0, Math.min(clip.fadeInDuration ?? 0, clipDuration));
    const fadeOutDuration = Math.max(0, Math.min(clip.fadeOutDuration ?? 0, clipDuration));
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
  selectedVideoClipIds = [],
  onSeek,
  onToggleMute,
  onFadeChange,
  onVolumeChange,
  showLabel = true,
}: WaveformTrackProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [fadeDrag, setFadeDrag] = useState<{
    clipId: string;
    edge: "in" | "out";
    duration: number;
  } | null>(null);
  const [volumeDrag, setVolumeDrag] = useState<{
    clipId: string;
    volume: number;
  } | null>(null);

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

  const startAudioFadeResize = (
    event: ReactMouseEvent<HTMLButtonElement>,
    clip: AudioTimelineClip,
    edge: "in" | "out",
  ) => {
    const fadeChange = onFadeChange;
    const linkedVideoClipId = clip.linkedVideoClipId;

    if (!fadeChange || !linkedVideoClipId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const clipElement = event.currentTarget.closest(
      ".audio-clip-label",
    ) as HTMLElement | null;

    if (!clipElement) {
      return;
    }

    const rect = clipElement.getBoundingClientRect();
    const clipDuration = Math.max(0.001, clip.timelineEnd - clip.timelineStart);
    const maxDuration = clipDuration;
    const originalDuration = Math.max(
      0,
      Math.min(
        maxDuration,
        edge === "in" ? clip.fadeInDuration ?? 0 : clip.fadeOutDuration ?? 0,
      ),
    );
    const startX = event.clientX;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaSeconds =
        ((moveEvent.clientX - startX) / Math.max(1, rect.width)) * clipDuration;
      const nextDuration = Math.max(
        0,
        Math.min(
          maxDuration,
          edge === "in"
            ? originalDuration + deltaSeconds
            : originalDuration - deltaSeconds,
        ),
      );

      setFadeDrag({ clipId: clip.id, edge, duration: nextDuration });
      fadeChange(linkedVideoClipId, edge, nextDuration);
    };

    const handleMouseUp = () => {
      setFadeDrag(null);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const startAudioVolumeDrag = (
    event: ReactMouseEvent<HTMLButtonElement>,
    clip: AudioTimelineClip,
  ) => {
    const volumeChange = onVolumeChange;
    const linkedVideoClipId = clip.linkedVideoClipId;

    if (!volumeChange || !linkedVideoClipId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const envelope = event.currentTarget.closest(
      ".audio-volume-envelope",
    ) as HTMLElement | null;

    if (!envelope) {
      return;
    }

    const rect = envelope.getBoundingClientRect();

    const applyVolumeAtY = (clientY: number) => {
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
      const nextVolume = Math.round((1 - ratio) * 100);

      setVolumeDrag({ clipId: clip.id, volume: nextVolume });
      volumeChange(linkedVideoClipId, nextVolume);
    };

    applyVolumeAtY(event.clientY);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      applyVolumeAtY(moveEvent.clientY);
    };

    const handleMouseUp = () => {
      setVolumeDrag(null);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

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

        {audioClips.map((clip) => {
          const clipDuration = Math.max(0.001, clip.timelineEnd - clip.timelineStart);
          const fadeInDuration = Math.max(
            0,
            Math.min(clipDuration, clip.fadeInDuration ?? 0),
          );
          const fadeOutDuration = Math.max(
            0,
            Math.min(clipDuration, clip.fadeOutDuration ?? 0),
          );
          const fadeInWidth = (fadeInDuration / clipDuration) * 100;
          const fadeOutWidth = (fadeOutDuration / clipDuration) * 100;
          const volume = Math.max(0, Math.min(100, clip.volume ?? 100));
          const volumeY = 100 - volume;
          const videoTrackLabel = `V${track.index}`;

          return (
            <span
              key={clip.id}
              className={[
                "audio-clip-label",
                clip.linkedVideoClipId && selectedVideoClipIds.includes(clip.linkedVideoClipId)
                  ? "selected"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
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
              title={`${clip.sourceName} · linked to ${videoTrackLabel} · ${
                clip.muted ? "Muted" : `${Math.round(clip.volume ?? 100)}%`
              }`}
            >
              <span className="audio-clip-name">
                {clip.sourceName}{clip.muted ? " · Muted" : ""}
              </span>

              {fadeInDuration > 0 && (
                <span
                  className="clip-fade-region audio in"
                  style={{ width: `${fadeInWidth}%` }}
                  aria-hidden="true"
                >
                  <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                    <path d={`M0 100 C22 100 38 ${volumeY} 100 ${volumeY}`} />
                  </svg>
                </span>
              )}

              {fadeOutDuration > 0 && (
                <span
                  className="clip-fade-region audio out"
                  style={{ width: `${fadeOutWidth}%` }}
                  aria-hidden="true"
                >
                  <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                    <path d={`M0 ${volumeY} C62 ${volumeY} 78 100 100 100`} />
                  </svg>
                </span>
              )}

              {clip.linkedVideoClipId && (onVolumeChange || onFadeChange) && (
                <span className="audio-volume-envelope">
                  {onVolumeChange && (
                    <>
                      <span
                        className="audio-volume-line"
                        style={{ top: `${volumeY}%` }}
                      />
                      <button
                        type="button"
                        className={[
                          "audio-volume-handle",
                          volumeDrag?.clipId === clip.id ? "active" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        style={{ top: `${volumeY}%` }}
                        onMouseDown={(event) => startAudioVolumeDrag(event, clip)}
                        onClick={(event) => event.stopPropagation()}
                        title={`Volume · ${Math.round(volume)}%`}
                        aria-label={`Adjust audio volume, currently ${Math.round(volume)} percent`}
                      />
                    </>
                  )}

                  {onFadeChange && (
                    <>
                      <button
                        type="button"
                        className={[
                          "clip-fade-handle",
                          "audio",
                          "in",
                          fadeDrag?.clipId === clip.id && fadeDrag.edge === "in"
                            ? "active"
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        style={{
                          left: `clamp(5px, ${fadeInWidth}%, calc(100% - 5px))`,
                          top: `${volumeY}%`,
                        }}
                        onMouseDown={(event) => startAudioFadeResize(event, clip, "in")}
                        onClick={(event) => event.stopPropagation()}
                        title={`Audio fade in · ${fadeInDuration.toFixed(2)}s`}
                        aria-label="Adjust audio fade in"
                      />
                      <button
                        type="button"
                        className={[
                          "clip-fade-handle",
                          "audio",
                          "out",
                          fadeDrag?.clipId === clip.id && fadeDrag.edge === "out"
                            ? "active"
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        style={{
                          right: `clamp(5px, ${fadeOutWidth}%, calc(100% - 5px))`,
                          top: `${volumeY}%`,
                        }}
                        onMouseDown={(event) => startAudioFadeResize(event, clip, "out")}
                        onClick={(event) => event.stopPropagation()}
                        title={`Audio fade out · ${fadeOutDuration.toFixed(2)}s`}
                        aria-label="Adjust audio fade out"
                      />
                    </>
                  )}
                </span>
              )}

              {fadeDrag?.clipId === clip.id && (
                <span
                  className={`clip-fade-duration-label audio ${fadeDrag.edge}`}
                  style={
                    fadeDrag.edge === "in"
                      ? { left: `${(fadeDrag.duration / clipDuration) * 100}%` }
                      : { right: `${(fadeDrag.duration / clipDuration) * 100}%` }
                  }
                >
                  {fadeDrag.duration.toFixed(2)}s
                </span>
              )}

              {volumeDrag?.clipId === clip.id && (
                <span
                  className="audio-volume-value-label"
                  style={{ top: `${100 - volumeDrag.volume}%` }}
                >
                  {volumeDrag.volume}%
                </span>
              )}
            </span>
          );
        })}

      </div>
    </div>
  );
}

export default WaveformTrack;
