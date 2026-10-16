import { getSubtitleTrackId, type Subtitle } from "../types/subtitle";

import {
  SUBTITLE_CANVAS_HEIGHT,
  SUBTITLE_CANVAS_WIDTH,
  canvasPercentToOutputPoint,
} from "./subtitleCanvas";

export const ASS_WIDTH = SUBTITLE_CANVAS_WIDTH;
export const ASS_HEIGHT = SUBTITLE_CANVAS_HEIGHT;

/*
 * For true preview/export parity, every selectable font should be bundled
 * and made available to both the browser libass renderer and FFmpeg/libass.
 *
 * Start with one bundled CJK-capable font. Add more here only after adding
 * the matching font file to public/fonts and to the FFmpeg fonts directory.
 */
export const DEFAULT_ASS_FONT_FAMILY = "Noto Sans CJK TC";
export const DEFAULT_ASS_FONT_URL = "/fonts/NotoSansCJKtc-Regular.otf";

const SUPPORTED_ASS_FONTS = new Set([DEFAULT_ASS_FONT_FAMILY]);

function resolveAssFontFamily(fontFamily?: string): string {
  if (fontFamily && SUPPORTED_ASS_FONTS.has(fontFamily)) {
    return fontFamily;
  }

  return DEFAULT_ASS_FONT_FAMILY;
}

function formatAssTime(seconds: number): string {
  const totalCentiseconds = Math.max(0, Math.round(seconds * 100));

  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);

  const wholeSeconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);

  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  return `${hours}:${minutes.toString().padStart(2, "0")}:${wholeSeconds
    .toString()
    .padStart(2, "0")}.${centiseconds.toString().padStart(2, "0")}`;
}

function hexToAssColor(color: string, transparent = false): string {
  if (transparent || color === "transparent") {
    return "&HFF000000";
  }

  const normalized = color.trim().replace(/^#/, "");

  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return "&H00FFFFFF";
  }

  const red = normalized.slice(0, 2);
  const green = normalized.slice(2, 4);
  const blue = normalized.slice(4, 6);

  return `&H00${blue}${green}${red}`;
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r\n/g, "\\N")
    .replace(/\r/g, "\\N")
    .replace(/\n/g, "\\N");
}

function sanitizeStyleValue(value: string): string {
  return value.replace(/,/g, " ").trim();
}

function getAlignment(textAlign: Subtitle["textAlign"]): number {
  switch (textAlign) {
    case "left":
      return 4;
    case "right":
      return 6;
    default:
      return 5;
  }
}

/*
 * Use ASS BorderStyle=3 for subtitle backgrounds. This is the standard opaque
 * box mode and is supported consistently by both the browser libass renderer
 * and FFmpeg/libass. OutlineColour becomes the box colour and Outline controls
 * its padding.
 */
export type AssSourceViewport = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type AssTrackOptions = {
  playResWidth?: number;
  playResHeight?: number;
  /**
   * Optional crop viewport expressed in canonical 1920x1080 Program-space
   * coordinates. Export uses this to remap subtitle positions into the exact
   * same aspect-ratio box shown by the Program Monitor.
   */
  sourceViewport?: AssSourceViewport;
};

function createStyle(
  index: number,
  subtitle: Subtitle,
  designScale: number,
): string {
  const fontFamily = sanitizeStyleValue(
    resolveAssFontFamily(subtitle.fontFamily),
  );

  const fontSize = (subtitle.fontSize ?? 24) * designScale;
  const textColor = hexToAssColor(subtitle.color ?? "#ffffff");

  const hasBackground =
    !!subtitle.backgroundColor && subtitle.backgroundColor !== "transparent";

  const backgroundColor = hasBackground
    ? hexToAssColor(subtitle.backgroundColor!)
    : "&HFF000000";

  const bold = subtitle.isBold ? -1 : 0;
  const italic = subtitle.isItalic ? -1 : 0;
  const underline = subtitle.isUnderlined ? -1 : 0;

  const borderStyle = hasBackground ? 3 : 1;

  /*
   * BorderStyle=3 uses OutlineColour as the opaque box colour and Outline as
   * the box padding. Keeping the same 8-design-pixel padding also means the
   * Program Monitor's dashed move rectangle can mirror the rendered box.
   */
  const outline = (hasBackground ? 8 : 2) * designScale;
  const shadow = 0;
  const outlineColor = hasBackground ? backgroundColor : "&H00000000";

  return [
    `Style: Subtitle${index}`,
    fontFamily,
    fontSize.toFixed(2),
    textColor,
    "&H00000000",
    outlineColor,
    backgroundColor,
    bold,
    italic,
    underline,
    0,
    100,
    100,
    0,
    0,
    borderStyle,
    outline,
    shadow,
    5,
    0,
    0,
    0,
    1,
  ].join(",");
}

function subtitleLayer(subtitle: Subtitle) {
  const match = /^subtitle-(\d+)$/.exec(getSubtitleTrackId(subtitle));
  return match ? Math.max(0, Number(match[1]) - 1) : 0;
}

function createDialogue(
  index: number,
  subtitle: Subtitle,
  playResWidth: number,
  playResHeight: number,
  sourceViewport: AssSourceViewport,
): string {
  const start = formatAssTime(subtitle.startTime);
  const end = formatAssTime(subtitle.endTime);

  // Use the shared canonical-canvas-to-export-viewport mapping. Values beyond
  // the viewport intentionally remain unclamped for libass to crop.
  const { x, y } = canvasPercentToOutputPoint(
    subtitle.positionX ?? 50,
    subtitle.positionY ?? 80,
    sourceViewport,
    playResWidth,
    playResHeight,
  );

  const alignment = getAlignment(subtitle.textAlign);
  const text = escapeAssText(subtitle.text);

  const override = `{\\an${alignment}\\pos(${x.toFixed(2)},${y.toFixed(2)})}`;

  return `Dialogue: ${subtitleLayer(subtitle)},${start},${end},Subtitle${index},,0,0,0,,${override}${text}`;
}

export function buildAssTrack(
  subtitles: Subtitle[],
  options: AssTrackOptions = {},
): string {
  const playResWidth = Math.max(
    2,
    Math.round(options.playResWidth ?? ASS_WIDTH),
  );
  const playResHeight = Math.max(
    2,
    Math.round(options.playResHeight ?? ASS_HEIGHT),
  );

  const sourceViewport = options.sourceViewport ?? {
    left: 0,
    top: 0,
    width: ASS_WIDTH,
    height: ASS_HEIGHT,
  };
  const safeSourceViewport: AssSourceViewport = {
    left: Number.isFinite(sourceViewport.left) ? sourceViewport.left : 0,
    top: Number.isFinite(sourceViewport.top) ? sourceViewport.top : 0,
    width: Math.max(
      1,
      Number.isFinite(sourceViewport.width) ? sourceViewport.width : ASS_WIDTH,
    ),
    height: Math.max(
      1,
      Number.isFinite(sourceViewport.height)
        ? sourceViewport.height
        : ASS_HEIGHT,
    ),
  };

  // Subtitle styles are authored in canonical Program-space units. Scale by
  // the crop viewport -> output transform, not merely by output resolution.
  // This keeps typography visually identical to what is inside the guide box.
  const designScale = playResHeight / safeSourceViewport.height;

  const sorted = [...subtitles].sort(
    (a, b) => a.startTime - b.startTime || subtitleLayer(a) - subtitleLayer(b),
  );

  const styles = sorted
    .map((subtitle, index) => createStyle(index, subtitle, designScale))
    .join("\n");

  const events = sorted
    .map((subtitle, index) =>
      createDialogue(
        index,
        subtitle,
        playResWidth,
        playResHeight,
        safeSourceViewport,
      ),
    )
    .join("\n");

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResWidth}
PlayResY: ${playResHeight}
LayoutResX: ${playResWidth}
LayoutResY: ${playResHeight}
ScaledBorderAndShadow: yes
WrapStyle: 0
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
${styles}

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
${events}
`;
}
