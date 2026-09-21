import { useEffect, useRef } from "react";

import type { Subtitle } from "../../types/subtitle";
import { formatSubtitleTime } from "../../utils/time";
import {
  canShowNativeContextMenu,
  showNativeContextMenu,
} from "../../services/nativeContextMenu";
import "./SubtitleList.css";

type SubtitleListProps = {
  subtitles: Subtitle[];

  selectedSubtitleId: string | null;
  selectedSubtitleIds: string[];
  activeSubtitleId: string | null;

  search: string;

  onSelect: (
    id: string,
    startTime: number,
    mode?: "single" | "toggle" | "range",
  ) => void;

  onTextChange: (id: string, text: string) => void;

  onDelete: (id: string) => void;
  onReveal?: (id: string) => void;
};

function SubtitleList({
  subtitles,
  selectedSubtitleId,
  selectedSubtitleIds,
  activeSubtitleId,
  search,
  onSelect,
  onTextChange,
  onDelete,
  onReveal,
}: SubtitleListProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!activeSubtitleId || !listRef.current) {
      return;
    }

    const element = listRef.current.querySelector(
      `[data-subtitle-id="${activeSubtitleId}"]`,
    );

    if (element instanceof HTMLElement) {
      element.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [activeSubtitleId]);

  return (
    <div ref={listRef} className="subtitle-list">
      {subtitles.length === 0 ? (
        <p className="subtitle-empty">
          {search ? "No matching subtitles." : "No subtitles yet."}
        </p>
      ) : (
        subtitles.map((subtitle) => {
          const isSelected = selectedSubtitleIds.includes(subtitle.id);
          const isPrimary = selectedSubtitleId === subtitle.id;
          const isActive = activeSubtitleId === subtitle.id;

          return (
            <div
              key={subtitle.id}
              data-subtitle-id={subtitle.id}
              className={[
                "subtitle-row",
                isSelected ? "selected" : "",
                isPrimary ? "primary-selected" : "",
                isActive ? "active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onContextMenu={(event) => {
                const target = event.target as HTMLElement;
                if (target.closest("input, textarea, [contenteditable='true']"))
                  return;
                if (!onReveal || !canShowNativeContextMenu()) return;
                event.preventDefault();
                event.stopPropagation();
                void showNativeContextMenu([
                  {
                    id: `subtitle-browser.${subtitle.id}.reveal`,
                    text: "Reveal in Timeline",
                    action: () => onReveal(subtitle.id),
                  },
                ]).catch((error) => {
                  console.error(
                    "Failed to show native subtitle browser context menu:",
                    error,
                  );
                });
              }}
              onClick={(event) => {
                const mode = event.shiftKey
                  ? "range"
                  : event.metaKey || event.ctrlKey
                    ? "toggle"
                    : "single";

                onSelect(subtitle.id, subtitle.startTime, mode);
              }}
            >
              <span className="subtitle-row-time">
                {formatSubtitleTime(subtitle.startTime)}
              </span>

              <input
                className="subtitle-row-text"
                value={subtitle.text}
                onClick={(event) => event.stopPropagation()}
                onFocus={() =>
                  onSelect(subtitle.id, subtitle.startTime, "single")
                }
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
  );
}

export default SubtitleList;
