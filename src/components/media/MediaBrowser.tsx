import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import type { ProjectMediaAsset } from "../../types/project";
import type { TimelineTrackId } from "../../types/timelineModel";

import "./MediaBrowser.css";

type MediaBrowserProps = {
  assets: ProjectMediaAsset[];
  primaryVideoPath: string | null;
  onImportMedia: () => void | Promise<void>;
  onInsertMedia: (asset: ProjectMediaAsset) => void;
  timelineDuration: number;
  onDropMedia: (
    assetId: string,
    targetTrackId: TimelineTrackId,
    timelineTime: number,
  ) => void;
};

function formatDuration(duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return "--:--";
  }

  const totalSeconds = Math.round(duration);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function MediaBrowser({
  assets,
  primaryVideoPath,
  onImportMedia,
  onInsertMedia,
  timelineDuration,
  onDropMedia,
}: MediaBrowserProps) {
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.id === selectedAssetId) ?? null,
    [assets, selectedAssetId],
  );


  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const didDragRef = useRef(false);

  const clearTrackPreview = () => {
    document
      .querySelectorAll<HTMLElement>(".video-track.media-drag-target")
      .forEach((element) => {
        element.classList.remove("media-drag-target");
        element.style.removeProperty("--media-drag-left");
        element.style.removeProperty("--media-drag-width");
      });
  };

  const removeDragGhost = () => {
    dragGhostRef.current?.remove();
    dragGhostRef.current = null;
  };

  const getTimelineDropTarget = (clientX: number, clientY: number) => {
    const target = document
      .elementsFromPoint(clientX, clientY)
      .find(
        (element) =>
          element instanceof HTMLElement &&
          element.matches(".video-track[data-video-track-id]"),
      );

    if (!(target instanceof HTMLElement)) {
      return null;
    }

    if (target.dataset.trackLocked === "true") {
      return null;
    }

    const trackId = target.dataset.videoTrackId;

    if (!trackId || timelineDuration <= 0) {
      return null;
    }

    const rect = target.getBoundingClientRect();
    const ratio = Math.max(
      0,
      Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)),
    );

    return {
      element: target,
      trackId,
      timelineTime: ratio * timelineDuration,
    };
  };

  const setTrackPreview = (
    element: HTMLElement,
    timelineTime: number,
    mediaDuration: number,
  ) => {
    clearTrackPreview();

    const left =
      timelineDuration > 0 ? (timelineTime / timelineDuration) * 100 : 0;
    const width =
      timelineDuration > 0 ? (mediaDuration / timelineDuration) * 100 : 0;

    element.classList.add("media-drag-target");
    element.style.setProperty("--media-drag-left", `${left}%`);
    element.style.setProperty(
      "--media-drag-width",
      `${Math.max(0.6, width)}%`,
    );
  };

  const startMediaPointerDrag = (
    event: ReactMouseEvent<HTMLButtonElement>,
    asset: ProjectMediaAsset,
  ) => {
    if (event.button !== 0 || asset.duration <= 0) {
      return;
    }

    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;

    didDragRef.current = false;

    const ensureGhost = () => {
      if (dragGhostRef.current) {
        return dragGhostRef.current;
      }

      const ghost = document.createElement("div");
      ghost.className = "media-browser-drag-ghost";
      ghost.textContent = asset.name;
      document.body.appendChild(ghost);
      dragGhostRef.current = ghost;
      return ghost;
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const distance = Math.hypot(
        moveEvent.clientX - startX,
        moveEvent.clientY - startY,
      );

      if (!dragging && distance < 5) {
        return;
      }

      dragging = true;
      didDragRef.current = true;
      moveEvent.preventDefault();

      const ghost = ensureGhost();
      ghost.style.left = `${moveEvent.clientX + 14}px`;
      ghost.style.top = `${moveEvent.clientY + 14}px`;

      const target = getTimelineDropTarget(
        moveEvent.clientX,
        moveEvent.clientY,
      );

      if (target) {
        setTrackPreview(
          target.element,
          target.timelineTime,
          asset.duration,
        );
        ghost.classList.add("can-drop");
      } else {
        clearTrackPreview();
        ghost.classList.remove("can-drop");
      }
    };

    const handleMouseUp = (upEvent: MouseEvent) => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);

      const target = dragging
        ? getTimelineDropTarget(upEvent.clientX, upEvent.clientY)
        : null;

      if (target) {
        onDropMedia(asset.id, target.trackId, target.timelineTime);
      }

      clearTrackPreview();
      removeDragGhost();

      if (dragging) {
        window.setTimeout(() => {
          didDragRef.current = false;
        }, 0);
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <aside className="media-browser" aria-label="Media browser">
      <div className="media-browser-header">
        <div>
          <span className="media-browser-eyebrow">Browser</span>
          <h2>Media</h2>
        </div>

        <span className="media-browser-count">{assets.length}</span>
      </div>

      <button
        type="button"
        className="media-import-button"
        onClick={() => void onImportMedia()}
      >
        <span aria-hidden="true">＋</span>
        Import Media
      </button>

      <div className="media-browser-list">
        {assets.length === 0 ? (
          <div className="media-browser-empty">
            <span className="media-browser-empty-icon" aria-hidden="true">▶</span>
            <p>Import video files to add them to this project.</p>
          </div>
        ) : (
          assets.map((asset) => {
            const selected = asset.id === selectedAssetId;
            const isPrimary = asset.path === primaryVideoPath;

            return (
              <button
                key={asset.id}
                type="button"
                className={["media-browser-item", selected ? "selected" : ""]
                  .filter(Boolean)
                  .join(" ")}
                onMouseDown={(event) => startMediaPointerDrag(event, asset)}
                onClick={() => {
                  if (!didDragRef.current) {
                    setSelectedAssetId(asset.id);
                  }
                }}
                onDoubleClick={() => {
                  if (!didDragRef.current) {
                    onInsertMedia(asset);
                  }
                }}
                title={`${asset.path} — drag directly to V1 or V2 to insert`}
              >
                <span className="media-browser-thumbnail" aria-hidden="true">
                  ▶
                </span>

                <span className="media-browser-item-copy">
                  <span className="media-browser-item-name">{asset.name}</span>
                  <span className="media-browser-item-meta">
                    {formatDuration(asset.duration)}
                    {isPrimary ? " · Primary" : ""}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>

      <button
        type="button"
        className="media-insert-button"
        disabled={!selectedAsset || selectedAsset.duration <= 0}
        onClick={() => {
          if (selectedAsset) {
            onInsertMedia(selectedAsset);
          }
        }}
      >
        Insert at Playhead
      </button>

      <p className="media-browser-hint">
        Drag a media card directly onto V1/V2, or double-click to insert at the playhead.
      </p>
    </aside>
  );
}

export default MediaBrowser;
