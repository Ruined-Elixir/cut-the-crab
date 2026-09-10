import { useMemo, useState } from "react";

import type { ProjectMediaAsset } from "../../types/project";

import "./MediaBrowser.css";

type MediaBrowserProps = {
  assets: ProjectMediaAsset[];
  primaryVideoPath: string | null;
  onImportMedia: () => void | Promise<void>;
  onInsertMedia: (asset: ProjectMediaAsset) => void;
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
}: MediaBrowserProps) {
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.id === selectedAssetId) ?? null,
    [assets, selectedAssetId],
  );

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
                onClick={() => setSelectedAssetId(asset.id)}
                onDoubleClick={() => onInsertMedia(asset)}
                title={asset.path}
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
        Double-click a media item to insert it on V1 at the playhead.
      </p>
    </aside>
  );
}

export default MediaBrowser;
