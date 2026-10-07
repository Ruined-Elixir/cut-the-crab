import type { Subtitle } from "../types/subtitle";
import type { VideoTimelineClip } from "../types/timelineModel";
import {
  isFreezeFrameClip,
  sourceTimeToTimelineTime,
  timelineTimeToSourceTime,
} from "./videoRetime";

const EPSILON = 0.000001;
const SOURCE_EPSILON = 0.0001;
const MIN_SUBTITLE_DURATION = 0.001;

function isLinkedTo(subtitle: Subtitle, clipId: string) {
  return subtitle.linkedVideoClipId === clipId;
}

function sameSourceIdentity(a: VideoTimelineClip, b: VideoTimelineClip) {
  if (a.sourcePath !== b.sourcePath) return false;
  if (a.sourceId && b.sourceId && a.sourceId !== b.sourceId) return false;
  return true;
}

function sourceBounds(clip: VideoTimelineClip) {
  return {
    start: Math.min(clip.sourceIn, clip.sourceOut),
    end: Math.max(clip.sourceIn, clip.sourceOut),
  };
}

function sourceRangeContains(
  outer: VideoTimelineClip,
  inner: VideoTimelineClip,
) {
  const outerRange = sourceBounds(outer);
  const innerRange = sourceBounds(inner);
  return (
    outerRange.start <= innerRange.start + SOURCE_EPSILON &&
    outerRange.end >= innerRange.end - SOURCE_EPSILON
  );
}

function sourceOverlapDuration(a: VideoTimelineClip, b: VideoTimelineClip) {
  const aRange = sourceBounds(a);
  const bRange = sourceBounds(b);
  return Math.max(
    0,
    Math.min(aRange.end, bRange.end) - Math.max(aRange.start, bRange.start),
  );
}

function hasRippleBoundary(clip: VideoTimelineClip) {
  return Boolean(
    clip.rippleAutoHealInBoundaryId || clip.rippleAutoHealOutBoundaryId,
  );
}

function boundaryRelated(a: VideoTimelineClip, b: VideoTimelineClip) {
  const aOut = a.rippleAutoHealOutBoundaryId;
  const aIn = a.rippleAutoHealInBoundaryId;
  const bOut = b.rippleAutoHealOutBoundaryId;
  const bIn = b.rippleAutoHealInBoundaryId;
  return Boolean(
    (aOut && aOut === bIn) ||
      (aIn && aIn === bOut) ||
      (aOut && aOut === bOut) ||
      (aIn && aIn === bIn),
  );
}

function expandClipFamily(
  seed: VideoTimelineClip,
  nextClips: VideoTimelineClip[],
) {
  const family = new Map<string, VideoTimelineClip>([[seed.id, seed]]);
  const queue = [seed];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const candidate of nextClips) {
      if (
        family.has(candidate.id) ||
        candidate.trackId !== current.trackId ||
        !sameSourceIdentity(current, candidate) ||
        !boundaryRelated(current, candidate)
      ) {
        continue;
      }

      family.set(candidate.id, candidate);
      queue.push(candidate);
    }
  }

  return [...family.values()];
}

function descendantClipsFor(
  previousClip: VideoTimelineClip,
  nextClips: VideoTimelineClip[],
  allowRippleSourceOverlapFallback = false,
) {
  const exact = nextClips.find((clip) => clip.id === previousClip.id);
  if (exact) {
    return expandClipFamily(exact, nextClips);
  }

  const sameSourceCandidates = nextClips.filter(
    (candidate) =>
      candidate.trackId === previousClip.trackId &&
      !isFreezeFrameClip(candidate) &&
      sameSourceIdentity(previousClip, candidate),
  );

  // Auto-heal can remove the right-hand fragment ID while expanding the
  // surviving left clip back over the same source range. This conservative
  // fallback is safe for ordinary topology changes because a deleted clip is
  // never redirected to a merely-overlapping copy.
  const containing = sameSourceCandidates
    .filter((candidate) => sourceRangeContains(candidate, previousClip))
    .sort((a, b) => {
      const previousMid =
        (previousClip.timelineStart + previousClip.timelineEnd) / 2;
      const aMid = (a.timelineStart + a.timelineEnd) / 2;
      const bMid = (b.timelineStart + b.timelineEnd) / 2;
      return Math.abs(aMid - previousMid) - Math.abs(bMid - previousMid);
    })[0];

  if (containing) {
    return expandClipFamily(containing, nextClips);
  }

  if (!allowRippleSourceOverlapFallback) {
    return [];
  }

  // During a magnetic drag the old destination split is first healed and then
  // re-split at the new insertion point. The old right-fragment ID can vanish
  // while its source interval is now distributed across TWO new fragments. A
  // full-containment lookup therefore fails and used to drop every subtitle
  // linked to that old right half. For an active Ripple gesture only, recover
  // the new lineage from source-overlapping auto-heal fragments.
  const overlapping = sameSourceCandidates.filter(
    (candidate) =>
      hasRippleBoundary(candidate) &&
      sourceOverlapDuration(previousClip, candidate) > SOURCE_EPSILON,
  );

  if (overlapping.length === 0) {
    return [];
  }

  // Ripple siblings share their generated auto-heal boundary token even when
  // the inserted clip sits between them on the timeline. Build those connected
  // families and choose the one that covers the greatest amount of the old
  // source interval, with timeline proximity only as a tie-breaker. This avoids
  // attaching captions to an unrelated duplicate of the same source file.
  const remaining = new Set(overlapping.map((clip) => clip.id));
  const families: VideoTimelineClip[][] = [];

  while (remaining.size > 0) {
    const seedId = remaining.values().next().value as string;
    remaining.delete(seedId);
    const seed = overlapping.find((clip) => clip.id === seedId)!;
    const family = [seed];
    const queue = [seed];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const candidate of overlapping) {
        if (!remaining.has(candidate.id) || !boundaryRelated(current, candidate)) {
          continue;
        }
        remaining.delete(candidate.id);
        family.push(candidate);
        queue.push(candidate);
      }
    }

    families.push(family);
  }

  const previousRange = sourceBounds(previousClip);
  const previousMid =
    (previousClip.timelineStart + previousClip.timelineEnd) / 2;

  const familyScore = (family: VideoTimelineClip[]) => {
    const intervals = family
      .map(sourceBounds)
      .map((range) => ({
        start: Math.max(previousRange.start, range.start),
        end: Math.min(previousRange.end, range.end),
      }))
      .filter((range) => range.end - range.start > SOURCE_EPSILON)
      .sort((a, b) => a.start - b.start);

    let covered = 0;
    let cursorStart: number | null = null;
    let cursorEnd = 0;
    for (const interval of intervals) {
      if (cursorStart === null) {
        cursorStart = interval.start;
        cursorEnd = interval.end;
      } else if (interval.start <= cursorEnd + SOURCE_EPSILON) {
        cursorEnd = Math.max(cursorEnd, interval.end);
      } else {
        covered += cursorEnd - cursorStart;
        cursorStart = interval.start;
        cursorEnd = interval.end;
      }
    }
    if (cursorStart !== null) covered += cursorEnd - cursorStart;

    const timelineMid =
      family.reduce(
        (sum, clip) => sum + (clip.timelineStart + clip.timelineEnd) / 2,
        0,
      ) / family.length;

    return { covered, distance: Math.abs(timelineMid - previousMid) };
  };

  families.sort((a, b) => {
    const scoreA = familyScore(a);
    const scoreB = familyScore(b);
    return (
      scoreB.covered - scoreA.covered ||
      scoreA.distance - scoreB.distance
    );
  });

  return families[0] ?? [];
}

function sourceIntervalForSubtitle(
  subtitle: Subtitle,
  clip: VideoTimelineClip,
) {
  const timelineStart = Math.max(subtitle.startTime, clip.timelineStart);
  const timelineEnd = Math.min(subtitle.endTime, clip.timelineEnd);
  if (timelineEnd - timelineStart < MIN_SUBTITLE_DURATION) return null;

  const sourceA = timelineTimeToSourceTime(clip, timelineStart);
  const sourceB = timelineTimeToSourceTime(clip, timelineEnd);
  return {
    start: Math.min(sourceA, sourceB),
    end: Math.max(sourceA, sourceB),
  };
}

function mapSubtitleAcrossClipFamily(
  subtitle: Subtitle,
  previousClip: VideoTimelineClip,
  family: VideoTimelineClip[],
  createId: () => string,
) {
  if (isFreezeFrameClip(previousClip)) return [subtitle];

  const sourceInterval = sourceIntervalForSubtitle(subtitle, previousClip);
  if (!sourceInterval) return [];

  const editableFamily = family.filter((clip) => !isFreezeFrameClip(clip));
  if (editableFamily.length === 0) return [];

  const fragments = editableFamily.flatMap((clip) => {
    const clipSource = sourceBounds(clip);
    const sourceStart = Math.max(sourceInterval.start, clipSource.start);
    const sourceEnd = Math.min(sourceInterval.end, clipSource.end);
    if (sourceEnd - sourceStart < SOURCE_EPSILON) return [];

    const timelineA = sourceTimeToTimelineTime(clip, sourceStart);
    const timelineB = sourceTimeToTimelineTime(clip, sourceEnd);
    const startTime = Math.max(
      clip.timelineStart,
      Math.min(timelineA, timelineB),
    );
    const endTime = Math.min(
      clip.timelineEnd,
      Math.max(timelineA, timelineB),
    );
    if (endTime - startTime < MIN_SUBTITLE_DURATION) return [];

    return [
      {
        ...subtitle,
        linkedVideoClipId: clip.id,
        linkedVideoSourcePath: clip.sourcePath,
        startTime,
        endTime,
      },
    ];
  });

  fragments.sort(
    (a, b) => a.startTime - b.startTime || a.endTime - b.endTime,
  );

  // A ripple/freeze insertion can split one caption into two source-contiguous
  // pieces separated by the inserted timeline gap. Keep the original ID on the
  // first piece so selection/history remain stable; additional pieces are new
  // timeline objects linked to the corresponding right-hand video fragment.
  return fragments.map((fragment, index) =>
    index === 0 ? fragment : { ...fragment, id: createId() },
  );
}

export function videoSubtitleTopologyKey(clips: VideoTimelineClip[]) {
  return clips
    .map((clip) =>
      [
        clip.id,
        clip.trackId,
        clip.sourceId ?? "",
        clip.sourcePath,
        clip.timelineStart.toFixed(6),
        clip.timelineEnd.toFixed(6),
        clip.sourceIn.toFixed(6),
        clip.sourceOut.toFixed(6),
        (clip.playbackRate ?? 1).toFixed(6),
        clip.playbackDirection ?? "forward",
        clip.freezeFrameSourceTime?.toFixed(6) ?? "",
        clip.rippleAutoHealInBoundaryId ?? "",
        clip.rippleAutoHealOutBoundaryId ?? "",
      ].join("\u001f"),
    )
    .sort()
    .join("\u001e");
}

export type ReconcileLinkedSubtitleTopologyOptions = {
  allowRippleSourceOverlapFallback?: boolean;
};

export function reconcileLinkedSubtitlesToVideoTopology(
  previousSubtitles: Subtitle[],
  currentSubtitles: Subtitle[],
  previousClips: VideoTimelineClip[],
  nextClips: VideoTimelineClip[],
  createId: () => string = () => crypto.randomUUID(),
  options: ReconcileLinkedSubtitleTopologyOptions = {},
) {
  const previousClipsById = new Map(
    previousClips.map((clip) => [clip.id, clip] as const),
  );
  const currentById = new Map(
    currentSubtitles.map((subtitle) => [subtitle.id, subtitle] as const),
  );
  const processedIds = new Set<string>();
  const replacements: Subtitle[] = [];
  const familyByPreviousClipId = new Map<string, VideoTimelineClip[]>();

  for (const previousSubtitle of previousSubtitles) {
    const currentSubtitle = currentById.get(previousSubtitle.id);
    const linkedClipId = previousSubtitle.linkedVideoClipId;
    if (!currentSubtitle || !linkedClipId) continue;

    const previousClip = previousClipsById.get(linkedClipId);
    if (!previousClip) continue;

    processedIds.add(previousSubtitle.id);
    let family = familyByPreviousClipId.get(previousClip.id);
    if (!family) {
      family = descendantClipsFor(
        previousClip,
        nextClips,
        options.allowRippleSourceOverlapFallback === true,
      );
      familyByPreviousClipId.set(previousClip.id, family);
    }
    replacements.push(
      ...mapSubtitleAcrossClipFamily(
        {
          ...currentSubtitle,
          linkedVideoClipId: linkedClipId,
          // Source mapping must be derived from the subtitle timing that
          // belonged to previousClip. currentSubtitle may already reflect the
          // next topology from an earlier committed update.
          startTime: previousSubtitle.startTime,
          endTime: previousSubtitle.endTime,
        },
        previousClip,
        family,
        createId,
      ),
    );
  }

  return [
    ...currentSubtitles.filter((subtitle) => !processedIds.has(subtitle.id)),
    ...replacements,
  ];
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
