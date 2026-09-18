import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import type { VideoTimelineClip } from "../../types/timelineModel";

import "./ProgramLayersPanel.css";

type ProgramLayerItem = {
  clip: VideoTimelineClip;
  trackLabel: string;
  locked: boolean;
};

type ProgramLayersPanelProps = {
  open: boolean;
  items: ProgramLayerItem[];
  selectedClipId?: string | null;
  onClose: () => void;
  onSelect?: (id: string) => void;
  onReorder?: (orderedClipIdsTopToBottom: string[]) => boolean | void;
};

type Position = { x: number; y: number };

const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 430;

function clampPanelPosition(position: Position): Position {
  return {
    x: Math.max(8, Math.min(window.innerWidth - PANEL_WIDTH - 8, position.x)),
    y: Math.max(
      8,
      Math.min(
        window.innerHeight - Math.min(PANEL_HEIGHT, window.innerHeight - 16) - 8,
        position.y,
      ),
    ),
  };
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length ||
    fromIndex === toIndex
  ) {
    return items;
  }

  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

export default function ProgramLayersPanel({
  open,
  items,
  selectedClipId,
  onClose,
  onSelect,
  onReorder,
}: ProgramLayersPanelProps) {
  const [position, setPosition] = useState<Position>(() => ({
    x: Math.max(12, window.innerWidth - PANEL_WIDTH - 28),
    y: 86,
  }));
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
  const [dragOverClipId, setDragOverClipId] = useState<string | null>(null);
  const dragOriginRef = useRef<{
    x: number;
    y: number;
    panelX: number;
    panelY: number;
  } | null>(null);

  useEffect(() => {
    const handleResize = () =>
      setPosition((current) => clampPanelPosition(current));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const beginPanelDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      (event.target as HTMLElement).closest("button, input, .program-layer-row")
    ) {
      return;
    }

    event.preventDefault();
    dragOriginRef.current = {
      x: event.clientX,
      y: event.clientY,
      panelX: position.x,
      panelY: position.y,
    };

    const handleMove = (moveEvent: MouseEvent) => {
      const origin = dragOriginRef.current;
      if (!origin) return;
      setPosition(
        clampPanelPosition({
          x: origin.panelX + moveEvent.clientX - origin.x,
          y: origin.panelY + moveEvent.clientY - origin.y,
        }),
      );
    };

    const handleUp = () => {
      dragOriginRef.current = null;
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  const applyMove = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    const reordered = moveItem(items, fromIndex, toIndex);
    onReorder?.(reordered.map((item) => item.clip.id));
  };

  const handleDrop = (
    event: ReactDragEvent<HTMLDivElement>,
    targetClipId: string,
  ) => {
    event.preventDefault();
    const sourceClipId = draggingClipId ?? event.dataTransfer.getData("text/plain");
    setDraggingClipId(null);
    setDragOverClipId(null);

    if (!sourceClipId || sourceClipId === targetClipId) return;
    const fromIndex = items.findIndex((item) => item.clip.id === sourceClipId);
    const toIndex = items.findIndex((item) => item.clip.id === targetClipId);
    if (fromIndex < 0 || toIndex < 0) return;
    applyMove(fromIndex, toIndex);
  };

  return (
    <aside
      className="program-layers-panel"
      style={{ left: position.x, top: position.y }}
      aria-label="Program Monitor video layers"
    >
      <div className="program-layers-panel-header" onMouseDown={beginPanelDrag}>
        <div>
          <strong>Video Layers</strong>
          <small>Current playhead · drag to reorder</small>
        </div>
        <button type="button" onClick={onClose} aria-label="Close video layers" title="Close">
          ×
        </button>
      </div>

      <div className="program-layers-stack-label front">Front</div>

      <div className="program-layers-panel-body">
        {items.length === 0 ? (
          <div className="program-layers-empty">
            No visible video layers at the current playhead.
          </div>
        ) : (
          items.map((item, index) => {
            const { clip } = item;
            const selected = selectedClipId === clip.id;
            const dragging = draggingClipId === clip.id;
            const dragOver = dragOverClipId === clip.id && !dragging;

            return (
              <div
                key={clip.id}
                className={[
                  "program-layer-row",
                  selected ? "selected" : "",
                  item.locked ? "locked" : "",
                  dragging ? "dragging" : "",
                  dragOver ? "drag-over" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                draggable={!item.locked && items.length > 1}
                onClick={() => onSelect?.(clip.id)}
                onDragStart={(event) => {
                  if (item.locked) {
                    event.preventDefault();
                    return;
                  }
                  setDraggingClipId(clip.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", clip.id);
                }}
                onDragEnter={() => setDragOverClipId(clip.id)}
                onDragOver={(event) => {
                  if (!draggingClipId || draggingClipId === clip.id) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDragOverClipId(clip.id);
                }}
                onDrop={(event) => handleDrop(event, clip.id)}
                onDragEnd={() => {
                  setDraggingClipId(null);
                  setDragOverClipId(null);
                }}
              >
                <span className="program-layer-drag-handle" aria-hidden="true">⋮⋮</span>
                <div className="program-layer-copy">
                  <strong title={clip.sourceName}>{clip.sourceName || "Video"}</strong>
                  <small>
                    {item.trackLabel}
                    {clip.compoundName ? ` · ${clip.compoundName}` : ""}
                  </small>
                </div>
                {item.locked && <span className="program-layer-lock" title="Track locked">⌕</span>}
                <div className="program-layer-order-buttons" aria-label="Layer order controls">
                  <button
                    type="button"
                    disabled={item.locked || index === 0 || items[index - 1]?.locked}
                    onClick={(event) => {
                      event.stopPropagation();
                      applyMove(index, index - 1);
                    }}
                    title="Bring forward"
                    aria-label={`Bring ${clip.sourceName || "video"} forward`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={item.locked || index === items.length - 1 || items[index + 1]?.locked}
                    onClick={(event) => {
                      event.stopPropagation();
                      applyMove(index, index + 1);
                    }}
                    title="Send backward"
                    aria-label={`Send ${clip.sourceName || "video"} backward`}
                  >
                    ↓
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="program-layers-stack-label back">Back</div>
      <div className="program-layers-panel-footer">
        Editable video layers visible at the current playhead are listed. Open a collapsed compound to edit its internal stack.
      </div>
    </aside>
  );
}
