import { useEffect, useMemo, useState } from "react";

import type { ExportFrameSize } from "../../services/videoExport";

import "./ExportSettingsModal.css";

type ExportPresetId = "16:9" | "4:3" | "1:1" | "9:16" | "custom";

type ExportPreset = {
  id: Exclude<ExportPresetId, "custom">;
  label: string;
  description: string;
  width: number;
  height: number;
};

const EXPORT_PRESETS: ExportPreset[] = [
  {
    id: "16:9",
    label: "16:9",
    description: "Landscape",
    width: 1920,
    height: 1080,
  },
  {
    id: "4:3",
    label: "4:3",
    description: "Classic",
    width: 1440,
    height: 1080,
  },
  {
    id: "1:1",
    label: "1:1",
    description: "Square",
    width: 1080,
    height: 1080,
  },
  {
    id: "9:16",
    label: "9:16",
    description: "Reels / Shorts",
    width: 1080,
    height: 1920,
  },
];

function nearestEven(value: number) {
  if (!Number.isFinite(value)) return 1080;
  const rounded = Math.max(64, Math.min(7680, Math.round(value)));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function matchingPreset(frameSize: ExportFrameSize): ExportPresetId {
  return (
    EXPORT_PRESETS.find(
      (preset) =>
        preset.width === frameSize.width && preset.height === frameSize.height,
    )?.id ?? "custom"
  );
}

type ExportSettingsModalProps = {
  open: boolean;
  rangeExport: boolean;
  initialFrameSize: ExportFrameSize;
  onCancel: () => void;
  onExport: (frameSize: ExportFrameSize) => void;
};

function ExportSettingsModal({
  open,
  rangeExport,
  initialFrameSize,
  onCancel,
  onExport,
}: ExportSettingsModalProps) {
  const [presetId, setPresetId] = useState<ExportPresetId>(() =>
    matchingPreset(initialFrameSize),
  );
  const [width, setWidth] = useState(initialFrameSize.width);
  const [height, setHeight] = useState(initialFrameSize.height);

  useEffect(() => {
    if (!open) return;
    setPresetId(matchingPreset(initialFrameSize));
    setWidth(initialFrameSize.width);
    setHeight(initialFrameSize.height);
  }, [initialFrameSize, open]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onCancel, open]);

  const normalizedFrameSize = useMemo(
    () => ({ width: nearestEven(width), height: nearestEven(height) }),
    [height, width],
  );

  const aspectRatio = normalizedFrameSize.width / normalizedFrameSize.height;

  if (!open) return null;

  const choosePreset = (preset: ExportPreset) => {
    setPresetId(preset.id);
    setWidth(preset.width);
    setHeight(preset.height);
  };

  const updateCustomDimension = (
    dimension: "width" | "height",
    value: number,
  ) => {
    setPresetId("custom");
    if (dimension === "width") setWidth(value);
    else setHeight(value);
  };

  return (
    <div
      className="export-settings-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        className="export-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-settings-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="export-settings-header">
          <div>
            <h2 id="export-settings-title">
              {rangeExport ? "Export Selected Range" : "Export Video"}
            </h2>
            <p>Preset ratios export exactly what is inside the matching dashed Program Monitor guide.</p>
          </div>

          <button
            type="button"
            className="export-settings-close"
            onClick={onCancel}
            aria-label="Close export settings"
          >
            ×
          </button>
        </header>

        <div className="export-settings-section">
          <span className="export-settings-section-title">Aspect ratio</span>

          <div className="export-preset-grid">
            {EXPORT_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`export-preset-card${presetId === preset.id ? " selected" : ""}`}
                onClick={() => choosePreset(preset)}
              >
                <span className="export-preset-ratio">{preset.label}</span>
                <span className="export-preset-description">
                  {preset.description}
                </span>
                <span className="export-preset-size">
                  {preset.width} × {preset.height}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="export-settings-section">
          <div className="export-custom-heading">
            <span className="export-settings-section-title">Output size</span>
            <span className="export-ratio-readout">
              {aspectRatio.toFixed(3)}:1
            </span>
          </div>

          <div className="export-size-fields">
            <label>
              <span>Width</span>
              <input
                type="number"
                min={64}
                max={7680}
                step={2}
                value={width}
                onChange={(event) =>
                  updateCustomDimension("width", Number(event.target.value))
                }
              />
              <small>px</small>
            </label>

            <span className="export-size-times">×</span>

            <label>
              <span>Height</span>
              <input
                type="number"
                min={64}
                max={7680}
                step={2}
                value={height}
                onChange={(event) =>
                  updateCustomDimension("height", Number(event.target.value))
                }
              />
              <small>px</small>
            </label>
          </div>

          {presetId === "custom" && (
            <p className="export-custom-note">
              Custom dimensions use the same centered Program viewport logic and are rounded to even pixels for H.264 export.
            </p>
          )}
        </div>

        <footer className="export-settings-actions">
          <button
            type="button"
            className="export-settings-secondary"
            onClick={onCancel}
          >
            Cancel
          </button>

          <button
            type="button"
            className="export-settings-primary"
            onClick={() => onExport(normalizedFrameSize)}
          >
            Continue to Export…
          </button>
        </footer>
      </section>
    </div>
  );
}

export default ExportSettingsModal;
