import type { VideoTimelineClip, VideoTransitionType } from "../../types/timelineModel";

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
  onTransitionChange: (
    id: string,
    edge: "in" | "out",
    transition: { type?: VideoTransitionType; duration?: number },
  ) => void;
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
  onTransitionChange,
}: VideoInspectorProps) {
  const positionX = clip.positionX ?? 0;
  const positionY = clip.positionY ?? 0;
  const scale = clip.scale ?? 100;
  const rotation = clip.rotation ?? 0;
  const cropTop = clip.cropTop ?? 0;
  const cropRight = clip.cropRight ?? 0;
  const cropBottom = clip.cropBottom ?? 0;
  const cropLeft = clip.cropLeft ?? 0;
  const transitionInType = clip.transitionInType ?? "none";
  const transitionInDuration = clip.transitionInDuration ?? 0.5;
  const transitionOutType = clip.transitionOutType ?? "none";
  const transitionOutDuration = clip.transitionOutDuration ?? 0.5;
  const clipDuration = Math.max(0.1, clip.timelineEnd - clip.timelineStart);
  const maxTransitionDuration = Math.max(0.1, Math.min(5, clipDuration / 2));

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


      <section className="video-inspector-section video-inspector-transition-section">
        <div className="video-inspector-section-heading">
          <h3>Transitions</h3>
        </div>

        <div className="video-transition-block">
          <div className="video-transition-title">Transition In</div>
          <label className="video-transition-select-row">
            <span>Type</span>
            <select
              value={transitionInType}
              disabled={disabled}
              onChange={(event) =>
                onTransitionChange(clip.id, "in", {
                  type: event.target.value as VideoTransitionType,
                })
              }
            >
              <option value="none">None</option>
              <option value="cross-dissolve">Cross Dissolve</option>
              <option value="fade-black">Fade from Black</option>
            </select>
          </label>
          {transitionInType !== "none" && (
            <label className="video-inspector-control">
              <div className="video-inspector-label-row">
                <span>Duration</span>
                <div className="video-inspector-number-wrap">
                  <input
                    type="number"
                    min={0.1}
                    max={maxTransitionDuration}
                    step={0.1}
                    value={Math.round(Math.min(transitionInDuration, maxTransitionDuration) * 10) / 10}
                    disabled={disabled}
                    onChange={(event) =>
                      onTransitionChange(clip.id, "in", {
                        duration: Number(event.target.value),
                      })
                    }
                  />
                  <span>s</span>
                </div>
              </div>
              <input
                className="video-inspector-range"
                type="range"
                min={0.1}
                max={maxTransitionDuration}
                step={0.1}
                value={Math.min(transitionInDuration, maxTransitionDuration)}
                disabled={disabled}
                onChange={(event) =>
                  onTransitionChange(clip.id, "in", {
                    duration: Number(event.target.value),
                  })
                }
              />
            </label>
          )}
        </div>

        <div className="video-transition-block">
          <div className="video-transition-title">Transition Out</div>
          <label className="video-transition-select-row">
            <span>Type</span>
            <select
              value={transitionOutType}
              disabled={disabled}
              onChange={(event) =>
                onTransitionChange(clip.id, "out", {
                  type: event.target.value as VideoTransitionType,
                })
              }
            >
              <option value="none">None</option>
              <option value="cross-dissolve">Cross Dissolve</option>
              <option value="fade-black">Fade to Black</option>
            </select>
          </label>
          {transitionOutType !== "none" && (
            <label className="video-inspector-control">
              <div className="video-inspector-label-row">
                <span>Duration</span>
                <div className="video-inspector-number-wrap">
                  <input
                    type="number"
                    min={0.1}
                    max={maxTransitionDuration}
                    step={0.1}
                    value={Math.round(Math.min(transitionOutDuration, maxTransitionDuration) * 10) / 10}
                    disabled={disabled}
                    onChange={(event) =>
                      onTransitionChange(clip.id, "out", {
                        duration: Number(event.target.value),
                      })
                    }
                  />
                  <span>s</span>
                </div>
              </div>
              <input
                className="video-inspector-range"
                type="range"
                min={0.1}
                max={maxTransitionDuration}
                step={0.1}
                value={Math.min(transitionOutDuration, maxTransitionDuration)}
                disabled={disabled}
                onChange={(event) =>
                  onTransitionChange(clip.id, "out", {
                    duration: Number(event.target.value),
                  })
                }
              />
            </label>
          )}
        </div>
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
