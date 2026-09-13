import type { VideoTimelineClip } from "../../types/timelineModel";

import "./VideoInspector.css";

type VideoTransformPatch = {
  positionX?: number;
  positionY?: number;
  scale?: number;
};

type VideoInspectorProps = {
  clip: VideoTimelineClip;
  disabled?: boolean;
  onTransformChange: (id: string, transform: VideoTransformPatch) => void;
  onResetTransform: (id: string) => void;
};

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
}

function VideoInspector({
  clip,
  disabled = false,
  onTransformChange,
  onResetTransform,
}: VideoInspectorProps) {
  const positionX = clip.positionX ?? 0;
  const positionY = clip.positionY ?? 0;
  const scale = clip.scale ?? 100;

  const updateNumber = (
    key: keyof VideoTransformPatch,
    rawValue: string,
    min: number,
    max: number,
  ) => {
    const parsed = Number(rawValue);

    if (!Number.isFinite(parsed)) {
      return;
    }

    onTransformChange(clip.id, {
      [key]: clampNumber(parsed, min, max),
    });
  };

  return (
    <aside className="video-inspector">
      <div className="video-inspector-header">
        <div>
          <span className="video-inspector-eyebrow">Inspector</span>
          <h2>Video</h2>
        </div>

        <span className="video-inspector-track">
          {clip.trackId === "video-2" ? "V2" : "V1"}
        </span>
      </div>

      <div className="video-inspector-clip-name" title={clip.sourceName}>
        {clip.sourceName}
      </div>

      <section className="video-inspector-section">
        <div className="video-inspector-section-heading">
          <h3>Transform</h3>

          <button
            type="button"
            className="video-inspector-reset"
            onClick={() => onResetTransform(clip.id)}
            disabled={disabled}
          >
            Reset
          </button>
        </div>

        <label className="video-inspector-control">
          <div className="video-inspector-label-row">
            <span>Position X</span>
            <div className="video-inspector-number-wrap">
              <input
                type="number"
                min={-100}
                max={100}
                step={1}
                value={Math.round(positionX * 10) / 10}
                disabled={disabled}
                onChange={(event) =>
                  updateNumber("positionX", event.target.value, -100, 100)
                }
              />
              <span>%</span>
            </div>
          </div>

          <input
            className="video-inspector-range"
            type="range"
            min={-100}
            max={100}
            step={0.5}
            value={positionX}
            disabled={disabled}
            onChange={(event) =>
              onTransformChange(clip.id, {
                positionX: Number(event.target.value),
              })
            }
          />
        </label>

        <label className="video-inspector-control">
          <div className="video-inspector-label-row">
            <span>Position Y</span>
            <div className="video-inspector-number-wrap">
              <input
                type="number"
                min={-100}
                max={100}
                step={1}
                value={Math.round(positionY * 10) / 10}
                disabled={disabled}
                onChange={(event) =>
                  updateNumber("positionY", event.target.value, -100, 100)
                }
              />
              <span>%</span>
            </div>
          </div>

          <input
            className="video-inspector-range"
            type="range"
            min={-100}
            max={100}
            step={0.5}
            value={positionY}
            disabled={disabled}
            onChange={(event) =>
              onTransformChange(clip.id, {
                positionY: Number(event.target.value),
              })
            }
          />
        </label>

        <label className="video-inspector-control">
          <div className="video-inspector-label-row">
            <span>Scale</span>
            <div className="video-inspector-number-wrap">
              <input
                type="number"
                min={10}
                max={400}
                step={1}
                value={Math.round(scale * 10) / 10}
                disabled={disabled}
                onChange={(event) =>
                  updateNumber("scale", event.target.value, 10, 400)
                }
              />
              <span>%</span>
            </div>
          </div>

          <input
            className="video-inspector-range"
            type="range"
            min={10}
            max={400}
            step={1}
            value={scale}
            disabled={disabled}
            onChange={(event) =>
              onTransformChange(clip.id, {
                scale: Number(event.target.value),
              })
            }
          />
        </label>
      </section>

      {disabled && (
        <p className="video-inspector-locked-message">
          Unlock this track to change the clip transform.
        </p>
      )}
    </aside>
  );
}

export default VideoInspector;
