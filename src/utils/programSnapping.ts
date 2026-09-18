export type ProgramSnapGuide = {
  axis: "x" | "y";
  percent: number;
  targetId?: string;
  targetKind?: "object" | "layout" | "aspect" | "player-edge";
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

export type ProgramAspectGuideRect = ProgramBounds & {
  id: string;
  label: string;
};

export type ProgramSnapLine = {
  positionPx: number;
  targetId: string;
  targetKind: NonNullable<ProgramSnapGuide["targetKind"]>;
};

// Existing Program Monitor alignment points remain available as a fallback.
export const PROGRAM_SNAP_POINTS = [10, 25, 33.3333, 50, 66.6667, 75, 90] as const;

export const PROGRAM_SNAP_THRESHOLD_PX = 7;
export const PROGRAM_OBJECT_SNAP_THRESHOLD_PX = 5;
export const PROGRAM_FRAME_SNAP_THRESHOLD_PX = 8;

const PROGRAM_ASPECT_GUIDE_SPECS = [
  { id: "aspect-16-9", label: "16:9", aspect: 16 / 9 },
  { id: "aspect-4-3", label: "4:3", aspect: 4 / 3 },
  { id: "aspect-1-1", label: "1:1", aspect: 1 },
  { id: "aspect-9-16", label: "Reels 9:16", aspect: 9 / 16 },
] as const;

/**
 * Returns centered presentation guides inside the Program Monitor.
 * The guides deliberately leave a margin so the actual player edge remains a
 * separate soft snap target.
 */
export function programAspectGuideRects(
  widthPx: number,
  heightPx: number,
): ProgramAspectGuideRect[] {
  const width = Math.max(1, widthPx);
  const height = Math.max(1, heightPx);
  const availableWidth = width * 0.88;
  const availableHeight = height * 0.88;

  return PROGRAM_ASPECT_GUIDE_SPECS.map((spec) => {
    let rectWidth = availableWidth;
    let rectHeight = rectWidth / spec.aspect;

    if (rectHeight > availableHeight) {
      rectHeight = availableHeight;
      rectWidth = rectHeight * spec.aspect;
    }

    const left = (width - rectWidth) / 2;
    const top = (height - rectHeight) / 2;

    return {
      id: spec.id,
      label: spec.label,
      left,
      right: left + rectWidth,
      top,
      bottom: top + rectHeight,
      centerX: width / 2,
      centerY: height / 2,
    };
  });
}

export function programFrameSnapLines(
  widthPx: number,
  heightPx: number,
  axis: "x" | "y",
): ProgramSnapLine[] {
  const width = Math.max(1, widthPx);
  const height = Math.max(1, heightPx);
  const aspectRects = programAspectGuideRects(width, height);

  const edgeLines: ProgramSnapLine[] =
    axis === "x"
      ? [
          { positionPx: 0, targetId: "player-edge", targetKind: "player-edge" },
          { positionPx: width, targetId: "player-edge", targetKind: "player-edge" },
        ]
      : [
          { positionPx: 0, targetId: "player-edge", targetKind: "player-edge" },
          { positionPx: height, targetId: "player-edge", targetKind: "player-edge" },
        ];

  const aspectLines = aspectRects.flatMap<ProgramSnapLine>((rect) =>
    axis === "x"
      ? [
          { positionPx: rect.left, targetId: rect.id, targetKind: "aspect" },
          { positionPx: rect.right, targetId: rect.id, targetKind: "aspect" },
        ]
      : [
          { positionPx: rect.top, targetId: rect.id, targetKind: "aspect" },
          { positionPx: rect.bottom, targetId: rect.id, targetKind: "aspect" },
        ],
  );

  return [...edgeLines, ...aspectLines];
}

export function programLayoutSnapLines(
  axisStartPx: number,
  axisSizePx: number,
): ProgramSnapLine[] {
  return PROGRAM_SNAP_POINTS.map((point) => ({
    positionPx: axisStartPx + (point / 100) * axisSizePx,
    targetId: `layout-${point}`,
    targetKind: "layout" as const,
  }));
}

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
    guide: { axis, percent: closest, targetId: `layout-${closest}`, targetKind: "layout" },
  };
}

export function snapProgramBoundsToLines(
  movingBounds: ProgramBounds,
  targetLines: ProgramSnapLine[],
  axisSizePx: number,
  axis: "x" | "y",
  thresholdPx = PROGRAM_FRAME_SNAP_THRESHOLD_PX,
): ProgramBoundsSnapResult {
  if (axisSizePx <= 0 || targetLines.length === 0) {
    return { deltaPx: 0, guide: null };
  }

  // Frame/aspect snapping is edge-to-edge. The object's centre remains free so
  // the magnetic feeling stays light rather than turning the guides into rails.
  const movingPoints =
    axis === "x"
      ? [movingBounds.left, movingBounds.right]
      : [movingBounds.top, movingBounds.bottom];

  let bestDeltaPx = 0;
  let bestLine: ProgramSnapLine | null = null;
  let bestDistancePx = Number.POSITIVE_INFINITY;

  for (const movingPoint of movingPoints) {
    for (const line of targetLines) {
      const deltaPx = line.positionPx - movingPoint;
      const distancePx = Math.abs(deltaPx);

      if (distancePx < bestDistancePx) {
        bestDistancePx = distancePx;
        bestDeltaPx = deltaPx;
        bestLine = line;
      }
    }
  }

  if (!bestLine || bestDistancePx > thresholdPx) {
    return { deltaPx: 0, guide: null };
  }

  return {
    deltaPx: bestDeltaPx,
    guide: {
      axis,
      percent: (bestLine.positionPx / axisSizePx) * 100,
      targetId: bestLine.targetId,
      targetKind: bestLine.targetKind,
    },
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
      targetKind: "object",
    },
  };
}

export function snapProgramPointToLines(
  movingPointPx: number,
  targetLines: ProgramSnapLine[],
  axisSizePx: number,
  axis: "x" | "y",
  thresholdPx = PROGRAM_SNAP_THRESHOLD_PX,
): ProgramBoundsSnapResult {
  if (axisSizePx <= 0 || targetLines.length === 0) {
    return { deltaPx: 0, guide: null };
  }

  let bestDeltaPx = 0;
  let bestLine: ProgramSnapLine | null = null;
  let bestDistancePx = Number.POSITIVE_INFINITY;

  for (const line of targetLines) {
    const deltaPx = line.positionPx - movingPointPx;
    const distancePx = Math.abs(deltaPx);

    if (distancePx < bestDistancePx) {
      bestDistancePx = distancePx;
      bestDeltaPx = deltaPx;
      bestLine = line;
    }
  }

  if (!bestLine || bestDistancePx > thresholdPx) {
    return { deltaPx: 0, guide: null };
  }

  return {
    deltaPx: bestDeltaPx,
    guide: {
      axis,
      percent: (bestLine.positionPx / axisSizePx) * 100,
      targetId: bestLine.targetId,
      targetKind: bestLine.targetKind,
    },
  };
}
