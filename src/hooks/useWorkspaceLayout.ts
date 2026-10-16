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
 * When a variable is not set the stylesheet defaults apply, so nothing changes
 * until the user drags a splitter. Double-click a splitter to reset it.
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

  // Resolved grid tracks: media, splitter, program, splitter, subtitle.
  const tracks = parseGridTrackSizes(getComputedStyle(workspace).gridTemplateColumns);
  const rect = workspace.getBoundingClientRect();

  return {
    workspaceWidth: rect.width,
    mediaWidth: tracks[0] ?? 0,
    subtitleWidth: tracks[4] ?? 0,
    workspaceHeight: rect.height,
    timelineHeight: timeline?.getBoundingClientRect().height ?? 0,
  };
}

function applySize(root: HTMLElement, id: SplitterId, value: number | null) {
  if (value === null) root.style.removeProperty(CSS_VARS[id]);
  else root.style.setProperty(CSS_VARS[id], `${Math.round(value)}px`);
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
  options: { active: boolean; locked: boolean },
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
    for (const id of SPLITTER_IDS) {
      const desired = desiredRef.current[id];
      if (desired === undefined) {
        applySize(root, id, null);
        continue;
      }
      const live = measure(root);
      applySize(root, id, live ? clampSplit(id, desired, live) : desired);
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

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;

    if (drag.frame !== null) window.cancelAnimationFrame(drag.frame);
    const root = rootRef.current;
    if (drag.pending !== null) {
      if (root) applySize(root, drag.id, drag.pending);
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
          if (root && drag.pending !== null) applySize(root, drag.id, drag.pending);
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
      applySize(root, id, clamped);
      desiredRef.current = { ...desiredRef.current, [id]: clamped };
      persist();
    },

    onDoubleClick: () => {
      if (lockedRef.current) return;
      const root = rootRef.current;
      if (!root) return;
      const rest = { ...desiredRef.current };
      delete rest[id];
      desiredRef.current = rest;
      applySize(root, id, null);
      persist();
    },
  });

  return { dragging, splitterProps };
}
