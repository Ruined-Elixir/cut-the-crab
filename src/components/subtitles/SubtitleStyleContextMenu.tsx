import { useEffect, useRef, useState } from "react";

import { createPortal } from "react-dom";

import type { SubtitleStyle, SubtitleTextAlign } from "../../types/subtitle";

import { DEFAULT_ASS_FONT_FAMILY } from "../../utils/assSubtitles";

import "./SubtitleStyleContextMenu.css";

export type SubtitleStyleScope = "current" | "all";

type SubtitleStyleContextMenuProps = {
  x: number;
  y: number;

  fontSize: number;
  fontFamily: string;

  color: string;
  backgroundColor: string;

  isBold: boolean;
  isUnderlined: boolean;

  textAlign: SubtitleTextAlign;

  scope: SubtitleStyleScope;

  onScopeChange: (scope: SubtitleStyleScope) => void;

  onStyleChange: (style: SubtitleStyle) => void;

  onClose: () => void;
};

/*
 * Exact preview/export matching requires the same physical font file in
 * browser-libass and FFmpeg/libass. Start with the bundled Noto CJK font.
 *
 * Add more entries only after also adding their font files to public/fonts
 * and exposing them to the libass preview renderer.
 */
const FONT_OPTIONS = [DEFAULT_ASS_FONT_FAMILY];

function SubtitleStyleContextMenu({
  x,
  y,
  fontSize,
  fontFamily,
  color,
  backgroundColor,
  isBold,
  isUnderlined,
  textAlign,
  scope,
  onScopeChange,
  onStyleChange,
  onClose,
}: SubtitleStyleContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  /*
   * Keep the text field separate from the committed numeric style.
   * This lets users freely type values such as "48" without the first
   * keystroke being immediately clamped/reset.
   */
  const [fontSizeInput, setFontSizeInput] = useState(String(fontSize));

  useEffect(() => {
    setFontSizeInput(String(fontSize));
  }, [fontSize]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);

      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const menuWidth = 300;
  const menuHeight = 390;

  const left = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8));

  const top = Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8));

  const commitFontSize = () => {
    const value = Number(fontSizeInput);

    if (!Number.isFinite(value)) {
      setFontSizeInput(String(fontSize));
      return;
    }

    const clamped = Math.max(10, Math.min(96, Math.round(value)));

    setFontSizeInput(String(clamped));

    if (clamped !== fontSize) {
      onStyleChange({
        fontSize: clamped,
      });
    }
  };

  const effectiveFontFamily = FONT_OPTIONS.includes(fontFamily)
    ? fontFamily
    : DEFAULT_ASS_FONT_FAMILY;

  return createPortal(
    <div
      ref={menuRef}
      className="subtitle-style-context-menu"
      style={{
        left,
        top,
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="subtitle-style-menu-title">Subtitle style</div>

      <div className="subtitle-style-menu-fields">
        <label className="subtitle-style-menu-field">
          <span>Font</span>

          <select
            value={effectiveFontFamily}
            onChange={(event) =>
              onStyleChange({
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

        <label className="subtitle-style-menu-field">
          <span>Size</span>

          <input
            type="number"
            min={10}
            max={96}
            step={1}
            inputMode="numeric"
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
        </label>

        <label className="subtitle-style-menu-field">
          <span>Text color</span>

          <input
            type="color"
            value={color}
            onChange={(event) =>
              onStyleChange({
                color: event.target.value,
              })
            }
          />
        </label>

        <div className="subtitle-style-menu-field">
          <span>Background</span>

          <div className="subtitle-style-background-controls">
            <input
              type="color"
              value={
                backgroundColor === "transparent" ? "#000000" : backgroundColor
              }
              onChange={(event) =>
                onStyleChange({
                  backgroundColor: event.target.value,
                })
              }
            />

            <button
              type="button"
              className="subtitle-style-clear-background"
              onClick={() =>
                onStyleChange({
                  backgroundColor: "transparent",
                })
              }
            >
              None
            </button>
          </div>
        </div>
      </div>

      <div className="subtitle-style-menu-section">
        <button
          type="button"
          className={["subtitle-style-menu-button", isBold ? "active" : ""]
            .filter(Boolean)
            .join(" ")}
          onClick={() =>
            onStyleChange({
              isBold: !isBold,
            })
          }
        >
          <strong>B</strong>
          Bold
        </button>

        <button
          type="button"
          className={[
            "subtitle-style-menu-button",
            isUnderlined ? "active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() =>
            onStyleChange({
              isUnderlined: !isUnderlined,
            })
          }
        >
          <span className="subtitle-style-underline-icon">U</span>
          Underline
        </button>
      </div>

      <div className="subtitle-style-menu-section subtitle-style-menu-alignment-row">
        <span className="subtitle-style-menu-label">Alignment</span>

        <div className="subtitle-style-alignments">
          {(["left", "center", "right"] as SubtitleTextAlign[]).map(
            (alignment) => (
              <button
                key={alignment}
                type="button"
                className={textAlign === alignment ? "active" : ""}
                onClick={() =>
                  onStyleChange({
                    textAlign: alignment,
                  })
                }
              >
                {alignment.charAt(0).toUpperCase() + alignment.slice(1)}
              </button>
            ),
          )}
        </div>
      </div>

      <div className="subtitle-style-menu-divider" />

      <fieldset className="subtitle-style-scope">
        <legend>Apply changes to</legend>

        <label>
          <input
            type="radio"
            name="subtitle-style-scope"
            checked={scope === "current"}
            onChange={() => onScopeChange("current")}
          />

          <span>This subtitle</span>
        </label>

        <label>
          <input
            type="radio"
            name="subtitle-style-scope"
            checked={scope === "all"}
            onChange={() => onScopeChange("all")}
          />

          <span>All subtitles on track</span>
        </label>
      </fieldset>
    </div>,
    document.body,
  );
}

export default SubtitleStyleContextMenu;
