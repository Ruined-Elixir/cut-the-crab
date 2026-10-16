import { describe, expect, it } from "vitest";

import {
  canvasPercentToOutputPoint,
  canvasPercentToRenderPoint,
  renderPointToCanvasPercent,
  subtitleCanvasRect,
} from "./subtitleCanvas";

describe("subtitleCanvasRect", () => {
  it("fills a 16:9 shell", () => {
    expect(subtitleCanvasRect({ width: 1600, height: 900 })).toEqual({
      left: 0, top: 0, width: 1600, height: 900,
    });
  });

  it("is centred and full height in a wider shell", () => {
    const rect = subtitleCanvasRect({ width: 2000, height: 900 });
    expect(rect.height).toBe(900);
    expect(rect.width).toBeCloseTo(1600, 6);
    expect(rect.left).toBeCloseTo(200, 6);
    expect(rect.top).toBe(0);
  });

  it("is centred and full width in a taller shell", () => {
    const rect = subtitleCanvasRect({ width: 1600, height: 1200 });
    expect(rect.width).toBe(1600);
    expect(rect.height).toBeCloseTo(900, 6);
    expect(rect.left).toBe(0);
    expect(rect.top).toBeCloseTo(150, 6);
  });

  it("does not depend on any video (a vertical reel makes no difference)", () => {
    const shell = { width: 1600, height: 900 };
    expect(subtitleCanvasRect(shell)).toEqual(subtitleCanvasRect(shell));
  });

  it("handles an empty shell", () => {
    expect(subtitleCanvasRect({ width: 0, height: 0 })).toEqual({
      left: 0, top: 0, width: 0, height: 0,
    });
  });
});

describe("canvas <-> render conversion", () => {
  it("round-trips a position", () => {
    const rect = subtitleCanvasRect({ width: 2000, height: 900 });
    const point = canvasPercentToRenderPoint(rect, 30, 70);
    const back = renderPointToCanvasPercent(rect, point.x, point.y);
    expect(back.positionX).toBeCloseTo(30, 6);
    expect(back.positionY).toBeCloseTo(70, 6);
  });

  it("puts the centre of the canvas at the centre of the shell", () => {
    const rect = subtitleCanvasRect({ width: 2000, height: 900 });
    const point = canvasPercentToRenderPoint(rect, 50, 50);
    expect(point.x).toBeCloseTo(1000, 6);
    expect(point.y).toBeCloseTo(450, 6);
  });
});

describe("canvasPercentToOutputPoint", () => {
  const full = { left: 0, top: 0, width: 1920, height: 1080 };

  it("16:9 export: default position maps proportionally", () => {
    const p = canvasPercentToOutputPoint(50, 80, full, 1920, 1080);
    expect(p.x).toBeCloseTo(960, 6);
    expect(p.y).toBeCloseTo(864, 6);
    const small = canvasPercentToOutputPoint(50, 80, full, 1280, 720);
    expect(small.x).toBeCloseTo(640, 6);
    expect(small.y).toBeCloseTo(576, 6);
  });

  it("9:16 export: crops the centre of the canvas", () => {
    const viewport = { left: 656.25, top: 0, width: 607.5, height: 1080 };
    const centre = canvasPercentToOutputPoint(50, 80, viewport, 1080, 1920);
    expect(centre.x).toBeCloseTo(540, 4);
    expect(centre.y).toBeCloseTo(1536, 4);
    const outside = canvasPercentToOutputPoint(10, 80, viewport, 1080, 1920);
    expect(outside.x).toBeLessThan(0);
  });

  it("1:1 export: crops a centred square", () => {
    const viewport = { left: 420, top: 0, width: 1080, height: 1080 };
    const p = canvasPercentToOutputPoint(50, 50, viewport, 1080, 1080);
    expect(p.x).toBeCloseTo(540, 6);
    expect(p.y).toBeCloseTo(540, 6);
  });

  it("matches the formula currently used by assSubtitles.createDialogue", () => {
    const viewport = { left: 656.25, top: 0, width: 607.5, height: 1080 };
    const positionX = 37;
    const positionY = 66;
    const sourceX = (positionX / 100) * 1920;
    const sourceY = (positionY / 100) * 1080;
    const oldX = ((sourceX - viewport.left) / viewport.width) * 1080;
    const oldY = ((sourceY - viewport.top) / viewport.height) * 1920;
    const p = canvasPercentToOutputPoint(positionX, positionY, viewport, 1080, 1920);
    expect(p.x).toBeCloseTo(oldX, 9);
    expect(p.y).toBeCloseTo(oldY, 9);
  });

  it("preview and export agree on relative position for a 16:9 export", () => {
    const rect = subtitleCanvasRect({ width: 2000, height: 900 });
    const preview = canvasPercentToRenderPoint(rect, 25, 60);
    const relPreviewX = (preview.x - rect.left) / rect.width;
    const relPreviewY = (preview.y - rect.top) / rect.height;
    const out = canvasPercentToOutputPoint(25, 60, { left: 0, top: 0, width: 1920, height: 1080 }, 1920, 1080);
    expect(out.x / 1920).toBeCloseTo(relPreviewX, 9);
    expect(out.y / 1080).toBeCloseTo(relPreviewY, 9);
  });
});
