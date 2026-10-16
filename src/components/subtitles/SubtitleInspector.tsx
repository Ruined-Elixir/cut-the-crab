import { useEffect, useMemo, useState } from "react";

import type {
  Subtitle,
  SubtitleStyle,
  SubtitleTextAlign,
} from "../../types/subtitle";

import { DEFAULT_ASS_FONT_FAMILY } from "../../utils/assSubtitles";

import SubtitlePresetsSection from "./SubtitlePresetsSection";
import SubtitleBackgroundSection from "./SubtitleBackgroundSection";

import "./SubtitleInspector.css";

type SubtitleAppearanceScope = "track" | "all";

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

function AlignmentIcon({ alignment }: { alignment: SubtitleTextAlign }) {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      {alignment === "left" && <path d="M3 5h12M3 9h8M3 13h10" />}
      {alignment === "center" && <path d="M3 5h12M5 9h8M4 13h10" />}
      {alignment === "right" && <path d="M3 5h12M7 9h8M5 13h10" />}
    </svg>
  );
}

function SubtitleInspector({
  subtitle,
  selectedCount,
  onStyleChange,
  onApplyAppearance,
}: SubtitleInspectorProps) {
  const fontSize = subtitle?.fontSize ?? 24;
  const fontFamily = subtitle?.fontFamily ?? DEFAULT_ASS_FONT_FAMILY;
  const color = subtitle?.color ?? "#ffffff";
  const backgroundColor = subtitle?.backgroundColor ?? "transparent";
  const backgroundRadius = subtitle?.backgroundRadius ?? 0;
  const isBold = subtitle?.isBold ?? false;
  const isItalic = subtitle?.isItalic ?? false;
  const isUnderlined = subtitle?.isUnderlined ?? false;
  const textAlign = subtitle?.textAlign ?? "center";

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
      backgroundRadius,
      backgroundColor,
      color,
      fontFamily,
      fontSize,
      isBold,
      isItalic,
      isUnderlined,
      textAlign,
    ],
  );

  const commitFontSize = () => {
    if (!subtitle) {
      return;
    }

    const parsed = Number(fontSizeInput);

    if (!Number.isFinite(parsed)) {
      setFontSizeInput(String(fontSize));
      return;
    }

    const next = Math.max(10, Math.min(96, Math.round(parsed)));

    setFontSizeInput(String(next));

    if (next !== fontSize) {
      onStyleChange(subtitle.id, {
        fontSize: next,
      });
    }
  };

  if (!subtitle) {
    return (
      <section
        className="subtitle-inspector empty"
        aria-label="Subtitle inspector"
      >
        <div className="subtitle-inspector-heading">
          <div>
            <span className="subtitle-inspector-eyebrow">Inspector</span>
            <h3>No Selection</h3>
          </div>
        </div>

        <div className="subtitle-inspector-empty-state">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="4" y="5" width="16" height="14" rx="2.5" />
            <path d="M8 10h8M8 14h5" />
          </svg>

          <p>Select a subtitle to edit its appearance.</p>
        </div>
      </section>
    );
  }

  const selectionLabel =
    selectedCount > 1
      ? `${selectedCount} Subtitles Selected`
      : "1 Subtitle Selected";

  return (
    <section className="subtitle-inspector" aria-label="Subtitle inspector">
      <div className="subtitle-inspector-heading">
        <div>
          <span className="subtitle-inspector-eyebrow">Inspector</span>
          <h3>Appearance</h3>
        </div>

        <span className="subtitle-inspector-selection-count">
          {selectionLabel}
        </span>
      </div>

      <div className="subtitle-inspector-scroll">
        <section className="inspector-section inspector-appearance-section">
          <div className="inspector-section-header">
            <span>Appearance</span>

            {selectedCount > 1 && (
              <span className="inspector-section-note">
                Applies to selection
              </span>
            )}
          </div>

          <div className="inspector-compact-fields">
            <label className="inspector-compact-field inspector-font-field">
              <span>Font</span>
              <select
                className="inspector-control inspector-font-control"
                value={
                  FONT_OPTIONS.includes(fontFamily)
                    ? fontFamily
                    : DEFAULT_ASS_FONT_FAMILY
                }
                onChange={(event) =>
                  onStyleChange(subtitle.id, {
                    fontFamily: event.target.value,
                  })
                }
              >
                {FONT_OPTIONS.map((font) => (
                  <option key={font} value={font}>
                    {font}
                  </option>
                ))}
              </select>
            </label>

            <label className="inspector-compact-field inspector-size-field">
              <span>Size</span>
              <div className="inspector-number-wrap">
                <input
                  className="inspector-control inspector-size-control"
                  type="number"
                  min={10}
                  max={96}
                  step={1}
                  value={fontSizeInput}
                  onChange={(event) => setFontSizeInput(event.target.value)}
                  onBlur={commitFontSize}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitFontSize();
                      event.currentTarget.blur();
                    }

                    if (event.key === "Escape") {
                      event.preventDefault();
                      setFontSizeInput(String(fontSize));
                      event.currentTarget.blur();
                    }
                  }}
                />
                <span>pt</span>
              </div>
            </label>
          </div>

          <div className="inspector-tool-row">
            <div className="inspector-tool-group">
              <span className="inspector-tool-label">Colour</span>

              <label
                className="inspector-color-tool"
                title="Text colour"
                aria-label="Text colour"
              >
                <input
                  type="color"
                  value={color}
                  onChange={(event) =>
                    onStyleChange(subtitle.id, {
                      color: event.target.value,
                    })
                  }
                />
                <span className="inspector-color-tool-letter">A</span>
                <span
                  className="inspector-color-tool-bar"
                  style={{ backgroundColor: color }}
                />
              </label>

              <label
                className={[
                  "inspector-color-tool",
                  "background",
                  backgroundColor === "transparent" ? "transparent" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                title="Background colour"
                aria-label="Background colour"
              >
                <input
                  type="color"
                  value={
                    backgroundColor === "transparent"
                      ? "#000000"
                      : backgroundColor
                  }
                  onChange={(event) =>
                    onStyleChange(subtitle.id, {
                      backgroundColor: event.target.value,
                    })
                  }
                />
                <span
                  className="inspector-color-tool-letter background-letter"
                  style={
                    backgroundColor === "transparent"
                      ? undefined
                      : { backgroundColor }
                  }
                >
                  A
                </span>
                <span
                  className="inspector-color-tool-bar"
                  style={{
                    backgroundColor:
                      backgroundColor === "transparent"
                        ? "transparent"
                        : backgroundColor,
                  }}
                />
              </label>

              <button
                type="button"
                className="inspector-mini-button inspector-clear-background"
                title="Remove background colour"
                aria-label="Remove background colour"
                disabled={backgroundColor === "transparent"}
                onClick={() =>
                  onStyleChange(subtitle.id, {
                    backgroundColor: "transparent",
                  })
                }
              >
                ∅
              </button>
            </div>

            <div className="inspector-tool-group">
              <span className="inspector-tool-label">Style</span>

              <button
                type="button"
                className={[
                  "inspector-mini-button",
                  isBold ? "active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-label="Bold"
                title="Bold"
                aria-pressed={isBold}
                onClick={() =>
                  onStyleChange(subtitle.id, {
                    isBold: !isBold,
                  })
                }
              >
                <strong>B</strong>
              </button>

              <button
                type="button"
                className={[
                  "inspector-mini-button",
                  isItalic ? "active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-label="Italic"
                title="Italic"
                aria-pressed={isItalic}
                onClick={() =>
                  onStyleChange(subtitle.id, {
                    isItalic: !isItalic,
                  })
                }
              >
                <em>I</em>
              </button>

              <button
                type="button"
                className={[
                  "inspector-mini-button",
                  isUnderlined ? "active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-label="Underline"
                title="Underline"
                aria-pressed={isUnderlined}
                onClick={() =>
                  onStyleChange(subtitle.id, {
                    isUnderlined: !isUnderlined,
                  })
                }
              >
                <span className="inspector-underline-icon">U</span>
              </button>
            </div>
          </div>

          <div className="inspector-alignment-compact-row">
            <span className="inspector-tool-label">Alignment</span>

            <div className="inspector-segmented-control compact">
              {(["left", "center", "right"] as SubtitleTextAlign[]).map(
                (alignment) => (
                  <button
                    key={alignment}
                    type="button"
                    className={textAlign === alignment ? "active" : ""}
                    aria-label={`${alignment} align`}
                    title={`${alignment[0].toUpperCase()}${alignment.slice(1)} align`}
                    aria-pressed={textAlign === alignment}
                    onClick={() =>
                      onStyleChange(subtitle.id, {
                        textAlign: alignment,
                      })
                    }
                  >
                    <AlignmentIcon alignment={alignment} />
                  </button>
                ),
              )}
            </div>
          </div>

          <div className="inspector-apply-row">
            <span className="inspector-tool-label">Apply appearance</span>

            <div className="inspector-apply-actions">
              <button
                type="button"
                className="inspector-apply-button"
                onClick={() =>
                  onApplyAppearance(subtitle.id, "track", appearanceStyle)
                }
                title="Copy this subtitle appearance to every subtitle on the same track"
              >
                Same Track
              </button>

              <button
                type="button"
                className="inspector-apply-button"
                onClick={() =>
                  onApplyAppearance(subtitle.id, "all", appearanceStyle)
                }
                title="Copy this subtitle appearance to every subtitle"
              >
                All Subtitles
              </button>
            </div>
          </div>
        </section>
        <SubtitleBackgroundSection
          radius={backgroundRadius}
          hasBackground={backgroundColor !== "transparent"}
          onChange={(radius) => onStyleChange(subtitle.id, { backgroundRadius: radius })}
        />
        <SubtitlePresetsSection
          currentStyle={appearanceStyle}
          onApply={(style) => onStyleChange(subtitle.id, style)}
        />
      </div>
    </section>
  );
}

export default SubtitleInspector;
