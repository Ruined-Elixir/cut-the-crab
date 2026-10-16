/*
 * Rounded subtitle background geometry (pure, no DOM, no React).
 *
 * Findings from the Phase 5 lab (libass WASM, same font as the app):
 *  - Box height = lines x font size + 2 x padding (exact).
 *  - Box width = widest line measured at font size / (ascent + descent), in the
 *    REGULAR weight, + 2 x padding + a small allowance. libass fakes bold on the
 *    single Regular font without widening it, so bold is not measured.
 *  - The line text is measured as libass draws it. escapeAssText doubles
 *    backslashes and libass prints both.
 */

export const SUBTITLE_BACKGROUND_PADDING = 8;
export const MAX_BACKGROUND_RADIUS = 40;
export const BACKGROUND_WIDTH_ALLOWANCE = 1.5;
/** A box wider than this share of the frame would make libass wrap the text. */
export const BACKGROUND_WRAP_SAFETY = 0.98;

export type LineMeasurer = (line: string, emPx: number, italic: boolean) => number;

export type RoundedBoxSize = {
  width: number;
  height: number;
  lineCount: number;
};

export function clampBackgroundRadius(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_BACKGROUND_RADIUS, Math.round(value)));
}

export function subtitleDisplayLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** The text libass will actually draw for one line (backslashes doubled). */
export function drawnLineText(line: string): string {
  return line.replace(/\\/g, "\\\\");
}

export function roundedBoxSize(input: {
  text: string;
  fontSize: number;
  italic: boolean;
  /** (ascent + descent) / em size of the font. */
  lineRatio: number;
  measureLine: LineMeasurer;
}): RoundedBoxSize {
  const lines = subtitleDisplayLines(input.text);
  const emPx = input.fontSize / input.lineRatio;

  let widest = 0;
  for (const line of lines) {
    widest = Math.max(widest, input.measureLine(drawnLineText(line), emPx, input.italic));
  }

  return {
    width: widest + 2 * SUBTITLE_BACKGROUND_PADDING + BACKGROUND_WIDTH_ALLOWANCE,
    height: lines.length * input.fontSize + 2 * SUBTITLE_BACKGROUND_PADDING,
    lineCount: lines.length,
  };
}

/**
 * ASS drawing commands (use with \p1) for a rounded rectangle whose top-left
 * corner is the drawing origin. Coordinates are rounded to whole units.
 */
export function roundedRectPath(width: number, height: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const k = 0.5522847498 * r;
  const n = (value: number) => Math.round(value);
  const w = n(width);
  const h = n(height);
  return [
    `m ${n(r)} 0`,
    `l ${n(w - r)} 0`,
    `b ${n(w - r + k)} 0 ${w} ${n(r - k)} ${w} ${n(r)}`,
    `l ${w} ${n(h - r)}`,
    `b ${w} ${n(h - r + k)} ${n(w - r + k)} ${h} ${n(w - r)} ${h}`,
    `l ${n(r)} ${h}`,
    `b ${n(r - k)} ${h} 0 ${n(h - r + k)} 0 ${n(h - r)}`,
    `l 0 ${n(r)}`,
    `b 0 ${n(r - k)} ${n(r - k)} 0 ${n(r)} 0`,
  ].join(" ");
}

/**
 * The text is anchored at the subtitle position (left, centre or right). The
 * box extends one padding beyond the text on the open side, so the drawing is
 * anchored one padding further out for left and right alignment.
 */
export function backgroundAnchorOffset(
  textAlign: "left" | "center" | "right" | undefined,
  padding: number,
): number {
  if (textAlign === "left") return -padding;
  if (textAlign === "right") return padding;
  return 0;
}
