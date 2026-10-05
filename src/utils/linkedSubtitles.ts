import type { Subtitle } from "../types/subtitle";

const EPSILON = 0.000001;
const MIN_SUBTITLE_DURATION = 0.001;

function isLinkedTo(subtitle: Subtitle, clipId: string) {
  return subtitle.linkedVideoClipId === clipId;
}

export function splitLinkedSubtitlesAtVideoCut(
  subtitles: Subtitle[],
  clipId: string,
  rightClipId: string,
  splitTime: number,
  createId: () => string = () => crypto.randomUUID(),
) {
  const next: Subtitle[] = [];

  for (const subtitle of subtitles) {
    if (!isLinkedTo(subtitle, clipId)) {
      next.push(subtitle);
      continue;
    }

    if (subtitle.endTime <= splitTime + EPSILON) {
      next.push(subtitle);
      continue;
    }

    if (subtitle.startTime >= splitTime - EPSILON) {
      next.push({ ...subtitle, linkedVideoClipId: rightClipId });
      continue;
    }

    const leftDuration = splitTime - subtitle.startTime;
    const rightDuration = subtitle.endTime - splitTime;

    if (leftDuration >= MIN_SUBTITLE_DURATION) {
      next.push({ ...subtitle, endTime: splitTime });
    }

    if (rightDuration >= MIN_SUBTITLE_DURATION) {
      next.push({
        ...subtitle,
        id: createId(),
        linkedVideoClipId: rightClipId,
        startTime: splitTime,
      });
    }
  }

  return next;
}

export function trimLinkedSubtitlesToVideoWindow(
  subtitles: Subtitle[],
  clipId: string,
  timelineStart: number,
  timelineEnd: number,
) {
  const start = Math.min(timelineStart, timelineEnd);
  const end = Math.max(timelineStart, timelineEnd);
  const next: Subtitle[] = [];

  for (const subtitle of subtitles) {
    if (!isLinkedTo(subtitle, clipId)) {
      next.push(subtitle);
      continue;
    }

    const clippedStart = Math.max(subtitle.startTime, start);
    const clippedEnd = Math.min(subtitle.endTime, end);

    if (clippedEnd - clippedStart < MIN_SUBTITLE_DURATION) {
      continue;
    }

    if (
      Math.abs(clippedStart - subtitle.startTime) <= EPSILON &&
      Math.abs(clippedEnd - subtitle.endTime) <= EPSILON
    ) {
      next.push(subtitle);
    } else {
      next.push({
        ...subtitle,
        startTime: clippedStart,
        endTime: clippedEnd,
      });
    }
  }

  return next;
}

export function removeLinkedSubtitlesForVideoClips(
  subtitles: Subtitle[],
  clipIds: Iterable<string>,
) {
  const removed = new Set(clipIds);
  if (removed.size === 0) return subtitles;
  return subtitles.filter(
    (subtitle) =>
      !subtitle.linkedVideoClipId || !removed.has(subtitle.linkedVideoClipId),
  );
}
