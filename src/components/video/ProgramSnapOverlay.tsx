import { useMemo } from "react";

import {
  programAspectGuideRects,
  type ProgramSnapGuide,
} from "../../utils/programSnapping";

import "./ProgramSnapOverlay.css";

type ProgramSnapOverlayProps = {
  width: number;
  height: number;
  activeGuides?: ProgramSnapGuide[];
  show: boolean;
};

function ProgramSnapOverlay({
  width,
  height,
  activeGuides = [],
  show,
}: ProgramSnapOverlayProps) {
  const aspectRects = useMemo(
    () => programAspectGuideRects(width, height),
    [width, height],
  );

  if (!show || width <= 0 || height <= 0) {
    return null;
  }

  const activeTargetIds = new Set(
    activeGuides
      .map((guide) => guide.targetId)
      .filter((id): id is string => Boolean(id)),
  );
  const playerEdgeActive = activeTargetIds.has("player-edge");

  return (
    <div
      className={`program-snap-v2-overlay${playerEdgeActive ? " player-edge-active" : ""}`}
      aria-hidden="true"
    >
      {aspectRects.map((rect) => {
        const active = activeTargetIds.has(rect.id);

        return (
          <div
            key={rect.id}
            className={`program-aspect-guide${active ? " active" : ""}`}
            style={{
              left: rect.left,
              top: rect.top,
              width: rect.right - rect.left,
              height: rect.bottom - rect.top,
            }}
          >
            <span className="program-aspect-guide-label">{rect.label}</span>
          </div>
        );
      })}

      {activeGuides.map((guide, index) => (
        <span
          key={`${guide.axis}-${guide.percent}-${guide.targetId ?? "guide"}-${index}`}
          className={`program-snap-v2-line ${guide.axis}`}
          style={
            guide.axis === "x"
              ? { left: `${guide.percent}%` }
              : { top: `${guide.percent}%` }
          }
        />
      ))}
    </div>
  );
}

export default ProgramSnapOverlay;
