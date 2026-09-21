import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import type { VideoMask, VideoMaskShape } from "../../types/timelineModel";
import {
  createVideoMask,
  resetVideoMask,
  videoMaskSummary,
  type VideoMaskGeometry,
} from "../../utils/videoMasks";

import "./MasksPanel.css";

type Props = {
  open: boolean;
  targetName: string;
  targetDetail?: string;
  ownerKind?: "video" | "adjustment";
  mask?: VideoMask;
  disabled?: boolean;
  onChange: (mask: VideoMask | undefined) => void;
  onClose: () => void;
  onBeginContinuousChange?: () => void;
  onEndContinuousChange?: () => void;
  onDiscreteChange?: () => void;
  getDefaultGeometry?: () => VideoMaskGeometry | null | undefined;
};

type Position = { x: number; y: number };

const PANEL_WIDTH = 344;
const PANEL_HEIGHT = 500;

function clampPanelPosition(position: Position): Position {
  return {
    x: Math.max(8, Math.min(window.innerWidth - PANEL_WIDTH - 8, position.x)),
    y: Math.max(
      8,
      Math.min(
        window.innerHeight -
          Math.min(PANEL_HEIGHT, window.innerHeight - 16) -
          8,
        position.y,
      ),
    ),
  };
}

function precisionForStep(step: number) {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

function formatValue(value: number, step: number) {
  return value.toFixed(precisionForStep(step));
}

function MaskNumberInput({
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  disabled,
  onChange,
  onBegin,
  onEnd,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
  onBegin?: () => void;
  onEnd?: () => void;
}) {
  const [draft, setDraft] = useState(() => formatValue(value, step));
  const editingRef = useRef(false);

  useEffect(() => {
    if (!editingRef.current) {
      setDraft(formatValue(value, step));
    }
  }, [step, value]);

  const clamp = (candidate: number) =>
    Math.max(min, Math.min(max, Number.isFinite(candidate) ? candidate : value));

  const commit = () => {
    const parsed = Number(draft);
    const next = clamp(parsed);
    onChange(next);
    setDraft(formatValue(next, step));
  };

  return (
    <label className="mask-number-row">
      <span className="mask-number-label">{label}</span>
      {suffix && <span className="mask-number-unit">({suffix})</span>}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        aria-label={`${label} value`}
        onFocus={(event) => {
          editingRef.current = true;
          onBegin?.();
          event.currentTarget.select();
        }}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          if (text === "" || text === "-" || text === ".") return;
          const parsed = Number(text);
          if (Number.isFinite(parsed)) onChange(clamp(parsed));
        }}
        onBlur={() => {
          commit();
          editingRef.current = false;
          onEnd?.();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraft(formatValue(value, step));
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function MaskSlider({
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  disabled,
  onChange,
  onBegin,
  onEnd,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
  onBegin?: () => void;
  onEnd?: () => void;
}) {
  const activeRef = useRef(false);

  useEffect(() => {
    const end = () => {
      if (!activeRef.current) return;
      activeRef.current = false;
      onEnd?.();
    };

    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("blur", end);

    return () => {
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("blur", end);
    };
  }, [onEnd]);

  return (
    <label className="mask-panel-slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0 || activeRef.current) return;
          activeRef.current = true;
          onBegin?.();
        }}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>
        {Number.isInteger(value) ? value : value.toFixed(1)}
        {suffix}
      </output>
    </label>
  );
}

export default function MasksPanel({
  open,
  targetName,
  targetDetail,
  ownerKind,
  mask,
  disabled = false,
  onChange,
  onClose,
  onBeginContinuousChange,
  onEndContinuousChange,
  onDiscreteChange,
  getDefaultGeometry,
}: Props) {
  const [position, setPosition] = useState<Position>(() => ({
    x: Math.max(12, window.innerWidth - PANEL_WIDTH - 24),
    y: 90,
  }));
  const dragOriginRef = useRef<{
    x: number;
    y: number;
    px: number;
    py: number;
  } | null>(null);

  useEffect(() => {
    const resize = () =>
      setPosition((current) => clampPanelPosition(current));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose, open]);

  if (!open) return null;

  const beginDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      (event.target as HTMLElement).closest("button,input")
    ) {
      return;
    }

    event.preventDefault();
    dragOriginRef.current = {
      x: event.clientX,
      y: event.clientY,
      px: position.x,
      py: position.y,
    };

    const move = (moveEvent: MouseEvent) => {
      const origin = dragOriginRef.current;
      if (!origin) return;
      setPosition(
        clampPanelPosition({
          x: origin.px + moveEvent.clientX - origin.x,
          y: origin.py + moveEvent.clientY - origin.y,
        }),
      );
    };

    const up = () => {
      dragOriginRef.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };

    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const discrete = (next: VideoMask | undefined) => {
    if (disabled) return;
    onDiscreteChange?.();
    onChange(next);
  };

  const patch = (next: Partial<VideoMask>) => {
    if (!mask || disabled) return;
    onChange({ ...mask, ...next });
  };

  const defaultGeometry = () =>
    ownerKind === "video" ? getDefaultGeometry?.() ?? undefined : undefined;

  const add = (shape: VideoMaskShape) =>
    discrete(createVideoMask(shape, defaultGeometry()));

  return (
    <aside
      className={`masks-panel ${disabled ? "disabled" : ""}`.trim()}
      style={{ left: position.x, top: position.y }}
    >
      <div className="masks-panel-header" onMouseDown={beginDrag}>
        <div>
          <strong>Masks</strong>
          <small>
            {targetName}
            {targetDetail ? ` · ${targetDetail}` : ""}
          </small>
        </div>
        <button type="button" onClick={onClose} aria-label="Close Masks">
          ×
        </button>
      </div>

      {!mask ? (
        <div className="masks-panel-empty">
          <strong>No mask</strong>
          <span>
            Add a mask, then position and resize it directly in the Program
            Monitor.
          </span>
          <div>
            <button disabled={disabled} onClick={() => add("rectangle")}>
              + Rectangle
            </button>
            <button disabled={disabled} onClick={() => add("ellipse")}>
              + Ellipse
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="masks-panel-toolbar">
            <label>
              <input
                type="checkbox"
                checked={mask.enabled !== false}
                disabled={disabled}
                onChange={(event) =>
                  discrete({ ...mask, enabled: event.target.checked })
                }
              />
              Enable
            </label>
            <span>{videoMaskSummary(mask)}</span>
          </div>

          <div className="masks-panel-body">
            <section>
              <div className="mask-shape-switch">
                <button
                  className={mask.shape === "rectangle" ? "active" : ""}
                  disabled={disabled}
                  onClick={() => discrete({ ...mask, shape: "rectangle" })}
                >
                  Rectangle
                </button>
                <button
                  className={mask.shape === "ellipse" ? "active" : ""}
                  disabled={disabled}
                  onClick={() => discrete({ ...mask, shape: "ellipse" })}
                >
                  Ellipse
                </button>
              </div>
              <label className="mask-invert-toggle">
                <input
                  type="checkbox"
                  checked={mask.invert}
                  disabled={disabled}
                  onChange={(event) =>
                    discrete({ ...mask, invert: event.target.checked })
                  }
                />
                Invert mask
              </label>
            </section>

            <section>
              <h4>Geometry</h4>
              <div className="mask-number-grid">
                <MaskNumberInput
                  label="X"
                  value={mask.positionX}
                  min={-100}
                  max={200}
                  step={0.5}
                  suffix="%"
                  disabled={disabled}
                  onBegin={onBeginContinuousChange}
                  onEnd={onEndContinuousChange}
                  onChange={(positionX) => patch({ positionX })}
                />
                <MaskNumberInput
                  label="Y"
                  value={mask.positionY}
                  min={-100}
                  max={200}
                  step={0.5}
                  suffix="%"
                  disabled={disabled}
                  onBegin={onBeginContinuousChange}
                  onEnd={onEndContinuousChange}
                  onChange={(positionY) => patch({ positionY })}
                />
                <MaskNumberInput
                  label="Width"
                  value={mask.width}
                  min={1}
                  max={300}
                  step={0.5}
                  suffix="%"
                  disabled={disabled}
                  onBegin={onBeginContinuousChange}
                  onEnd={onEndContinuousChange}
                  onChange={(width) => patch({ width })}
                />
                <MaskNumberInput
                  label="Height"
                  value={mask.height}
                  min={1}
                  max={300}
                  step={0.5}
                  suffix="%"
                  disabled={disabled}
                  onBegin={onBeginContinuousChange}
                  onEnd={onEndContinuousChange}
                  onChange={(height) => patch({ height })}
                />
              </div>
            </section>

            <section>
              <h4>Edge</h4>
              <MaskSlider
                label="Feather"
                value={mask.feather}
                min={0}
                max={300}
                step={1}
                suffix=" px"
                disabled={disabled}
                onBegin={onBeginContinuousChange}
                onEnd={onEndContinuousChange}
                onChange={(feather) => patch({ feather })}
              />
            </section>
          </div>

          <div className="masks-panel-footer">
            <span>
              {ownerKind === "video"
                ? "Move the video to carry its mask · ⌘-drag the video to move it alone."
                : "Drag the mask in Program to reposition · drag corners to resize."}
            </span>
            <div>
              <button
                disabled={disabled}
                onClick={() => discrete(resetVideoMask(mask, defaultGeometry()))}
              >
                Reset
              </button>
              <button
                className="danger"
                disabled={disabled}
                onClick={() => discrete(undefined)}
              >
                Remove
              </button>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
