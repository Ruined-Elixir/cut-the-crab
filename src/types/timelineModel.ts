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

export type VideoTransformKeyframeProperty =
  | "positionX"
  | "positionY"
  | "scale"
  | "rotation"
  | "opacity";

export type VideoTransformKeyframe = {
  /** Time in seconds relative to the clip's timelineStart. */
  time: number;
  value: number;
};

export type VideoTransformKeyframes = Partial<
  Record<VideoTransformKeyframeProperty, VideoTransformKeyframe[]>
>;

export type VideoTimelineClip = TimelineClipBase & {
  kind: "video";
  sourceId: string;
  sourcePath: string;
  sourceName: string;
  sourceIn: number;
  sourceOut: number;
  sourceDuration?: number;
  /** Source seconds consumed per one timeline second. 1 = normal speed. */
  playbackRate?: number;
  positionX?: number;
  positionY?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
  transformKeyframes?: VideoTransformKeyframes;
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
  /**
   * Internal lineage markers for edit points created automatically by Ripple
   * insertion. A matching Out/In pair may be healed when the two source
   * fragments become adjacent again. Manual blade/range cuts never create
   * these markers.
   */
  rippleAutoHealInBoundaryId?: string;
  rippleAutoHealOutBoundaryId?: string;
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
  /** Used by linked video audio; standalone audio currently remains at 1x. */
  playbackRate?: number;
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
  solo?: boolean;
  hidden?: boolean;
  clips: TimelineClip[];
};

export type TimelineTrackControlState = {
  locked: boolean;
  /** Explicit link between a video track and its paired audio track. */
  linkedTrackId?: TimelineTrackId | null;
  muted?: boolean;
  solo?: boolean;
  hidden?: boolean;
  /** Persisted tombstone used when the user deletes a timeline track. */
  deleted?: boolean;
};

export type TimelineTrackSettings = Record<string, TimelineTrackControlState>;

export const DEFAULT_TIMELINE_TRACK_SETTINGS: TimelineTrackSettings = {
  "video-2": { locked: false, hidden: false, linkedTrackId: "audio-2" },
  "video-1": { locked: false, hidden: false, linkedTrackId: "audio-1" },
  "subtitle-1": { locked: false, hidden: false },
  "audio-1": { locked: true, muted: false, solo: false, linkedTrackId: "video-1" },
  "audio-2": { locked: true, muted: false, solo: false, linkedTrackId: "video-2" },
};
