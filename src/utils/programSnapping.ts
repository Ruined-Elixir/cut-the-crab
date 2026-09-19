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

// The editor is authored against one canonical 16:9 Program frame. Aspect
// guides are viewports cut from that frame, and export uses the same viewport
// math so the dashed box is a true representation of the final output.
export const PROGRAM_BASE_ASPECT = 16 / 9;

export type ProgramViewportRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * Center-crop viewport for a requested aspect inside a source frame.
 * Standard CTC presets (4:3, 1:1, 9:16) keep the full source height and
 * crop only the sides of the canonical 16:9 frame. Wider custom ratios keep
 * the full width and crop top/bottom instead.
 */
export function programViewportRectForAspect(
  sourceWidth: number,
  sourceHeight: number,
  aspect: number,
): ProgramViewportRect {
  const width = Math.max(1, sourceWidth);
  const height = Math.max(1, sourceHeight);
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : PROGRAM_BASE_ASPECT;
  const sourceAspect = width / height;

  if (safeAspect <= sourceAspect) {
    const viewportWidth = height * safeAspect;
    return {
      left: (width - viewportWidth) / 2,
      top: 0,
      width: viewportWidth,
      height,
    };
  }

  const viewportHeight = width / safeAspect;
  return {
    left: 0,
    top: (height - viewportHeight) / 2,
    width,
    height: viewportHeight,
  };
}

/**
 * Canonical 16:9 Program frame inside the available monitor shell. It uses as
 * much monitor height as possible (full height in the normal wide editor
 * layout) while remaining fully visible if the panel becomes unusually narrow.
 */
export function programBaseFrameRect(
  widthPx: number,
  heightPx: number,
): ProgramViewportRect {
  const width = Math.max(1, widthPx);
  const height = Math.max(1, heightPx);
  const shellAspect = width / height;

  if (shellAspect >= PROGRAM_BASE_ASPECT) {
    const frameWidth = height * PROGRAM_BASE_ASPECT;
    return {
      left: (width - frameWidth) / 2,
      top: 0,
      width: frameWidth,
      height,
    };
  }

  const frameHeight = width / PROGRAM_BASE_ASPECT;
  return {
    left: 0,
    top: (height - frameHeight) / 2,
    width,
    height: frameHeight,
  };
}

const PROGRAM_ASPECT_GUIDE_SPECS = [
  { id: "aspect-16-9", label: "16:9", aspect: 16 / 9 },
  { id: "aspect-4-3", label: "4:3", aspect: 4 / 3 },
  { id: "aspect-1-1", label: "1:1", aspect: 1 },
  { id: "aspect-9-16", label: "Reels 9:16", aspect: 9 / 16 },
] as const;

/**
 * Returns the real export viewports inside the Program Monitor. The outer
 * 16:9 frame uses the full available monitor height in the normal editor
 * layout; 4:3, 1:1 and 9:16 share that exact height and crop inward from the
 * sides. This is intentionally the same geometry used by final export.
 */
export function programAspectGuideRects(
  widthPx: number,
  heightPx: number,
): ProgramAspectGuideRect[] {
  const base = programBaseFrameRect(widthPx, heightPx);

  return PROGRAM_ASPECT_GUIDE_SPECS.map((spec) => {
    const localViewport = programViewportRectForAspect(
      base.width,
      base.height,
      spec.aspect,
    );
    const left = base.left + localViewport.left;
    const top = base.top + localViewport.top;
    const rectWidth = localViewport.width;
    const rectHeight = localViewport.height;

    return {
      id: spec.id,
      label: spec.label,
      left,
      right: left + rectWidth,
      top,
      bottom: top + rectHeight,
      centerX: left + rectWidth / 2,
      centerY: top + rectHeight / 2,
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
