import { describe, expect, it } from "vitest";

import {
  applyBoxPatch,
  boxPatch,
  clampBoxWidth,
  computeSubtitleBox,
  cornerAnchoredCenter,
  cornerPointerScale,
  normalizeRotation,
  oppositeCornerPoint,
  resizeBoxFromEdge,
  resizeCursor,
  rotationPatch,
  scaledBoxWidth,
  scaledFontSize,
  snapRotation,
  unboxedAnchorX,
  wrapTextToWidth,
  type SubtitleBoxInput,
} from "./subtitleBox";

// Every character is 10 px wide, which makes the expected numbers easy to check.
const tenPx = (line: string) => line.length * 10;
const measureLine = (line: string, emPx: number) => line.length * emPx * 0.5;

const base: SubtitleBoxInput = {
  text: "Hello",
  fontSize: 20,
  italic: false,
  textAlign: "center",
  positionX: 50,
  positionY: 80,
  lineRatio: 1,
  measureLine,
};

describe("wrapTextToWidth", () => {
  it("breaks Latin text at spaces", () => {
    expect(wrapTextToWidth("aaaa bbbb cccc dddd", 140, tenPx)).toEqual(["aaaa bbbb cccc", "dddd"]);
  });

  it("keeps explicit line breaks", () => {
    expect(wrapTextToWidth("one\ntwo", 200, tenPx)).toEqual(["one", "two"]);
    expect(wrapTextToWidth("a\n\nb", 200, tenPx)).toEqual(["a", "", "b"]);
  });

  it("breaks CJK text between characters", () => {
    expect(wrapTextToWidth("這是一個測試字幕", 40, tenPx)).toEqual(["這是一個", "測試字幕"]);
  });

  it("breaks a word that is wider than the box by character", () => {
    expect(wrapTextToWidth("abcdefghij", 40, tenPx)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("does not start a line with closing punctuation", () => {
    expect(wrapTextToWidth("你好嗎，朋友", 40, tenPx)).toEqual(["你好嗎，", "朋友"]);
  });

  it("returns one empty line for empty text", () => {
    expect(wrapTextToWidth("", 100, tenPx)).toEqual([""]);
  });
});

describe("computeSubtitleBox: auto layout", () => {
  it("centres a centre-aligned box on the position", () => {
    const box = computeSubtitleBox(base);
    expect(box.boxed).toBe(false);
    expect(box.centerX).toBe(960);
    expect(box.centerY).toBe(864);
    // 5 chars x 20 x 0.5 = 50 + 16 + 1.5
    expect(box.width).toBeCloseTo(67.5, 6);
    expect(box.height).toBe(36);
  });

  it("anchors left- and right-aligned boxes at the text edge", () => {
    const left = computeSubtitleBox({ ...base, textAlign: "left", positionX: 10 });
    // text starts at x = 192, box starts one padding earlier
    expect(left.centerX - left.width / 2).toBeCloseTo(192 - 8, 6);
    const right = computeSubtitleBox({ ...base, textAlign: "right", positionX: 90 });
    expect(right.centerX + right.width / 2).toBeCloseTo(1728 + 8, 6);
  });
});

describe("computeSubtitleBox: boxed layout", () => {
  it("uses the box width and centres the box on the position", () => {
    const box = computeSubtitleBox({ ...base, text: "aaaa bbbb cccc dddd", boxWidth: 200 });
    expect(box.boxed).toBe(true);
    expect(box.width).toBe(200);
    expect(box.centerX).toBe(960);
    // text width 200 - 16 - 1.5 = 182.5 -> 18 characters at 10 px = "aaaa bbbb cccc" (14), "dddd"
    expect(box.lines).toEqual(["aaaa bbbb cccc", "dddd"]);
    expect(box.height).toBe(2 * 20 + 16);
  });

  it("places the text anchor by alignment inside the box", () => {
    const left = computeSubtitleBox({ ...base, boxWidth: 400, textAlign: "left" });
    expect(left.textAnchorX).toBe(960 - 200 + 8);
    const right = computeSubtitleBox({ ...base, boxWidth: 400, textAlign: "right" });
    expect(right.textAnchorX).toBe(960 + 200 - 8);
    const centre = computeSubtitleBox({ ...base, boxWidth: 400 });
    expect(centre.textAnchorX).toBe(960);
  });

  it("keeps the box inside the allowed width range", () => {
    expect(clampBoxWidth(10)).toBe(64);
    expect(clampBoxWidth(99999)).toBe(1920);
  });
});

describe("rotation and patches", () => {
  it("normalises rotation into [-180, 180)", () => {
    expect(normalizeRotation(190)).toBe(-170);
    expect(normalizeRotation(-190)).toBe(170);
    expect(normalizeRotation(180)).toBe(-180);
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(Number.NaN)).toBe(0);
  });

  it("round-trips an auto box through the unboxed anchor", () => {
    for (const textAlign of ["left", "center", "right"] as const) {
      const auto = computeSubtitleBox({ ...base, textAlign, positionX: 30 });
      const anchor = unboxedAnchorX(auto.centerX, auto.width, textAlign);
      expect(anchor).toBeCloseTo((30 / 100) * 1920, 6);
    }
  });

  it("builds a stored patch with percentages and a clean rotation", () => {
    const patch = boxPatch({ width: 300.4, centerX: 960, centerY: 540, rotation: 15.04 });
    expect(patch).toEqual({ boxWidth: 300, positionX: 50, positionY: 50, rotation: 15 });
    expect(boxPatch({ width: 300, centerX: 960, centerY: 540, rotation: 0 }).rotation).toBeUndefined();
  });
});

describe("rotationPatch and snapRotation", () => {
  it("changes only the rotation", () => {
    expect(rotationPatch(30.04)).toEqual({ rotation: 30 });
    expect(rotationPatch(0).rotation).toBeUndefined();
    expect(Object.keys(rotationPatch(10))).toEqual(["rotation"]);
  });

  it("snaps to 15 degree steps only when close", () => {
    expect(snapRotation(14)).toBe(15);
    expect(snapRotation(8)).toBe(8);
    expect(snapRotation(-1)).toBe(0);
    expect(snapRotation(92)).toBe(90);
    expect(snapRotation(358)).toBe(0);
  });

  it("snaps hard when the threshold is large", () => {
    expect(snapRotation(8, 15, 1000)).toBe(15);
    expect(snapRotation(7, 15, 1000)).toBe(0);
  });
});

describe("resizeBoxFromEdge", () => {
  const start = { width: 300, centerX: 960, centerY: 540, rotation: 0 };

  it("keeps the opposite edge fixed when dragging the right side", () => {
    const result = resizeBoxFromEdge(start, "right", 50, 7);
    expect(result.width).toBe(350);
    expect(result.centerX).toBe(985);
    expect(result.centerY).toBe(540);
  });

  it("grows when the left side is dragged outward", () => {
    const result = resizeBoxFromEdge(start, "left", -50, 0);
    expect(result.width).toBe(350);
    expect(result.centerX).toBe(935);
  });

  it("follows the rotated axis", () => {
    const result = resizeBoxFromEdge({ ...start, rotation: 90 }, "right", 0, 40);
    expect(result.width).toBeCloseTo(340, 6);
    expect(result.centerX).toBeCloseTo(960, 6);
    expect(result.centerY).toBeCloseTo(560, 6);
  });

  it("stops at the minimum width without moving the centre further", () => {
    const result = resizeBoxFromEdge(start, "right", -1000, 0);
    expect(result.width).toBe(64);
    expect(result.centerX).toBe(960 + (64 - 300) / 2);
  });
});

describe("corner scaling", () => {
  const br = { sx: 1, sy: 1 } as const;
  const tl = { sx: -1, sy: -1 } as const;

  it("measures the scale along the diagonal", () => {
    const size = { width: 200, height: 100, rotation: 0 };
    expect(cornerPointerScale(size, br, 100, 50)).toBeCloseTo(1.5, 9);
    expect(cornerPointerScale(size, br, -50, 100)).toBeCloseTo(1, 9);
    expect(cornerPointerScale(size, tl, -100, -50)).toBeCloseTo(1.5, 9);
  });

  it("follows a rotated box", () => {
    const size = { width: 200, height: 100, rotation: 90 };
    expect(cornerPointerScale(size, br, -50, 100)).toBeCloseTo(1.5, 9);
  });

  it("scales the font so the outer box matches, in half steps", () => {
    const result = scaledFontSize(24, 2, { width: 106, height: 40 });
    expect(result.fontSize).toBe(58.5);
    expect(result.factor).toBeCloseTo(58.5 / 24, 9);
  });

  it("stays within 10 and 96", () => {
    expect(scaledFontSize(24, 0.01, { width: 106, height: 40 }).fontSize).toBe(10);
    expect(scaledFontSize(24, 100, { width: 106, height: 40 }).fontSize).toBe(96);
  });

  it("does not change the font size for a scale of one", () => {
    expect(scaledFontSize(24, 1, { width: 106, height: 40 }).fontSize).toBe(24);
  });

  it("scales a sized box width around its padding", () => {
    expect(scaledBoxWidth(300, 2)).toBe(582.5);
    expect(scaledBoxWidth(300, 1)).toBe(300);
  });

  it("keeps the opposite corner fixed", () => {
    const start = { centerX: 960, centerY: 540, width: 200, height: 100, rotation: 0 };
    expect(cornerAnchoredCenter(start, br, { width: 300, height: 150 })).toEqual({
      centerX: 1010,
      centerY: 565,
    });
    expect(cornerAnchoredCenter(start, tl, { width: 300, height: 150 })).toEqual({
      centerX: 910,
      centerY: 515,
    });
    const turned = cornerAnchoredCenter({ ...start, rotation: 90 }, br, { width: 300, height: 150 });
    expect(turned.centerX).toBeCloseTo(935, 9);
    expect(turned.centerY).toBeCloseTo(590, 9);
  });

  it("agrees with the opposite corner point before and after", () => {
    const start = { centerX: 960, centerY: 540, width: 200, height: 100, rotation: 30 };
    const next = { width: 340, height: 130 };
    const center = cornerAnchoredCenter(start, br, next);
    const before = oppositeCornerPoint(start, br);
    const after = oppositeCornerPoint({ ...start, ...center, ...next }, br);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it("picks a resize cursor that follows the rotation", () => {
    expect(resizeCursor(45, 0)).toBe("nwse-resize");
    expect(resizeCursor(-45, 0)).toBe("nesw-resize");
    expect(resizeCursor(0, 0)).toBe("ew-resize");
    expect(resizeCursor(0, 90)).toBe("ns-resize");
    expect(resizeCursor(45, 90)).toBe("nesw-resize");
    expect(resizeCursor(0, 170)).toBe("ew-resize");
  });
});

describe("applyBoxPatch", () => {
  it("applies the fields that are present and clears the ones set to undefined", () => {
    const next = applyBoxPatch(
      { ...base, boxWidth: 400, rotation: 20 },
      { fontSize: 30, positionX: 10, boxWidth: undefined },
    );
    expect(next.fontSize).toBe(30);
    expect(next.positionX).toBe(10);
    expect(next.positionY).toBe(80);
    expect(next.boxWidth).toBeUndefined();
    expect(next.rotation).toBe(20);
  });
});
