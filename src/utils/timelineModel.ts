import type { Subtitle } from "../types/subtitle";
import type {
  AudioTimelineClip,
  SubtitleTimelineClip,
  TimelineTrack,
  VideoTimelineClip,
} from "../types/timelineModel";

type BuildTimelineModelOptions = {
  duration: number;
  sourceDuration?: number;
  videoName: string | null;
  videoPath?: string | null;
  videoClips: VideoTimelineClip[];
  subtitles: Subtitle[];
};

export function buildTimelineModel({
  duration,
  sourceDuration,
  videoName,
  videoPath,
  videoClips,
  subtitles,
}: BuildTimelineModelOptions): TimelineTrack[] {
  const safeDuration = Math.max(0, duration);
  const safeSourceDuration = Math.max(
    0,
    sourceDuration ?? safeDuration,
  );
  const sourceName = videoName ?? "Source Video";
  const sourceId =
    videoPath ?? videoName ?? "current-source-video";
  const sourcePath = videoPath ?? "";

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
    safeSourceDuration > 0 && videoName
      ? {
          id: "audio-source-clip",
          kind: "audio",
          trackId: "audio-1",
          sourceId,
          sourcePath,
          sourceName,
          sourceIn: 0,
          sourceOut: safeSourceDuration,
          timelineStart: 0,
          timelineEnd: safeSourceDuration,
        }
      : null;

  return [
    {
      id: "video-1",
      kind: "video",
      index: 1,
      name: "Video",
      shortLabel: "V1",
      locked: false,
      hidden: false,
      clips: videoClips,
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
      name: "Source Audio",
      shortLabel: "A1",
      locked: true,
      muted: false,
      clips: audioClip ? [audioClip] : [],
    },
  ];
}
