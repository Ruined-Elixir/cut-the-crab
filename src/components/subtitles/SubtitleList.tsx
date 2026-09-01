import { useEffect, useRef } from "react";

import type { Subtitle } from "../../types/subtitle";
import { formatSubtitleTime } from "../../utils/time";
import "./SubtitleList.css";

type SubtitleListProps = {
  subtitles: Subtitle[];

  selectedSubtitleId: string | null;
  activeSubtitleId: string | null;

  search: string;

  onSelect: (
    id: string,
    startTime: number
  ) => void;

  onTextChange: (
    id: string,
    text: string
  ) => void;

  onDelete: (id: string) => void;
};

function SubtitleList({
  subtitles,
  selectedSubtitleId,
  activeSubtitleId,
  search,
  onSelect,
  onTextChange,
  onDelete,
}: SubtitleListProps) {
  const listRef =
    useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (
      !activeSubtitleId ||
      !listRef.current
    ) {
      return;
    }

    const element =
      listRef.current.querySelector(
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
    <div
      ref={listRef}
      className="subtitle-list"
    >
      {subtitles.length === 0 ? (
        <p className="subtitle-empty">
          {search
            ? "No matching subtitles."
            : "No subtitles yet."}
        </p>
      ) : (
        subtitles.map((subtitle) => {
          const isSelected =
            selectedSubtitleId === subtitle.id;

          const isActive =
            activeSubtitleId === subtitle.id;

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
              onClick={() =>
                onSelect(
                  subtitle.id,
                  subtitle.startTime
                )
              }
            >
              <span className="subtitle-row-time">
                {formatSubtitleTime(
                  subtitle.startTime
                )}
              </span>

              <input
                className="subtitle-row-text"
                value={subtitle.text}
                onClick={(event) =>
                  event.stopPropagation()
                }
                onFocus={() =>
                  onSelect(
                    subtitle.id,
                    subtitle.startTime
                  )
                }
                onChange={(event) =>
                  onTextChange(
                    subtitle.id,
                    event.target.value
                  )
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