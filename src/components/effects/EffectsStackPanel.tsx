import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import type { VideoEffectInstance, VideoEffectKind } from "../../types/timelineModel";
import {
  VIDEO_EFFECT_LABELS,
  createVideoEffect,
  moveVideoEffect,
  reorderVideoEffects,
  updateVideoEffect,
} from "../../utils/videoEffects";

import "./EffectsStackPanel.css";

type EffectsStackPanelProps = {
  open: boolean;
  targetName: string;
  targetDetail?: string;
  effects?: VideoEffectInstance[];
  disabled?: boolean;
  onChange: (effects: VideoEffectInstance[]) => void;
  onClose: () => void;
};

type Position = { x: number; y: number };

const PANEL_WIDTH = 372;
const PANEL_HEIGHT = 600;

function clampPanelPosition(position: Position): Position {
  return {
    x: Math.max(8, Math.min(window.innerWidth - PANEL_WIDTH - 8, position.x)),
    y: Math.max(8, Math.min(window.innerHeight - Math.min(PANEL_HEIGHT, window.innerHeight - 16) - 8, position.y)),
  };
}

function EffectSlider({
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="effect-stack-slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{Math.round(value)}{suffix}</output>
    </label>
  );
}

function EffectControls({
  effect,
  disabled,
  onPatch,
}: {
  effect: VideoEffectInstance;
  disabled?: boolean;
  onPatch: (patch: Partial<{ radius: number; amount: number; softness: number }>) => void;
}) {
  if (effect.kind === "gaussian-blur") {
    return (
      <EffectSlider
        label="Radius"
        value={effect.radius}
        min={0}
        max={50}
        step={1}
        suffix=" px"
        disabled={disabled}
        onChange={(radius) => onPatch({ radius })}
      />
    );
  }

  if (effect.kind === "sharpen") {
    return (
      <EffectSlider
        label="Amount"
        value={effect.amount}
        min={0}
        max={100}
        step={1}
        suffix="%"
        disabled={disabled}
        onChange={(amount) => onPatch({ amount })}
      />
    );
  }

  return (
    <>
      <EffectSlider
        label="Amount"
        value={effect.amount}
        min={0}
        max={100}
        step={1}
        suffix="%"
        disabled={disabled}
        onChange={(amount) => onPatch({ amount })}
      />
      <EffectSlider
        label="Softness"
        value={effect.softness}
        min={0}
        max={100}
        step={1}
        suffix="%"
        disabled={disabled}
        onChange={(softness) => onPatch({ softness })}
      />
    </>
  );
}

export default function EffectsStackPanel({
  open,
  targetName,
  targetDetail,
  effects = [],
  disabled = false,
  onChange,
  onClose,
}: EffectsStackPanelProps) {
  const [position, setPosition] = useState<Position>(() => ({
    x: Math.max(12, window.innerWidth - PANEL_WIDTH - 24),
    y: 78,
  }));
  const [draggedEffectId, setDraggedEffectId] = useState<string | null>(null);
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

  if (!open) return null;

  const beginDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, select")) return;
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

  const addEffect = (kind: VideoEffectKind) => {
    if (disabled) return;
    onChange([...effects, createVideoEffect(kind)]);
  };

  const patchEffect = (
    id: string,
    patch: Partial<{ enabled: boolean; radius: number; amount: number; softness: number }>,
  ) => {
    if (disabled) return;
    onChange(updateVideoEffect(effects, id, patch));
  };

  const removeEffect = (id: string) => {
    if (disabled) return;
    onChange(effects.filter((effect) => effect.id !== id));
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>, targetId: string) => {
    event.preventDefault();
    if (disabled || !draggedEffectId || draggedEffectId === targetId) return;
    onChange(reorderVideoEffects(effects, draggedEffectId, targetId));
    setDraggedEffectId(null);
  };

  return (
    <aside
      className={`effects-stack-panel ${disabled ? "disabled" : ""}`.trim()}
      style={{ left: position.x, top: position.y }}
      aria-label="Effects stack"
    >
      <div className="effects-stack-header" onMouseDown={beginDrag}>
        <div>
          <strong>Effects</strong>
          <small>{targetName}{targetDetail ? ` · ${targetDetail}` : ""}</small>
        </div>
        <button type="button" onClick={onClose} aria-label="Close Effects" title="Close">×</button>
      </div>

      <div className="effects-stack-addbar">
        <button type="button" disabled={disabled} onClick={() => addEffect("gaussian-blur")}>+ Blur</button>
        <button type="button" disabled={disabled} onClick={() => addEffect("sharpen")}>+ Sharpen</button>
        <button type="button" disabled={disabled} onClick={() => addEffect("vignette")}>+ Vignette</button>
      </div>

      <div className="effects-stack-body">
        {effects.length === 0 ? (
          <div className="effects-stack-empty">
            <strong>No effects</strong>
            <span>Add an effect above. Effects are processed from top to bottom.</span>
          </div>
        ) : (
          effects.map((effect, index) => (
            <div
              key={effect.id}
              className={`effect-stack-card ${effect.enabled === false ? "bypassed" : ""}`.trim()}
              draggable={!disabled}
              onDragStart={() => setDraggedEffectId(effect.id)}
              onDragEnd={() => setDraggedEffectId(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => handleDrop(event, effect.id)}
            >
              <div className="effect-stack-card-header">
                <span className="effect-stack-drag-handle" title="Drag to reorder">⋮⋮</span>
                <label className="effect-stack-enable">
                  <input
                    type="checkbox"
                    checked={effect.enabled !== false}
                    disabled={disabled}
                    onChange={(event) => patchEffect(effect.id, { enabled: event.target.checked })}
                  />
                  <strong>{VIDEO_EFFECT_LABELS[effect.kind]}</strong>
                </label>
                <span className="effect-stack-order">{index + 1}</span>
                <button
                  type="button"
                  className="effect-stack-move"
                  disabled={disabled || index === 0}
                  onClick={() => onChange(moveVideoEffect(effects, effect.id, "up"))}
                  title="Move effect up"
                >↑</button>
                <button
                  type="button"
                  className="effect-stack-move"
                  disabled={disabled || index === effects.length - 1}
                  onClick={() => onChange(moveVideoEffect(effects, effect.id, "down"))}
                  title="Move effect down"
                >↓</button>
                <button
                  type="button"
                  className="effect-stack-remove"
                  disabled={disabled}
                  onClick={() => removeEffect(effect.id)}
                  title="Remove effect"
                  aria-label={`Remove ${VIDEO_EFFECT_LABELS[effect.kind]}`}
                >×</button>
              </div>

              <div className="effect-stack-card-controls">
                <EffectControls
                  effect={effect}
                  disabled={disabled || effect.enabled === false}
                  onPatch={(patch) => patchEffect(effect.id, patch)}
                />
              </div>
            </div>
          ))
        )}
      </div>

      <div className="effects-stack-footer">
        {disabled ? "Track locked · effects are read-only" : "Drag cards to reorder · changes are undoable"}
      </div>
    </aside>
  );
}
