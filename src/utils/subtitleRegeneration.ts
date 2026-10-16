import {
  DEFAULT_SUBTITLE_TRACK_ID,
  getSubtitleTrackId,
  type Subtitle,
} from "../types/subtitle";
import type { VideoTimelineClip } from "../types/timelineModel";

export type RegeneratedLinkedSubtitle = {
  startTime: number;
  endTime: number;
  text: string;
  linkedVideoClipId: string;
  linkedVideoSourcePath: string;
};

const TEXT_MATCH_WINDOW_SECONDS = 0.4;
const DUPLICATE_OVERLAP_RATIO = 0.38;

function normalizeText(text: string) {
  return text
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();
}

function overlapDuration(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function nearestSubtitle(subtitles: Subtitle[], time: number) {
  let best: Subtitle | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const subtitle of subtitles) {
    const midpoint = (subtitle.startTime + subtitle.endTime) / 2;
    const distance = Math.abs(midpoint - time);
    if (distance < bestDistance) {
      best = subtitle;
      bestDistance = distance;
    }
  }
  return best;
}

function copyPresentation(template: Subtitle | null) {
  if (!template) return {};
  return {
    fontSize: template.fontSize,
    fontFamily: template.fontFamily,
    color: template.color,
    backgroundColor: template.backgroundColor,
    backgroundRadius: template.backgroundRadius,
    isBold: template.isBold,
    isItalic: template.isItalic,
    isUnderlined: template.isUnderlined,
    textAlign: template.textAlign,
    positionX: template.positionX,
    positionY: template.positionY,
  };
}

export function preferredLinkedSubtitleTrack(
  subtitles: Subtitle[],
  clipId: string,
) {
  const first = subtitles
    .filter((subtitle) => subtitle.linkedVideoClipId === clipId)
    .sort((a, b) => a.startTime - b.startTime)[0];
  return first ? getSubtitleTrackId(first) : DEFAULT_SUBTITLE_TRACK_ID;
}

export function mergeRegeneratedLinkedSubtitles(
  subtitles: Subtitle[],
  clip: VideoTimelineClip,
  regenerated: RegeneratedLinkedSubtitle[],
  targetTrackId = preferredLinkedSubtitleTrack(subtitles, clip.id),
) {
  const next = subtitles.map((subtitle) => ({ ...subtitle }));
  const linked = () =>
    next.filter((subtitle) => subtitle.linkedVideoClipId === clip.id);

  for (const candidate of regenerated) {
    const startTime = Math.max(clip.timelineStart, candidate.startTime);
    const endTime = Math.min(clip.timelineEnd, candidate.endTime);
    if (endTime <= startTime) continue;

    const candidateText = normalizeText(candidate.text);
    const currentLinked = linked();
    const sameText = currentLinked.find((subtitle) => {
      if (!candidateText || normalizeText(subtitle.text) !== candidateText) {
        return false;
      }
      return (
        startTime <= subtitle.endTime + TEXT_MATCH_WINDOW_SECONDS &&
        endTime >= subtitle.startTime - TEXT_MATCH_WINDOW_SECONDS
      );
    });

    if (sameText) {
      sameText.startTime = Math.max(
        clip.timelineStart,
        Math.min(sameText.startTime, startTime),
      );
      sameText.endTime = Math.min(
        clip.timelineEnd,
        Math.max(sameText.endTime, endTime),
      );
      continue;
    }

    const candidateDuration = Math.max(0.001, endTime - startTime);
    const largestOverlap = currentLinked.reduce(
      (largest, subtitle) =>
        Math.max(
          largest,
          overlapDuration(
            startTime,
            endTime,
            subtitle.startTime,
            subtitle.endTime,
          ),
        ),
      0,
    );

    if (largestOverlap / candidateDuration >= DUPLICATE_OVERLAP_RATIO) {
      continue;
    }

    const template = nearestSubtitle(
      currentLinked,
      (startTime + endTime) / 2,
    );
    next.push({
      id: crypto.randomUUID(),
      trackId: template ? getSubtitleTrackId(template) : targetTrackId,
      startTime,
      endTime,
      text: candidate.text,
      linkedVideoClipId: clip.id,
      linkedVideoSourcePath: clip.sourcePath,
      ...copyPresentation(template),
    });
  }

  return next.sort(
    (a, b) =>
      a.startTime - b.startTime ||
      getSubtitleTrackId(a).localeCompare(getSubtitleTrackId(b)) ||
      a.endTime - b.endTime,
  );
}
