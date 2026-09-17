export type SubtitleTextAlign = "left" | "center" | "right";

export type SubtitleStyle = {
  fontSize?: number;
  fontFamily?: string;

  color?: string;
  backgroundColor?: string;

  isBold?: boolean;
  isUnderlined?: boolean;

  textAlign?: SubtitleTextAlign;
};

export const DEFAULT_SUBTITLE_TRACK_ID = "subtitle-1";

export type Subtitle = SubtitleStyle & {
  id: string;

  /**
   * Owning subtitle timeline track. Projects created before multi-track
   * subtitle routing omit this field and are migrated to subtitle-1.
   */
  trackId?: string;

  startTime: number;
  endTime: number;

  text: string;

  positionX?: number;
  positionY?: number;

  /** Optional compound-clip membership. */
  compoundId?: string;
};

export function getSubtitleTrackId(subtitle: Pick<Subtitle, "trackId">) {
  return /^subtitle-\d+$/.test(subtitle.trackId ?? "")
    ? subtitle.trackId!
    : DEFAULT_SUBTITLE_TRACK_ID;
}
