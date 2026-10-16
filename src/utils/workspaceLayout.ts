/*
 * Pure math for the resizable workspace (no DOM, no React).
 *
 * Three draggable splitters:
 *  - "media":    between the Media Browser and the Program Monitor (width)
 *  - "subtitle": between the Program Monitor and the Subtitle panel (width)
 *  - "timeline": between the top workspace and the Timeline (height)
 * The Program Monitor takes whatever width is left.
 *
 * Applied sizes are written to CSS as math expressions (see sizeExpression), so
 * the browser keeps them valid while the window is being resized, without
 * waiting for any JavaScript.
 */

export type SplitterId = "media" | "subtitle" | "timeline";

export const SPLITTER_IDS: SplitterId[] = ["media", "subtitle", "timeline"];

export const LAYOUT_STORAGE_KEY = "ctc.workspaceLayout.v1";

/** Height of the top bar (see .topbar in App.css). */
export const TOPBAR_HEIGHT = 52;

export const LAYOUT_LIMITS = {
  mediaMin: 160,
  mediaMax: 420,
  subtitleMin: 280,
  subtitleMax: 720,
  /** The Program Monitor never gets narrower than this. */
  programMin: 420,
  timelineMin: 170,
  /** The top workspace (media, program, subtitles) never gets shorter than this. */
  workspaceMin: 300,
} as const;

/**
 * Share of the width left over after the Program Monitor's minimum that each
 * side panel may use. The two shares add up to 1, so both panels at their
 * caps still leave the Program Monitor its minimum width.
 */
export const SIDE_SHARE = { media: 0.3, subtitle: 0.7 } as const;

export type StoredLayout = Partial<Record<SplitterId, number>>;

/** Sizes in CSS pixels, measured from the live layout. */
export type LayoutMeasure = {
  workspaceWidth: number;
  mediaWidth: number;
  subtitleWidth: number;
  workspaceHeight: number;
  timelineHeight: number;
  /** Height the Timeline needs to show every track row (no empty space below). */
  timelineContentMax?: number;
};

export function currentSize(id: SplitterId, measure: LayoutMeasure): number {
  if (id === "media") return measure.mediaWidth;
  if (id === "subtitle") return measure.subtitleWidth;
  return measure.timelineHeight;
}

export function splitterBounds(
  id: SplitterId,
  measure: LayoutMeasure,
): { min: number; max: number } {
  const L = LAYOUT_LIMITS;
  const sideRoom = measure.workspaceWidth - L.programMin;

  if (id === "media") {
    const room = sideRoom - measure.subtitleWidth;
    const share = sideRoom * SIDE_SHARE.media;
    return {
      min: L.mediaMin,
      max: Math.max(L.mediaMin, Math.min(L.mediaMax, room, share)),
    };
  }

  if (id === "subtitle") {
    const room = sideRoom - measure.mediaWidth;
    const share = sideRoom * SIDE_SHARE.subtitle;
    return {
      min: L.subtitleMin,
      max: Math.max(L.subtitleMin, Math.min(L.subtitleMax, room, share)),
    };
  }

  const total = measure.workspaceHeight + measure.timelineHeight;
  let max = Math.max(L.timelineMin, total - L.workspaceMin);
  const content = measure.timelineContentMax;
  if (content !== undefined && content > 0) {
    max = Math.max(L.timelineMin, Math.min(max, content));
  }
  return { min: L.timelineMin, max };
}

/** Clamp to the limits. An unmeasured layout (zero size) is left unclamped. */
export function clampSplit(id: SplitterId, value: number, measure: LayoutMeasure): number {
  const unmeasured =
    id === "timeline"
      ? measure.workspaceHeight <= 0
      : measure.workspaceWidth <= 0;
  if (unmeasured || !Number.isFinite(value)) return value;

  const { min, max } = splitterBounds(id, measure);
  return Math.round(Math.max(min, Math.min(max, value)));
}

/**
 * New size while dragging. Dragging right grows the media panel, dragging left
 * grows the subtitle panel, dragging up grows the timeline.
 */
export function sizeFromDrag(
  id: SplitterId,
  startSize: number,
  deltaX: number,
  deltaY: number,
): number {
  if (id === "media") return startSize + deltaX;
  if (id === "subtitle") return startSize - deltaX;
  return startSize - deltaY;
}

/**
 * The CSS value written to --ws-media, --ws-subtitle and --ws-timeline. It is a
 * math expression, so the browser re-evaluates it on every window resize.
 */
export function sizeExpression(
  id: SplitterId,
  value: number,
  timelineContentMax?: number,
): string {
  const L = LAYOUT_LIMITS;
  const px = (n: number) => `${Math.round(n)}px`;

  if (id === "media") {
    return `max(${px(L.mediaMin)}, min(${px(value)}, ${px(L.mediaMax)}, calc((100vw - ${px(L.programMin)}) * ${SIDE_SHARE.media})))`;
  }

  if (id === "subtitle") {
    return `max(${px(L.subtitleMin)}, min(${px(value)}, ${px(L.subtitleMax)}, calc((100vw - ${px(L.programMin)}) * ${SIDE_SHARE.subtitle})))`;
  }

  const content =
    timelineContentMax !== undefined && timelineContentMax > 0
      ? `${px(timelineContentMax)}, `
      : "";
  return `max(${px(L.timelineMin)}, min(${px(value)}, ${content}calc(100vh - ${px(TOPBAR_HEIGHT + L.workspaceMin)})))`;
}

/** "218px 0px 903.5px 0px 490px" -> [218, 0, 903.5, 0, 490] */
export function parseGridTrackSizes(template: string): number[] {
  return template
    .trim()
    .split(/\s+/)
    .map((token) => Number.parseFloat(token))
    .filter((value) => Number.isFinite(value));
}

export function parseStoredLayout(text: string | null): StoredLayout {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return {};
    const raw = parsed as Record<string, unknown>;
    const result: StoredLayout = {};
    for (const id of SPLITTER_IDS) {
      const value = raw[id];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        result[id] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}
