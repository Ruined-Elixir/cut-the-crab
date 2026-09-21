import { useEffect, useState } from "react";

import type {
  Subtitle,
  SubtitleStyle,
  SubtitleTextAlign,
} from "../../types/subtitle";

import { DEFAULT_ASS_FONT_FAMILY } from "../../utils/assSubtitles";
import { formatSubtitleTime } from "../../utils/time";

import "./SubtitleInspector.css";

type SubtitleInspectorProps = {
  subtitle: Subtitle | null;
  selectedCount: number;

  onTextChange: (id: string, text: string) => void;
  onStyleChange: (id: string, style: SubtitleStyle) => void;
};

const FONT_OPTIONS = [DEFAULT_ASS_FONT_FAMILY];

function SubtitleInspector({
  subtitle,
  selectedCount,
  onTextChange,
  onStyleChange,
}: SubtitleInspectorProps) {
  const fontSize = subtitle?.fontSize ?? 24;
  const fontFamily = subtitle?.fontFamily ?? DEFAULT_ASS_FONT_FAMILY;
  const color = subtitle?.color ?? "#ffffff";
  const backgroundColor = subtitle?.backgroundColor ?? "transparent";
  const isBold = subtitle?.isBold ?? false;
  const isUnderlined = subtitle?.isUnderlined ?? false;
  const textAlign = subtitle?.textAlign ?? "center";

  const [fontSizeInput, setFontSizeInput] = useState(String(fontSize));

  useEffect(() => {
    setFontSizeInput(String(fontSize));
  }, [fontSize, subtitle?.id]);

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

          <p>Select a subtitle to edit its properties.</p>
        </div>
      </section>
    );
  }

  const duration = Math.max(0, subtitle.endTime - subtitle.startTime);

  const selectionLabel =
    selectedCount > 1
      ? `${selectedCount} Subtitles Selected`
      : "1 Subtitle Selected";

  return (
    <section className="subtitle-inspector" aria-label="Subtitle inspector">
      <div className="subtitle-inspector-heading">
        <div>
          <span className="subtitle-inspector-eyebrow">Inspector</span>

          <h3>Subtitle</h3>
        </div>

        <span className="subtitle-inspector-selection-count">
          {selectionLabel}
        </span>
      </div>

      <div className="subtitle-inspector-scroll">
        <section className="inspector-section">
          <div className="inspector-section-header">
            <span>Text</span>

            {selectedCount > 1 && (
              <span className="inspector-section-note">Primary only</span>
            )}
          </div>

          <textarea
            className="inspector-textarea"
            value={subtitle.text}
            rows={3}
            onChange={(event) => onTextChange(subtitle.id, event.target.value)}
          />
        </section>

        <section className="inspector-section">
          <div className="inspector-section-header">
            <span>Timing</span>
          </div>

          <div className="inspector-property-grid">
            <span className="inspector-property-label">Start</span>
            <span className="inspector-time-value">
              {formatSubtitleTime(subtitle.startTime)}
            </span>

            <span className="inspector-property-label">End</span>
            <span className="inspector-time-value">
              {formatSubtitleTime(subtitle.endTime)}
            </span>

            <span className="inspector-property-label">Duration</span>
            <span className="inspector-time-value">
              {duration.toFixed(3)} s
            </span>
          </div>
        </section>

        <section className="inspector-section">
          <div className="inspector-section-header">
            <span>Appearance</span>

            {selectedCount > 1 && (
              <span className="inspector-section-note">
                Applies to selection
              </span>
            )}
          </div>

          <div className="inspector-property-grid">
            <label className="inspector-property-label">Font</label>

            <select
              className="inspector-control"
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

            <label className="inspector-property-label">Size</label>

            <div className="inspector-number-wrap">
              <input
                className="inspector-control"
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

            <span className="inspector-property-label">Text</span>

            <label className="inspector-color-control">
              <input
                type="color"
                value={color}
                onChange={(event) =>
                  onStyleChange(subtitle.id, {
                    color: event.target.value,
                  })
                }
              />

              <span>{color.toUpperCase()}</span>
            </label>

            <span className="inspector-property-label">Background</span>

            <div className="inspector-background-control">
              <label className="inspector-color-control">
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

                <span>
                  {backgroundColor === "transparent"
                    ? "None"
                    : backgroundColor.toUpperCase()}
                </span>
              </label>

              {backgroundColor !== "transparent" && (
                <button
                  type="button"
                  className="inspector-inline-button"
                  onClick={() =>
                    onStyleChange(subtitle.id, {
                      backgroundColor: "transparent",
                    })
                  }
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="inspector-formatting-row">
            <button
              type="button"
              className={["inspector-format-button", isBold ? "active" : ""]
                .filter(Boolean)
                .join(" ")}
              aria-pressed={isBold}
              onClick={() =>
                onStyleChange(subtitle.id, {
                  isBold: !isBold,
                })
              }
            >
              <strong>B</strong>
              <span>Bold</span>
            </button>

            <button
              type="button"
              className={[
                "inspector-format-button",
                isUnderlined ? "active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-pressed={isUnderlined}
              onClick={() =>
                onStyleChange(subtitle.id, {
                  isUnderlined: !isUnderlined,
                })
              }
            >
              <span className="inspector-underline-icon">U</span>
              <span>Underline</span>
            </button>
          </div>

          <div className="inspector-alignment-row">
            <span className="inspector-property-label">Alignment</span>

            <div className="inspector-segmented-control">
              {(["left", "center", "right"] as SubtitleTextAlign[]).map(
                (alignment) => (
                  <button
                    key={alignment}
                    type="button"
                    className={textAlign === alignment ? "active" : ""}
                    aria-label={`${alignment} align`}
                    aria-pressed={textAlign === alignment}
                    onClick={() =>
                      onStyleChange(subtitle.id, {
                        textAlign: alignment,
                      })
                    }
                  >
                    <svg viewBox="0 0 18 18" aria-hidden="true">
                      {alignment === "left" && (
                        <>
                          <path d="M3 5h12M3 9h8M3 13h10" />
                        </>
                      )}

                      {alignment === "center" && (
                        <>
                          <path d="M3 5h12M5 9h8M4 13h10" />
                        </>
                      )}

                      {alignment === "right" && (
                        <>
                          <path d="M3 5h12M7 9h8M5 13h10" />
                        </>
                      )}
                    </svg>
                  </button>
                ),
              )}
            </div>
          </div>
        </section>

        <section className="inspector-section">
          <div className="inspector-section-header">
            <span>Position</span>
          </div>

          <div className="inspector-property-grid">
            <span className="inspector-property-label">X</span>
            <span className="inspector-readonly-value">
              {(subtitle.positionX ?? 50).toFixed(1)}%
            </span>

            <span className="inspector-property-label">Y</span>
            <span className="inspector-readonly-value">
              {(subtitle.positionY ?? 80).toFixed(1)}%
            </span>
          </div>

          <p className="inspector-help">
            Drag the subtitle directly in the Program Monitor to reposition it.
          </p>
        </section>
      </div>
    </section>
  );
}

export default SubtitleInspector;
