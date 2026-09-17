import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import type { AdjustmentLayerClip } from "../../types/timelineModel";
import { DEFAULT_ADJUSTMENT_LAYER_VALUES } from "../../utils/adjustmentLayers";

import "./AdjustmentLayerPanel.css";

type AdjustmentLayerPanelProps = {
  layer: AdjustmentLayerClip | null;
  open: boolean;
  onClose: () => void;
  onChange: (id: string, patch: Partial<AdjustmentLayerClip>) => void;
};

type Position = { x: number; y: number };

const PANEL_WIDTH = 310;
const PANEL_HEIGHT = 420;

function clampPanelPosition(position: Position): Position {
  return {
    x: Math.max(8, Math.min(window.innerWidth - PANEL_WIDTH - 8, position.x)),
    y: Math.max(8, Math.min(window.innerHeight - PANEL_HEIGHT - 8, position.y)),
  };
}

function AdjustmentSlider({
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="adjustment-control-row">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{Number.isInteger(value) ? value : value.toFixed(1)}{suffix}</output>
    </label>
  );
}

export default function AdjustmentLayerPanel({
  layer,
  open,
  onClose,
  onChange,
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

  const reset = () => onChange(layer.id, { ...DEFAULT_ADJUSTMENT_LAYER_VALUES });

  return (
    <aside
      className="adjustment-layer-panel"
      style={{ left: position.x, top: position.y }}
      aria-label="Adjustment Layer controls"
    >
      <div className="adjustment-layer-panel-header" onMouseDown={beginDrag}>
        <div>
          <strong>{layer.name}</strong>
          <small>{layer.trackId.replace("video-", "V")} · {(layer.timelineEnd - layer.timelineStart).toFixed(2)}s</small>
        </div>
        <button type="button" onClick={onClose} aria-label="Close adjustment controls" title="Close">
          ×
        </button>
      </div>

      <div className="adjustment-layer-panel-body">
        <section>
          <div className="adjustment-section-title">
            <span>Blend</span>
            <small>Effect strength</small>
          </div>
          <AdjustmentSlider
            label="Opacity"
            value={layer.opacity}
            min={0}
            max={100}
            step={1}
            suffix="%"
            onChange={(opacity) => onChange(layer.id, { opacity })}
          />
        </section>

        <section>
          <div className="adjustment-section-title">
            <span>Basic Color</span>
            <small>Applied to video tracks below</small>
          </div>
          <AdjustmentSlider
            label="Exposure"
            value={layer.exposure}
            min={-3}
            max={3}
            step={0.1}
            onChange={(exposure) => onChange(layer.id, { exposure })}
          />
          <AdjustmentSlider
            label="Contrast"
            value={layer.contrast}
            min={-100}
            max={100}
            step={1}
            onChange={(contrast) => onChange(layer.id, { contrast })}
          />
          <AdjustmentSlider
            label="Saturation"
            value={layer.saturation}
            min={0}
            max={200}
            step={1}
            suffix="%"
            onChange={(saturation) => onChange(layer.id, { saturation })}
          />
          <AdjustmentSlider
            label="Temperature"
            value={layer.temperature}
            min={-100}
            max={100}
            step={1}
            onChange={(temperature) => onChange(layer.id, { temperature })}
          />
        </section>
      </div>

      <div className="adjustment-layer-panel-footer">
        <span>Preview and export use the same layer timing.</span>
        <button type="button" onClick={reset}>Reset</button>
      </div>
    </aside>
  );
}
