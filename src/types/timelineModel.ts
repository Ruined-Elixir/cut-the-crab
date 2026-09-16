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
  | "video-2"
  | "subtitle-1"
  | "audio-1"
  | "audio-2"
  | string;

export type TimelineClipBase = {
  id: string;
  kind: TimelineClipKind;
  trackId: TimelineTrackId;
  timelineStart: number;
  timelineEnd: number;
};

export type VideoTransitionType = "none" | "cross-dissolve" | "fade-black";

export type VideoTimelineClip = TimelineClipBase & {
  kind: "video";
  sourceId: string;
  sourcePath: string;
  sourceName: string;
  sourceIn: number;
  sourceOut: number;
  sourceDuration?: number;
  positionX?: number;
  positionY?: number;
  scale?: number;
  rotation?: number;
  cropTop?: number;
  cropRight?: number;
  cropBottom?: number;
  cropLeft?: number;
  transitionInType?: VideoTransitionType;
  transitionInDuration?: number;
  transitionOutType?: VideoTransitionType;
  transitionOutDuration?: number;
  videoFadeInDuration?: number;
  videoFadeOutDuration?: number;
  audioVolume?: number;
  audioMuted?: boolean;
  audioFadeInDuration?: number;
  audioFadeOutDuration?: number;
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
  sourceDuration?: number;
  linkedVideoClipId?: string;
  volume?: number;
  muted?: boolean;
  fadeInDuration?: number;
  fadeOutDuration?: number;
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

export type TimelineTrackControlState = {
  locked: boolean;
  muted?: boolean;
  hidden?: boolean;
  /** Persisted tombstone used when the user deletes a timeline track. */
  deleted?: boolean;
};

export type TimelineTrackSettings = Record<string, TimelineTrackControlState>;

export const DEFAULT_TIMELINE_TRACK_SETTINGS: TimelineTrackSettings = {
  "video-2": { locked: false, hidden: false },
  "video-1": { locked: false, hidden: false },
  "subtitle-1": { locked: false, hidden: false },
  "audio-1": { locked: true, muted: false },
  "audio-2": { locked: true, muted: false },
};
