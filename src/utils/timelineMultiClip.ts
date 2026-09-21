import type { VideoTimelineClip } from "../types/timelineModel";

export function clampVideoClipGroupMoveDelta(
  selectedClips: VideoTimelineClip[],
  unselectedClips: VideoTimelineClip[],
  requestedDelta: number,
) {
  if (selectedClips.length === 0 || Math.abs(requestedDelta) < 0.000001) {
    return 0;
  }

  const minimumStart = Math.min(
    ...selectedClips.map((clip) => clip.timelineStart),
  );
  let delta = Math.max(-minimumStart, requestedDelta);

  if (delta > 0) {
    let rightLimit = Number.POSITIVE_INFINITY;

    for (const selected of selectedClips) {
      for (const other of unselectedClips) {
        if (
          other.trackId !== selected.trackId ||
          other.timelineStart < selected.timelineEnd - 0.000001
        ) {
          continue;
        }

        rightLimit = Math.min(
          rightLimit,
          other.timelineStart - selected.timelineEnd,
        );
      }
    }

    if (Number.isFinite(rightLimit)) {
      delta = Math.min(delta, Math.max(0, rightLimit));
    }
  } else if (delta < 0) {
    let leftLimit = Number.NEGATIVE_INFINITY;

    for (const selected of selectedClips) {
      for (const other of unselectedClips) {
        if (
          other.trackId !== selected.trackId ||
          other.timelineEnd > selected.timelineStart + 0.000001
        ) {
          continue;
        }

        leftLimit = Math.max(
          leftLimit,
          other.timelineEnd - selected.timelineStart,
        );
      }
    }

    if (Number.isFinite(leftLimit)) {
      delta = Math.max(delta, Math.min(0, leftLimit));
    }
  }

  return Object.is(delta, -0) ? 0 : delta;
}

export function findNextAvailableVideoClipGroupShift(
  existingClips: VideoTimelineClip[],
  sourceClips: VideoTimelineClip[],
  requestedTimelineStart: number,
) {
  if (sourceClips.length === 0) {
    return 0;
  }

  const groupStart = Math.min(...sourceClips.map((clip) => clip.timelineStart));
  let shift = Math.max(0, requestedTimelineStart) - groupStart;

  for (let pass = 0; pass < 1000; pass += 1) {
    let extraShift = 0;

    for (const source of sourceClips) {
      const proposedStart = source.timelineStart + shift;
      const proposedEnd = source.timelineEnd + shift;

      for (const existing of existingClips) {
        if (existing.trackId !== source.trackId) {
          continue;
        }

        if (
          proposedEnd <= existing.timelineStart ||
          proposedStart >= existing.timelineEnd
        ) {
          continue;
        }

        extraShift = Math.max(extraShift, existing.timelineEnd - proposedStart);
      }
    }

    if (extraShift <= 0.000001) {
      return shift;
    }

    shift += extraShift;
  }

  return shift;
}
