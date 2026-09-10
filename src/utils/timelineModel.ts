import type { Subtitle } from "../types/subtitle";
import type {
  AudioTimelineClip,
  SubtitleTimelineClip,
  TimelineTrack,
  VideoTimelineClip,
} from "../types/timelineModel";

type BuildTimelineModelOptions = {
  duration: number;
  videoClips: VideoTimelineClip[];
  subtitles: Subtitle[];
};

export function buildTimelineModel({
  videoClips,
  subtitles,
}: BuildTimelineModelOptions): TimelineTrack[] {
  const subtitleClips: SubtitleTimelineClip[] =
    subtitles.map((subtitle) => ({
      id: `subtitle-clip:${subtitle.id}`,
      kind: "subtitle",
      trackId: "subtitle-1",
      subtitleId: subtitle.id,
      timelineStart: subtitle.startTime,
      timelineEnd: subtitle.endTime,
    }));

  /*
   * A1 is linked to V1 for now. Every video clip owns a matching audio clip
   * with identical timeline/source in/out values. That means split, trim,
   * move, paste, duplicate, and imported-media placement automatically stay
   * synchronized without maintaining a second editable state tree yet.
   */
  const audioClips: AudioTimelineClip[] = videoClips.map((clip) => ({
    id: `audio:${clip.id}`,
    kind: "audio",
    trackId: "audio-1",
    sourceId: clip.sourceId,
    sourcePath: clip.sourcePath,
    sourceName: clip.sourceName,
    sourceIn: clip.sourceIn,
    sourceOut: clip.sourceOut,
    sourceDuration: clip.sourceDuration,
    linkedVideoClipId: clip.id,
    timelineStart: clip.timelineStart,
    timelineEnd: clip.timelineEnd,
  }));

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
      name: "Linked Audio",
      shortLabel: "A1",
      locked: true,
      muted: false,
      clips: audioClips,
    },
  ];
}
