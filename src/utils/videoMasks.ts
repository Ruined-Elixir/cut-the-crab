import type { CSSProperties } from "react";
import type { VideoMask, VideoMaskShape } from "../types/timelineModel";

export type VideoMaskGeometry = Pick<
  VideoMask,
  "positionX" | "positionY" | "width" | "height"
>;

export const DEFAULT_VIDEO_MASK: Omit<VideoMask, "id"> = {
  enabled: true,
  shape: "rectangle",
  invert: false,
  positionX: 50,
  positionY: 50,
  width: 50,
  height: 50,
  feather: 0,
};

function finite(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number, fallback: number) {
  return Math.max(min, Math.min(max, finite(value, fallback)));
}

function pct(value: number) {
  return `${Number(value.toFixed(4))}%`;
}

export function createVideoMask(
  shape: VideoMaskShape,
  geometry?: Partial<VideoMaskGeometry>,
): VideoMask {
  return normalizeVideoMask({
    id: `mask-${crypto.randomUUID()}`,
    ...DEFAULT_VIDEO_MASK,
    ...geometry,
    shape,
  })!;
}

export function normalizeVideoMask(
  mask: VideoMask | undefined,
): VideoMask | undefined {
  if (!mask) return undefined;

  return {
    id: mask.id || `mask-${crypto.randomUUID()}`,
    enabled: mask.enabled !== false,
    shape: mask.shape === "ellipse" ? "ellipse" : "rectangle",
    invert: mask.invert === true,
    positionX: clamp(mask.positionX, -100, 200, 50),
    positionY: clamp(mask.positionY, -100, 200, 50),
    width: clamp(mask.width, 1, 300, 50),
    height: clamp(mask.height, 1, 300, 50),
    feather: clamp(mask.feather, 0, 300, 0),
  };
}

export function cloneVideoMask(
  mask: VideoMask | undefined,
): VideoMask | undefined {
  return mask ? { ...mask } : undefined;
}

export function videoMasksEqual(
  left: VideoMask | undefined,
  right: VideoMask | undefined,
) {
  return (
    JSON.stringify(normalizeVideoMask(left) ?? null) ===
    JSON.stringify(normalizeVideoMask(right) ?? null)
  );
}

export function activeVideoMask(mask: VideoMask | undefined) {
  return mask?.enabled !== false ? normalizeVideoMask(mask) : undefined;
}

export function resetVideoMask(
  mask: VideoMask,
  geometry?: Partial<VideoMaskGeometry>,
): VideoMask {
  return normalizeVideoMask({
    id: mask.id,
    ...DEFAULT_VIDEO_MASK,
    ...geometry,
    shape: mask.shape,
  })!;
}

export function videoMaskSummary(mask: VideoMask | undefined) {
  if (!mask) return "No mask";
  return `${mask.shape === "ellipse" ? "Ellipse" : "Rectangle"}${
    mask.invert ? " · inverted" : ""
  }`;
}

function escapeSvg(svg: string) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function legacySvgMaskStyle(
  active: VideoMask,
  canvasAspect: number,
): CSSProperties {
  const left = active.positionX - active.width / 2;
  const top = active.positionY - active.height / 2;
  const blurY = (Math.max(0, active.feather) / 1080) * 100;
  const blurX = blurY / Math.max(0.01, canvasAspect);
  const background = active.invert ? "white" : "black";
  const foreground = active.invert ? "black" : "white";
  const filter = blurY > 0.0001 ? ` filter="url(#b)"` : "";
  const shape =
    active.shape === "ellipse"
      ? `<ellipse cx="${active.positionX}" cy="${active.positionY}" rx="${
          active.width / 2
        }" ry="${active.height / 2}" fill="${foreground}"${filter}/>`
      : `<rect x="${left}" y="${top}" width="${active.width}" height="${
          active.height
        }" fill="${foreground}"${filter}/>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none"><defs><filter id="b" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="${blurX} ${blurY}"/></filter><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect x="0" y="0" width="100" height="100" fill="${background}"/>${shape}</mask></defs><rect x="0" y="0" width="100" height="100" fill="white" mask="url(#m)"/></svg>`;
  const url = `url("${escapeSvg(svg)}")`;

  return {
    WebkitMaskImage: url,
    maskImage: url,
    WebkitMaskSize: "100% 100%",
    maskSize: "100% 100%",
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
  } as CSSProperties;
}

/**
 * Program-space preview mask.
 *
 * The first Masks v1 implementation rebuilt an encoded SVG data URL on every
 * pointer move. WebKit can briefly drop the composited video layer while that
 * new mask image is decoded, which looks like flashing during a mask drag.
 *
 * v1.1 keeps the same saved/export geometry but uses native CSS geometry for
 * the common interactive cases. Hard masks use clip-path, ellipse feathering
 * uses a radial gradient, and rectangle feathering uses intersecting linear
 * mask gradients. The encoded-SVG path remains only for the uncommon inverted
 * feathered rectangle case where CSS composition is less predictable.
 */
export function videoMaskCssStyle(
  mask: VideoMask | undefined,
  canvasAspect = 16 / 9,
): CSSProperties {
  const active = activeVideoMask(mask);
  if (!active) return {};

  const left = active.positionX - active.width / 2;
  const right = active.positionX + active.width / 2;
  const top = active.positionY - active.height / 2;
  const bottom = active.positionY + active.height / 2;
  const feather = Math.max(0, active.feather);

  if (!active.invert && feather <= 0.001) {
    if (active.shape === "ellipse") {
      return {
        clipPath: `ellipse(${pct(active.width / 2)} ${pct(
          active.height / 2,
        )} at ${pct(active.positionX)} ${pct(active.positionY)})`,
      };
    }

    return {
      clipPath: `inset(${pct(top)} ${pct(100 - right)} ${pct(
        100 - bottom,
      )} ${pct(left)})`,
    };
  }

  if (active.shape === "ellipse") {
    const radiusX = Math.max(0.5, active.width / 2);
    const radiusY = Math.max(0.5, active.height / 2);

    // Match rectangle feathering: preserve the entire authored ellipse as a
    // fully solid region, then feather OUTWARD beyond its boundary. The old
    // implementation used the authored ellipse as the radial gradient's outer
    // radius, which consumed the feather inside the ellipse and made it look
    // like the whole mask was fading away.
    const featherY = (feather / 1080) * 100;
    const featherX = featherY / Math.max(0.01, canvasAspect);
    const outerRadiusX = radiusX + featherX;
    const outerRadiusY = radiusY + featherY;

    // CSS radial-gradient has one normalized stop axis even for an ellipse.
    // Use the larger original/outer ratio so the complete original ellipse is
    // guaranteed to remain inside the fully-solid part of the mask.
    const originalRadiusRatio = Math.max(
      radiusX / Math.max(radiusX, outerRadiusX),
      radiusY / Math.max(radiusY, outerRadiusY),
    );
    const solidStop = Math.max(0, Math.min(99.999, originalRadiusRatio * 100));

    const inner = active.invert
      ? "rgba(0,0,0,0)"
      : "rgba(0,0,0,1)";
    const outer = active.invert
      ? "rgba(0,0,0,1)"
      : "rgba(0,0,0,0)";
    const gradient = `radial-gradient(ellipse ${pct(outerRadiusX)} ${pct(
      outerRadiusY,
    )} at ${pct(active.positionX)} ${pct(active.positionY)}, ${inner} 0%, ${inner} ${solidStop.toFixed(
      3,
    )}%, ${outer} 100%)`;

    return {
      WebkitMaskImage: gradient,
      maskImage: gradient,
      WebkitMaskRepeat: "no-repeat",
      maskRepeat: "no-repeat",
    } as CSSProperties;
  }

  if (!active.invert) {
    const featherY = (feather / 1080) * 100;
    const featherX = featherY / Math.max(0.01, canvasAspect);
    const horizontal = `linear-gradient(to right, transparent ${pct(
      left - featherX,
    )}, rgba(0,0,0,1) ${pct(left)}, rgba(0,0,0,1) ${pct(
      right,
    )}, transparent ${pct(right + featherX)})`;
    const vertical = `linear-gradient(to bottom, transparent ${pct(
      top - featherY,
    )}, rgba(0,0,0,1) ${pct(top)}, rgba(0,0,0,1) ${pct(
      bottom,
    )}, transparent ${pct(bottom + featherY)})`;

    return {
      WebkitMaskImage: `${horizontal}, ${vertical}`,
      maskImage: `${horizontal}, ${vertical}`,
      WebkitMaskComposite: "source-in",
      maskComposite: "intersect",
      WebkitMaskRepeat: "no-repeat, no-repeat",
      maskRepeat: "no-repeat, no-repeat",
    } as CSSProperties;
  }

  return legacySvgMaskStyle(active, canvasAspect);
}

export function videoMaskBounds(mask: VideoMask) {
  return {
    left: mask.positionX - mask.width / 2,
    right: mask.positionX + mask.width / 2,
    top: mask.positionY - mask.height / 2,
    bottom: mask.positionY + mask.height / 2,
  };
}
