import type { Subtitle } from "../types/subtitle";
import type {
  AudioTimelineClip,
  SubtitleTimelineClip,
  TimelineTrack,
  VideoTimelineClip,
} from "../types/timelineModel";

type BuildTimelineModelOptions = {
  duration: number;
  videoName: string | null;
  subtitles: Subtitle[];
};

export function buildTimelineModel({
  duration,
  videoName,
  subtitles,
}: BuildTimelineModelOptions): TimelineTrack[] {
  const safeDuration = Math.max(0, duration);
  const sourceName = videoName ?? "Source Video";
  const sourceId = videoName ?? "current-source-video";

  const videoClip: VideoTimelineClip | null =
    safeDuration > 0 && videoName
      ? {
          id: "video-source-clip",
          kind: "video",
          trackId: "video-1",
          sourceId,
          sourceName,
          sourceIn: 0,
          sourceOut: safeDuration,
          timelineStart: 0,
          timelineEnd: safeDuration,
        }
      : null;

  const subtitleClips: SubtitleTimelineClip[] =
    subtitles.map((subtitle) => ({
      id: `subtitle-clip:${subtitle.id}`,
      kind: "subtitle",
      trackId: "subtitle-1",
      subtitleId: subtitle.id,
      timelineStart: subtitle.startTime,
      timelineEnd: subtitle.endTime,
    }));

  const audioClip: AudioTimelineClip | null =
    safeDuration > 0 && videoName
      ? {
          id: "audio-source-clip",
          kind: "audio",
          trackId: "audio-1",
          sourceId,
          sourceName,
          sourceIn: 0,
          sourceOut: safeDuration,
          timelineStart: 0,
          timelineEnd: safeDuration,
        }
      : null;

  return [
    {
      id: "video-1",
      kind: "video",
      index: 1,
      name: "Video",
      shortLabel: "V1",
      locked: true,
      hidden: false,
      clips: videoClip ? [videoClip] : [],
    },
    {
      id: "subtitle-1",
      kind: "subtitle",
      index: 1,
      name: "Subtitles",
      shortLabel: "S1",
      locked: false,
      hidden: false,
      clips: subtitleClips,
    },
    {
      id: "audio-1",
      kind: "audio",
      index: 1,
      name: "Audio",
      shortLabel: "A1",
      locked: true,
      muted: false,
      clips: audioClip ? [audioClip] : [],
    },
  ];
}
