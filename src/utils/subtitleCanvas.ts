/*
 * Shared subtitle canvas geometry (pure, no React or DOM).
 *
 * Subtitles live on a fixed 16:9 canvas (1920 x 1080 design units) that is
 * independent of any video clip. A subtitle position is stored as a percentage
 * of that canvas.
 *
 *  - Preview: the canvas is the largest centred 16:9 rectangle inside the
 *    Program Monitor shell (subtitleCanvasRect).
 *  - Export: the same canvas is cropped to the chosen aspect-ratio viewport and
 *    scaled to the output size (canvasPercentToOutputPoint).
 */

export const SUBTITLE_CANVAS_WIDTH = 1920;
export const SUBTITLE_CANVAS_HEIGHT = 1080;
export const SUBTITLE_CANVAS_ASPECT =
  SUBTITLE_CANVAS_WIDTH / SUBTITLE_CANVAS_HEIGHT;

export type CanvasRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type CanvasViewport = CanvasRect;

/** Largest centred 16:9 rectangle inside a shell of the given size (px). */
export function subtitleCanvasRect(shell: {
  width: number;
  height: number;
}): CanvasRect {
  const shellWidth = Math.max(0, shell.width);
  const shellHeight = Math.max(0, shell.height);

  if (shellWidth === 0 || shellHeight === 0) {
    return { left: 0, top: 0, width: shellWidth, height: shellHeight };
  }

  if (shellWidth / shellHeight > SUBTITLE_CANVAS_ASPECT) {
    const height = shellHeight;
    const width = height * SUBTITLE_CANVAS_ASPECT;
    return { left: (shellWidth - width) / 2, top: 0, width, height };
  }

  const width = shellWidth;
  const height = width / SUBTITLE_CANVAS_ASPECT;
  return { left: 0, top: (shellHeight - height) / 2, width, height };
}

/** Canvas percentage position to shell pixels, given the canvas rect. */
export function canvasPercentToRenderPoint(
  rect: CanvasRect,
  positionX: number,
  positionY: number,
) {
  return {
    x: rect.left + (positionX / 100) * rect.width,
    y: rect.top + (positionY / 100) * rect.height,
  };
}

/** Shell pixels back to a canvas percentage position. */
export function renderPointToCanvasPercent(
  rect: CanvasRect,
  x: number,
  y: number,
) {
  return {
    positionX: rect.width > 0 ? ((x - rect.left) / rect.width) * 100 : 50,
    positionY: rect.height > 0 ? ((y - rect.top) / rect.height) * 100 : 80,
  };
}

/**
 * Canvas percentage position to output pixels. `viewport` is the crop of the
 * 1920 x 1080 canvas that becomes the exported frame (the whole canvas for a
 * 16:9 export). Values outside the viewport are allowed so libass clips them.
 */
export function canvasPercentToOutputPoint(
  positionX: number,
  positionY: number,
  viewport: CanvasViewport,
  outputWidth: number,
  outputHeight: number,
) {
  const sourceX = (positionX / 100) * SUBTITLE_CANVAS_WIDTH;
  const sourceY = (positionY / 100) * SUBTITLE_CANVAS_HEIGHT;

  return {
    x: ((sourceX - viewport.left) / viewport.width) * outputWidth,
    y: ((sourceY - viewport.top) / viewport.height) * outputHeight,
  };
}
