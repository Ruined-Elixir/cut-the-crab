export type TimelineTrackKind =
  | "video"
  | "subtitle"
  | "audio";

export type TimelineClipKind =
  | "video"
  | "subtitle"
  | "audio";

export type TimelineTrackId =
  | "video-1"
  | "subtitle-1"
  | "audio-1"
  | string;

export type TimelineClipBase = {
  id: string;
  kind: TimelineClipKind;
  trackId: TimelineTrackId;
  timelineStart: number;
  timelineEnd: number;
};

export type VideoTimelineClip = TimelineClipBase & {
  kind: "video";
  sourceId: string;
  sourcePath: string;
  sourceName: string;
  sourceIn: number;
  sourceOut: number;
  sourceDuration?: number;
};

export type SubtitleTimelineClip = TimelineClipBase & {
  kind: "subtitle";
  subtitleId: string;
};

export type AudioTimelineClip = TimelineClipBase & {
  kind: "audio";
  sourceId: string;
  sourcePath: string;
  sourceName: string;
  sourceIn: number;
  sourceOut: number;
};

export type TimelineClip =
  | VideoTimelineClip
  | SubtitleTimelineClip
  | AudioTimelineClip;

export type TimelineTrack = {
  id: TimelineTrackId;
  kind: TimelineTrackKind;
  index: number;
  name: string;
  shortLabel: string;
  locked: boolean;
  muted?: boolean;
  hidden?: boolean;
  clips: TimelineClip[];
};
