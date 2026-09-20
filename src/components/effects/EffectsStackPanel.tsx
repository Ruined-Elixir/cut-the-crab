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
  duplicateVideoEffect,
  moveVideoEffect,
  reorderVideoEffects,
  resetVideoEffect,
  updateVideoEffect,
  videoEffectSummary,
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
  onBeginContinuousChange?: () => void;
  onEndContinuousChange?: () => void;
  onDiscreteChange?: () => void;
};

type Position = { x: number; y: number };
type DropPlacement = "before" | "after";

const PANEL_WIDTH = 390;
const PANEL_HEIGHT = 660;

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

function numberPrecision(step: number) {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

function formatNumericValue(value: number, step: number) {
  return value.toFixed(numberPrecision(step));
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
  onBeginContinuousChange,
  onEndContinuousChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
  onBeginContinuousChange?: () => void;
  onEndContinuousChange?: () => void;
}) {
  const [draftValue, setDraftValue] = useState(() => formatNumericValue(value, step));
  const numericEditingRef = useRef(false);
  const cancelNumericEditRef = useRef(false);
  const rangePointerActiveRef = useRef(false);
  const rangeKeyboardActiveRef = useRef(false);

  useEffect(() => {
    if (!numericEditingRef.current) {
      setDraftValue(formatNumericValue(value, step));
    }
  }, [step, value]);

  const clampValue = (candidate: number) => Math.max(min, Math.min(max, candidate));

  const quantizeValue = (candidate: number) => {
    const clamped = clampValue(candidate);
    const steps = Math.round((clamped - min) / step);
    const quantized = min + steps * step;
    return Number(clampValue(quantized).toFixed(Math.max(0, numberPrecision(step))));
  };

  const beginPointerInteraction = () => {
    if (disabled || rangePointerActiveRef.current) return;
    rangePointerActiveRef.current = true;
    onBeginContinuousChange?.();
  };

  const endPointerInteraction = () => {
    if (!rangePointerActiveRef.current) return;
    rangePointerActiveRef.current = false;
    onEndContinuousChange?.();
  };

  const beginKeyboardInteraction = () => {
    if (disabled || rangeKeyboardActiveRef.current) return;
    rangeKeyboardActiveRef.current = true;
    onBeginContinuousChange?.();
  };

  const endKeyboardInteraction = () => {
    if (!rangeKeyboardActiveRef.current) return;
    rangeKeyboardActiveRef.current = false;
    onEndContinuousChange?.();
  };

  useEffect(() => {
    const handlePointerEnd = () => endPointerInteraction();
    const handleWindowBlur = () => {
      endPointerInteraction();
      endKeyboardInteraction();
    };

    // Use a window-level release as a safety net for drags that end outside the
    // range element. This does not take over the range control itself; WebKit
    // still owns the normal click/drag behavior.
    window.addEventListener("pointerup", handlePointerEnd, true);
    window.addEventListener("pointercancel", handlePointerEnd, true);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      window.removeEventListener("pointerup", handlePointerEnd, true);
      window.removeEventListener("pointercancel", handlePointerEnd, true);
      window.removeEventListener("blur", handleWindowBlur);
    };
  });

  const commitDraft = () => {
    const parsed = Number(draftValue);
    if (Number.isFinite(parsed)) {
      const next = quantizeValue(parsed);
      if (next !== value) onChange(next);
      setDraftValue(formatNumericValue(next, step));
    } else {
      setDraftValue(formatNumericValue(value, step));
    }
  };

  const isRangeKeyboardKey = (key: string) =>
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "Home" ||
    key === "End" ||
    key === "PageUp" ||
    key === "PageDown";

  return (
    <div className="effect-stack-slider">
      <label className="effect-stack-slider-label">{label}</label>
      <input
        className="effect-stack-range"
        aria-label={`${label} slider`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        // Match the rest of CTC's sliders: the browser owns the range control.
        // Clicking the track jumps once; holding the primary button and moving
        // drags; releasing immediately ends the gesture.
        onPointerDown={(event) => {
          if (event.button !== 0 || disabled) return;
          beginPointerInteraction();
        }}
        onPointerUp={endPointerInteraction}
        onPointerCancel={endPointerInteraction}
        onChange={(event) => onChange(Number(event.target.value))}
        onKeyDown={(event) => {
          if (isRangeKeyboardKey(event.key)) beginKeyboardInteraction();
        }}
        onKeyUp={(event) => {
          if (isRangeKeyboardKey(event.key)) endKeyboardInteraction();
        }}
        onBlur={() => {
          endPointerInteraction();
          endKeyboardInteraction();
        }}
      />
      <label className="effect-stack-value-field">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={draftValue}
          disabled={disabled}
          aria-label={`${label} value`}
          onFocus={() => {
            numericEditingRef.current = true;
            cancelNumericEditRef.current = false;
            onBeginContinuousChange?.();
          }}
          onChange={(event) => {
            const nextText = event.target.value;
            setDraftValue(nextText);
            const parsed = Number(nextText);
            if (nextText !== "" && Number.isFinite(parsed)) {
              onChange(clampValue(parsed));
            }
          }}
          onBlur={() => {
            if (cancelNumericEditRef.current) {
              setDraftValue(formatNumericValue(value, step));
            } else {
              commitDraft();
            }
            cancelNumericEditRef.current = false;
            numericEditingRef.current = false;
            onEndContinuousChange?.();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              cancelNumericEditRef.current = true;
              setDraftValue(formatNumericValue(value, step));
              event.currentTarget.blur();
            }
          }}
        />
        {suffix && <span>{suffix}</span>}
      </label>
    </div>
  );
}

function EffectControls({
  effect,
  disabled,
  onPatch,
  onBeginContinuousChange,
  onEndContinuousChange,
}: {
  effect: VideoEffectInstance;
  disabled?: boolean;
  onPatch: (patch: Partial<{ radius: number; amount: number; softness: number }>) => void;
  onBeginContinuousChange?: () => void;
  onEndContinuousChange?: () => void;
}) {
  const common = {
    disabled,
    onBeginContinuousChange,
    onEndContinuousChange,
  };

  if (effect.kind === "gaussian-blur") {
    return (
      <EffectSlider
        {...common}
        label="Radius"
        value={effect.radius}
        min={0}
        max={50}
        step={1}
        suffix="px"
        onChange={(radius) => onPatch({ radius })}
      />
    );
  }

  if (effect.kind === "sharpen") {
    return (
      <EffectSlider
        {...common}
        label="Amount"
        value={effect.amount}
        min={0}
        max={100}
        step={1}
        suffix="%"
        onChange={(amount) => onPatch({ amount })}
      />
    );
  }

  return (
    <>
      <EffectSlider
        {...common}
        label="Amount"
        value={effect.amount}
        min={0}
        max={100}
        step={1}
        suffix="%"
        onChange={(amount) => onPatch({ amount })}
      />
      <EffectSlider
        {...common}
        label="Softness"
        value={effect.softness}
        min={0}
        max={100}
        step={1}
        suffix="%"
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
  onBeginContinuousChange,
  onEndContinuousChange,
  onDiscreteChange,
}: EffectsStackPanelProps) {
  const [position, setPosition] = useState<Position>(() => ({
    x: Math.max(12, window.innerWidth - PANEL_WIDTH - 24),
    y: 78,
  }));
  const [draggedEffectId, setDraggedEffectId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<{ id: string; placement: DropPlacement } | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const dragOriginRef = useRef<{ x: number; y: number; panelX: number; panelY: number } | null>(null);
  const continuousChangeActiveRef = useRef(false);
  const endContinuousChangeRef = useRef(onEndContinuousChange);
  endContinuousChangeRef.current = onEndContinuousChange;

  const beginContinuousChange = () => {
    if (disabled || continuousChangeActiveRef.current) return;
    continuousChangeActiveRef.current = true;
    onBeginContinuousChange?.();
  };

  const endContinuousChange = () => {
    if (!continuousChangeActiveRef.current) return;
    continuousChangeActiveRef.current = false;
    onEndContinuousChange?.();
  };

  useEffect(() => {
    const handleResize = () => setPosition((current) => clampPanelPosition(current));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!open) {
      endContinuousChange();
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, open]);

  useEffect(() => () => {
    if (continuousChangeActiveRef.current) {
      continuousChangeActiveRef.current = false;
      endContinuousChangeRef.current?.();
    }
  }, []);

  useEffect(() => {
    const ids = new Set(effects.map((effect) => effect.id));
    setCollapsedIds((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [effects]);

  if (!open) return null;

  const activeCount = effects.filter((effect) => effect.enabled !== false).length;
  const bypassedCount = effects.length - activeCount;

  const beginDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      (event.target as HTMLElement).closest(
        "button, input, select, .effect-stack-drag-handle",
      )
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

  const commitDiscrete = (nextEffects: VideoEffectInstance[]) => {
    if (disabled) return;
    onDiscreteChange?.();
    onChange(nextEffects);
  };

  const addEffect = (kind: VideoEffectKind) => {
    commitDiscrete([...effects, createVideoEffect(kind)]);
  };

  const patchEffect = (
    id: string,
    patch: Partial<{ enabled: boolean; radius: number; amount: number; softness: number }>,
    discrete = false,
  ) => {
    if (disabled) return;
    if (discrete) onDiscreteChange?.();
    onChange(updateVideoEffect(effects, id, patch));
  };

  const removeEffect = (id: string) => {
    commitDiscrete(effects.filter((effect) => effect.id !== id));
  };

  const resetEffect = (id: string) => {
    const next = effects.map((effect) =>
      effect.id === id ? resetVideoEffect(effect) : effect,
    );
    commitDiscrete(next);
  };

  const duplicateEffect = (id: string) => {
    const index = effects.findIndex((effect) => effect.id === id);
    if (index < 0) return;
    const next = [...effects];
    next.splice(index + 1, 0, duplicateVideoEffect(effects[index]));
    commitDiscrete(next);
  };

  const resetAllEffects = () => {
    if (effects.length === 0) return;
    commitDiscrete(effects.map(resetVideoEffect));
  };

  const clearAllEffects = () => {
    if (effects.length === 0) return;
    commitDiscrete([]);
  };

  const moveEffect = (id: string, direction: "up" | "down") => {
    const next = moveVideoEffect(effects, id, direction);
    if (next.every((effect, index) => effect.id === effects[index]?.id)) return;
    commitDiscrete(next);
  };

  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>, targetId: string) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (!draggedEffectId || draggedEffectId === targetId) {
      setDragOver(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const placement: DropPlacement = event.clientY < rect.top + rect.height / 2
      ? "before"
      : "after";
    setDragOver({ id: targetId, placement });
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>, targetId: string) => {
    event.preventDefault();
    if (disabled || !draggedEffectId || draggedEffectId === targetId) {
      setDraggedEffectId(null);
      setDragOver(null);
      return;
    }
    const placement = dragOver?.id === targetId ? dragOver.placement : "before";
    commitDiscrete(reorderVideoEffects(effects, draggedEffectId, targetId, placement));
    setDraggedEffectId(null);
    setDragOver(null);
  };

  const toggleCollapsed = (id: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const collapseAll = () => setCollapsedIds(new Set(effects.map((effect) => effect.id)));
  const expandAll = () => setCollapsedIds(new Set());
  const allCollapsed = effects.length > 0 && effects.every((effect) => collapsedIds.has(effect.id));

  return (
    <aside
      className={`effects-stack-panel ${disabled ? "disabled" : ""}`.trim()}
      style={{ left: position.x, top: position.y }}
      aria-label="Effects stack"
    >
      <div className="effects-stack-header" onMouseDown={beginDrag}>
        <div className="effects-stack-header-copy">
          <div className="effects-stack-title-row">
            <strong>Effects</strong>
            {effects.length > 0 && (
              <span className="effects-stack-count" title={`${activeCount} active${bypassedCount ? `, ${bypassedCount} bypassed` : ""}`}>
                {activeCount}/{effects.length}
              </span>
            )}
          </div>
          <small>{targetName}{targetDetail ? ` · ${targetDetail}` : ""}</small>
        </div>
        <button type="button" className="effects-stack-close" onClick={onClose} aria-label="Close Effects" title="Close">×</button>
      </div>

      <div className="effects-stack-toolbar">
        <div className="effects-stack-addbar" aria-label="Add effect">
          <button type="button" disabled={disabled} onClick={() => addEffect("gaussian-blur")}>+ Blur</button>
          <button type="button" disabled={disabled} onClick={() => addEffect("sharpen")}>+ Sharpen</button>
          <button type="button" disabled={disabled} onClick={() => addEffect("vignette")}>+ Vignette</button>
        </div>
        <div className="effects-stack-stack-actions">
          <button
            type="button"
            disabled={effects.length === 0}
            onClick={allCollapsed ? expandAll : collapseAll}
            title={allCollapsed ? "Expand all effects" : "Collapse all effects"}
          >
            {allCollapsed ? "Expand" : "Collapse"}
          </button>
          <button type="button" disabled={disabled || effects.length === 0} onClick={resetAllEffects} title="Reset all effect parameters">Reset all</button>
          <button type="button" className="danger" disabled={disabled || effects.length === 0} onClick={clearAllEffects} title="Remove all effects (Undo restores them)">Clear</button>
        </div>
      </div>

      <div className="effects-stack-body">
        {effects.length === 0 ? (
          <div className="effects-stack-empty">
            <span className="effects-stack-empty-icon">FX</span>
            <strong>No effects yet</strong>
            <span>Add Blur, Sharpen, or Vignette. Effects are processed from top to bottom.</span>
          </div>
        ) : (
          effects.map((effect, index) => {
            const collapsed = collapsedIds.has(effect.id);
            const isDropTarget = dragOver?.id === effect.id;
            return (
              <div
                key={effect.id}
                className={[
                  "effect-stack-card",
                  effect.enabled === false ? "bypassed" : "",
                  draggedEffectId === effect.id ? "dragging" : "",
                  isDropTarget ? `drop-${dragOver?.placement}` : "",
                ].filter(Boolean).join(" ")}
                onDragOver={(event) => handleDragOver(event, effect.id)}
                onDragLeave={(event) => {
                  const related = event.relatedTarget;
                  if (!(related instanceof Node) || !event.currentTarget.contains(related)) {
                    setDragOver((current) => current?.id === effect.id ? null : current);
                  }
                }}
                onDrop={(event) => handleDrop(event, effect.id)}
              >
                <div className="effect-stack-card-header">
                  <span
                    className="effect-stack-drag-handle"
                    title="Drag to reorder"
                    draggable={!disabled}
                    onDragStart={(event) => {
                      setDraggedEffectId(effect.id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", effect.id);
                    }}
                    onDragEnd={() => {
                      setDraggedEffectId(null);
                      setDragOver(null);
                    }}
                  >
                    ⠿
                  </span>

                  <button
                    type="button"
                    className="effect-stack-collapse"
                    onClick={() => toggleCollapsed(effect.id)}
                    aria-expanded={!collapsed}
                    title={collapsed ? "Expand effect" : "Collapse effect"}
                  >
                    {collapsed ? "›" : "⌄"}
                  </button>

                  <button
                    type="button"
                    className={`effect-stack-power ${effect.enabled === false ? "off" : "on"}`}
                    disabled={disabled}
                    onClick={() => patchEffect(effect.id, { enabled: effect.enabled === false }, true)}
                    aria-pressed={effect.enabled !== false}
                    title={effect.enabled === false ? "Enable effect" : "Bypass effect"}
                  >
                    ◉
                  </button>

                  <button
                    type="button"
                    className="effect-stack-name"
                    onClick={() => toggleCollapsed(effect.id)}
                    aria-expanded={!collapsed}
                  >
                    <strong>{VIDEO_EFFECT_LABELS[effect.kind]}</strong>
                    <small>{effect.enabled === false ? "Bypassed" : videoEffectSummary(effect)}</small>
                  </button>

                  <span className="effect-stack-order">{index + 1}</span>

                  <button type="button" className="effect-stack-icon-button" disabled={disabled} onClick={() => resetEffect(effect.id)} title="Reset effect">↺</button>
                  <button type="button" className="effect-stack-icon-button" disabled={disabled} onClick={() => duplicateEffect(effect.id)} title="Duplicate effect">⧉</button>
                  <button type="button" className="effect-stack-move" disabled={disabled || index === 0} onClick={() => moveEffect(effect.id, "up")} title="Move effect up">↑</button>
                  <button type="button" className="effect-stack-move" disabled={disabled || index === effects.length - 1} onClick={() => moveEffect(effect.id, "down")} title="Move effect down">↓</button>
                  <button
                    type="button"
                    className="effect-stack-remove"
                    disabled={disabled}
                    onClick={() => removeEffect(effect.id)}
                    title="Remove effect"
                    aria-label={`Remove ${VIDEO_EFFECT_LABELS[effect.kind]}`}
                  >×</button>
                </div>

                {!collapsed && (
                  <div className="effect-stack-card-controls">
                    <EffectControls
                      effect={effect}
                      disabled={disabled || effect.enabled === false}
                      onPatch={(patch) => patchEffect(effect.id, patch)}
                      onBeginContinuousChange={beginContinuousChange}
                      onEndContinuousChange={endContinuousChange}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="effects-stack-footer">
        <span>
          {disabled
            ? "Track locked · effects are read-only"
            : effects.length === 0
              ? "Effects are previewed live and included in export"
              : `${activeCount} active${bypassedCount ? ` · ${bypassedCount} bypassed` : ""} · drag ⠿ to reorder`}
        </span>
        {!disabled && effects.length > 0 && <span>Undo restores removed/reset effects</span>}
      </div>
    </aside>
  );
}
