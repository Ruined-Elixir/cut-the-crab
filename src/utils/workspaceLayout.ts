/*
 * Pure math for the resizable workspace (no DOM, no React).
 *
 * Three draggable splitters:
 *  - "media":    between the Media Browser and the Program Monitor (width)
 *  - "subtitle": between the Program Monitor and the Subtitle panel (width)
 *  - "timeline": between the top workspace and the Timeline (height)
 * The Program Monitor takes whatever width is left.
 */

export type SplitterId = "media" | "subtitle" | "timeline";

export const SPLITTER_IDS: SplitterId[] = ["media", "subtitle", "timeline"];

export const LAYOUT_STORAGE_KEY = "ctc.workspaceLayout.v1";

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

export type StoredLayout = Partial<Record<SplitterId, number>>;

/** Sizes in CSS pixels, measured from the live layout. */
export type LayoutMeasure = {
  workspaceWidth: number;
  mediaWidth: number;
  subtitleWidth: number;
  workspaceHeight: number;
  timelineHeight: number;
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

  if (id === "media") {
    const room = measure.workspaceWidth - measure.subtitleWidth - L.programMin;
    return { min: L.mediaMin, max: Math.max(L.mediaMin, Math.min(L.mediaMax, room)) };
  }

  if (id === "subtitle") {
    const room = measure.workspaceWidth - measure.mediaWidth - L.programMin;
    return {
      min: L.subtitleMin,
      max: Math.max(L.subtitleMin, Math.min(L.subtitleMax, room)),
    };
  }

  const total = measure.workspaceHeight + measure.timelineHeight;
  return { min: L.timelineMin, max: Math.max(L.timelineMin, total - L.workspaceMin) };
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
