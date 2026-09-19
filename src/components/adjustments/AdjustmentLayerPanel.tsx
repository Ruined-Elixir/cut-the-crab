import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import type {
  AdjustmentLayerClip,
  AdjustmentLayerProperty,
} from "../../types/timelineModel";
import {
  ADJUSTMENT_KEYFRAME_EPSILON,
  DEFAULT_ADJUSTMENT_LAYER_VALUES,
  adjustmentKeyframeAtTime,
  adjustmentLayerChannel,
  evaluateAdjustmentLayerProperty,
  removeAdjustmentPropertyKeyframe,
  setAdjustmentPropertyKeyframe,
} from "../../utils/adjustmentLayers";

import "./AdjustmentLayerPanel.css";

type AdjustmentLayerPanelProps = {
  layer: AdjustmentLayerClip | null;
  open: boolean;
  currentTime: number;
  onClose: () => void;
  onChange: (id: string, patch: Partial<AdjustmentLayerClip>) => void;
  onSeek?: (time: number) => void;
  onOpenEffects?: () => void;
};

type Position = { x: number; y: number };

const PANEL_WIDTH = 350;
const PANEL_HEIGHT = 640;

function clampPanelPosition(position: Position): Position {
  return {
    x: Math.max(8, Math.min(window.innerWidth - PANEL_WIDTH - 8, position.x)),
    y: Math.max(8, Math.min(window.innerHeight - Math.min(PANEL_HEIGHT, window.innerHeight - 16) - 8, position.y)),
  };
}

function AdjustmentSlider({
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  animated,
  keyedHere,
  canGoPrevious,
  canGoNext,
  onChange,
  onToggleKeyframe,
  onPreviousKeyframe,
  onNextKeyframe,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  animated: boolean;
  keyedHere: boolean;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onChange: (value: number) => void;
  onToggleKeyframe: () => void;
  onPreviousKeyframe: () => void;
  onNextKeyframe: () => void;
}) {
  return (
    <div className={`adjustment-control-row ${animated ? "animated" : ""}`.trim()}>
      <span className="adjustment-control-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{Number.isInteger(value) ? value : value.toFixed(1)}{suffix}</output>
      <div className="adjustment-keyframe-controls" aria-label={`${label} keyframes`}>
        <button
          type="button"
          className="adjustment-keyframe-nav"
          disabled={!canGoPrevious}
          onClick={onPreviousKeyframe}
          title="Previous keyframe"
          aria-label={`Previous ${label} keyframe`}
        >
          ‹
        </button>
        <button
          type="button"
          className={`adjustment-keyframe-toggle ${keyedHere ? "active" : ""} ${animated ? "channel-active" : ""}`.trim()}
          onClick={onToggleKeyframe}
          title={keyedHere ? "Remove keyframe at playhead" : "Add keyframe at playhead"}
          aria-label={`${keyedHere ? "Remove" : "Add"} ${label} keyframe at playhead`}
        >
          ◆
        </button>
        <button
          type="button"
          className="adjustment-keyframe-nav"
          disabled={!canGoNext}
          onClick={onNextKeyframe}
          title="Next keyframe"
          aria-label={`Next ${label} keyframe`}
        >
          ›
        </button>
      </div>
    </div>
  );
}

export default function AdjustmentLayerPanel({
  layer,
  open,
  currentTime,
  onClose,
  onChange,
  onSeek,
  onOpenEffects,
}: AdjustmentLayerPanelProps) {
  const [position, setPosition] = useState<Position>(() => ({
    x: Math.max(12, window.innerWidth - PANEL_WIDTH - 24),
    y: 78,
  }));
  const dragOriginRef = useRef<{ x: number; y: number; panelX: number; panelY: number } | null>(null);

  useEffect(() => {
    const handleResize = () => setPosition((current) => clampPanelPosition(current));
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

  if (!open || !layer) return null;

  const beginDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input")) return;
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
      setPosition(clampPanelPosition({
        x: origin.panelX + moveEvent.clientX - origin.x,
        y: origin.panelY + moveEvent.clientY - origin.y,
      }));
    };

    const handleUp = () => {
      dragOriginRef.current = null;
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  const reset = () => onChange(layer.id, {
    ...DEFAULT_ADJUSTMENT_LAYER_VALUES,
    keyframes: undefined,
  });

  const changeProperty = (property: AdjustmentLayerProperty, value: number) => {
    const channel = adjustmentLayerChannel(layer, property);
    if (channel.length > 0) {
      const next = setAdjustmentPropertyKeyframe(layer, property, currentTime, value);
      onChange(layer.id, { keyframes: next.keyframes });
      return;
    }

    onChange(layer.id, { [property]: value } as Partial<AdjustmentLayerClip>);
  };

  const toggleKeyframe = (property: AdjustmentLayerProperty) => {
    const currentValue = evaluateAdjustmentLayerProperty(layer, property, currentTime);
    if (adjustmentKeyframeAtTime(layer, property, currentTime)) {
      const next = removeAdjustmentPropertyKeyframe(layer, property, currentTime);
      const patch: Partial<AdjustmentLayerClip> = { keyframes: next.keyframes };
      if (adjustmentLayerChannel(next, property).length === 0) {
        Object.assign(patch, { [property]: currentValue });
      }
      onChange(layer.id, patch);
      return;
    }

    const next = setAdjustmentPropertyKeyframe(layer, property, currentTime, currentValue);
    onChange(layer.id, { keyframes: next.keyframes });
  };

  const seekKeyframe = (
    property: AdjustmentLayerProperty,
    direction: "previous" | "next",
  ) => {
    const channel = adjustmentLayerChannel(layer, property);
    if (channel.length === 0) return;
    const relativeTime = currentTime - layer.timelineStart;
    const candidate = direction === "previous"
      ? [...channel].reverse().find((key) => key.time < relativeTime - ADJUSTMENT_KEYFRAME_EPSILON)
      : channel.find((key) => key.time > relativeTime + ADJUSTMENT_KEYFRAME_EPSILON);
    if (candidate) onSeek?.(layer.timelineStart + candidate.time);
  };

  const renderSlider = (
    property: AdjustmentLayerProperty,
    label: string,
    min: number,
    max: number,
    step: number,
    suffix = "",
  ) => {
    const channel = adjustmentLayerChannel(layer, property);
    const relativeTime = currentTime - layer.timelineStart;
    return (
      <AdjustmentSlider
        key={property}
        label={label}
        value={evaluateAdjustmentLayerProperty(layer, property, currentTime)}
        min={min}
        max={max}
        step={step}
        suffix={suffix}
        animated={channel.length > 0}
        keyedHere={!!adjustmentKeyframeAtTime(layer, property, currentTime)}
        canGoPrevious={channel.some((key) => key.time < relativeTime - ADJUSTMENT_KEYFRAME_EPSILON)}
        canGoNext={channel.some((key) => key.time > relativeTime + ADJUSTMENT_KEYFRAME_EPSILON)}
        onChange={(value) => changeProperty(property, value)}
        onToggleKeyframe={() => toggleKeyframe(property)}
        onPreviousKeyframe={() => seekKeyframe(property, "previous")}
        onNextKeyframe={() => seekKeyframe(property, "next")}
      />
    );
  };

  const playheadInside = currentTime >= layer.timelineStart && currentTime <= layer.timelineEnd;

  return (
    <aside
      className={`adjustment-layer-panel ${layer.enabled === false ? "disabled" : ""}`.trim()}
      style={{ left: position.x, top: position.y }}
      aria-label="Adjustment Layer controls"
    >
      <div className="adjustment-layer-panel-header" onMouseDown={beginDrag}>
        <div>
          <strong>{layer.name}</strong>
          <small>
            {layer.trackId.replace("video-", "V")} · {(layer.timelineEnd - layer.timelineStart).toFixed(2)}s
            {playheadInside ? ` · ${Math.max(0, currentTime - layer.timelineStart).toFixed(2)}s` : " · playhead outside layer"}
          </small>
        </div>
        <button type="button" onClick={onClose} aria-label="Close adjustment controls" title="Close">
          ×
        </button>
      </div>

      <div className="adjustment-layer-panel-toolbar">
        <label className="adjustment-enable-toggle">
          <input
            type="checkbox"
            checked={layer.enabled !== false}
            onChange={(event) => onChange(layer.id, { enabled: event.target.checked })}
          />
          <span>Enable Adjustment Layer</span>
        </label>
        <div className="adjustment-toolbar-actions">
          <button type="button" className="adjustment-effects-button" onClick={onOpenEffects}>Effects…</button>
          <span className="adjustment-keyframe-legend"><b>◆</b> keyframes</span>
        </div>
      </div>

      <div className="adjustment-layer-panel-body">
        <section>
          <div className="adjustment-section-title">
            <span>Blend</span>
            <small>Effect strength</small>
          </div>
          {renderSlider("opacity", "Opacity", 0, 100, 1, "%")}
        </section>

        <section>
          <div className="adjustment-section-title">
            <span>Basic Color</span>
            <small>Applied to video tracks below</small>
          </div>
          {renderSlider("exposure", "Exposure", -3, 3, 0.1)}
          {renderSlider("contrast", "Contrast", -100, 100, 1)}
          {renderSlider("saturation", "Saturation", 0, 200, 1, "%")}
        </section>

        <section>
          <div className="adjustment-section-title">
            <span>White Balance</span>
            <small>Cool/warm · green/magenta</small>
          </div>
          {renderSlider("temperature", "Temperature", -100, 100, 1)}
          {renderSlider("tint", "Tint", -100, 100, 1)}
        </section>

        <section>
          <div className="adjustment-section-title">
            <span>Tone</span>
            <small>Broad tonal shaping</small>
          </div>
          {renderSlider("highlights", "Highlights", -100, 100, 1)}
          {renderSlider("shadows", "Shadows", -100, 100, 1)}
          {renderSlider("whites", "Whites", -100, 100, 1)}
          {renderSlider("blacks", "Blacks", -100, 100, 1)}
        </section>
      </div>

      <div className="adjustment-layer-panel-footer">
        <span>Move the playhead, then ◆ to add/remove a keyframe.</span>
        <button type="button" onClick={reset}>Reset</button>
      </div>
    </aside>
  );
}
