import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { VideoMask } from "../../types/timelineModel";
import "./ProgramMaskEditor.css";

type Props = {
  mask?: VideoMask;
  width: number;
  height: number;
  disabled?: boolean;
  label?: string;
  onChange: (mask: VideoMask) => void;
  onBeginChange?: () => void;
  onEndChange?: () => void;
};

type Handle = "nw" | "ne" | "sw" | "se";

export default function ProgramMaskEditor({
  mask,
  width,
  height,
  disabled = false,
  label = "Mask",
  onChange,
  onBeginChange,
  onEndChange,
}: Props) {
  const activePointerRef = useRef<number | null>(null);
  if (!mask || mask.enabled === false || width <= 0 || height <= 0) return null;

  const left = mask.positionX - mask.width / 2;
  const top = mask.positionY - mask.height / 2;
  const featherPx = mask.feather * (height / 1080);

  const beginMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const el = event.currentTarget;
    el.setPointerCapture?.(event.pointerId);
    activePointerRef.current = event.pointerId;
    onBeginChange?.();
    const startX = event.clientX,
      startY = event.clientY,
      start = { ...mask };
    const move = (e: PointerEvent) => {
      if (activePointerRef.current !== e.pointerId || (e.buttons & 1) === 0)
        return;
      onChange({
        ...start,
        positionX: Math.max(
          -100,
          Math.min(200, start.positionX + ((e.clientX - startX) / width) * 100),
        ),
        positionY: Math.max(
          -100,
          Math.min(
            200,
            start.positionY + ((e.clientY - startY) / height) * 100,
          ),
        ),
      });
    };
    const end = (e: PointerEvent) => {
      if (activePointerRef.current !== e.pointerId) return;
      activePointerRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      onEndChange?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const beginResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    handle: Handle,
  ) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    activePointerRef.current = event.pointerId;
    onBeginChange?.();
    const startX = event.clientX,
      startY = event.clientY;
    const b = {
      left,
      right: left + mask.width,
      top,
      bottom: top + mask.height,
    };
    const move = (e: PointerEvent) => {
      if (activePointerRef.current !== e.pointerId || (e.buttons & 1) === 0)
        return;
      const dx = ((e.clientX - startX) / width) * 100;
      const dy = ((e.clientY - startY) / height) * 100;
      let l = b.left,
        r = b.right,
        t = b.top,
        bt = b.bottom;
      if (handle.includes("w")) l += dx;
      else r += dx;
      if (handle.includes("n")) t += dy;
      else bt += dy;
      if (r - l < 1) {
        if (handle.includes("w")) l = r - 1;
        else r = l + 1;
      }
      if (bt - t < 1) {
        if (handle.includes("n")) t = bt - 1;
        else bt = t + 1;
      }
      const nextWidth = Math.max(1, Math.min(300, r - l));
      const nextHeight = Math.max(1, Math.min(300, bt - t));
      onChange({
        ...mask,
        positionX: Math.max(-100, Math.min(200, (l + r) / 2)),
        positionY: Math.max(-100, Math.min(200, (t + bt) / 2)),
        width: nextWidth,
        height: nextHeight,
      });
    };
    const end = (e: PointerEvent) => {
      if (activePointerRef.current !== e.pointerId) return;
      activePointerRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      onEndChange?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  return (
    <div
      className="program-mask-editor"
      style={{
        left: `${left}%`,
        top: `${top}%`,
        width: `${mask.width}%`,
        height: `${mask.height}%`,
        borderRadius: mask.shape === "ellipse" ? "50%" : "3px",
        boxShadow:
          featherPx > 0
            ? `0 0 0 ${Math.max(1, featherPx)}px rgba(92,188,255,.06)`
            : undefined,
      }}
      onPointerDown={beginMove}
    >
      <span className="program-mask-label">
        {label}
        {mask.invert ? " · Inverted" : ""}
      </span>
      {!disabled &&
        (["nw", "ne", "sw", "se"] as Handle[]).map((handle) => (
          <button
            key={handle}
            type="button"
            className={`program-mask-handle ${handle}`}
            onPointerDown={(e) => beginResize(e, handle)}
            aria-label={`Resize mask ${handle}`}
          />
        ))}
    </div>
  );
}
