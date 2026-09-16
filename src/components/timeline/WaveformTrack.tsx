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
import {
  canShowNativeContextMenu,
  showNativeContextMenu,
} from "../../services/nativeContextMenu";
import { videoPlaybackRate } from "../../utils/videoRetime";

import TimelineTrackLabel from "./TimelineTrackLabel";

type WaveformTrackProps = {
  duration: number;
  track: TimelineTrack;
  waveformsBySource: Record<string, number[]>;
  selectedVideoClipIds?: string[];
  selectedAudioClipId?: string | null;
  selectedAudioClipIds?: string[];
  linkedTrackId?: TimelineTrackId | null;
  onSeek?: (time: number) => void;
  onPasteTargetChange?: (trackId: TimelineTrackId, time: number) => void;
  onToggleMute?: (trackId: TimelineTrackId) => void;
  onSelect?: (id: string, mode?: "single" | "toggle" | "focus") => void;
  onMoveStart?: (id: string) => boolean | void;
  onMoveEnd?: () => void;
  onMove?: (id: string, newTimelineStart: number) => void;
  onMoveToTrack?: (
    id: string,
    targetTrackId: TimelineTrackId,
    newTimelineStart: number,
  ) => void;
  onResize?: (id: string, newTimelineStart: number, newTimelineEnd: number) => void;
  onLinkedFadeChange?: (id: string, edge: "in" | "out", duration: number) => void;
  onLinkedVolumeChange?: (id: string, volume: number) => void;
  onLinkedMuteChange?: (id: string, muted: boolean) => void;
  onStandaloneFadeChange?: (id: string, edge: "in" | "out", duration: number) => void;
  onStandaloneVolumeChange?: (id: string, volume: number) => void;
  onStandaloneMuteChange?: (id: string, muted: boolean) => void;
  onRevealClip?: (clip: AudioTimelineClip) => void;
  showLabel?: boolean;
};

const MIN_AUDIO_CLIP_DURATION = 0.05;

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
  const sourceStartRatio = Math.max(0, Math.min(1, clip.sourceIn / sourceDuration));
  const sourceEndRatio = Math.max(sourceStartRatio, Math.min(1, clip.sourceOut / sourceDuration));
  const sourceStartIndex = Math.max(
    0,
    Math.min(waveform.length - 1, Math.floor(sourceStartRatio * waveform.length)),
  );
  const sourceEndIndex = Math.max(
    sourceStartIndex + 1,
    Math.min(waveform.length, Math.ceil(sourceEndRatio * waveform.length)),
  );

  const clipLeft = (clip.timelineStart / timelineDuration) * width;
  const clipRight = (clip.timelineEnd / timelineDuration) * width;
  const clipWidth = Math.max(1, clipRight - clipLeft);
  const centerY = height / 2;

  context.save();
  context.beginPath();
  context.rect(clipLeft, 0, clipWidth, height);
  context.clip();
  context.fillStyle = clip.linkedVideoClipId
    ? "rgba(255, 255, 255, 0.045)"
    : "rgba(80, 190, 130, 0.075)";
  context.fillRect(clipLeft, 0, clipWidth, height);

  const sourceSampleCount = Math.max(1, sourceEndIndex - sourceStartIndex);
  const barCount = Math.max(1, Math.min(sourceSampleCount, Math.floor(clipWidth / 2)));
  const barWidth = clipWidth / barCount;
  context.fillStyle = clip.linkedVideoClipId
    ? "rgba(220, 220, 220, 0.76)"
    : "rgba(198, 235, 212, 0.82)";

  for (let barIndex = 0; barIndex < barCount; barIndex += 1) {
    const bucketStart = sourceStartIndex + Math.floor((barIndex / barCount) * sourceSampleCount);
    const bucketEnd = sourceStartIndex + Math.max(
      1,
      Math.floor(((barIndex + 1) / barCount) * sourceSampleCount),
    );
    let amplitudeValue = 0;

    for (
      let sampleIndex = bucketStart;
      sampleIndex < Math.min(bucketEnd, sourceEndIndex);
      sampleIndex += 1
    ) {
      amplitudeValue = Math.max(amplitudeValue, Math.abs(waveform[sampleIndex] ?? 0));
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
    context.fillRect(x, y, Math.max(1, barWidth * 0.72), amplitude);
  }

  context.strokeStyle = clip.linkedVideoClipId
    ? "rgba(255, 255, 255, 0.12)"
    : "rgba(135, 223, 170, 0.28)";
  context.lineWidth = 1;
  context.strokeRect(
    Math.round(clipLeft) + 0.5,
    0.5,
    Math.max(0, Math.round(clipWidth) - 1),
    Math.max(0, height - 1),
  );
  context.restore();
}

function clearExternalAudioTrackPreview() {
  document
    .querySelectorAll<HTMLElement>(".waveform-track.clip-drag-target")
    .forEach((element) => {
      element.classList.remove("clip-drag-target");
      element.style.removeProperty("--clip-drag-left");
      element.style.removeProperty("--clip-drag-width");
    });
}

function setExternalAudioTrackPreview(
  target: HTMLElement,
  timelineStart: number,
  clipDuration: number,
  timelineDuration: number,
) {
  clearExternalAudioTrackPreview();
  const left = timelineDuration > 0 ? (timelineStart / timelineDuration) * 100 : 0;
  const width = timelineDuration > 0 ? (clipDuration / timelineDuration) * 100 : 0;
  target.classList.add("clip-drag-target");
  target.style.setProperty("--clip-drag-left", `${left}%`);
  target.style.setProperty("--clip-drag-width", `${Math.max(width, 0.6)}%`);
}

function WaveformTrack({
  duration,
  track,
  waveformsBySource,
  selectedVideoClipIds = [],
  selectedAudioClipId = null,
  selectedAudioClipIds = [],
  linkedTrackId,
  onSeek,
  onPasteTargetChange,
  onToggleMute,
  onSelect,
  onMoveStart,
  onMoveEnd,
  onMove,
  onMoveToTrack,
  onResize,
  onLinkedFadeChange,
  onLinkedVolumeChange,
  onLinkedMuteChange,
  onStandaloneFadeChange,
  onStandaloneVolumeChange,
  onStandaloneMuteChange,
  onRevealClip,
  showLabel = true,
}: WaveformTrackProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
  const [fadeDrag, setFadeDrag] = useState<{
    clipId: string;
    edge: "in" | "out";
    duration: number;
  } | null>(null);
  const [volumeDrag, setVolumeDrag] = useState<{
    clipId: string;
    volume: number;
  } | null>(null);

  const isLinkedTrack = !!linkedTrackId;
  const audioClips = useMemo(
    () => track.clips.filter((clip): clip is AudioTimelineClip => clip.kind === "audio"),
    [track.clips],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const context = canvas.getContext("2d");
      if (!context) return;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, width, height);
      if (duration <= 0) return;
      context.globalAlpha = track.muted ? 0.35 : 1;
      for (const clip of audioClips) {
        drawWaveformClip(
          context,
          clip,
          waveformsBySource[clip.sourcePath] ?? [],
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
    return () => observer.disconnect();
  }, [audioClips, duration, waveformsBySource, track.muted]);

  const timeFromClientX = (clientX: number, element: HTMLElement) => {
    if (duration <= 0) return 0;
    const rect = element.getBoundingClientRect();
    const ratio = (clientX - rect.left) / Math.max(1, rect.width);
    return Math.max(0, Math.min(duration, ratio * duration));
  };

  const handleTrackClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (duration <= 0 || (event.target as HTMLElement).closest(".audio-clip-label")) return;
    const time = timeFromClientX(event.clientX, event.currentTarget);
    onPasteTargetChange?.(track.id, time);
    onSeek?.(time);
  };

  const startMove = (event: ReactMouseEvent<HTMLSpanElement>, clip: AudioTimelineClip) => {
    if (event.button !== 0) return;

    if (
      clip.linkedVideoClipId ||
      (event.target as HTMLElement).closest(".audio-resize-handle") ||
      (event.target as HTMLElement).closest(".audio-volume-handle") ||
      (event.target as HTMLElement).closest(".clip-fade-handle")
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) {
      onSelect?.(clip.id, "toggle");
      return;
    }
    if (!selectedAudioClipIds.includes(clip.id)) onSelect?.(clip.id, "single");
    else onSelect?.(clip.id, "focus");
    if (track.locked || duration <= 0) return;

    const trackElement = event.currentTarget.parentElement;
    if (!trackElement || onMoveStart?.(clip.id) === false) return;
    setDraggingClipId(clip.id);
    const startX = event.clientX;
    const originalStart = clip.timelineStart;
    const clipDuration = clip.timelineEnd - clip.timelineStart;
    const width = trackElement.getBoundingClientRect().width;
    let latestStart = originalStart;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaTime = ((moveEvent.clientX - startX) / Math.max(1, width)) * duration;
      latestStart = Math.max(0, originalStart + deltaTime);
      onMove?.(clip.id, latestStart);

      const target = document.elementsFromPoint(moveEvent.clientX, moveEvent.clientY).find(
        (element) => element instanceof HTMLElement && element.matches(".waveform-track[data-audio-track-id]"),
      );
      if (
        selectedAudioClipIds.length <= 1 &&
        target instanceof HTMLElement &&
        target.dataset.trackLocked !== "true" &&
        target.dataset.trackLinked !== "true" &&
        target.dataset.audioTrackId !== track.id
      ) {
        setExternalAudioTrackPreview(target, latestStart, clipDuration, duration);
      } else {
        clearExternalAudioTrackPreview();
      }
    };

    const handleMouseUp = (upEvent: MouseEvent) => {
      setDraggingClipId(null);
      const target = document.elementsFromPoint(upEvent.clientX, upEvent.clientY).find(
        (element) => element instanceof HTMLElement && element.matches(".waveform-track[data-audio-track-id]"),
      );
      if (target instanceof HTMLElement) {
        const targetTrackId = target.dataset.audioTrackId;
        if (
          selectedAudioClipIds.length <= 1 &&
          targetTrackId &&
          targetTrackId !== track.id &&
          target.dataset.trackLocked !== "true" &&
          target.dataset.trackLinked !== "true"
        ) {
          onMoveToTrack?.(clip.id, targetTrackId, latestStart);
        }
      }
      clearExternalAudioTrackPreview();
      onMoveEnd?.();
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const startResize = (
    event: ReactMouseEvent<HTMLSpanElement>,
    clip: AudioTimelineClip,
    edge: "left" | "right",
  ) => {
    if (clip.linkedVideoClipId || track.locked || !onResize) return;
    event.preventDefault();
    event.stopPropagation();
    const clipElement = event.currentTarget.parentElement;
    const trackElement = clipElement?.parentElement;
    if (!trackElement || duration <= 0) return;
    onSelect?.(clip.id, "single");
    const startX = event.clientX;
    const originalStart = clip.timelineStart;
    const originalEnd = clip.timelineEnd;
    const width = trackElement.getBoundingClientRect().width;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaTime = ((moveEvent.clientX - startX) / Math.max(1, width)) * duration;
      if (edge === "left") {
        onResize(
          clip.id,
          Math.max(0, Math.min(originalEnd - MIN_AUDIO_CLIP_DURATION, originalStart + deltaTime)),
          originalEnd,
        );
      } else {
        onResize(
          clip.id,
          originalStart,
          Math.max(originalStart + MIN_AUDIO_CLIP_DURATION, originalEnd + deltaTime),
        );
      }
    };
    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const startAudioFadeResize = (
    event: ReactMouseEvent<HTMLButtonElement>,
    clip: AudioTimelineClip,
    edge: "in" | "out",
  ) => {
    const fadeChange = clip.linkedVideoClipId ? onLinkedFadeChange : onStandaloneFadeChange;
    const targetId = clip.linkedVideoClipId ?? clip.id;
    if (!fadeChange || (track.locked && !clip.linkedVideoClipId)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!clip.linkedVideoClipId) onSelect?.(clip.id, "focus");
    const clipElement = event.currentTarget.closest(".audio-clip-label") as HTMLElement | null;
    if (!clipElement) return;
    const rect = clipElement.getBoundingClientRect();
    const clipDuration = Math.max(0.001, clip.timelineEnd - clip.timelineStart);
    const originalDuration = Math.max(
      0,
      Math.min(clipDuration, edge === "in" ? clip.fadeInDuration ?? 0 : clip.fadeOutDuration ?? 0),
    );
    const startX = event.clientX;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaSeconds = ((moveEvent.clientX - startX) / Math.max(1, rect.width)) * clipDuration;
      const nextDuration = Math.max(
        0,
        Math.min(
          clipDuration,
          edge === "in" ? originalDuration + deltaSeconds : originalDuration - deltaSeconds,
        ),
      );
      setFadeDrag({ clipId: clip.id, edge, duration: nextDuration });
      fadeChange(targetId, edge, nextDuration);
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
    const volumeChange = clip.linkedVideoClipId ? onLinkedVolumeChange : onStandaloneVolumeChange;
    const targetId = clip.linkedVideoClipId ?? clip.id;
    if (!volumeChange || (track.locked && !clip.linkedVideoClipId)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!clip.linkedVideoClipId) onSelect?.(clip.id, "focus");
    const envelope = event.currentTarget.closest(".audio-volume-envelope") as HTMLElement | null;
    if (!envelope) return;
    const rect = envelope.getBoundingClientRect();

    const applyVolumeAtY = (clientY: number) => {
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
      const nextVolume = Math.round((1 - ratio) * 100);
      setVolumeDrag({ clipId: clip.id, volume: nextVolume });
      volumeChange(targetId, nextVolume);
    };
    applyVolumeAtY(event.clientY);
    const handleMouseMove = (moveEvent: MouseEvent) => applyVolumeAtY(moveEvent.clientY);
    const handleMouseUp = () => {
      setVolumeDrag(null);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
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
          track.locked ? "locked" : "",
          isLinkedTrack ? "linked-audio-track" : "standalone-audio-track",
        ].filter(Boolean).join(" ")}
        data-audio-track-id={track.id}
        data-track-locked={track.locked ? "true" : "false"}
        data-track-linked={isLinkedTrack ? "true" : "false"}
        onClick={handleTrackClick}
      >
        <canvas ref={canvasRef} className="waveform-canvas" />

        {audioClips.map((clip) => {
          const clipDuration = Math.max(0.001, clip.timelineEnd - clip.timelineStart);
          const fadeInDuration = Math.max(0, Math.min(clipDuration, clip.fadeInDuration ?? 0));
          const fadeOutDuration = Math.max(0, Math.min(clipDuration, clip.fadeOutDuration ?? 0));
          const fadeInWidth = (fadeInDuration / clipDuration) * 100;
          const fadeOutWidth = (fadeOutDuration / clipDuration) * 100;
          const volume = Math.max(0, Math.min(100, clip.volume ?? 100));
          const volumeY = 100 - volume;
          const linkedSelected = !!clip.linkedVideoClipId && selectedVideoClipIds.includes(clip.linkedVideoClipId);
          const standaloneSelected = !clip.linkedVideoClipId && selectedAudioClipIds.includes(clip.id);
          const primarySelected = !clip.linkedVideoClipId && selectedAudioClipId === clip.id;
          const dragging = draggingClipId === clip.id;
          const editable = !clip.linkedVideoClipId && !track.locked;
          const canAdjust = clip.linkedVideoClipId
            ? !!(onLinkedVolumeChange || onLinkedFadeChange)
            : !!(onStandaloneVolumeChange || onStandaloneFadeChange);
          const activeFadeDrag = fadeDrag?.clipId === clip.id ? fadeDrag : null;
          const activeVolumeDrag = volumeDrag?.clipId === clip.id ? volumeDrag : null;

          return (
            <span
              key={clip.id}
              className={[
                "audio-clip-label",
                clip.linkedVideoClipId ? "linked" : "standalone",
                linkedSelected || standaloneSelected ? "selected" : "",
                primarySelected ? "primary-selected" : "",
                dragging ? "dragging" : "",
              ].filter(Boolean).join(" ")}
              style={{
                left: `${duration > 0 ? (clip.timelineStart / duration) * 100 : 0}%`,
                width: `${duration > 0 ? ((clip.timelineEnd - clip.timelineStart) / duration) * 100 : 0}%`,
              }}
              data-audio-clip-id={!clip.linkedVideoClipId ? clip.id : undefined}
              title={clip.linkedVideoClipId
                ? `${clip.sourceName} · linked audio · ${videoPlaybackRate(clip)}× · ${clip.muted ? "Muted" : `${Math.round(volume)}%`}`
                : `${clip.sourceName} · ${clip.sourceIn.toFixed(2)}–${clip.sourceOut.toFixed(2)} s · ${track.shortLabel}`}
              onContextMenu={(event) => {
                const linkedVideoClipId = clip.linkedVideoClipId;
                const muteChange = linkedVideoClipId
                  ? onLinkedMuteChange
                  : onStandaloneMuteChange;

                if (!muteChange || !canShowNativeContextMenu()) return;

                event.preventDefault();
                event.stopPropagation();

                if (!linkedVideoClipId) {
                  onSelect?.(clip.id, "focus");
                }

                void showNativeContextMenu([
                  {
                    id: `audio-clip.${linkedVideoClipId ?? clip.id}.toggle-mute`,
                    text: clip.muted ? "Unmute Clip" : "Mute Clip",
                    enabled: linkedVideoClipId ? true : !track.locked,
                    action: () => {
                      muteChange(linkedVideoClipId ?? clip.id, !(clip.muted ?? false));
                    },
                  },
                  ...(onRevealClip
                    ? [
                        {
                          id: `audio-clip.${linkedVideoClipId ?? clip.id}.reveal`,
                          text: "Reveal in Timeline",
                          action: () => onRevealClip(clip),
                        },
                      ]
                    : []),
                ]).catch((error) => {
                  console.error("Failed to show native audio clip context menu:", error);
                });
              }}
              onMouseDown={(event) => startMove(event, clip)}
              onClick={(event) => {
                event.stopPropagation();
                if (!clip.linkedVideoClipId && !event.shiftKey) onSelect?.(clip.id, "focus");
                onPasteTargetChange?.(track.id, clip.timelineStart);
                onSeek?.(Math.max(clip.timelineStart, Math.min(clip.timelineEnd, timeFromClientX(event.clientX, event.currentTarget.parentElement ?? event.currentTarget))));
              }}
            >
              <span className="audio-clip-name">
                {clip.sourceName}{clip.muted ? " · Muted" : ""}
              </span>


              {editable && (
                <>
                  <span
                    className="audio-resize-handle left"
                    onMouseDown={(event) => startResize(event, clip, "left")}
                    aria-hidden="true"
                  />
                  <span
                    className="audio-resize-handle right"
                    onMouseDown={(event) => startResize(event, clip, "right")}
                    aria-hidden="true"
                  />
                </>
              )}

              {fadeInDuration > 0 && (
                <span className="clip-fade-region audio in" style={{ width: `${fadeInWidth}%` }} aria-hidden="true">
                  <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                    <path d={`M0 100 C22 100 38 ${volumeY} 100 ${volumeY}`} />
                  </svg>
                </span>
              )}
              {fadeOutDuration > 0 && (
                <span className="clip-fade-region audio out" style={{ width: `${fadeOutWidth}%` }} aria-hidden="true">
                  <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                    <path d={`M0 ${volumeY} C62 ${volumeY} 78 100 100 100`} />
                  </svg>
                </span>
              )}

              {canAdjust && (
                <span className="audio-volume-envelope">
                  {(clip.linkedVideoClipId ? onLinkedVolumeChange : onStandaloneVolumeChange) && (
                    <>
                      <span className="audio-volume-line" style={{ top: `${volumeY}%` }} />
                      <button
                        type="button"
                        className={["audio-volume-handle", volumeDrag?.clipId === clip.id ? "active" : ""].filter(Boolean).join(" ")}
                        style={{ top: `${volumeY}%` }}
                        onMouseDown={(event) => startAudioVolumeDrag(event, clip)}
                        onClick={(event) => event.stopPropagation()}
                        title={`Volume · ${Math.round(volume)}%`}
                        aria-label={`Adjust audio volume, currently ${Math.round(volume)} percent`}
                      />
                    </>
                  )}

                  {(clip.linkedVideoClipId ? onLinkedFadeChange : onStandaloneFadeChange) && (
                    <>
                      <button
                        type="button"
                        className={["clip-fade-handle", "audio", "in", activeFadeDrag?.edge === "in" ? "active" : ""].filter(Boolean).join(" ")}
                        style={{ left: `clamp(5px, ${fadeInWidth}%, calc(100% - 5px))`, top: `${volumeY}%` }}
                        onMouseDown={(event) => startAudioFadeResize(event, clip, "in")}
                        onClick={(event) => event.stopPropagation()}
                        title={`Audio fade in · ${fadeInDuration.toFixed(2)}s`}
                        aria-label="Adjust audio fade in"
                      />
                      <button
                        type="button"
                        className={["clip-fade-handle", "audio", "out", activeFadeDrag?.edge === "out" ? "active" : ""].filter(Boolean).join(" ")}
                        style={{ right: `clamp(5px, ${fadeOutWidth}%, calc(100% - 5px))`, top: `${volumeY}%` }}
                        onMouseDown={(event) => startAudioFadeResize(event, clip, "out")}
                        onClick={(event) => event.stopPropagation()}
                        title={`Audio fade out · ${fadeOutDuration.toFixed(2)}s`}
                        aria-label="Adjust audio fade out"
                      />
                    </>
                  )}
                </span>
              )}

              {activeFadeDrag && (
                <span
                  className={`clip-fade-duration-label audio ${activeFadeDrag.edge}`}
                  style={activeFadeDrag.edge === "in"
                    ? { left: `${(activeFadeDrag.duration / clipDuration) * 100}%` }
                    : { right: `${(activeFadeDrag.duration / clipDuration) * 100}%` }}
                >
                  {activeFadeDrag.duration.toFixed(2)}s
                </span>
              )}
              {activeVolumeDrag && (
                <span className="audio-volume-value-label" style={{ top: `${100 - activeVolumeDrag.volume}%` }}>
                  {activeVolumeDrag.volume}%
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
