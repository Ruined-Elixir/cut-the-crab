import type { Subtitle } from "../types/subtitle";

export const ASS_WIDTH = 1920;
export const ASS_HEIGHT = 1080;

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
 * BorderStyle=4 is a libass extension that creates a square background box.
 * Because both preview and export use libass, this is intentionally our
 * canonical background implementation.
 */
function createStyle(index: number, subtitle: Subtitle): string {
  const fontFamily = sanitizeStyleValue(
    resolveAssFontFamily(subtitle.fontFamily),
  );

  const fontSize = subtitle.fontSize ?? 24;
  const textColor = hexToAssColor(subtitle.color ?? "#ffffff");

  const hasBackground =
    !!subtitle.backgroundColor && subtitle.backgroundColor !== "transparent";

  const backgroundColor = hasBackground
    ? hexToAssColor(subtitle.backgroundColor!)
    : "&HFF000000";

  const bold = subtitle.isBold ? -1 : 0;
  const underline = subtitle.isUnderlined ? -1 : 0;

  const borderStyle = hasBackground ? 4 : 1;

  /*
   * With BorderStyle=4:
   * - Outline remains the text outline.
   * - Shadow acts as square-box padding in libass.
   *
   * These are design-space units at PlayResY=1080.
   */
  const outline = 2;
  const boxPadding = hasBackground ? 8 : 0;

  return [
    `Style: Subtitle${index}`,
    fontFamily,
    fontSize.toFixed(2),
    textColor,
    "&H00000000",
    "&H00000000",
    backgroundColor,
    bold,
    0,
    underline,
    0,
    100,
    100,
    0,
    0,
    borderStyle,
    outline,
    boxPadding,
    5,
    0,
    0,
    0,
    1,
  ].join(",");
}

function createDialogue(index: number, subtitle: Subtitle): string {
  const start = formatAssTime(subtitle.startTime);
  const end = formatAssTime(subtitle.endTime);

  const x = ((subtitle.positionX ?? 50) / 100) * ASS_WIDTH;

  const y = ((subtitle.positionY ?? 80) / 100) * ASS_HEIGHT;

  const alignment = getAlignment(subtitle.textAlign);
  const text = escapeAssText(subtitle.text);

  const override = `{\\an${alignment}\\pos(${x.toFixed(2)},${y.toFixed(2)})}`;

  return `Dialogue: 0,${start},${end},Subtitle${index},,0,0,0,,${override}${text}`;
}

export function buildAssTrack(subtitles: Subtitle[]): string {
  const sorted = [...subtitles].sort((a, b) => a.startTime - b.startTime);

  const styles = sorted
    .map((subtitle, index) => createStyle(index, subtitle))
    .join("\n");

  const events = sorted
    .map((subtitle, index) => createDialogue(index, subtitle))
    .join("\n");

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${ASS_WIDTH}
PlayResY: ${ASS_HEIGHT}
LayoutResX: ${ASS_WIDTH}
LayoutResY: ${ASS_HEIGHT}
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
