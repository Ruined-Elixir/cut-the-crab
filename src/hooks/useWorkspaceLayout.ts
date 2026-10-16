import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import {
  LAYOUT_STORAGE_KEY,
  SPLITTER_IDS,
  clampSplit,
  currentSize,
  parseGridTrackSizes,
  parseStoredLayout,
  sizeExpression,
  sizeFromDrag,
  splitterBounds,
  type LayoutMeasure,
  type SplitterId,
  type StoredLayout,
} from "../utils/workspaceLayout";

/*
 * Resizable workspace: Media Browser | Program | Subtitle panel, and the
 * Timeline underneath.
 *
 * While dragging, sizes are written straight to CSS custom properties on the
 * app root (no React re-render per pointer move) and throttled to one update
 * per animation frame. The size is saved when the drag ends.
 *
 *   --ws-media     width of the Media Browser
 *   --ws-subtitle  width of the Subtitle panel
 *   --ws-timeline  height of the Timeline
 *
 * The values are CSS math expressions (see sizeExpression), so the browser
 * keeps them inside the allowed range while the window is being resized.
 * When a variable is not set the stylesheet defaults apply. Double-click a
 * splitter to reset it.
 */

const CSS_VARS: Record<SplitterId, string> = {
  media: "--ws-media",
  subtitle: "--ws-subtitle",
  timeline: "--ws-timeline",
};

const LABELS: Record<SplitterId, string> = {
  media: "Resize media browser",
  subtitle: "Resize subtitle panel",
  timeline: "Resize timeline",
};

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;
/** Room for the timeline's horizontal scrollbar below the last track. */
const TIMELINE_CONTENT_SLACK = 16;

function readStoredLayout(): StoredLayout {
  try {
    return parseStoredLayout(window.localStorage.getItem(LAYOUT_STORAGE_KEY));
  } catch {
    return {};
  }
}

function measure(root: HTMLElement | null): LayoutMeasure | null {
  if (!root) return null;
  const workspace = root.querySelector<HTMLElement>(".workspace");
  if (!workspace) return null;
  const timeline = root.querySelector<HTMLElement>(".timeline-panel");
  const body = root.querySelector<HTMLElement>(".timeline-body");
  const stack = root.querySelector<HTMLElement>(".timeline-track-stack");

  // Resolved grid tracks: media, splitter, program, splitter, subtitle.
  const tracks = parseGridTrackSizes(getComputedStyle(workspace).gridTemplateColumns);
  const rect = workspace.getBoundingClientRect();

  // The height at which every track row is visible and nothing is left empty.
  let timelineContentMax: number | undefined;
  if (timeline && body && stack) {
    const chrome = timeline.getBoundingClientRect().height - body.clientHeight;
    const contentBottom =
      stack.getBoundingClientRect().bottom -
      body.getBoundingClientRect().top +
      body.scrollTop;
    timelineContentMax = Math.ceil(chrome + contentBottom + TIMELINE_CONTENT_SLACK);
  }

  return {
    workspaceWidth: rect.width,
    mediaWidth: tracks[0] ?? 0,
    subtitleWidth: tracks[4] ?? 0,
    workspaceHeight: rect.height,
    timelineHeight: timeline?.getBoundingClientRect().height ?? 0,
    timelineContentMax,
  };
}

function applySize(
  root: HTMLElement,
  id: SplitterId,
  value: number | null,
  timelineContentMax?: number,
) {
  if (value === null) root.style.removeProperty(CSS_VARS[id]);
  else root.style.setProperty(CSS_VARS[id], sizeExpression(id, value, timelineContentMax));
}

type DragState = {
  id: SplitterId;
  pointerId: number;
  startX: number;
  startY: number;
  startSize: number;
  measure: LayoutMeasure;
  pending: number | null;
  frame: number | null;
};

export function useWorkspaceLayout(
  rootRef: RefObject<HTMLElement | null>,
  options: {
    active: boolean;
    locked: boolean;
    /** Changes whenever the number of timeline rows changes. */
    contentKey?: number;
  },
) {
  // The size the user asked for. The applied size may be smaller when the
  // window is small, and grows back when the window does.
  const desiredRef = useRef<StoredLayout>(readStoredLayout());
  const dragRef = useRef<DragState | null>(null);
  const lockedRef = useRef(options.locked);
  lockedRef.current = options.locked;
  const [dragging, setDragging] = useState<SplitterId | null>(null);

  const persist = () => {
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(desiredRef.current));
    } catch {
      // Storage can be unavailable; the layout is simply not remembered.
    }
  };

  const applyAll = () => {
    const root = rootRef.current;
    if (!root) return;
    const live = measure(root);
    for (const id of SPLITTER_IDS) {
      const desired = desiredRef.current[id];
      if (desired === undefined) {
        applySize(root, id, null);
        continue;
      }
      applySize(
        root,
        id,
        live ? clampSplit(id, desired, live) : desired,
        live?.timelineContentMax,
      );
    }
  };

  // Apply saved sizes when the editor appears, and keep them valid on resize.
  useLayoutEffect(() => {
    if (!options.active) return;
    const root = rootRef.current;
    if (!root) return;

    applyAll();
    const observer = new ResizeObserver(() => {
      if (!dragRef.current) applyAll();
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [options.active]);

  // Tracks added or removed: the timeline may now be taller than its content.
  useLayoutEffect(() => {
    if (!options.active) return;
    const frame = window.requestAnimationFrame(() => {
      if (!dragRef.current) applyAll();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [options.active, options.contentKey]);

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;

    if (drag.frame !== null) window.cancelAnimationFrame(drag.frame);
    const root = rootRef.current;
    if (drag.pending !== null) {
      if (root) applySize(root, drag.id, drag.pending, drag.measure.timelineContentMax);
      desiredRef.current = { ...desiredRef.current, [drag.id]: Math.round(drag.pending) };
      persist();
    }

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Capture may already be released.
    }
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    setDragging(null);
  };

  const splitterProps = (id: SplitterId) => ({
    role: "separator" as const,
    "aria-orientation": (id === "timeline" ? "horizontal" : "vertical") as
      | "horizontal"
      | "vertical",
    "aria-label": LABELS[id],
    tabIndex: 0,

    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (lockedRef.current || event.button !== 0) return;
      const root = rootRef.current;
      const live = measure(root);
      if (!root || !live) return;

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startSize: currentSize(id, live),
        measure: live,
        pending: null,
        frame: null,
      };
      document.body.style.userSelect = "none";
      document.body.style.cursor = id === "timeline" ? "row-resize" : "col-resize";
      setDragging(id);
    },

    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      drag.pending = clampSplit(
        drag.id,
        sizeFromDrag(
          drag.id,
          drag.startSize,
          event.clientX - drag.startX,
          event.clientY - drag.startY,
        ),
        drag.measure,
      );

      if (drag.frame === null) {
        drag.frame = window.requestAnimationFrame(() => {
          drag.frame = null;
          const root = rootRef.current;
          if (root && drag.pending !== null) {
            applySize(root, drag.id, drag.pending, drag.measure.timelineContentMax);
          }
        });
      }
    },

    onPointerUp: endDrag,
    onPointerCancel: endDrag,

    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (lockedRef.current) return;
      const root = rootRef.current;
      const live = measure(root);
      if (!root || !live) return;

      const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
      const grow = id === "media" ? "ArrowRight" : id === "subtitle" ? "ArrowLeft" : "ArrowUp";
      const shrink = id === "media" ? "ArrowLeft" : id === "subtitle" ? "ArrowRight" : "ArrowDown";
      const bounds = splitterBounds(id, live);
      const size = currentSize(id, live);

      let next: number | null = null;
      if (event.key === grow) next = size + step;
      else if (event.key === shrink) next = size - step;
      else if (event.key === "Home") next = bounds.min;
      else if (event.key === "End") next = bounds.max;
      if (next === null) return;

      event.preventDefault();
      const clamped = clampSplit(id, next, live);
      applySize(root, id, clamped, live.timelineContentMax);
      desiredRef.current = { ...desiredRef.current, [id]: clamped };
      persist();
    },

    onDoubleClick: () => {
      if (lockedRef.current) return;
      const root = rootRef.current;
      if (!root) return;
      const next = { ...desiredRef.current };
      delete next[id];
      desiredRef.current = next;
      applySize(root, id, null);
      persist();
    },
  });

  return { dragging, splitterProps };
}
