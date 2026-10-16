import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

import {
  boxPatch,
  cornerAnchoredCenter,
  cornerPointerScale,
  normalizeRotation,
  oppositeCornerPoint,
  resizeBoxFromEdge,
  resizeCursor,
  rotationPatch,
  scaledBoxWidth,
  scaledFontSize,
  snapRotation,
  unboxedAnchorX,
  type BoxCorner,
  type SubtitleBoxGeometry,
  type SubtitleBoxPatch,
} from "../../utils/subtitleBox";
import {
  SUBTITLE_CANVAS_HEIGHT,
  SUBTITLE_CANVAS_WIDTH,
} from "../../utils/subtitleCanvas";

import "./SubtitleBoxFrame.css";

export type BoxFrameRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type BoxDraftKind = "resize" | "rotate" | "scale";

/**
 * Tells the overlay how to move the painted text while a drag is in progress,
 * so the text follows the handle even though libass has not re-rendered yet.
 * Origin is in px inside the canvas frame.
 */
export type BoxDraftHint = {
  originX: number;
  originY: number;
  /** Scale factor for a corner drag. */
  scale?: number;
};

type SubtitleBoxFrameProps = {
  /** The box as it looks right now (including a drag in progress). */
  geometry: SubtitleBoxGeometry;
  /** The same subtitle laid out with no box width and no rotation. */
  autoGeometry: SubtitleBoxGeometry;
  /** Current font size of the subtitle. */
  fontSize: number;
  /** Lays the subtitle out again with some fields changed. */
  layoutFor: (patch: SubtitleBoxPatch) => SubtitleBoxGeometry;
  /** The subtitle canvas rectangle inside the Program Monitor shell, in px. */
  frameRect: BoxFrameRect;
  shellRef: RefObject<HTMLElement | null>;
  selected: boolean;
  editable: boolean;
  /** Called while dragging. `null` means the drag was cancelled. */
  onDraft: (
    patch: SubtitleBoxPatch | null,
    kind: BoxDraftKind,
    hint?: BoxDraftHint,
  ) => void;
  /** Called once when a drag ends, or for a reset. Clear a field with undefined. */
  onCommit: (patch: SubtitleBoxPatch) => void;
  /** The move surface. It fills the box. */
  children?: ReactNode;
};

type Snapshot = {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  rotation: number;
  boxed: boolean;
  fontSize: number;
  /** Stored position in design units (the text anchor for auto boxes). */
  posX: number;
  posY: number;
};

type DragState = {
  kind: "left" | "right" | "rotate" | "scale";
  corner?: BoxCorner;
  pointerId: number;
  startX: number;
  startY: number;
  snapshot: Snapshot;
  centerClientX: number;
  centerClientY: number;
  startAngle: number;
  patch: SubtitleBoxPatch | null;
};

type Readout = { text: string; snapped: boolean };

const CORNERS: Array<{ id: "tl" | "tr" | "bl" | "br"; corner: BoxCorner }> = [
  { id: "tl", corner: { sx: -1, sy: -1 } },
  { id: "tr", corner: { sx: 1, sy: -1 } },
  { id: "bl", corner: { sx: -1, sy: 1 } },
  { id: "br", corner: { sx: 1, sy: 1 } },
];

const KEY_WIDTH_STEP = 8;
const KEY_ROTATE_STEP = 1;
const KEY_FONT_STEP = 1;
const ROTATE_HANDLE_DISTANCE = 34;
const HARD_SNAP = 1000;

const percentX = (design: number) =>
  Math.round((design / SUBTITLE_CANVAS_WIDTH) * 10000) / 100;
const percentY = (design: number) =>
  Math.round((design / SUBTITLE_CANVAS_HEIGHT) * 10000) / 100;

/*
 * The dashed box and its handles for the selected subtitle.
 *
 *   corners        scale the text and the box together (opposite corner fixed)
 *   side handles   change the box width; the text re-wraps
 *   top handle and
 *   just outside
 *   the corners    rotate around the centre
 *
 * The box is placed and sized from the real measured text, so it matches the
 * background box that libass draws. Moving is done by the child.
 */
function SubtitleBoxFrame({
  geometry,
  autoGeometry,
  fontSize,
  layoutFor,
  frameRect,
  shellRef,
  selected,
  editable,
  onDraft,
  onCommit,
  children,
}: SubtitleBoxFrameProps) {
  const dragRef = useRef<DragState | null>(null);
  const [readout, setReadout] = useState<Readout | null>(null);
  const [rotating, setRotating] = useState(false);

  const scale = frameRect.width / SUBTITLE_CANVAS_WIDTH;
  const showHandles = selected && editable;
  const widthPx = geometry.width * scale;
  const heightPx = geometry.height * scale;

  const snapshotOf = (): Snapshot => ({
    width: geometry.width,
    height: geometry.height,
    centerX: geometry.centerX,
    centerY: geometry.centerY,
    rotation: geometry.rotation,
    boxed: geometry.boxed,
    fontSize,
    posX: geometry.boxed ? geometry.centerX : geometry.textAnchorX,
    posY: geometry.centerY,
  });

  /** The patch (and canvas hint) for a text scale around the fixed corner. */
  const scalePatchFor = (snapshot: Snapshot, corner: BoxCorner, nextFontSize: number) => {
    const factor = snapshot.fontSize > 0 ? nextFontSize / snapshot.fontSize : 1;
    const widthPatch: SubtitleBoxPatch = snapshot.boxed
      ? { boxWidth: Math.round(scaledBoxWidth(snapshot.width, factor)) }
      : {};
    const base: SubtitleBoxPatch = {
      fontSize: nextFontSize,
      positionX: percentX(snapshot.posX),
      positionY: percentY(snapshot.posY),
      ...widthPatch,
    };

    // Lay the scaled subtitle out where it is, then slide it so the corner
    // opposite the dragged one has not moved.
    const laidOut = layoutFor(base);
    const anchoredCenter = cornerAnchoredCenter(snapshot, corner, {
      width: laidOut.width,
      height: laidOut.height,
    });
    const shiftX = anchoredCenter.centerX - laidOut.centerX;
    const shiftY = anchoredCenter.centerY - laidOut.centerY;

    const fixed = oppositeCornerPoint(snapshot, corner);
    return {
      patch: {
        ...base,
        positionX: percentX(snapshot.posX + shiftX),
        positionY: percentY(snapshot.posY + shiftY),
      } as SubtitleBoxPatch,
      hint: {
        originX: fixed.x * scale,
        originY: fixed.y * scale,
        scale: factor,
      } as BoxDraftHint,
    };
  };

  const begin =
    (kind: DragState["kind"], corner?: BoxCorner) =>
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || !event.isPrimary) return;
      const shell = shellRef.current;
      if (!shell || scale <= 0) return;

      event.preventDefault();
      event.stopPropagation();

      const shellRect = shell.getBoundingClientRect();
      const centerClientX = shellRect.left + frameRect.left + geometry.centerX * scale;
      const centerClientY = shellRect.top + frameRect.top + geometry.centerY * scale;

      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        kind,
        corner,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        snapshot: snapshotOf(),
        centerClientX,
        centerClientY,
        startAngle:
          (Math.atan2(event.clientY - centerClientY, event.clientX - centerClientX) * 180) /
          Math.PI,
        patch: null,
      };
      if (kind === "rotate") setRotating(true);
    };

  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const { snapshot } = drag;

    if (drag.kind === "rotate") {
      const angle =
        (Math.atan2(event.clientY - drag.centerClientY, event.clientX - drag.centerClientX) *
          180) /
        Math.PI;
      const free = normalizeRotation(snapshot.rotation + angle - drag.startAngle);
      // Default: a gentle pull towards 15 degree steps. Shift: always on a
      // step. Alt: no snapping at all.
      const rotation = event.altKey
        ? free
        : event.shiftKey
          ? snapRotation(free, 15, HARD_SNAP)
          : snapRotation(free);

      const patch = rotationPatch(rotation);
      drag.patch = patch;
      const shown = Math.round(rotation * 10) / 10;
      setReadout({
        text: `${Number.isInteger(shown) ? shown : shown.toFixed(1)}°`,
        snapped: rotation % 15 === 0,
      });
      onDraft(patch, "rotate", {
        originX: snapshot.centerX * scale,
        originY: snapshot.centerY * scale,
      });
      return;
    }

    if (drag.kind === "scale" && drag.corner) {
      const outer = cornerPointerScale(
        snapshot,
        drag.corner,
        (event.clientX - drag.startX) / scale,
        (event.clientY - drag.startY) / scale,
      );
      const { fontSize: nextFontSize } = scaledFontSize(snapshot.fontSize, outer, snapshot);
      const { patch, hint } = scalePatchFor(snapshot, drag.corner, nextFontSize);
      drag.patch = patch;
      setReadout({ text: `${nextFontSize} pt`, snapped: false });
      onDraft(patch, "scale", hint);
      return;
    }

    const side = drag.kind === "left" ? "left" : "right";
    const next = resizeBoxFromEdge(
      snapshot,
      side,
      (event.clientX - drag.startX) / scale,
      (event.clientY - drag.startY) / scale,
    );
    const patch = boxPatch({
      width: next.width,
      centerX: next.centerX,
      centerY: next.centerY,
      rotation: snapshot.rotation,
    });
    drag.patch = patch;
    setReadout({ text: `${Math.round(next.width)}`, snapped: false });
    onDraft(patch, "resize");
  };

  const finish = () => {
    setReadout(null);
    setRotating(false);
  };

  const end = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    finish();

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Capture may already be released.
    }

    if (drag.patch) onCommit(drag.patch);
  };

  const cancel = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    finish();
    onDraft(null, drag.kind === "rotate" ? "rotate" : drag.kind === "scale" ? "scale" : "resize");
  };

  // Back to a box that hugs the text. The text anchor stays where the box is.
  const resetWidth = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const anchorX = unboxedAnchorX(geometry.centerX, autoGeometry.width, geometry.alignment);
    onCommit({ boxWidth: undefined, positionX: percentX(anchorX) });
  };

  const resetRotation = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onCommit({ rotation: undefined });
  };

  const keyResize = (side: "left" | "right") => (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? KEY_WIDTH_STEP * 4 : KEY_WIDTH_STEP;
    const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const radians = (geometry.rotation * Math.PI) / 180;
    const next = resizeBoxFromEdge(
      snapshotOf(),
      side,
      direction * step * Math.cos(radians),
      direction * step * Math.sin(radians),
    );
    onCommit(
      boxPatch({
        width: next.width,
        centerX: next.centerX,
        centerY: next.centerY,
        rotation: geometry.rotation,
      }),
    );
  };

  const keyScale = (corner: BoxCorner) => (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? KEY_FONT_STEP * 4 : KEY_FONT_STEP;
    const up = event.key === "ArrowUp" || event.key === "ArrowRight";
    const down = event.key === "ArrowDown" || event.key === "ArrowLeft";
    if (!up && !down) return;
    event.preventDefault();
    const snapshot = snapshotOf();
    const next = Math.max(10, Math.min(96, snapshot.fontSize + (up ? step : -step)));
    onCommit(scalePatchFor(snapshot, corner, next).patch);
  };

  const keyRotate = (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 15 : KEY_ROTATE_STEP;
    const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    onCommit(rotationPatch(geometry.rotation + direction * step));
  };

  // Put the rotation handle on the other side when it would leave the monitor.
  const shellHeight = shellRef.current?.clientHeight ?? Number.POSITIVE_INFINITY;
  const radians = (geometry.rotation * Math.PI) / 180;
  const handleY =
    frameRect.top +
    geometry.centerY * scale -
    (heightPx / 2 + ROTATE_HANDLE_DISTANCE) * Math.cos(radians);
  const flip = handleY < 18 || handleY > shellHeight - 18;

  // Side handles get shorter on small boxes so they never cover the corners.
  const edgeHeight = Math.max(10, Math.min(34, heightPx - 22));

  const style = {
    left: frameRect.left + geometry.centerX * scale,
    top: frameRect.top + geometry.centerY * scale,
    width: widthPx,
    height: heightPx,
    transform: `translate(-50%, -50%) rotate(${geometry.rotation}deg)`,
    "--sbx-edge-h": `${edgeHeight}px`,
  } as CSSProperties;

  return (
    <div
      className={`sbx${selected ? " selected" : ""}${rotating ? " rotating" : ""}`}
      style={style}
    >
      {children}

      {showHandles && (
        <>
          {rotating && (
            <>
              {readout?.snapped && <span className="sbx-guide" aria-hidden="true" />}
              <span className="sbx-pivot" aria-hidden="true" />
            </>
          )}

          {CORNERS.map(({ id, corner }) => (
            <button
              key={`rz-${id}`}
              type="button"
              tabIndex={-1}
              className={`sbx-rzone ${id}`}
              aria-label="Rotate subtitle"
              onPointerDown={begin("rotate")}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={cancel}
              onDoubleClick={resetRotation}
              data-corner={`${corner.sx},${corner.sy}`}
            />
          ))}

          <button
            type="button"
            className="sbx-edge left"
            aria-label="Resize subtitle box from the left. Double-click to fit the text."
            title="Drag to change the width. Double-click to fit the text."
            style={{ cursor: resizeCursor(0, geometry.rotation) }}
            onPointerDown={begin("left")}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={cancel}
            onDoubleClick={resetWidth}
            onKeyDown={keyResize("left")}
          />
          <button
            type="button"
            className="sbx-edge right"
            aria-label="Resize subtitle box from the right. Double-click to fit the text."
            title="Drag to change the width. Double-click to fit the text."
            style={{ cursor: resizeCursor(0, geometry.rotation) }}
            onPointerDown={begin("right")}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={cancel}
            onDoubleClick={resetWidth}
            onKeyDown={keyResize("right")}
          />

          {CORNERS.map(({ id, corner }) => (
            <button
              key={`c-${id}`}
              type="button"
              className={`sbx-corner ${id}`}
              aria-label="Scale subtitle text and box. Arrow keys change the size."
              title="Drag to scale the text with the box"
              style={{
                cursor: resizeCursor(
                  (Math.atan2(corner.sy, corner.sx) * 180) / Math.PI,
                  geometry.rotation,
                ),
              }}
              onPointerDown={begin("scale", corner)}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={cancel}
              onKeyDown={keyScale(corner)}
            />
          ))}

          <button
            type="button"
            className={`sbx-rotate${flip ? " flip" : ""}${rotating ? " active" : ""}`}
            aria-label="Rotate subtitle. Hold Shift to snap to 15 degree steps, Alt for free rotation. Double-click to level."
            title="Drag to rotate. Shift: 15° steps. Alt: free. Double-click: level."
            onPointerDown={begin("rotate")}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={cancel}
            onDoubleClick={resetRotation}
            onKeyDown={keyRotate}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M13 8a5 5 0 1 1-1.5-3.55" />
              <path d="M13 2.4v3.1h-3.1" />
            </svg>
          </button>

          {readout && (
            <span
              className={`sbx-readout${flip ? " flip" : ""}${readout.snapped ? " snapped" : ""}`}
              style={{ transform: `translateX(-50%) rotate(${-geometry.rotation}deg)` }}
            >
              {readout.text}
            </span>
          )}
        </>
      )}
    </div>
  );
}

export default SubtitleBoxFrame;
