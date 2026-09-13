export type ProgramSnapGuide = {
  axis: "x" | "y";
  percent: number;
};

export type ProgramSnapResult = {
  value: number;
  guide: ProgramSnapGuide | null;
};

export type ProgramBounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerX: number;
  centerY: number;
};

export type ProgramBoundsSnapResult = {
  deltaPx: number;
  guide: ProgramSnapGuide | null;
};

// Common editing-layout guides: safe margins, quarters, thirds, center.
export const PROGRAM_SNAP_POINTS = [10, 25, 33.3333, 50, 66.6667, 75, 90] as const;

export const PROGRAM_SNAP_THRESHOLD_PX = 7;
export const PROGRAM_OBJECT_SNAP_THRESHOLD_PX = 5;

export function snapProgramPercent(
  valuePercent: number,
  axisSizePx: number,
  axis: "x" | "y",
  thresholdPx = PROGRAM_SNAP_THRESHOLD_PX,
): ProgramSnapResult {
  if (!Number.isFinite(valuePercent) || axisSizePx <= 0) {
    return { value: valuePercent, guide: null };
  }

  let closest: number = PROGRAM_SNAP_POINTS[0];
  let closestDistancePx = Number.POSITIVE_INFINITY;

  for (const point of PROGRAM_SNAP_POINTS) {
    const distancePx = Math.abs(valuePercent - point) * axisSizePx / 100;

    if (distancePx < closestDistancePx) {
      closest = point;
      closestDistancePx = distancePx;
    }
  }

  if (closestDistancePx > thresholdPx) {
    return { value: valuePercent, guide: null };
  }

  return {
    value: closest,
    guide: { axis, percent: closest },
  };
}

export function snapProgramBoundsToBounds(
  movingBounds: ProgramBounds,
  targetBounds: ProgramBounds[],
  axisSizePx: number,
  axis: "x" | "y",
  thresholdPx = PROGRAM_SNAP_THRESHOLD_PX,
): ProgramBoundsSnapResult {
  if (axisSizePx <= 0 || targetBounds.length === 0) {
    return { deltaPx: 0, guide: null };
  }

  const movingPoints =
    axis === "x"
      ? [movingBounds.left, movingBounds.centerX, movingBounds.right]
      : [movingBounds.top, movingBounds.centerY, movingBounds.bottom];

  let bestDeltaPx = 0;
  let bestGuidePositionPx = 0;
  let bestDistancePx = Number.POSITIVE_INFINITY;

  for (const target of targetBounds) {
    const targetPoints =
      axis === "x"
        ? [target.left, target.centerX, target.right]
        : [target.top, target.centerY, target.bottom];

    for (const movingPoint of movingPoints) {
      for (const targetPoint of targetPoints) {
        const deltaPx = targetPoint - movingPoint;
        const distancePx = Math.abs(deltaPx);

        if (distancePx < bestDistancePx) {
          bestDistancePx = distancePx;
          bestDeltaPx = deltaPx;
          bestGuidePositionPx = targetPoint;
        }
      }
    }
  }

  if (bestDistancePx > thresholdPx) {
    return { deltaPx: 0, guide: null };
  }

  return {
    deltaPx: bestDeltaPx,
    guide: {
      axis,
      percent: (bestGuidePositionPx / axisSizePx) * 100,
    },
  };
}
