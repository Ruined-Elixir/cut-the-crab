import type { Subtitle } from "../types/subtitle";
import type {
  AudioTimelineClip,
  SubtitleTimelineClip,
  TimelineTrack,
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

function getTrackSettings(
  trackId: string,
  trackSettings?: TimelineTrackSettings,
) {
  return {
    ...(DEFAULT_TIMELINE_TRACK_SETTINGS[trackId] ?? {
      locked: false,
      muted: false,
      hidden: false,
    }),
    ...(trackSettings?.[trackId] ?? {}),
  };
}

function linkedAudioClip(
  clip: VideoTimelineClip,
  trackId: "audio-1" | "audio-2",
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

export function buildTimelineModel({
  videoClips,
  subtitles,
  trackSettings,
}: BuildTimelineModelOptions): TimelineTrack[] {
  const subtitleClips: SubtitleTimelineClip[] = subtitles.map((subtitle) => ({
    id: `subtitle-clip:${subtitle.id}`,
    kind: "subtitle",
    trackId: "subtitle-1",
    subtitleId: subtitle.id,
    timelineStart: subtitle.startTime,
    timelineEnd: subtitle.endTime,
  }));

  const v1Clips = videoClips.filter((clip) => clip.trackId !== "video-2");
  const v2Clips = videoClips.filter((clip) => clip.trackId === "video-2");
  const a1Clips = v1Clips.map((clip) => linkedAudioClip(clip, "audio-1"));
  const a2Clips = v2Clips.map((clip) => linkedAudioClip(clip, "audio-2"));

  const v2Settings = getTrackSettings("video-2", trackSettings);
  const v1Settings = getTrackSettings("video-1", trackSettings);
  const s1Settings = getTrackSettings("subtitle-1", trackSettings);
  const a1Settings = getTrackSettings("audio-1", trackSettings);
  const a2Settings = getTrackSettings("audio-2", trackSettings);

  return [
    {
      id: "video-1",
      kind: "video",
      index: 1,
      name: "Video",
      shortLabel: "V1",
      locked: v1Settings.locked,
      hidden: v1Settings.hidden,
      clips: v1Clips,
    },
    {
      id: "video-2",
      kind: "video",
      index: 2,
      name: "Video Overlay",
      shortLabel: "V2",
      locked: v2Settings.locked,
      hidden: v2Settings.hidden,
      clips: v2Clips,
    },
    {
      id: "subtitle-1",
      kind: "subtitle",
      index: 1,
      name: "Subtitles",
      shortLabel: "S1",
      locked: s1Settings.locked,
      hidden: s1Settings.hidden,
      clips: subtitleClips,
    },
    {
      id: "audio-1",
      kind: "audio",
      index: 1,
      name: "Linked Audio",
      shortLabel: "A1",
      locked: a1Settings.locked,
      muted: a1Settings.muted,
      clips: a1Clips,
    },
    {
      id: "audio-2",
      kind: "audio",
      index: 2,
      name: "Overlay Audio",
      shortLabel: "A2",
      locked: a2Settings.locked,
      muted: a2Settings.muted,
      clips: a2Clips,
    },
  ];
}
