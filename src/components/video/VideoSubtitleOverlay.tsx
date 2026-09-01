import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { Subtitle } from "../../types/subtitle";
import "./VideoSubtitleOverlay.css";

type VideoSubtitleOverlayProps = {
  activeSubtitle: Subtitle;
  selectedSubtitleId?: string | null;

  shellRef: React.RefObject<HTMLDivElement | null>;

  onSubtitleSelect?: (id: string) => void;

  onSubtitlePositionChange?: (
    id: string,
    positionX: number,
    positionY: number
  ) => void;

  onSubtitleTextChange?: (
    id: string,
    text: string
  ) => void;
};

function VideoSubtitleOverlay({
  activeSubtitle,
  selectedSubtitleId,
  shellRef,
  onSubtitleSelect,
  onSubtitlePositionChange,
  onSubtitleTextChange,
}: VideoSubtitleOverlayProps) {
  const [editingSubtitleId, setEditingSubtitleId] =
    useState<string | null>(null);

  const [editingText, setEditingText] = useState("");

  const subtitleButtonRef =
    useRef<HTMLButtonElement | null>(null);

  const subtitleTextareaRef =
    useRef<HTMLTextAreaElement | null>(null);

  const isEditing =
    editingSubtitleId === activeSubtitle.id;

  const startEditingSubtitle = () => {
    onSubtitleSelect?.(activeSubtitle.id);

    setEditingSubtitleId(activeSubtitle.id);
    setEditingText(activeSubtitle.text);
  };

  const finishEditingSubtitle = () => {
    onSubtitleTextChange?.(
      activeSubtitle.id,
      editingText
    );

    setEditingSubtitleId(null);
  };

  const cancelEditingSubtitle = () => {
    setEditingText(activeSubtitle.text);
    setEditingSubtitleId(null);
  };

  const handleSubtitlePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>
  ) => {
    if (!shellRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    onSubtitleSelect?.(activeSubtitle.id);

    const shell = shellRef.current;

    const handlePointerMove = (
      moveEvent: PointerEvent
    ) => {
      const shellRect =
        shell.getBoundingClientRect();

      const subtitleRect =
        subtitleButtonRef.current?.getBoundingClientRect();

      let x =
        ((moveEvent.clientX - shellRect.left) /
          shellRect.width) *
        100;

      let y =
        ((moveEvent.clientY - shellRect.top) /
          shellRect.height) *
        100;

      if (subtitleRect) {
        const halfWidthPercent =
          (subtitleRect.width / shellRect.width) * 50;

        const halfHeightPercent =
          (subtitleRect.height / shellRect.height) * 50;

        x = Math.max(
          halfWidthPercent,
          Math.min(100 - halfWidthPercent, x)
        );

        y = Math.max(
          halfHeightPercent,
          Math.min(100 - halfHeightPercent, y)
        );
      }

      onSubtitlePositionChange?.(
        activeSubtitle.id,
        x,
        y
      );
    };

    const handlePointerUp = () => {
      window.removeEventListener(
        "pointermove",
        handlePointerMove
      );

      window.removeEventListener(
        "pointerup",
        handlePointerUp
      );
    };

    window.addEventListener(
      "pointermove",
      handlePointerMove
    );

    window.addEventListener(
      "pointerup",
      handlePointerUp
    );
  };

  return (
    <div className="video-subtitle-layer">
      {isEditing ? (
        <textarea
          ref={subtitleTextareaRef}
          className="video-subtitle-preview editing"
          style={{
            left: `${activeSubtitle.positionX ?? 50}%`,
            top: `${activeSubtitle.positionY ?? 80}%`,
          }}
          value={editingText}
          autoFocus
          onChange={(event) =>
            setEditingText(event.target.value)
          }
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey
            ) {
              event.preventDefault();
              finishEditingSubtitle();
            }

            if (event.key === "Escape") {
              event.preventDefault();
              cancelEditingSubtitle();
            }
          }}
          onPointerDown={(event) =>
            event.stopPropagation()
          }
          onClick={(event) =>
            event.stopPropagation()
          }
        />
      ) : (
        <button
          ref={subtitleButtonRef}
          className={[
            "video-subtitle-preview",
            selectedSubtitleId === activeSubtitle.id
              ? "selected"
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{
            left: `${activeSubtitle.positionX ?? 50}%`,
            top: `${activeSubtitle.positionY ?? 80}%`,
          }}
          onPointerDown={handleSubtitlePointerDown}
          onDoubleClick={(event) => {
            event.stopPropagation();
            startEditingSubtitle();
          }}
          type="button"
        >
          {activeSubtitle.text}
        </button>
      )}
    </div>
  );
}

export default VideoSubtitleOverlay;