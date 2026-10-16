import { useEffect, useMemo, useState } from "react";

import type {
  Subtitle,
  SubtitleStyle,
  SubtitleTextAlign,
} from "../../types/subtitle";

import { DEFAULT_ASS_FONT_FAMILY } from "../../utils/assSubtitles";
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from "../../utils/subtitlePresets";

import SubtitleBackgroundSection from "./SubtitleBackgroundSection";
import SubtitlePresetsSection from "./SubtitlePresetsSection";

import "./SubtitleInspectorTabs.css";

type SubtitleAppearanceScope = "track" | "all";

type InspectorTab = "presets" | "text" | "background";

type SubtitleInspectorProps = {
  subtitle: Subtitle | null;
  selectedCount: number;

  onStyleChange: (id: string, style: SubtitleStyle) => void;
  onApplyAppearance: (
    id: string,
    scope: SubtitleAppearanceScope,
    style: SubtitleStyle,
  ) => void;
};

const FONT_OPTIONS = [DEFAULT_ASS_FONT_FAMILY];

const TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: "presets", label: "Presets" },
  { id: "text", label: "Text" },
  { id: "background", label: "Background" },
];

const ALIGNMENTS: Array<{ id: SubtitleTextAlign; label: string }> = [
  { id: "left", label: "Left" },
  { id: "center", label: "Center" },
  { id: "right", label: "Right" },
];

type ColorFieldProps = {
  label: string;
  value: string;
  transparent?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
};

/* A labelled swatch. The native colour input covers it, so a click anywhere
   on the swatch opens the picker. */
function ColorField({ label, value, transparent, disabled, onChange }: ColorFieldProps) {
  return (
    <label className={`si-color${disabled ? " disabled" : ""}`}>
      <span
        className={`si-color-chip${transparent ? " transparent" : ""}`}
        style={transparent ? undefined : { background: value }}
      />
      <span className="si-color-label">{label}</span>
      <input
        type="color"
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function SubtitleInspector({
  subtitle,
  selectedCount,
  onStyleChange,
  onApplyAppearance,
}: SubtitleInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>("presets");

  const fontSize = subtitle?.fontSize ?? 24;
  const fontFamily = subtitle?.fontFamily ?? DEFAULT_ASS_FONT_FAMILY;
  const color = subtitle?.color ?? "#ffffff";
  const backgroundColor = subtitle?.backgroundColor ?? "transparent";
  const backgroundRadius = subtitle?.backgroundRadius ?? 0;
  const isBold = subtitle?.isBold ?? false;
  const isItalic = subtitle?.isItalic ?? false;
  const isUnderlined = subtitle?.isUnderlined ?? false;
  const textAlign = subtitle?.textAlign ?? "center";
  const hasBackground = backgroundColor !== "transparent";

  const [fontSizeInput, setFontSizeInput] = useState(String(fontSize));

  useEffect(() => {
    setFontSizeInput(String(fontSize));
  }, [fontSize, subtitle?.id]);

  const appearanceStyle = useMemo<SubtitleStyle>(
    () => ({
      fontSize,
      fontFamily,
      color,
      backgroundColor,
      backgroundRadius,
      isBold,
      isItalic,
      isUnderlined,
      textAlign,
    }),
    [
      backgroundColor,
      backgroundRadius,
      color,
      fontFamily,
      fontSize,
      isBold,
      isItalic,
      isUnderlined,
      textAlign,
    ],
  );

  if (!subtitle) {
    return (
      <div className="subtitle-inspector si-panel si-empty">
        <p>Select a subtitle to edit its appearance.</p>
      </div>
    );
  }

  const apply = (style: SubtitleStyle) => onStyleChange(subtitle.id, style);

  const commitFontSize = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      setFontSizeInput(String(fontSize));
      return;
    }
    const next = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(parsed)));
    setFontSizeInput(String(next));
    if (next !== fontSize) apply({ fontSize: next });
  };

  // Approximate preview only: the real box is drawn by libass at export size.
  const previewSize = Math.max(11, Math.min(24, Math.round(fontSize * 0.5)));

  const selectionLabel =
    selectedCount > 1 ? `${selectedCount} subtitles selected` : "1 subtitle selected";

  return (
    <div className="subtitle-inspector si-panel">
      <div className="si-header">
        <div
          className="si-preview"
          style={{
            color,
            background: hasBackground ? backgroundColor : "rgba(255,255,255,0.06)",
            borderRadius: hasBackground ? Math.round(backgroundRadius * 0.5) : 6,
            fontFamily: `"${fontFamily}", sans-serif`,
            fontSize: previewSize,
            fontWeight: isBold ? 700 : 400,
            fontStyle: isItalic ? "italic" : "normal",
            textDecoration: isUnderlined ? "underline" : "none",
          }}
          title="Approximate preview"
        >
          Aa 字幕
        </div>
        <div className="si-header-text">
          <span className="si-title">Appearance</span>
          <span className="si-count">
            {selectionLabel}
            {selectedCount > 1 ? ". Changes apply to all." : ""}
          </span>
        </div>
      </div>

      <div className="si-tabs" role="tablist" aria-label="Subtitle appearance">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`si-tab${tab === item.id ? " active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="si-content" role="tabpanel">
        {tab === "presets" && (
          <SubtitlePresetsSection currentStyle={appearanceStyle} onApply={apply} />
        )}

        {tab === "text" && (
          <>
            <div className="si-field">
              <span className="si-field-label">Font</span>
              <select
                className="si-select"
                value={fontFamily}
                onChange={(event) => apply({ fontFamily: event.target.value })}
              >
                {FONT_OPTIONS.map((font) => (
                  <option key={font} value={font}>
                    {font}
                  </option>
                ))}
              </select>
            </div>

            <div className="si-field">
              <span className="si-field-label">Size</span>
              <div className="si-stepper">
                <button
                  type="button"
                  aria-label="Smaller"
                  disabled={fontSize <= MIN_FONT_SIZE}
                  onClick={() => commitFontSize(String(fontSize - 1))}
                >
                  -
                </button>
                <input
                  value={fontSizeInput}
                  inputMode="numeric"
                  aria-label="Font size"
                  onChange={(event) => setFontSizeInput(event.target.value)}
                  onBlur={() => commitFontSize(fontSizeInput)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitFontSize(fontSizeInput);
                      event.currentTarget.blur();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setFontSizeInput(String(fontSize));
                      event.currentTarget.blur();
                    }
                  }}
                />
                <button
                  type="button"
                  aria-label="Larger"
                  disabled={fontSize >= MAX_FONT_SIZE}
                  onClick={() => commitFontSize(String(fontSize + 1))}
                >
                  +
                </button>
              </div>
              <span className="si-unit">pt</span>
            </div>

            <div className="si-field">
              <span className="si-field-label">Color</span>
              <ColorField
                label="Text"
                value={color}
                onChange={(value) => apply({ color: value })}
              />
            </div>

            <div className="si-field">
              <span className="si-field-label">Style</span>
              <div className="si-segmented">
                <button
                  type="button"
                  aria-pressed={isBold}
                  className={isBold ? "active" : ""}
                  onClick={() => apply({ isBold: !isBold })}
                >
                  <b>Bold</b>
                </button>
                <button
                  type="button"
                  aria-pressed={isItalic}
                  className={isItalic ? "active" : ""}
                  onClick={() => apply({ isItalic: !isItalic })}
                >
                  <i>Italic</i>
                </button>
                <button
                  type="button"
                  aria-pressed={isUnderlined}
                  className={isUnderlined ? "active" : ""}
                  onClick={() => apply({ isUnderlined: !isUnderlined })}
                >
                  <u>Underline</u>
                </button>
              </div>
            </div>

            <div className="si-field">
              <span className="si-field-label">Align</span>
              <div className="si-segmented">
                {ALIGNMENTS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={textAlign === item.id}
                    className={textAlign === item.id ? "active" : ""}
                    onClick={() => apply({ textAlign: item.id })}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {tab === "background" && (
          <>
            <div className="si-field">
              <span className="si-field-label">Fill</span>
              <ColorField
                label={hasBackground ? "Background" : "None"}
                value={hasBackground ? backgroundColor : "#000000"}
                transparent={!hasBackground}
                onChange={(value) => apply({ backgroundColor: value })}
              />
              <button
                type="button"
                className="si-link"
                disabled={!hasBackground}
                onClick={() => apply({ backgroundColor: "transparent" })}
              >
                Remove
              </button>
            </div>

            <SubtitleBackgroundSection
              radius={backgroundRadius}
              hasBackground={hasBackground}
              onChange={(radius) => apply({ backgroundRadius: radius })}
            />
          </>
        )}

        <div className="si-copy">
          <span className="si-field-label">Copy this look to</span>
          <div className="si-copy-buttons">
            <button
              type="button"
              onClick={() => onApplyAppearance(subtitle.id, "track", appearanceStyle)}
              title="Copy this subtitle's appearance to every subtitle on the same track"
            >
              Same track
            </button>
            <button
              type="button"
              onClick={() => onApplyAppearance(subtitle.id, "all", appearanceStyle)}
              title="Copy this subtitle's appearance to every subtitle"
            >
              All subtitles
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SubtitleInspector;
