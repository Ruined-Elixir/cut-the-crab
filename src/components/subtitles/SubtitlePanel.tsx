import { useState } from "react";

import type { Subtitle, SubtitleStyle } from "../../types/subtitle";

import SubtitleInspector from "./SubtitleInspector";
import SubtitleList from "./SubtitleList";

import "./SubtitlePanel.css";

type SubtitlePanelProps = {
  subtitles: Subtitle[];
  activeTrackId: string;
  selectedSubtitle: Subtitle | null;
  selectedSubtitleId: string | null;
  selectedSubtitleIds: string[];
  selectedSubtitleCount: number;
  activeSubtitleId: string | null;

  search: string;
  onSearchChange: (value: string) => void;

  onSelect: (
    id: string,
    startTime: number,
    mode?: "single" | "toggle" | "range",
  ) => void;
  onTextChange: (id: string, text: string) => void;
  onStyleChange: (id: string, style: SubtitleStyle) => void;
  onApplyAppearance: (
    id: string,
    scope: "track" | "all",
    style: SubtitleStyle,
  ) => void;

  onAdd: () => void;
  onDelete: (id: string) => void;
  onReveal?: (id: string) => void;
};

function SubtitlePanel({
  subtitles,
  activeTrackId,
  selectedSubtitle,
  selectedSubtitleId,
  selectedSubtitleIds,
  selectedSubtitleCount,
  activeSubtitleId,
  search,
  onSearchChange,
  onSelect,
  onTextChange,
  onStyleChange,
  onApplyAppearance,
  onAdd,
  onDelete,
  onReveal,
}: SubtitlePanelProps) {
  const [isInspectorExpanded, setIsInspectorExpanded] = useState(false);

  return (
    <aside
      className={[
        "subtitle-panel",
        isInspectorExpanded ? "inspector-expanded" : "inspector-collapsed",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <section className="subtitle-browser">
        <div className="subtitle-panel-header">
          <div className="subtitle-panel-title-row">
            <div>
              <span className="subtitle-panel-eyebrow">Browser</span>

              <h2>Subtitles · S{activeTrackId.split("-")[1] ?? "1"}</h2>
            </div>

            <span className="subtitle-panel-count">{subtitles.length}</span>
          </div>

          <div className="subtitle-panel-tools">
            <div className="subtitle-search-wrap">
              <svg
                className="subtitle-search-icon"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="6.5" />
                <path d="m16 16 4 4" />
              </svg>

              <input
                type="text"
                className="subtitle-search"
                placeholder="Search subtitles"
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
              />
            </div>

            <button
              type="button"
              className="subtitle-add-button"
              onClick={onAdd}
              aria-label="Add subtitle"
              title="Add Subtitle"
            >
              <svg viewBox="0 0 18 18" aria-hidden="true">
                <path d="M9 3.5v11M3.5 9h11" />
              </svg>
            </button>
          </div>
        </div>

        <SubtitleList
          subtitles={subtitles}
          selectedSubtitleId={selectedSubtitleId}
          selectedSubtitleIds={selectedSubtitleIds}
          activeSubtitleId={activeSubtitleId}
          search={search}
          onSelect={onSelect}
          onTextChange={onTextChange}
          onDelete={onDelete}
          onReveal={onReveal}
        />
      </section>

      <div className="subtitle-panel-divider" aria-hidden="true" />

      <section className="subtitle-inspector-disclosure">
        <button
          type="button"
          className="subtitle-inspector-disclosure-button"
          aria-expanded={isInspectorExpanded}
          onClick={() => setIsInspectorExpanded((current) => !current)}
        >
          <svg
            className="subtitle-inspector-disclosure-chevron"
            viewBox="0 0 12 12"
            aria-hidden="true"
          >
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>

          <span>Inspector</span>

          {selectedSubtitleCount > 0 && (
            <span className="subtitle-inspector-disclosure-count">
              {selectedSubtitleCount}
            </span>
          )}
        </button>

        {isInspectorExpanded && (
          <SubtitleInspector
            subtitle={selectedSubtitle}
            selectedCount={selectedSubtitleCount}
            onStyleChange={onStyleChange}
            onApplyAppearance={onApplyAppearance}
          />
        )}
      </section>
    </aside>
  );
}

export default SubtitlePanel;
