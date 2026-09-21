import type { Subtitle } from "../types/subtitle";
import { getSubtitleTrackId } from "../types/subtitle";
import type {
  AudioTimelineClip,
  TimelineTrackId,
  TimelineTrackSettings,
  VideoTimelineClip,
} from "../types/timelineModel";
import { DEFAULT_TIMELINE_TRACK_SETTINGS } from "../types/timelineModel";
import {
  isFreezeFrameClip,
  isReverseVideoClip,
  timelineTimeToSourceTime,
  videoPlaybackRate,
} from "./videoRetime";
import { sliceVideoTransformKeyframes } from "./videoTransformKeyframes";

const EPSILON = 0.000001;
const MIN_VIDEO_DURATION = 0.1;
const MIN_AUDIO_DURATION = 0.05;
const MIN_SUBTITLE_DURATION = 0.05;

export type CompoundClipGroup = {
  id: string;
  name: string;
  anchorVideoId: string;
  trackId: TimelineTrackId;
  start: number;
  end: number;
  videoIds: string[];
  audioIds: string[];
  subtitleIds: string[];
  memberCount: number;
};

export type CompoundTimelineState = {
  videoClips: VideoTimelineClip[];
  audioClips: AudioTimelineClip[];
  subtitles: Subtitle[];
};

export type CompoundTrackRegion = {
  compoundId: string;
  anchorVideoId: string;
  name: string;
  trackId: TimelineTrackId;
  start: number;
  end: number;
  memberCount: number;
  kind: "audio" | "subtitle";
};

export type CompoundTrackRegions = {
  audio: CompoundTrackRegion[];
  subtitle: CompoundTrackRegion[];
};

export function buildCompoundGroups(
  videoClips: VideoTimelineClip[],
  audioClips: AudioTimelineClip[],
  subtitles: Subtitle[],
) {
  const ids = new Set<string>();
  for (const clip of videoClips) if (clip.compoundId) ids.add(clip.compoundId);
  for (const clip of audioClips) if (clip.compoundId) ids.add(clip.compoundId);
  for (const subtitle of subtitles)
    if (subtitle.compoundId) ids.add(subtitle.compoundId);

  const groups = new Map<string, CompoundClipGroup>();

  for (const id of ids) {
    const videos = videoClips.filter((clip) => clip.compoundId === id);
    const audios = audioClips.filter((clip) => clip.compoundId === id);
    const subs = subtitles.filter((subtitle) => subtitle.compoundId === id);
    if (videos.length === 0) continue;

    const anchor =
      videos.find((clip) => clip.compoundAnchor) ??
      [...videos].sort(
        (a, b) =>
          a.timelineStart - b.timelineStart ||
          a.trackId.localeCompare(b.trackId) ||
          a.id.localeCompare(b.id),
      )[0];

    const starts = [
      ...videos.map((clip) => clip.timelineStart),
      ...audios.map((clip) => clip.timelineStart),
      ...subs.map((subtitle) => subtitle.startTime),
    ];
    const ends = [
      ...videos.map((clip) => clip.timelineEnd),
      ...audios.map((clip) => clip.timelineEnd),
      ...subs.map((subtitle) => subtitle.endTime),
    ];

    groups.set(id, {
      id,
      name: anchor.compoundName?.trim() || "Compound Clip",
      anchorVideoId: anchor.id,
      trackId: anchor.trackId,
      start: Math.min(...starts),
      end: Math.max(...ends),
      videoIds: videos.map((clip) => clip.id),
      audioIds: audios.map((clip) => clip.id),
      subtitleIds: subs.map((subtitle) => subtitle.id),
      memberCount: videos.length + audios.length + subs.length,
    });
  }

  return groups;
}

export function nextCompoundClipName(groups: Iterable<CompoundClipGroup>) {
  let highest = 0;
  for (const group of groups) {
    const match = /^Compound Clip\s+(\d+)$/i.exec(group.name.trim());
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `Compound Clip ${highest + 1}`;
}

export function assignCompoundMembership(
  state: CompoundTimelineState,
  selection: { videoIds: string[]; audioIds: string[]; subtitleIds: string[] },
  options: { compoundId: string; name: string; anchorVideoId: string },
): CompoundTimelineState {
  const videoIds = new Set(selection.videoIds);
  const audioIds = new Set(selection.audioIds);
  const subtitleIds = new Set(selection.subtitleIds);

  return {
    videoClips: state.videoClips.map((clip) =>
      videoIds.has(clip.id)
        ? {
            ...clip,
            compoundId: options.compoundId,
            compoundAnchor: clip.id === options.anchorVideoId,
            compoundName: options.name,
          }
        : clip,
    ),
    audioClips: state.audioClips.map((clip) =>
      audioIds.has(clip.id)
        ? { ...clip, compoundId: options.compoundId }
        : clip,
    ),
    subtitles: state.subtitles.map((subtitle) =>
      subtitleIds.has(subtitle.id)
        ? { ...subtitle, compoundId: options.compoundId }
        : subtitle,
    ),
  };
}

export function breakApartCompound(
  state: CompoundTimelineState,
  compoundId: string,
): CompoundTimelineState {
  return {
    videoClips: state.videoClips.map((clip) =>
      clip.compoundId === compoundId
        ? {
            ...clip,
            compoundId: undefined,
            compoundAnchor: undefined,
            compoundName: undefined,
          }
        : clip,
    ),
    audioClips: state.audioClips.map((clip) =>
      clip.compoundId === compoundId
        ? { ...clip, compoundId: undefined }
        : clip,
    ),
    subtitles: state.subtitles.map((subtitle) =>
      subtitle.compoundId === compoundId
        ? { ...subtitle, compoundId: undefined }
        : subtitle,
    ),
  };
}

export function deleteCompound(
  state: CompoundTimelineState,
  compoundId: string,
): CompoundTimelineState {
  return {
    videoClips: state.videoClips.filter(
      (clip) => clip.compoundId !== compoundId,
    ),
    audioClips: state.audioClips.filter(
      (clip) => clip.compoundId !== compoundId,
    ),
    subtitles: state.subtitles.filter(
      (subtitle) => subtitle.compoundId !== compoundId,
    ),
  };
}

function overlaps(
  start: number,
  end: number,
  otherStart: number,
  otherEnd: number,
) {
  return end > otherStart + EPSILON && start < otherEnd - EPSILON;
}

export function canShiftCompound(
  state: CompoundTimelineState,
  group: CompoundClipGroup,
  delta: number,
) {
  if (group.start + delta < -EPSILON) return false;

  const videoIds = new Set(group.videoIds);
  const audioIds = new Set(group.audioIds);
  const subtitleIds = new Set(group.subtitleIds);

  for (const clip of state.videoClips) {
    if (!videoIds.has(clip.id)) continue;
    const start = clip.timelineStart + delta;
    const end = clip.timelineEnd + delta;
    if (
      state.videoClips.some(
        (other) =>
          !videoIds.has(other.id) &&
          other.trackId === clip.trackId &&
          overlaps(start, end, other.timelineStart, other.timelineEnd),
      )
    )
      return false;
  }

  for (const clip of state.audioClips) {
    if (!audioIds.has(clip.id)) continue;
    const start = clip.timelineStart + delta;
    const end = clip.timelineEnd + delta;
    if (
      state.audioClips.some(
        (other) =>
          !audioIds.has(other.id) &&
          other.trackId === clip.trackId &&
          overlaps(start, end, other.timelineStart, other.timelineEnd),
      )
    )
      return false;
  }

  for (const subtitle of state.subtitles) {
    if (!subtitleIds.has(subtitle.id)) continue;
    const trackId = getSubtitleTrackId(subtitle);
    const start = subtitle.startTime + delta;
    const end = subtitle.endTime + delta;
    if (
      state.subtitles.some(
        (other) =>
          !subtitleIds.has(other.id) &&
          getSubtitleTrackId(other) === trackId &&
          overlaps(start, end, other.startTime, other.endTime),
      )
    )
      return false;
  }

  return true;
}

export function shiftCompound(
  state: CompoundTimelineState,
  compoundId: string,
  delta: number,
): CompoundTimelineState {
  if (Math.abs(delta) <= EPSILON) return state;
  return {
    videoClips: state.videoClips.map((clip) =>
      clip.compoundId === compoundId
        ? {
            ...clip,
            timelineStart: Math.max(0, clip.timelineStart + delta),
            timelineEnd: Math.max(0, clip.timelineEnd + delta),
          }
        : clip,
    ),
    audioClips: state.audioClips.map((clip) =>
      clip.compoundId === compoundId
        ? {
            ...clip,
            timelineStart: Math.max(0, clip.timelineStart + delta),
            timelineEnd: Math.max(0, clip.timelineEnd + delta),
          }
        : clip,
    ),
    subtitles: state.subtitles.map((subtitle) =>
      subtitle.compoundId === compoundId
        ? {
            ...subtitle,
            startTime: Math.max(0, subtitle.startTime + delta),
            endTime: Math.max(0, subtitle.endTime + delta),
          }
        : subtitle,
    ),
  };
}

function trimVideoClip(
  clip: VideoTimelineClip,
  retainedStart: number,
  retainedEnd: number,
): VideoTimelineClip | null {
  const start = Math.max(clip.timelineStart, retainedStart);
  const end = Math.min(clip.timelineEnd, retainedEnd);
  if (end - start < MIN_VIDEO_DURATION) return null;

  if (isFreezeFrameClip(clip)) {
    return {
      ...clip,
      timelineStart: start,
      timelineEnd: end,
      transformKeyframes: sliceVideoTransformKeyframes(clip, start, end),
    };
  }

  const startSource = timelineTimeToSourceTime(clip, start);
  const endSource = timelineTimeToSourceTime(clip, end);
  const reverse = isReverseVideoClip(clip);

  return {
    ...clip,
    timelineStart: start,
    timelineEnd: end,
    sourceIn: reverse ? endSource : startSource,
    sourceOut: reverse ? startSource : endSource,
    transformKeyframes: sliceVideoTransformKeyframes(clip, start, end),
    transitionInType:
      start > clip.timelineStart + EPSILON ? "none" : clip.transitionInType,
    transitionOutType:
      end < clip.timelineEnd - EPSILON ? "none" : clip.transitionOutType,
    videoFadeInDuration:
      start > clip.timelineStart + EPSILON ? 0 : clip.videoFadeInDuration,
    videoFadeOutDuration:
      end < clip.timelineEnd - EPSILON ? 0 : clip.videoFadeOutDuration,
    audioFadeInDuration:
      start > clip.timelineStart + EPSILON ? 0 : clip.audioFadeInDuration,
    audioFadeOutDuration:
      end < clip.timelineEnd - EPSILON ? 0 : clip.audioFadeOutDuration,
    rippleAutoHealInBoundaryId: undefined,
    rippleAutoHealOutBoundaryId: undefined,
  };
}

function trimAudioClip(
  clip: AudioTimelineClip,
  retainedStart: number,
  retainedEnd: number,
): AudioTimelineClip | null {
  const start = Math.max(clip.timelineStart, retainedStart);
  const end = Math.min(clip.timelineEnd, retainedEnd);
  if (end - start < MIN_AUDIO_DURATION) return null;
  const rate = videoPlaybackRate(clip);
  return {
    ...clip,
    timelineStart: start,
    timelineEnd: end,
    sourceIn: clip.sourceIn + (start - clip.timelineStart) * rate,
    sourceOut: clip.sourceOut - (clip.timelineEnd - end) * rate,
    fadeInDuration:
      start > clip.timelineStart + EPSILON ? 0 : clip.fadeInDuration,
    fadeOutDuration:
      end < clip.timelineEnd - EPSILON ? 0 : clip.fadeOutDuration,
  };
}

export function trimCompound(
  state: CompoundTimelineState,
  compoundId: string,
  retainedStart: number,
  retainedEnd: number,
): CompoundTimelineState {
  const originalName =
    buildCompoundGroups(
      state.videoClips,
      state.audioClips,
      state.subtitles,
    ).get(compoundId)?.name ?? "Compound Clip";
  const nextVideos = state.videoClips.flatMap((clip) => {
    if (clip.compoundId !== compoundId) return [clip];
    const trimmed = trimVideoClip(clip, retainedStart, retainedEnd);
    return trimmed ? [trimmed] : [];
  });
  const nextAudios = state.audioClips.flatMap((clip) => {
    if (clip.compoundId !== compoundId) return [clip];
    const trimmed = trimAudioClip(clip, retainedStart, retainedEnd);
    return trimmed ? [trimmed] : [];
  });
  const nextSubtitles = state.subtitles.flatMap((subtitle) => {
    if (subtitle.compoundId !== compoundId) return [subtitle];
    const start = Math.max(subtitle.startTime, retainedStart);
    const end = Math.min(subtitle.endTime, retainedEnd);
    return end - start >= MIN_SUBTITLE_DURATION
      ? [{ ...subtitle, startTime: start, endTime: end }]
      : [];
  });

  const members = nextVideos.filter((clip) => clip.compoundId === compoundId);
  if (members.length === 0) {
    return deleteCompound(
      {
        videoClips: nextVideos,
        audioClips: nextAudios,
        subtitles: nextSubtitles,
      },
      compoundId,
    );
  }

  const previousAnchor = members.find((clip) => clip.compoundAnchor);
  const anchor =
    previousAnchor ??
    [...members].sort((a, b) => a.timelineStart - b.timelineStart)[0];
  const name =
    previousAnchor?.compoundName ?? anchor.compoundName ?? originalName;

  return {
    videoClips: nextVideos.map((clip) =>
      clip.compoundId === compoundId
        ? {
            ...clip,
            compoundAnchor: clip.id === anchor.id,
            compoundName: name,
          }
        : clip,
    ),
    audioClips: nextAudios,
    subtitles: nextSubtitles,
  };
}

export function insertCompoundCopy(
  state: CompoundTimelineState,
  sourceState: CompoundTimelineState,
  compoundId: string,
  requestedStart: number,
): {
  state: CompoundTimelineState;
  compoundId: string;
  anchorVideoId: string;
} | null {
  const groups = buildCompoundGroups(
    sourceState.videoClips,
    sourceState.audioClips,
    sourceState.subtitles,
  );
  const group = groups.get(compoundId);
  if (!group) return null;

  const sourceVideos = sourceState.videoClips.filter(
    (clip) => clip.compoundId === compoundId,
  );
  const sourceAudios = sourceState.audioClips.filter(
    (clip) => clip.compoundId === compoundId,
  );
  const sourceSubtitles = sourceState.subtitles.filter(
    (subtitle) => subtitle.compoundId === compoundId,
  );

  let targetStart = Math.max(0, requestedStart);

  // Search forward for the first collision-free placement while preserving all
  // relative track assignments and timing inside the compound.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const delta = targetStart - group.start;
    let requiredShift = 0;

    for (const clip of sourceVideos) {
      const start = clip.timelineStart + delta;
      const end = clip.timelineEnd + delta;
      for (const other of state.videoClips) {
        if (
          other.trackId !== clip.trackId ||
          !overlaps(start, end, other.timelineStart, other.timelineEnd)
        )
          continue;
        requiredShift = Math.max(
          requiredShift,
          other.timelineEnd - start + 0.001,
        );
      }
    }

    for (const clip of sourceAudios) {
      const start = clip.timelineStart + delta;
      const end = clip.timelineEnd + delta;
      for (const other of state.audioClips) {
        if (
          other.trackId !== clip.trackId ||
          !overlaps(start, end, other.timelineStart, other.timelineEnd)
        )
          continue;
        requiredShift = Math.max(
          requiredShift,
          other.timelineEnd - start + 0.001,
        );
      }
    }

    for (const subtitle of sourceSubtitles) {
      const trackId = getSubtitleTrackId(subtitle);
      const start = subtitle.startTime + delta;
      const end = subtitle.endTime + delta;
      for (const other of state.subtitles) {
        if (
          getSubtitleTrackId(other) !== trackId ||
          !overlaps(start, end, other.startTime, other.endTime)
        )
          continue;
        requiredShift = Math.max(requiredShift, other.endTime - start + 0.001);
      }
    }

    if (requiredShift <= EPSILON) break;
    targetStart += requiredShift;
  }

  const newCompoundId = crypto.randomUUID();
  const delta = targetStart - group.start;
  const videoIdMap = new Map<string, string>();
  const audioIdMap = new Map<string, string>();
  const subtitleIdMap = new Map<string, string>();
  for (const id of group.videoIds) videoIdMap.set(id, crypto.randomUUID());
  for (const id of group.audioIds) audioIdMap.set(id, crypto.randomUUID());
  for (const id of group.subtitleIds)
    subtitleIdMap.set(id, crypto.randomUUID());

  const copiedVideos = sourceVideos.map((clip) => ({
    ...clip,
    id: videoIdMap.get(clip.id)!,
    compoundId: newCompoundId,
    compoundAnchor: clip.id === group.anchorVideoId,
    compoundName: group.name,
    timelineStart: clip.timelineStart + delta,
    timelineEnd: clip.timelineEnd + delta,
    rippleAutoHealInBoundaryId: undefined,
    rippleAutoHealOutBoundaryId: undefined,
  }));
  const copiedAudios = sourceAudios.map((clip) => ({
    ...clip,
    id: audioIdMap.get(clip.id)!,
    compoundId: newCompoundId,
    timelineStart: clip.timelineStart + delta,
    timelineEnd: clip.timelineEnd + delta,
    linkedVideoClipId: clip.linkedVideoClipId
      ? (videoIdMap.get(clip.linkedVideoClipId) ?? clip.linkedVideoClipId)
      : undefined,
  }));
  const copiedSubtitles = sourceSubtitles.map((subtitle) => ({
    ...subtitle,
    id: subtitleIdMap.get(subtitle.id)!,
    compoundId: newCompoundId,
    startTime: subtitle.startTime + delta,
    endTime: subtitle.endTime + delta,
  }));

  const anchorVideoId = videoIdMap.get(group.anchorVideoId)!;
  return {
    state: {
      videoClips: [...state.videoClips, ...copiedVideos],
      audioClips: [...state.audioClips, ...copiedAudios],
      subtitles: [...state.subtitles, ...copiedSubtitles],
    },
    compoundId: newCompoundId,
    anchorVideoId,
  };
}

export function duplicateCompound(
  state: CompoundTimelineState,
  compoundId: string,
  requestedStart: number,
) {
  return insertCompoundCopy(state, state, compoundId, requestedStart);
}

export function collapsedTimelineMedia(
  videoClips: VideoTimelineClip[],
  audioClips: AudioTimelineClip[],
  subtitles: Subtitle[],
  expandedCompoundId: string | null,
) {
  const groups = buildCompoundGroups(videoClips, audioClips, subtitles);
  const collapsedIds = new Set(
    [...groups.keys()].filter((id) => id !== expandedCompoundId),
  );

  const visibleVideos = videoClips.filter(
    (clip) => !clip.compoundId || !collapsedIds.has(clip.compoundId),
  );
  const visibleAudios = audioClips.filter(
    (clip) => !clip.compoundId || !collapsedIds.has(clip.compoundId),
  );
  // Subtitles intentionally remain visible/editable even while their related
  // video/audio members are represented by a collapsed compound.
  const visibleSubtitles = [...subtitles];

  for (const group of groups.values()) {
    if (!collapsedIds.has(group.id)) continue;
    const anchor = videoClips.find((clip) => clip.id === group.anchorVideoId);
    if (!anchor) continue;
    visibleVideos.push({
      ...anchor,
      timelineStart: group.start,
      timelineEnd: group.end,
      sourceName: group.name,
      compoundAnchor: true,
      compoundName: group.name,
      compoundDisplay: true,
      compoundMemberCount: group.memberCount,
    });
  }

  return {
    videoClips: visibleVideos,
    audioClips: visibleAudios,
    subtitles: visibleSubtitles,
    groups,
  };
}

export function collapsedCompoundTrackRegions(
  videoClips: VideoTimelineClip[],
  audioClips: AudioTimelineClip[],
  subtitles: Subtitle[],
  trackSettings: TimelineTrackSettings,
  expandedCompoundId: string | null,
): CompoundTrackRegions {
  const groups = buildCompoundGroups(videoClips, audioClips, subtitles);
  const audio: CompoundTrackRegion[] = [];
  const subtitle: CompoundTrackRegion[] = [];

  for (const group of groups.values()) {
    if (group.id === expandedCompoundId) continue;

    const audioMemberCounts = new Map<TimelineTrackId, number>();

    // Linked audio is synthesized from video clips by buildTimelineModel rather
    // than stored in audioClips, so include the explicit linked audio track for
    // every video member as part of the collapsed compound presentation.
    for (const clip of videoClips) {
      if (clip.compoundId !== group.id) continue;
      const settings = {
        ...(DEFAULT_TIMELINE_TRACK_SETTINGS[clip.trackId] ?? {}),
        ...(trackSettings[clip.trackId] ?? {}),
      };
      const linkedTrackId = settings.linkedTrackId;
      if (
        linkedTrackId &&
        linkedTrackId.startsWith("audio-") &&
        trackSettings[linkedTrackId]?.deleted !== true
      ) {
        audioMemberCounts.set(
          linkedTrackId,
          (audioMemberCounts.get(linkedTrackId) ?? 0) + 1,
        );
      }
    }

    for (const clip of audioClips) {
      if (clip.compoundId !== group.id) continue;
      audioMemberCounts.set(
        clip.trackId,
        (audioMemberCounts.get(clip.trackId) ?? 0) + 1,
      );
    }

    for (const [trackId, memberCount] of audioMemberCounts) {
      audio.push({
        compoundId: group.id,
        anchorVideoId: group.anchorVideoId,
        name: group.name,
        trackId,
        start: group.start,
        end: group.end,
        memberCount,
        kind: "audio",
      });
    }
  }

  return { audio, subtitle };
}
