import { useState } from "react";

import type { SubtitleStyle } from "../../types/subtitle";
import {
  BUILT_IN_SUBTITLE_PRESETS,
  MAX_PRESET_NAME_LENGTH,
  addCustomPreset,
  deleteCustomPreset,
  loadCustomPresets,
  renameCustomPreset,
  saveCustomPresets,
  stylePatchFromPreset,
  type SubtitleStylePreset,
} from "../../utils/subtitlePresets";

import "./SubtitlePresetsSection.css";

type SubtitlePresetsSectionProps = {
  /** Appearance of the subtitle currently shown in the inspector. */
  currentStyle: SubtitleStyle;
  /** Apply a preset's appearance to the current selection. */
  onApply: (style: SubtitleStyle) => void;
};

function PresetSwatch({ preset }: { preset: SubtitleStylePreset }) {
  const { style } = preset;
  const hasBackground = style.backgroundColor !== "transparent";
  return (
    <span
      className="subtitle-preset-swatch"
      style={{
        color: style.color,
        background: hasBackground ? style.backgroundColor : "rgba(255,255,255,0.06)",
        fontWeight: style.isBold ? 700 : 400,
        fontStyle: style.isItalic ? "italic" : "normal",
        textDecoration: style.isUnderlined ? "underline" : "none",
      }}
      aria-hidden="true"
    >
      Aa
    </span>
  );
}

function SubtitlePresetsSection({ currentStyle, onApply }: SubtitlePresetsSectionProps) {
  const [custom, setCustom] = useState<SubtitleStylePreset[]>(() => loadCustomPresets());
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const persist = (next: SubtitleStylePreset[]) => {
    setCustom(next);
    if (!saveCustomPresets(next)) {
      setMessage("Presets could not be saved on this device.");
    }
  };

  const saveCurrent = () => {
    const result = addCustomPreset(custom, newName, currentStyle, () => crypto.randomUUID());
    if (result.error) {
      setMessage(result.error);
      return;
    }
    persist(result.presets);
    setNewName("");
    setMessage(null);
  };

  const commitRename = () => {
    if (!renamingId) return;
    const result = renameCustomPreset(custom, renamingId, renameValue);
    if (result.error) {
      setMessage(result.error);
      return;
    }
    persist(result.presets);
    setRenamingId(null);
    setMessage(null);
  };

  const remove = (preset: SubtitleStylePreset) => {
    if (!window.confirm(`Delete the preset "${preset.name}"?`)) return;
    persist(deleteCustomPreset(custom, preset.id));
    setMessage(null);
  };

  const renderRow = (preset: SubtitleStylePreset) => {
    const editing = renamingId === preset.id;
    return (
      <li key={preset.id} className="subtitle-preset-row">
        <button
          type="button"
          className="subtitle-preset-apply"
          onClick={() => onApply(stylePatchFromPreset(preset))}
          title={`Apply "${preset.name}" to the selected subtitles`}
        >
          <PresetSwatch preset={preset} />
          {editing ? null : <span className="subtitle-preset-name">{preset.name}</span>}
        </button>

        {editing && (
          <input
            className="subtitle-preset-input"
            value={renameValue}
            maxLength={MAX_PRESET_NAME_LENGTH}
            autoFocus
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setRenamingId(null);
                setMessage(null);
              }
            }}
          />
        )}

        {!preset.builtIn && !editing && (
          <span className="subtitle-preset-actions">
            <button
              type="button"
              className="subtitle-preset-icon"
              title="Rename preset"
              onClick={() => {
                setRenamingId(preset.id);
                setRenameValue(preset.name);
                setMessage(null);
              }}
            >
              Rename
            </button>
            <button
              type="button"
              className="subtitle-preset-icon"
              title="Delete preset"
              onClick={() => remove(preset)}
            >
              Delete
            </button>
          </span>
        )}
      </li>
    );
  };

  return (
    <section className="inspector-section subtitle-presets">
      <div className="inspector-section-header">
        <span>Presets</span>
      </div>

      <ul className="subtitle-preset-list">
        {BUILT_IN_SUBTITLE_PRESETS.map(renderRow)}
        {custom.map(renderRow)}
      </ul>

      <div className="subtitle-preset-save">
        <input
          className="subtitle-preset-input"
          placeholder="Preset name"
          value={newName}
          maxLength={MAX_PRESET_NAME_LENGTH}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              saveCurrent();
            }
          }}
        />
        <button
          type="button"
          className="subtitle-preset-save-button"
          onClick={saveCurrent}
          disabled={newName.trim().length === 0}
          title="Save this subtitle's appearance as a preset"
        >
          Save current
        </button>
      </div>

      {message && <p className="subtitle-preset-message">{message}</p>}
      <p className="inspector-section-note">
        Presets change appearance only. Position and alignment stay as they are.
      </p>
    </section>
  );
}

export default SubtitlePresetsSection;
