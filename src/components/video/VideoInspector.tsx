import type { VideoTimelineClip } from "../../types/timelineModel";

import "./VideoInspector.css";

type VideoTransformPatch = {
  positionX?: number;
  positionY?: number;
  scale?: number;
  rotation?: number;
  cropTop?: number;
  cropRight?: number;
  cropBottom?: number;
  cropLeft?: number;
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
  const rotation = clip.rotation ?? 0;
  const cropTop = clip.cropTop ?? 0;
  const cropRight = clip.cropRight ?? 0;
  const cropBottom = clip.cropBottom ?? 0;
  const cropLeft = clip.cropLeft ?? 0;

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

  const renderRangeControl = (
    label: string,
    key: keyof VideoTransformPatch,
    value: number,
    min: number,
    max: number,
    step: number,
    suffix: string,
  ) => (
    <label className="video-inspector-control">
      <div className="video-inspector-label-row">
        <span>{label}</span>
        <div className="video-inspector-number-wrap">
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={Math.round(value * 10) / 10}
            disabled={disabled}
            onChange={(event) =>
              updateNumber(key, event.target.value, min, max)
            }
          />
          <span>{suffix}</span>
        </div>
      </div>

      <input
        className="video-inspector-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) =>
          onTransformChange(clip.id, {
            [key]: Number(event.target.value),
          })
        }
      />
    </label>
  );

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
            Reset All
          </button>
        </div>

        {renderRangeControl("Position X", "positionX", positionX, -100, 100, 0.5, "%")}
        {renderRangeControl("Position Y", "positionY", positionY, -100, 100, 0.5, "%")}
        {renderRangeControl("Scale", "scale", scale, 10, 400, 1, "%")}
        {renderRangeControl("Rotation", "rotation", rotation, -180, 180, 1, "°")}
      </section>

      <section className="video-inspector-section video-inspector-crop-section">
        <div className="video-inspector-section-heading">
          <h3>Crop</h3>

          <button
            type="button"
            className="video-inspector-reset"
            disabled={disabled}
            onClick={() =>
              onTransformChange(clip.id, {
                cropTop: 0,
                cropRight: 0,
                cropBottom: 0,
                cropLeft: 0,
              })
            }
          >
            Reset Crop
          </button>
        </div>

        {renderRangeControl("Top", "cropTop", cropTop, 0, 49, 0.5, "%")}
        {renderRangeControl("Right", "cropRight", cropRight, 0, 49, 0.5, "%")}
        {renderRangeControl("Bottom", "cropBottom", cropBottom, 0, 49, 0.5, "%")}
        {renderRangeControl("Left", "cropLeft", cropLeft, 0, 49, 0.5, "%")}
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
