import { useEffect, useRef } from "react";

import type { Subtitle } from "../../types/subtitle";
import { formatSubtitleTime } from "../../utils/time";
import "./SubtitlePanel.css";

import type { WhisperModel } from "../../services/transcriptionService";

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
  onImport: () => void | Promise<void>;
  onExport: () => void | Promise<void>;

  onGenerate: () => void | Promise<void>;
  isGenerating: boolean;

  generationStatus: string;
  generationPercent: number;
  modelDownloadPercent: number;

  whisperModel: WhisperModel;
  onWhisperModelChange: (model: WhisperModel) => void;
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
  onImport,
  onExport,
  onGenerate,
  isGenerating,
  generationStatus,
  generationPercent,
  modelDownloadPercent,
  whisperModel,
  onWhisperModelChange,
}: SubtitlePanelProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!activeSubtitleId || !listRef.current) return;

    const element = listRef.current.querySelector(
      `[data-subtitle-id="${activeSubtitleId}"]`
    );

    if (element instanceof HTMLElement) {
      element.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [activeSubtitleId]);

  return (
    <aside className="subtitle-panel">
      <div className="subtitle-panel-header">
        <h2>Subtitles</h2>

        <div className="subtitle-actions">
          <select
            value={whisperModel}
            onChange={(event) =>
              onWhisperModelChange(
                event.target.value as WhisperModel
              )
            }
            disabled={isGenerating}
          >
            <option value="base">
              Base - Fast
            </option>

            <option value="small">
              Small - More Accurate
            </option>
          </select>
          <button onClick={onAdd}>Add</button>
          <button
            onClick={() => void onGenerate()}
            disabled={isGenerating}
          >
            {isGenerating
              ? generationStatus || "Generating..."
              : "Generate"}
          </button>
          <button onClick={() => void onImport()}>Import SRT</button>
          <button onClick={() => void onExport()}>Export SRT</button>
        </div>

        {isGenerating && (
          <div className="subtitle-generation-progress">
            <div className="subtitle-generation-status">
              <span>{generationStatus || "Generating..."}</span>

              {generationStatus === "Downloading model..." && (
                <span>{modelDownloadPercent}%</span>
              )}

              {generationStatus === "Transcribing..." && (
                <span>{generationPercent}%</span>
              )}
            </div>

            <div className="subtitle-progress-track">
              <div
                className="subtitle-progress-fill"
                style={{
                  width: `${
                    generationStatus === "Downloading model..."
                      ? modelDownloadPercent
                      : generationPercent
                  }%`,
                }}
              />
            </div>
          </div>
        )}

        <input
          type="text"
          placeholder="Search subtitles"
          className="subtitle-search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>

      <div className="subtitle-list" ref={listRef}>
        {subtitles.length === 0 ? (
          <p className="subtitle-empty">
            {search ? "No matching subtitles." : "No subtitles yet."}
          </p>
        ) : (
          subtitles.map((subtitle) => {
            const isSelected = selectedSubtitleId === subtitle.id;
            const isActive = activeSubtitleId === subtitle.id;

            return (
              <div
                key={subtitle.id}
                data-subtitle-id={subtitle.id}
                className={[
                  "subtitle-row",
                  isSelected ? "selected" : "",
                  isActive ? "active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => onSelect(subtitle.id, subtitle.startTime)}
              >
                <span className="subtitle-row-time">
                  {formatSubtitleTime(subtitle.startTime)}
                </span>

                <input
                  className="subtitle-row-text"
                  value={subtitle.text}
                  onClick={(event) => event.stopPropagation()}
                  onFocus={() => onSelect(subtitle.id, subtitle.startTime)}
                  onChange={(event) =>
                    onTextChange(subtitle.id, event.target.value)
                  }
                />

                <button
                  className="subtitle-delete"
                  aria-label="Delete subtitle"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(subtitle.id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

export default SubtitlePanel;
