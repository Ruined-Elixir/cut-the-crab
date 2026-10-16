/*
 * Subtitle box geometry (pure, no DOM, no React).
 *
 * A subtitle has two layouts:
 *  - Auto (no boxWidth): the box hugs the text. positionX/Y is the text anchor
 *    (the centre for centre-aligned text, the left edge for left-aligned text,
 *    the right edge for right-aligned text), as before.
 *  - Boxed (boxWidth set): the user sized the box. positionX/Y is the centre of
 *    the box, text is wrapped to the box width, and `alignment` places the text
 *    inside it. Rotation turns the whole box around its centre.
 *
 * All values are in canvas design units (the 1920 x 1080 subtitle canvas),
 * except positionX/Y inputs, which are percentages of the canvas.
 */

import {
  BACKGROUND_WIDTH_ALLOWANCE,
  SUBTITLE_BACKGROUND_PADDING,
  drawnLineText,
  roundedBoxSize,
  subtitleDisplayLines,
  type LineMeasurer,
} from "./subtitleBackground";
import { SUBTITLE_CANVAS_HEIGHT, SUBTITLE_CANVAS_WIDTH } from "./subtitleCanvas";

export const MIN_BOX_WIDTH = 64;

export type SubtitleAlignment = "left" | "center" | "right";

export type SubtitleBoxGeometry = {
  /** True when the user set a box width. */
  boxed: boolean;
  centerX: number;
  centerY: number;
  /** Outer width, including padding. */
  width: number;
  /** Outer height, including padding. */
  height: number;
  /** Display lines (already wrapped for a boxed subtitle). */
  lines: string[];
  /** Degrees, clockwise, in [-180, 180). */
  rotation: number;
  /** X of the text anchor before rotation (the \an4/5/6 anchor). */
  textAnchorX: number;
  alignment: SubtitleAlignment;
};

export type SubtitleBoxPatch = {
  boxWidth?: number;
  positionX?: number;
  positionY?: number;
  rotation?: number;
  /** Set by a corner drag, which scales the text with the box. */
  fontSize?: number;
};

export type SubtitleBoxInput = {
  text: string;
  fontSize: number;
  italic: boolean;
  textAlign: SubtitleAlignment;
  /** Percent of the canvas. */
  positionX: number;
  positionY: number;
  boxWidth?: number;
  rotation?: number;
  lineRatio: number;
  measureLine: LineMeasurer;
};

export function normalizeRotation(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

export function clampBoxWidth(value: number): number {
  return Math.max(MIN_BOX_WIDTH, Math.min(SUBTITLE_CANVAS_WIDTH, value));
}

const CJK = "\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFFEF";
const TOKEN = new RegExp(`\\s+|[${CJK}]|[^\\s${CJK}]+`, "g");
// A line must not start with these closing marks.
const NO_LINE_START = new Set(
  Array.from("，。、！？；：）」』】》,.!?;:)]}%"),
);

/**
 * Greedy line wrapping. Latin text breaks at spaces, CJK text between any two
 * characters, and a single word wider than the box breaks by character.
 */
export function wrapTextToWidth(
  text: string,
  maxWidth: number,
  measure: (line: string) => number,
): string[] {
  const result: string[] = [];

  for (const paragraph of subtitleDisplayLines(text)) {
    const tokens = paragraph.match(TOKEN) ?? [];
    let line = "";

    const flush = () => {
      result.push(line.trimEnd());
      line = "";
    };

    for (let token of tokens) {
      if (measure((line + token).trimEnd()) <= maxWidth) {
        line += token;
        continue;
      }

      if (NO_LINE_START.has(token) && line !== "") {
        // Keep closing punctuation on the previous line.
        line += token;
        continue;
      }

      if (line.trim() !== "") {
        flush();
        token = token.trimStart();
        if (token === "") continue;
      }

      if (measure(token) <= maxWidth) {
        line = token;
        continue;
      }

      // One word wider than the box: break it by character.
      for (const character of Array.from(token)) {
        if (line === "" || measure(line + character) <= maxWidth) {
          line += character;
        } else {
          flush();
          line = character;
        }
      }
    }

    result.push(line.trimEnd());
  }

  return result.length > 0 ? result : [""];
}

export function computeSubtitleBox(input: SubtitleBoxInput): SubtitleBoxGeometry {
  const pad = SUBTITLE_BACKGROUND_PADDING;
  const posX = (input.positionX / 100) * SUBTITLE_CANVAS_WIDTH;
  const posY = (input.positionY / 100) * SUBTITLE_CANVAS_HEIGHT;
  const alignment = input.textAlign;
  const rotation = normalizeRotation(input.rotation ?? 0);
  const emPx = input.fontSize / input.lineRatio;

  if (input.boxWidth !== undefined && input.boxWidth > 0) {
    const width = clampBoxWidth(input.boxWidth);
    const textWidth = Math.max(1, width - 2 * pad - BACKGROUND_WIDTH_ALLOWANCE);
    const lines = wrapTextToWidth(input.text, textWidth, (line) =>
      input.measureLine(drawnLineText(line), emPx, input.italic),
    );
    const height = lines.length * input.fontSize + 2 * pad;
    const textAnchorX =
      alignment === "left"
        ? posX - width / 2 + pad
        : alignment === "right"
          ? posX + width / 2 - pad
          : posX;

    return {
      boxed: true,
      centerX: posX,
      centerY: posY,
      width,
      height,
      lines,
      rotation,
      textAnchorX,
      alignment,
    };
  }

  const size = roundedBoxSize({
    text: input.text,
    fontSize: input.fontSize,
    italic: input.italic,
    lineRatio: input.lineRatio,
    measureLine: input.measureLine,
  });
  const centerX =
    alignment === "left"
      ? posX - pad + size.width / 2
      : alignment === "right"
        ? posX + pad - size.width / 2
        : posX;

  return {
    boxed: false,
    centerX,
    centerY: posY,
    width: size.width,
    height: size.height,
    lines: subtitleDisplayLines(input.text),
    rotation,
    textAnchorX: posX,
    alignment,
  };
}

/** The positionX (design units) that gives an auto-sized box this centre. */
export function unboxedAnchorX(
  centerX: number,
  autoWidth: number,
  alignment: SubtitleAlignment,
): number {
  const pad = SUBTITLE_BACKGROUND_PADDING;
  if (alignment === "left") return centerX - autoWidth / 2 + pad;
  if (alignment === "right") return centerX + autoWidth / 2 - pad;
  return centerX;
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;

/** The stored fields for a box with this centre, width and rotation. */
export function boxPatch(box: {
  width: number;
  centerX: number;
  centerY: number;
  rotation: number;
}): SubtitleBoxPatch {
  const rotation = round1(normalizeRotation(box.rotation));
  return {
    boxWidth: Math.round(clampBoxWidth(box.width)),
    positionX: round2((box.centerX / SUBTITLE_CANVAS_WIDTH) * 100),
    positionY: round2((box.centerY / SUBTITLE_CANVAS_HEIGHT) * 100),
    rotation: rotation === 0 ? undefined : rotation,
  };
}

/** The stored fields for a rotation only (position and box width stay as they are). */
export function rotationPatch(rotation: number): SubtitleBoxPatch {
  const value = round1(normalizeRotation(rotation));
  return { rotation: value === 0 ? undefined : value };
}

/**
 * Snap to multiples of `stepDegrees` when within `thresholdDegrees`, so a
 * subtitle is easy to put back to level. Use a huge threshold for a hard snap.
 */
export function snapRotation(
  value: number,
  stepDegrees = 15,
  thresholdDegrees = 3,
): number {
  const normalized = normalizeRotation(value);
  const snapped = Math.round(normalized / stepDegrees) * stepDegrees;
  return Math.abs(normalized - snapped) < thresholdDegrees
    ? normalizeRotation(snapped)
    : normalized;
}

/**
 * Drag one side handle. The opposite edge stays where it is, so the centre
 * moves by half the width change along the box's own (rotated) axis.
 * `pointerDeltaX/Y` are screen movements in canvas design units.
 */
export function resizeBoxFromEdge(
  start: { width: number; centerX: number; centerY: number; rotation: number },
  side: "left" | "right",
  pointerDeltaX: number,
  pointerDeltaY: number,
): { width: number; centerX: number; centerY: number } {
  const radians = (start.rotation * Math.PI) / 180;
  const ux = Math.cos(radians);
  const uy = Math.sin(radians);
  const along = pointerDeltaX * ux + pointerDeltaY * uy;
  const sign = side === "right" ? 1 : -1;
  const width = clampBoxWidth(start.width + sign * along);
  const change = width - start.width;

  return {
    width,
    centerX: start.centerX + (sign * ux * change) / 2,
    centerY: start.centerY + (sign * uy * change) / 2,
  };
}

/* ------------------------------------------------------------------------ */
/* Corner scaling: dragging a corner scales the text and the box together,   */
/* around the opposite corner, which stays where it is.                      */
/* ------------------------------------------------------------------------ */

/** Keep in step with MIN_FONT_SIZE and MAX_FONT_SIZE in subtitlePresets.ts. */
export const BOX_MIN_FONT_SIZE = 10;
export const BOX_MAX_FONT_SIZE = 96;

export type BoxCorner = { sx: 1 | -1; sy: 1 | -1 };

const PADDING_WIDTH = 2 * SUBTITLE_BACKGROUND_PADDING + BACKGROUND_WIDTH_ALLOWANCE;
const PADDING_HEIGHT = 2 * SUBTITLE_BACKGROUND_PADDING;

/** Apply a box patch to a layout input. A key set to undefined clears the field. */
export function applyBoxPatch(
  input: SubtitleBoxInput,
  patch: SubtitleBoxPatch,
): SubtitleBoxInput {
  const next = { ...input };
  if (patch.fontSize !== undefined) next.fontSize = patch.fontSize;
  if (patch.positionX !== undefined) next.positionX = patch.positionX;
  if (patch.positionY !== undefined) next.positionY = patch.positionY;
  if ("boxWidth" in patch) next.boxWidth = patch.boxWidth;
  if ("rotation" in patch) next.rotation = patch.rotation;
  return next;
}

/**
 * How much the box itself grew or shrank for a corner drag, as a ratio of the
 * start size, measured along the diagonal from the fixed corner to the dragged
 * one. `deltaX/Y` are screen movements in canvas design units.
 */
export function cornerPointerScale(
  start: { width: number; height: number; rotation: number },
  corner: BoxCorner,
  deltaX: number,
  deltaY: number,
): number {
  const radians = (start.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const a = corner.sx * start.width;
  const b = corner.sy * start.height;
  // Fixed corner to dragged corner, in screen axes.
  const vx = a * cos - b * sin;
  const vy = a * sin + b * cos;
  const lengthSquared = vx * vx + vy * vy;
  if (lengthSquared === 0) return 1;
  return 1 + (vx * deltaX + vy * deltaY) / lengthSquared;
}

/**
 * The font size for a box scale. Padding does not scale, so the text part of
 * the box is scaled by a factor chosen to make the outer box match
 * `outerScale`. Sizes move in steps of 0.5 and stay within 10 to 96.
 */
export function scaledFontSize(
  fontSize: number,
  outerScale: number,
  size: { width: number; height: number },
): { fontSize: number; factor: number } {
  const textWidth = Math.max(1, size.width - PADDING_WIDTH);
  const textHeight = Math.max(1, size.height - PADDING_HEIGHT);
  const kWidth = (outerScale * size.width - PADDING_WIDTH) / textWidth;
  const kHeight = (outerScale * size.height - PADDING_HEIGHT) / textHeight;
  const factor = Math.max(0.05, (kWidth + kHeight) / 2);
  const next = Math.max(
    BOX_MIN_FONT_SIZE,
    Math.min(BOX_MAX_FONT_SIZE, Math.round(fontSize * factor * 2) / 2),
  );
  return { fontSize: next, factor: fontSize > 0 ? next / fontSize : 1 };
}

/** A user-sized box width after the text scaled by `factor`. */
export function scaledBoxWidth(width: number, factor: number): number {
  return clampBoxWidth((width - PADDING_WIDTH) * factor + PADDING_WIDTH);
}

/**
 * Where the centre goes so the corner opposite `corner` stays put while the box
 * changes size.
 */
export function cornerAnchoredCenter(
  start: { centerX: number; centerY: number; width: number; height: number; rotation: number },
  corner: BoxCorner,
  next: { width: number; height: number },
): { centerX: number; centerY: number } {
  const radians = (start.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const a = (corner.sx * (next.width - start.width)) / 2;
  const b = (corner.sy * (next.height - start.height)) / 2;
  return {
    centerX: start.centerX + a * cos - b * sin,
    centerY: start.centerY + a * sin + b * cos,
  };
}

/** Canvas position of the corner opposite `corner`, where scaling is anchored. */
export function oppositeCornerPoint(
  start: { centerX: number; centerY: number; width: number; height: number; rotation: number },
  corner: BoxCorner,
): { x: number; y: number } {
  const radians = (start.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const a = (-corner.sx * start.width) / 2;
  const b = (-corner.sy * start.height) / 2;
  return {
    x: start.centerX + a * cos - b * sin,
    y: start.centerY + a * sin + b * cos,
  };
}

/**
 * The resize cursor for a handle whose direction is `localAngleDegrees` in the
 * box's own axes, once the box is rotated by `rotationDegrees`.
 */
export function resizeCursor(localAngleDegrees: number, rotationDegrees: number): string {
  const angle = (((localAngleDegrees + rotationDegrees) % 180) + 180) % 180;
  if (angle < 22.5 || angle >= 157.5) return "ew-resize";
  if (angle < 67.5) return "nwse-resize";
  if (angle < 112.5) return "ns-resize";
  return "nesw-resize";
}
