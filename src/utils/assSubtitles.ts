import { getSubtitleTrackId, type Subtitle } from "../types/subtitle";
import {
  BACKGROUND_WRAP_SAFETY,
  SUBTITLE_BACKGROUND_PADDING,
  backgroundAnchorOffset,
  clampBackgroundRadius,
  roundedBoxSize,
  roundedRectPath,
  type LineMeasurer,
} from "./subtitleBackground";
import { computeSubtitleBox, type SubtitleBoxGeometry } from "./subtitleBox";
import {
  SUBTITLE_CANVAS_HEIGHT,
  SUBTITLE_CANVAS_WIDTH,
  canvasPercentToOutputPoint,
} from "./subtitleCanvas";
import {
  getSubtitleLineRatio,
  isSubtitleFontReady,
  measureSubtitleLine,
} from "./subtitleTextMetrics";

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

export type AssSourceViewport = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** What the rounded-background and box planners need from the browser. */
export type AssBackgroundMetrics = {
  isReady: () => boolean;
  lineRatio: () => number;
  measureLine: LineMeasurer;
};

const BROWSER_BACKGROUND_METRICS: AssBackgroundMetrics = {
  isReady: isSubtitleFontReady,
  lineRatio: getSubtitleLineRatio,
  measureLine: measureSubtitleLine,
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
  /**
   * Draw rounded backgrounds, sized boxes and rotation as vector shapes where
   * possible. Defaults to true. When false (or when the font cannot be
   * measured) the plain layout is used instead.
   */
  roundedBackgrounds?: boolean;
  /** Test hook. Defaults to the browser font metrics. */
  backgroundMetrics?: AssBackgroundMetrics;
};

type RoundedBackgroundPlan = {
  /** Box size in design units (the units of subtitle.fontSize). */
  width: number;
  height: number;
  radius: number;
};

type RenderPlan =
  | { kind: "plain" }
  | { kind: "rounded"; box: RoundedBackgroundPlan }
  | { kind: "boxed"; geometry: SubtitleBoxGeometry; radius: number };

function hasSubtitleBackground(subtitle: Subtitle): boolean {
  return !!subtitle.backgroundColor && subtitle.backgroundColor !== "transparent";
}

/*
 * A rounded background is only planned when it can match the square box:
 * the subtitle has a background and a radius, the font could be measured, and
 * the box is narrower than the frame (otherwise libass would wrap the text and
 * the line count would no longer match).
 */
function planRoundedBackground(
  subtitle: Subtitle,
  frameWidthDesign: number,
  metrics: AssBackgroundMetrics,
): RoundedBackgroundPlan | null {
  const radius = clampBackgroundRadius(subtitle.backgroundRadius);
  if (!hasSubtitleBackground(subtitle) || radius <= 0) return null;
  if (!metrics.isReady()) return null;

  const lineRatio = metrics.lineRatio();
  if (!Number.isFinite(lineRatio) || lineRatio <= 0) return null;

  const size = roundedBoxSize({
    text: subtitle.text,
    fontSize: subtitle.fontSize ?? 24,
    italic: !!subtitle.isItalic,
    lineRatio,
    measureLine: metrics.measureLine,
  });

  if (size.width > frameWidthDesign * BACKGROUND_WRAP_SAFETY) return null;

  return { width: size.width, height: size.height, radius };
}

/*
 * A subtitle with a box width or a rotation is laid out by the app, not by
 * libass: lines are wrapped to the box, and the text and its background are
 * rotated together around the box centre.
 */
function planSubtitle(
  subtitle: Subtitle,
  frameWidthDesign: number,
  metrics: AssBackgroundMetrics,
  roundedAllowed: boolean,
): RenderPlan {
  const wantsBox = (subtitle.boxWidth ?? 0) > 0 || (subtitle.rotation ?? 0) !== 0;

  if (wantsBox && roundedAllowed && metrics.isReady()) {
    const lineRatio = metrics.lineRatio();
    if (Number.isFinite(lineRatio) && lineRatio > 0) {
      const geometry = computeSubtitleBox({
        text: subtitle.text,
        fontSize: subtitle.fontSize ?? 24,
        italic: !!subtitle.isItalic,
        textAlign: subtitle.textAlign ?? "center",
        positionX: subtitle.positionX ?? 50,
        positionY: subtitle.positionY ?? 80,
        boxWidth: subtitle.boxWidth,
        rotation: subtitle.rotation,
        lineRatio,
        measureLine: metrics.measureLine,
      });
      return {
        kind: "boxed",
        geometry,
        radius: clampBackgroundRadius(subtitle.backgroundRadius),
      };
    }
  }

  const rounded = roundedAllowed
    ? planRoundedBackground(subtitle, frameWidthDesign, metrics)
    : null;
  return rounded ? { kind: "rounded", box: rounded } : { kind: "plain" };
}

/** True when the background is a separate vector shape behind the text. */
function drawsOwnBackground(subtitle: Subtitle, plan: RenderPlan): boolean {
  if (plan.kind === "rounded") return true;
  return plan.kind === "boxed" && hasSubtitleBackground(subtitle);
}

function createStyle(
  index: number,
  subtitle: Subtitle,
  designScale: number,
  separateBackground: boolean,
): string {
  const fontFamily = sanitizeStyleValue(
    resolveAssFontFamily(subtitle.fontFamily),
  );

  const fontSize = (subtitle.fontSize ?? 24) * designScale;
  const textColor = hexToAssColor(subtitle.color ?? "#ffffff");

  const hasBackground = hasSubtitleBackground(subtitle);

  const backgroundColor = hasBackground
    ? hexToAssColor(subtitle.backgroundColor!)
    : "&HFF000000";

  const bold = subtitle.isBold ? -1 : 0;
  const italic = subtitle.isItalic ? -1 : 0;
  const underline = subtitle.isUnderlined ? -1 : 0;

  /*
   * Square background: BorderStyle=3 uses OutlineColour as the opaque box
   * colour and Outline as the box padding.
   * Separate background (rounded or sized box): the box is its own vector
   * shape, so the text uses BorderStyle=1 with no outline.
   */
  const borderStyle = separateBackground ? 1 : hasBackground ? 3 : 1;
  const outline = separateBackground
    ? 0
    : (hasBackground ? SUBTITLE_BACKGROUND_PADDING : 2) * designScale;
  const shadow = 0;
  const outlineColor =
    !separateBackground && hasBackground ? backgroundColor : "&H00000000";

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

/** Style used only to colour the drawn background box. */
function createBackgroundStyle(index: number, subtitle: Subtitle): string {
  const fontFamily = sanitizeStyleValue(
    resolveAssFontFamily(subtitle.fontFamily),
  );
  const backgroundColor = hexToAssColor(subtitle.backgroundColor!);

  return [
    `Style: Background${index}`,
    fontFamily,
    "24",
    backgroundColor,
    "&H00000000",
    "&H00000000",
    backgroundColor,
    0,
    0,
    0,
    0,
    100,
    100,
    0,
    0,
    1,
    0,
    0,
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

function createDialogues(
  index: number,
  subtitle: Subtitle,
  playResWidth: number,
  playResHeight: number,
  sourceViewport: AssSourceViewport,
  designScale: number,
  plan: RenderPlan,
): string[] {
  const start = formatAssTime(subtitle.startTime);
  const end = formatAssTime(subtitle.endTime);
  const alignment = getAlignment(subtitle.textAlign);
  const layer = subtitleLayer(subtitle);

  // Each track keeps two layers: the background below, the text above.
  const backgroundLayer = layer * 2;
  const textLayer = layer * 2 + 1;
  const lines: string[] = [];

  if (plan.kind === "boxed") {
    const g = plan.geometry;
    const toOutput = (canvasX: number, canvasY: number) =>
      canvasPercentToOutputPoint(
        (canvasX / ASS_WIDTH) * 100,
        (canvasY / ASS_HEIGHT) * 100,
        sourceViewport,
        playResWidth,
        playResHeight,
      );

    const center = toOutput(g.centerX, g.centerY);
    const anchor = toOutput(g.textAnchorX, g.centerY);
    // Positive rotation is clockwise in the editor, counter-clockwise in ASS.
    const rotate =
      g.rotation !== 0
        ? `\\org(${center.x.toFixed(2)},${center.y.toFixed(2)})\\frz${(-g.rotation).toFixed(2)}`
        : "";

    if (hasSubtitleBackground(subtitle)) {
      const path = roundedRectPath(
        g.width * designScale,
        g.height * designScale,
        plan.radius * designScale,
      );
      lines.push(
        `Dialogue: ${backgroundLayer},${start},${end},Background${index},,0,0,0,,{\\an5\\pos(${center.x.toFixed(2)},${center.y.toFixed(2)})${rotate}\\p1}${path}{\\p0}`,
      );
    }

    // \q2: no automatic wrapping. The lines were wrapped to the box already.
    const text = g.lines.map(escapeAssText).join("\\N");
    lines.push(
      `Dialogue: ${textLayer},${start},${end},Subtitle${index},,0,0,0,,{\\an${alignment}\\q2\\pos(${anchor.x.toFixed(2)},${anchor.y.toFixed(2)})${rotate}}${text}`,
    );
    return lines;
  }

  // Map the authored canonical Program-space point through the same centered
  // crop used for video export. Values are intentionally allowed outside the
  // output frame so libass naturally clips subtitles that sit beyond a chosen
  // aspect viewport, exactly like the dashed Program Monitor box.
  const { x, y } = canvasPercentToOutputPoint(
    subtitle.positionX ?? 50,
    subtitle.positionY ?? 80,
    sourceViewport,
    playResWidth,
    playResHeight,
  );

  const text = escapeAssText(subtitle.text);
  const override = `{\\an${alignment}\\pos(${x.toFixed(2)},${y.toFixed(2)})}`;

  if (plan.kind === "rounded") {
    const offset =
      backgroundAnchorOffset(subtitle.textAlign, SUBTITLE_BACKGROUND_PADDING) *
      designScale;
    const path = roundedRectPath(
      plan.box.width * designScale,
      plan.box.height * designScale,
      plan.box.radius * designScale,
    );
    lines.push(
      `Dialogue: ${backgroundLayer},${start},${end},Background${index},,0,0,0,,{\\an${alignment}\\pos(${(x + offset).toFixed(2)},${y.toFixed(2)})\\p1}${path}{\\p0}`,
    );
  }

  lines.push(
    `Dialogue: ${textLayer},${start},${end},Subtitle${index},,0,0,0,,${override}${text}`,
  );

  return lines;
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

  const roundedAllowed = options.roundedBackgrounds !== false;
  const metrics = options.backgroundMetrics ?? BROWSER_BACKGROUND_METRICS;
  const plans = sorted.map((subtitle) =>
    planSubtitle(subtitle, safeSourceViewport.width, metrics, roundedAllowed),
  );

  const styles = sorted
    .flatMap((subtitle, index) => {
      const separate = drawsOwnBackground(subtitle, plans[index]);
      const lines = [createStyle(index, subtitle, designScale, separate)];
      if (separate) lines.push(createBackgroundStyle(index, subtitle));
      return lines;
    })
    .join("\n");

  const events = sorted
    .flatMap((subtitle, index) =>
      createDialogues(
        index,
        subtitle,
        playResWidth,
        playResHeight,
        safeSourceViewport,
        designScale,
        plans[index],
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
