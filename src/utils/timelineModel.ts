import type { Subtitle } from "../types/subtitle";
import type {
  AudioTimelineClip,
  SubtitleTimelineClip,
  TimelineTrack,
  TimelineTrackControlState,
  TimelineTrackKind,
  TimelineTrackSettings,
  VideoTimelineClip,
} from "../types/timelineModel";
import { DEFAULT_TIMELINE_TRACK_SETTINGS } from "../types/timelineModel";

type BuildTimelineModelOptions = {
  duration: number;
  videoClips: VideoTimelineClip[];
  subtitles: Subtitle[];
  trackSettings?: TimelineTrackSettings;
};

const TRACK_ID_PATTERN = /^(video|subtitle|audio)-(\d+)$/;

export function timelineTrackKindFromId(trackId: string): TimelineTrackKind | null {
  const match = TRACK_ID_PATTERN.exec(trackId);
  if (!match) return null;
  return match[1] as TimelineTrackKind;
}

export function timelineTrackIndexFromId(trackId: string) {
  const match = TRACK_ID_PATTERN.exec(trackId);
  return match ? Number(match[2]) : Number.POSITIVE_INFINITY;
}

export function timelineTrackId(kind: TimelineTrackKind, index: number) {
  return `${kind}-${Math.max(1, Math.floor(index))}`;
}

export function nextTimelineTrackId(
  kind: TimelineTrackKind,
  trackSettings: TimelineTrackSettings,
  videoClips: VideoTimelineClip[] = [],
) {
  const ids = new Set(Object.keys(trackSettings));
  for (const clip of videoClips) ids.add(clip.trackId);

  let maxIndex = 0;
  for (const id of ids) {
    if (timelineTrackKindFromId(id) === kind) {
      maxIndex = Math.max(maxIndex, timelineTrackIndexFromId(id));
    }
  }

  return timelineTrackId(kind, maxIndex + 1);
}

export function defaultTrackControlState(kind: TimelineTrackKind): TimelineTrackControlState {
  if (kind === "audio") {
    return { locked: true, muted: false };
  }

  return { locked: false, hidden: false };
}

function getTrackSettings(
  trackId: string,
  trackSettings?: TimelineTrackSettings,
) {
  const kind = timelineTrackKindFromId(trackId) ?? "video";
  return {
    ...(DEFAULT_TIMELINE_TRACK_SETTINGS[trackId] ?? defaultTrackControlState(kind)),
    ...(trackSettings?.[trackId] ?? {}),
  };
}

function linkedAudioClip(
  clip: VideoTimelineClip,
  trackId: string,
): AudioTimelineClip {
  return {
    id: `audio:${clip.id}`,
    kind: "audio",
    trackId,
    sourceId: clip.sourceId,
    sourcePath: clip.sourcePath,
    sourceName: clip.sourceName,
    sourceIn: clip.sourceIn,
    sourceOut: clip.sourceOut,
    sourceDuration: clip.sourceDuration,
    linkedVideoClipId: clip.id,
    volume: clip.audioVolume ?? 100,
    muted: clip.audioMuted ?? false,
    fadeInDuration: clip.audioFadeInDuration ?? 0,
    fadeOutDuration: clip.audioFadeOutDuration ?? 0,
    timelineStart: clip.timelineStart,
    timelineEnd: clip.timelineEnd,
  };
}

function collectTrackIds(
  trackSettings: TimelineTrackSettings | undefined,
  videoClips: VideoTimelineClip[],
) {
  const ids = new Set<string>(Object.keys(DEFAULT_TIMELINE_TRACK_SETTINGS));

  for (const id of Object.keys(trackSettings ?? {})) {
    if (timelineTrackKindFromId(id)) ids.add(id);
  }

  for (const clip of videoClips) {
    if (timelineTrackKindFromId(clip.trackId) === "video") ids.add(clip.trackId);
  }

  // Every video track owns a linked audio partner with the same index.
  // This also migrates older projects that already contain V3+ but were saved
  // before automatic V/A pairing was introduced.
  for (const id of [...ids]) {
    if (timelineTrackKindFromId(id) === "video") {
      const index = timelineTrackIndexFromId(id);
      ids.add(timelineTrackId("audio", index));
    }
  }

  return ids;
}

function sortedTrackIds(ids: Set<string>, kind: TimelineTrackKind) {
  return [...ids]
    .filter((id) => timelineTrackKindFromId(id) === kind)
    .sort((a, b) => timelineTrackIndexFromId(a) - timelineTrackIndexFromId(b));
}

export function buildTimelineModel({
  videoClips,
  subtitles,
  trackSettings,
}: BuildTimelineModelOptions): TimelineTrack[] {
  const ids = collectTrackIds(trackSettings, videoClips);
  const videoTrackIds = sortedTrackIds(ids, "video");
  const subtitleTrackIds = sortedTrackIds(ids, "subtitle");
  const audioTrackIds = sortedTrackIds(ids, "audio");

  const subtitleClips: SubtitleTimelineClip[] = subtitles.map((subtitle) => ({
    id: `subtitle-clip:${subtitle.id}`,
    kind: "subtitle",
    trackId: "subtitle-1",
    subtitleId: subtitle.id,
    timelineStart: subtitle.startTime,
    timelineEnd: subtitle.endTime,
  }));

  const videoTracks: TimelineTrack[] = videoTrackIds.map((id) => {
    const index = timelineTrackIndexFromId(id);
    const settings = getTrackSettings(id, trackSettings);

    return {
      id,
      kind: "video",
      index,
      name: index === 1 ? "Video" : `Video ${index}`,
      shortLabel: `V${index}`,
      locked: settings.locked,
      hidden: settings.hidden,
      clips: videoClips.filter((clip) => clip.trackId === id),
    };
  });

  const subtitleTracks: TimelineTrack[] = subtitleTrackIds.map((id) => {
    const index = timelineTrackIndexFromId(id);
    const settings = getTrackSettings(id, trackSettings);

    return {
      id,
      kind: "subtitle",
      index,
      name: index === 1 ? "Subtitles" : `Subtitles ${index}`,
      shortLabel: `S${index}`,
      locked: settings.locked,
      hidden: settings.hidden,
      clips: id === "subtitle-1" ? subtitleClips : [],
    };
  });

  const audioTracks: TimelineTrack[] = audioTrackIds.map((id) => {
    const index = timelineTrackIndexFromId(id);
    const settings = getTrackSettings(id, trackSettings);
    const matchingVideoTrackId = timelineTrackId("video", index);
    const linked = videoClips
      .filter((clip) => clip.trackId === matchingVideoTrackId)
      .map((clip) => linkedAudioClip(clip, id));

    return {
      id,
      kind: "audio",
      index,
      name: index === 1 ? "Linked Audio" : `Audio ${index}`,
      shortLabel: `A${index}`,
      locked: settings.locked,
      muted: settings.muted,
      clips: linked,
    };
  });

  // Preserve the editor's established visual grouping: video, subtitles, audio.
  return [...videoTracks, ...subtitleTracks, ...audioTracks];
}
