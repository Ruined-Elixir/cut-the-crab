import {
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import type { Subtitle } from "../../types/subtitle";
import type { TimelineTrack, TimelineTrackId } from "../../types/timelineModel";
import {
  canShowNativeContextMenu,
  showNativeContextMenu,
} from "../../services/nativeContextMenu";

import TimelineTrackLabel from "./TimelineTrackLabel";

export type SubtitleSelectionMode =
  | "single"
  | "toggle"
  | "range";

type SubtitleTrackProps = {
  duration: number;
  track: TimelineTrack;
  subtitles: Subtitle[];
  selectedSubtitleId: string | null;
  selectedSubtitleIds: string[];
  markerTimes: number[];
  playheadTime: number;

  onSeek?: (time: number) => void;
  onSubtitleSelect?: (
    id: string,
    mode?: SubtitleSelectionMode,
  ) => void;
  onSubtitleMove?: (
    id: string,
    newStartTime: number,
  ) => void;
  onSubtitleMoveToTrack?: (
    id: string,
    targetTrackId: TimelineTrackId,
    newStartTime: number,
  ) => void;
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
  onToggleLock?: (trackId: TimelineTrackId) => void;
  onToggleHidden?: (trackId: TimelineTrackId) => void;
  onTrackActivate?: (trackId: TimelineTrackId) => void;
  onRevealSubtitle?: (subtitle: Subtitle) => void;
  showLabel?: boolean;
};

const MIN_SUBTITLE_DURATION = 0.1;
const SNAP_TOLERANCE_PX = 12;

function getSnapTolerance(
  trackWidth: number,
  duration: number,
) {
  if (trackWidth <= 0 || duration <= 0) {
    return 0;
  }

  return (SNAP_TOLERANCE_PX / trackWidth) * duration;
}

type SnapTargetType =
  | "marker"
  | "playhead"
  | "subtitle";

type SnapTarget = {
  time: number;
  type: SnapTargetType;
};

function getSnapTargets(
  subtitles: Subtitle[],
  excludedIds: Set<string>,
  markerTimes: number[],
  playheadTime: number,
) {
  const targets: SnapTarget[] = markerTimes.map(
    (time) => ({
      time,
      type: "marker",
    }),
  );

  if (Number.isFinite(playheadTime)) {
    targets.push({
      time: playheadTime,
      type: "playhead",
    });
  }

  for (const subtitle of subtitles) {
    if (excludedIds.has(subtitle.id)) {
      continue;
    }

    targets.push(
      {
        time: subtitle.startTime,
        type: "subtitle",
      },
      {
        time: subtitle.endTime,
        type: "subtitle",
      },
    );
  }

  return targets;
}

function findSnapTarget(
  value: number,
  targets: SnapTarget[],
  tolerance: number,
) {
  let best: SnapTarget | null = null;
  let bestDistance = tolerance;

  for (const target of targets) {
    const distance = Math.abs(
      target.time - value,
    );

    if (distance <= bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }

  return best;
}

function getOtherSubtitles(
  subtitles: Subtitle[],
  id: string,
) {
  return subtitles
    .filter((subtitle) => subtitle.id !== id)
    .sort((a, b) => a.startTime - b.startTime);
}

function clampMoveAgainstCollisions(
  subtitles: Subtitle[],
  id: string,
  requestedStart: number,
  subtitleDuration: number,
  duration: number,
) {
  let start = Math.max(
    0,
    Math.min(duration - subtitleDuration, requestedStart),
  );

  const others = getOtherSubtitles(subtitles, id);

  for (const other of others) {
    const end = start + subtitleDuration;

    if (
      end <= other.startTime ||
      start >= other.endTime
    ) {
      continue;
    }

    const pushLeft =
      other.startTime - subtitleDuration;
    const pushRight = other.endTime;

    start =
      Math.abs(requestedStart - pushLeft) <=
      Math.abs(requestedStart - pushRight)
        ? pushLeft
        : pushRight;

    start = Math.max(
      0,
      Math.min(duration - subtitleDuration, start),
    );
  }

  return start;
}

function clampGroupMove(
  subtitles: Subtitle[],
  selectedIds: string[],
  anchorId: string,
  requestedAnchorStart: number,
  duration: number,
) {
  const selectedSet = new Set(selectedIds);
  const selected = subtitles.filter((subtitle) =>
    selectedSet.has(subtitle.id),
  );

  const anchor = selected.find(
    (subtitle) => subtitle.id === anchorId,
  );

  if (!anchor || selected.length === 0) {
    return requestedAnchorStart;
  }

  const requestedDelta =
    requestedAnchorStart - anchor.startTime;

  const minStart = Math.min(
    ...selected.map((subtitle) => subtitle.startTime),
  );
  const maxEnd = Math.max(
    ...selected.map((subtitle) => subtitle.endTime),
  );

  let minimumDelta = -minStart;
  let maximumDelta = duration - maxEnd;

  const unselected = subtitles.filter(
    (subtitle) => !selectedSet.has(subtitle.id),
  );

  if (requestedDelta > 0) {
    for (const moving of selected) {
      for (const obstacle of unselected) {
        if (obstacle.startTime >= moving.endTime) {
          maximumDelta = Math.min(
            maximumDelta,
            obstacle.startTime - moving.endTime,
          );
        }
      }
    }
  } else if (requestedDelta < 0) {
    for (const moving of selected) {
      for (const obstacle of unselected) {
        if (obstacle.endTime <= moving.startTime) {
          minimumDelta = Math.max(
            minimumDelta,
            obstacle.endTime - moving.startTime,
          );
        }
      }
    }
  }

  const safeDelta = Math.max(
    minimumDelta,
    Math.min(maximumDelta, requestedDelta),
  );

  return anchor.startTime + safeDelta;
}

function selectionModeFromEvent(
  event: ReactMouseEvent,
): SubtitleSelectionMode {
  if (event.shiftKey) {
    return "range";
  }

  if (event.metaKey || event.ctrlKey) {
    return "toggle";
  }

  return "single";
}

function SubtitleTrack({
  duration,
  track,
  subtitles,
  selectedSubtitleId,
  selectedSubtitleIds,
  markerTimes,
  playheadTime,
  onSeek,
  onSubtitleSelect,
  onSubtitleMove,
  onSubtitleMoveToTrack,
  onSubtitleGroupMove,
  onSubtitleResize,
  onToggleLock,
  onToggleHidden,
  onTrackActivate,
  onRevealSubtitle,
  showLabel = true,
}: SubtitleTrackProps) {
  const [draggingSubtitleIds, setDraggingSubtitleIds] =
    useState<string[]>([]);
  const [snapIndicator, setSnapIndicator] =
    useState<SnapTarget | null>(null);

  const startMove = (
    event: ReactMouseEvent<HTMLDivElement>,
    subtitle: Subtitle,
  ) => {
    if (event.button !== 0) return;

    if (
      track.locked ||
      (event.target as HTMLElement).closest(
        ".subtitle-resize-handle",
      )
    ) {
      return;
    }

    /*
     * Modifier-click is a selection gesture, not a drag gesture.
     * Waiting for the click keeps Cmd/Ctrl toggle and Shift range
     * selection predictable.
     */
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey
    ) {
      return;
    }

    onTrackActivate?.(track.id);
    event.preventDefault();
    event.stopPropagation();

    const trackElement = event.currentTarget.parentElement;

    if (!trackElement || duration <= 0) {
      return;
    }

    const isAlreadySelected =
      selectedSubtitleIds.includes(subtitle.id);

    const trackSubtitleIds = new Set(subtitles.map((item) => item.id));
    const selectedIdsOnTrack = selectedSubtitleIds.filter((id) =>
      trackSubtitleIds.has(id),
    );
    const groupIds =
      isAlreadySelected && selectedIdsOnTrack.length > 1
        ? selectedIdsOnTrack
        : [subtitle.id];

    if (!isAlreadySelected) {
      onSubtitleSelect?.(subtitle.id, "single");
    }

    setDraggingSubtitleIds(groupIds);

    const snapTargets = getSnapTargets(
      subtitles,
      new Set(groupIds),
      markerTimes,
      playheadTime,
    );

    const startX = event.clientX;
    const originalStart = subtitle.startTime;
    const subtitleDuration =
      subtitle.endTime - subtitle.startTime;
    const trackWidth =
      trackElement.getBoundingClientRect().width;
    const snapTolerance = getSnapTolerance(
      trackWidth,
      duration,
    );
    let latestStart = originalStart;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaTime =
        ((moveEvent.clientX - startX) / trackWidth) *
        duration;

      let newStart = originalStart + deltaTime;

      const startSnap = findSnapTarget(
        newStart,
        snapTargets,
        snapTolerance,
      );

      const endSnap = findSnapTarget(
        newStart + subtitleDuration,
        snapTargets,
        snapTolerance,
      );

      const startDistance = startSnap
        ? Math.abs(startSnap.time - newStart)
        : Number.POSITIVE_INFINITY;

      const endDistance = endSnap
        ? Math.abs(
            endSnap.time -
              (newStart + subtitleDuration),
          )
        : Number.POSITIVE_INFINITY;

      if (
        startSnap &&
        startDistance <= endDistance
      ) {
        newStart = startSnap.time;
        setSnapIndicator(startSnap);
      } else if (endSnap) {
        newStart =
          endSnap.time - subtitleDuration;
        setSnapIndicator(endSnap);
      } else {
        setSnapIndicator(null);
      }

      if (groupIds.length > 1) {
        const safeAnchorStart = clampGroupMove(
          subtitles,
          groupIds,
          subtitle.id,
          newStart,
          duration,
        );

        latestStart = safeAnchorStart;
        onSubtitleGroupMove?.(
          groupIds,
          subtitle.id,
          safeAnchorStart,
        );

        return;
      }

      newStart = clampMoveAgainstCollisions(
        subtitles,
        subtitle.id,
        newStart,
        subtitleDuration,
        duration,
      );

      latestStart = newStart;
      onSubtitleMove?.(
        subtitle.id,
        newStart,
      );
    };

    const handleMouseUp = (upEvent: MouseEvent) => {
      setDraggingSubtitleIds([]);
      setSnapIndicator(null);

      if (groupIds.length === 1) {
        const target = document
          .elementsFromPoint(upEvent.clientX, upEvent.clientY)
          .find(
            (element) =>
              element instanceof HTMLElement &&
              element.matches(
                ".subtitle-track[data-subtitle-track-id]",
              ),
          );

        if (target instanceof HTMLElement) {
          const targetTrackId = target.dataset.subtitleTrackId;
          const targetLocked = target.dataset.trackLocked === "true";

          if (
            targetTrackId &&
            targetTrackId !== track.id &&
            !targetLocked
          ) {
            onSubtitleMoveToTrack?.(
              subtitle.id,
              targetTrackId,
              latestStart,
            );
            onTrackActivate?.(targetTrackId);
          }
        }
      }

      window.removeEventListener(
        "mousemove",
        handleMouseMove,
      );
      window.removeEventListener(
        "mouseup",
        handleMouseUp,
      );
    };

    window.addEventListener(
      "mousemove",
      handleMouseMove,
    );
    window.addEventListener(
      "mouseup",
      handleMouseUp,
    );
  };

  const startResize = (
    event: ReactMouseEvent<HTMLDivElement>,
    subtitle: Subtitle,
    edge: "left" | "right",
  ) => {
    if (track.locked) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const trackElement =
      event.currentTarget.parentElement?.parentElement;

    if (!trackElement || duration <= 0) {
      return;
    }

    onSubtitleSelect?.(
      subtitle.id,
      "single",
    );

    setDraggingSubtitleIds([subtitle.id]);

    const snapTargets = getSnapTargets(
      subtitles,
      new Set([subtitle.id]),
      markerTimes,
      playheadTime,
    );

    const startX = event.clientX;
    const originalStart = subtitle.startTime;
    const originalEnd = subtitle.endTime;
    const trackWidth =
      trackElement.getBoundingClientRect().width;
    const snapTolerance = getSnapTolerance(
      trackWidth,
      duration,
    );

    const others = getOtherSubtitles(
      subtitles,
      subtitle.id,
    );

    const previousSubtitle = [...others]
      .filter(
        (item) =>
          item.endTime <= originalStart,
      )
      .sort(
        (a, b) => b.endTime - a.endTime,
      )[0];

    const nextSubtitle = others
      .filter(
        (item) =>
          item.startTime >= originalEnd,
      )
      .sort(
        (a, b) => a.startTime - b.startTime,
      )[0];

    const handleMouseMove = (
      moveEvent: MouseEvent,
    ) => {
      const deltaTime =
        ((moveEvent.clientX - startX) /
          trackWidth) *
        duration;

      if (edge === "left") {
        let newStart =
          originalStart + deltaTime;

        const startSnap = findSnapTarget(
          newStart,
          snapTargets,
          snapTolerance,
        );

        if (startSnap) {
          setSnapIndicator(startSnap);
          newStart = startSnap.time;
        } else {
          setSnapIndicator(null);
        }

        newStart = Math.max(
          previousSubtitle?.endTime ?? 0,
          newStart,
        );

        newStart = Math.min(
          originalEnd - MIN_SUBTITLE_DURATION,
          newStart,
        );

        onSubtitleResize?.(
          subtitle.id,
          newStart,
          originalEnd,
        );

        return;
      }

      let newEnd = originalEnd + deltaTime;

      const endSnap = findSnapTarget(
        newEnd,
        snapTargets,
        snapTolerance,
      );

      if (endSnap) {
        setSnapIndicator(endSnap);
        newEnd = endSnap.time;
      } else {
        setSnapIndicator(null);
      }

      newEnd = Math.min(
        nextSubtitle?.startTime ?? duration,
        newEnd,
      );

      newEnd = Math.max(
        originalStart + MIN_SUBTITLE_DURATION,
        newEnd,
      );

      onSubtitleResize?.(
        subtitle.id,
        originalStart,
        newEnd,
      );
    };

    const handleMouseUp = () => {
      setDraggingSubtitleIds([]);
      setSnapIndicator(null);

      window.removeEventListener(
        "mousemove",
        handleMouseMove,
      );
      window.removeEventListener(
        "mouseup",
        handleMouseUp,
      );
    };

    window.addEventListener(
      "mousemove",
      handleMouseMove,
    );
    window.addEventListener(
      "mouseup",
      handleMouseUp,
    );
  };

  const handleTrackClick = (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    onTrackActivate?.(track.id);

    if (
      duration <= 0 ||
      event.detail > 1
    ) {
      return;
    }

    const rect =
      event.currentTarget.getBoundingClientRect();

    const ratio =
      (event.clientX - rect.left) /
      rect.width;

    onSeek?.(
      Math.max(
        0,
        Math.min(duration, ratio * duration),
      ),
    );
  };

  return (
    <div className={`timeline-row timeline-subtitle-row ${showLabel ? "" : "track-only"}`.trim()}>
      {showLabel && (
      <TimelineTrackLabel
        shortLabel={track.shortLabel}
        name={track.name}
        locked={track.locked}
        hidden={track.hidden}
        canHide
        onToggleLock={() => onToggleLock?.(track.id)}
        onToggleHidden={() => onToggleHidden?.(track.id)}
      />
      )}

      <div
        className={["subtitle-track", track.locked ? "locked" : "", track.hidden ? "track-hidden" : ""].filter(Boolean).join(" ")}
        data-subtitle-track-id={track.id}
        data-track-locked={track.locked ? "true" : "false"}
        onClick={handleTrackClick}
      >
        {snapIndicator !== null && duration > 0 && (
          <div
            className={[
              "subtitle-snap-indicator",
              `snap-${snapIndicator.type}`,
            ].join(" ")}
            style={{
              left: `${(snapIndicator.time / duration) * 100}%`,
            }}
            aria-hidden="true"
          >
            <span />
          </div>
        )}

        {subtitles.map((subtitle) => {
          const left =
            duration > 0
              ? (subtitle.startTime / duration) *
                100
              : 0;

          const width =
            duration > 0
              ? ((subtitle.endTime -
                  subtitle.startTime) /
                  duration) *
                100
              : 0;

          const isSelected =
            selectedSubtitleIds.includes(
              subtitle.id,
            );

          const isPrimary =
            selectedSubtitleId === subtitle.id;

          return (
            <div
              key={subtitle.id}
              className={[
                "subtitle-clip",
                isSelected ? "selected" : "",
                isPrimary ? "primary-selected" : "",
                draggingSubtitleIds.includes(subtitle.id)
                  ? "dragging"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                left: `${left}%`,
                width: `${width}%`,
              }}
              title={subtitle.text}
              onContextMenu={(event) => {
                if (!onRevealSubtitle || !canShowNativeContextMenu()) return;
                event.preventDefault();
                event.stopPropagation();
                onTrackActivate?.(track.id);
                onSubtitleSelect?.(subtitle.id, "single");
                void showNativeContextMenu([
                  {
                    id: `subtitle.${subtitle.id}.reveal`,
                    text: "Reveal in Timeline",
                    action: () => onRevealSubtitle(subtitle),
                  },
                ]).catch((error) => {
                  console.error("Failed to show native subtitle context menu:", error);
                });
              }}
              onClick={(event) => {
                event.stopPropagation();
                onTrackActivate?.(track.id);

                onSubtitleSelect?.(
                  subtitle.id,
                  selectionModeFromEvent(event),
                );

                if (
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.shiftKey
                ) {
                  onSeek?.(
                    subtitle.startTime,
                  );
                }
              }}
              onMouseDown={(event) =>
                startMove(event, subtitle)
              }
            >
              <div
                className="subtitle-resize-handle left"
                onMouseDown={(event) =>
                  startResize(
                    event,
                    subtitle,
                    "left",
                  )
                }
              />

              <span className="subtitle-clip-text">
                {subtitle.text}
              </span>

              <div
                className="subtitle-resize-handle right"
                onMouseDown={(event) =>
                  startResize(
                    event,
                    subtitle,
                    "right",
                  )
                }
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default SubtitleTrack;
