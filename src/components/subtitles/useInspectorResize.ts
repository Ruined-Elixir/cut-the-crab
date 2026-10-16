import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/*
 * Resizable split between the subtitle list and the inspector.
 *
 * - Drag the divider up to give the inspector more room, down for the list.
 * - Keyboard: Up / Down resize by 16 px, Home = largest, End = smallest.
 * - Double-click resets to the default proportions.
 * - The chosen height is remembered between launches.
 */

const STORAGE_KEY = "ctc.subtitleInspectorHeight.v1";
const MIN_INSPECTOR_HEIGHT = 220; // includes the 32 px "Inspector" header row
const MIN_LIST_HEIGHT = 140;
const KEY_STEP = 16;

function readStoredHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= MIN_INSPECTOR_HEIGHT ? value : null;
  } catch {
    return null;
  }
}

function storeHeight(value: number | null) {
  try {
    if (value === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(Math.round(value)));
  } catch {
    // Storage can be unavailable; the split simply is not remembered.
  }
}

export function useInspectorResize() {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | null>(readStoredHeight);
  const [dragging, setDragging] = useState(false);

  const heightRef = useRef<number | null>(height);
  heightRef.current = height;

  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);

  const maxHeight = () => {
    const panel = panelRef.current;
    if (!panel) return MIN_INSPECTOR_HEIGHT;
    return Math.max(MIN_INSPECTOR_HEIGHT, panel.clientHeight - MIN_LIST_HEIGHT - 1);
  };

  const clamp = (value: number) =>
    Math.round(Math.max(MIN_INSPECTOR_HEIGHT, Math.min(maxHeight(), value)));

  // Keep a remembered height valid when the window or panel gets smaller.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const observer = new ResizeObserver(() => {
      const current = heightRef.current;
      if (current !== null && current > maxHeight()) setHeight(clamp(current));
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  const measuredHeight = (handle: HTMLElement) =>
    heightRef.current ??
    (handle.nextElementSibling as HTMLElement | null)?.getBoundingClientRect().height ??
    MIN_INSPECTOR_HEIGHT;

  const endDrag = (handle: HTMLElement, pointerId: number) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      handle.releasePointerCapture(pointerId);
    } catch {
      // Capture may already be released.
    }
    document.body.style.userSelect = "";
    setDragging(false);
    storeHeight(heightRef.current);
  };

  const handleProps = (expanded: boolean) => {
    if (!expanded) return {};

    return {
      role: "separator" as const,
      "aria-orientation": "horizontal" as const,
      "aria-label": "Resize subtitle inspector",
      "aria-valuemin": MIN_INSPECTOR_HEIGHT,
      "aria-valuemax": panelRef.current ? maxHeight() : undefined,
      "aria-valuenow": height ?? undefined,
      tabIndex: 0,

      onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        dragRef.current = {
          pointerId: event.pointerId,
          startY: event.clientY,
          startHeight: measuredHeight(handle),
        };
        document.body.style.userSelect = "none";
        setDragging(true);
      },

      onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        // Dragging up (smaller clientY) makes the inspector taller.
        setHeight(clamp(drag.startHeight - (event.clientY - drag.startY)));
      },

      onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) =>
        endDrag(event.currentTarget, event.pointerId),
      onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) =>
        endDrag(event.currentTarget, event.pointerId),

      onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
        const base = measuredHeight(event.currentTarget);
        let next: number | null = null;
        if (event.key === "ArrowUp") next = clamp(base + KEY_STEP);
        else if (event.key === "ArrowDown") next = clamp(base - KEY_STEP);
        else if (event.key === "Home") next = clamp(maxHeight());
        else if (event.key === "End") next = MIN_INSPECTOR_HEIGHT;
        if (next === null) return;
        event.preventDefault();
        setHeight(next);
        storeHeight(next);
      },

      onDoubleClick: () => {
        setHeight(null);
        storeHeight(null);
      },
    };
  };

  /** Inline grid rows for the panel; undefined keeps the stylesheet defaults. */
  const panelStyle = (expanded: boolean): CSSProperties | undefined =>
    expanded && height !== null
      ? { gridTemplateRows: `minmax(0, 1fr) 1px ${height}px` }
      : undefined;

  return { panelRef, dragging, handleProps, panelStyle };
}
