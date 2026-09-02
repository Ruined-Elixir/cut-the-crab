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

export type Subtitle = SubtitleStyle & {
  id: string;

  startTime: number;
  endTime: number;

  text: string;

  positionX?: number;
  positionY?: number;
};
