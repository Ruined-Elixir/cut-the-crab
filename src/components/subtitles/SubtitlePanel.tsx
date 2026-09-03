import type { Subtitle } from "../../types/subtitle";

import SubtitleList from "./SubtitleList";

import "./SubtitlePanel.css";

type SubtitlePanelProps = {
  subtitles: Subtitle[];

  selectedSubtitleId: string | null;
  activeSubtitleId: string | null;

  search: string;
  onSearchChange: (value: string) => void;

  onSelect: (id: string, startTime: number) => void;
  onTextChange: (id: string, text: string) => void;

  onAdd: () => void;
  onDelete: (id: string) => void;
};

function SubtitlePanel({
  subtitles,
  selectedSubtitleId,
  activeSubtitleId,
  search,
  onSearchChange,
  onSelect,
  onTextChange,
  onAdd,
  onDelete,
}: SubtitlePanelProps) {
  return (
    <aside className="subtitle-panel">
      <div className="subtitle-panel-header">
        <h2>Subtitles</h2>

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
            title="Add subtitle"
          >
            +
          </button>
        </div>
      </div>

      <SubtitleList
        subtitles={subtitles}
        selectedSubtitleId={selectedSubtitleId}
        activeSubtitleId={activeSubtitleId}
        search={search}
        onSelect={onSelect}
        onTextChange={onTextChange}
        onDelete={onDelete}
      />
    </aside>
  );
}

export default SubtitlePanel;
