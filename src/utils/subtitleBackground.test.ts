import { describe, expect, it } from "vitest";

import {
  backgroundAnchorOffset,
  clampBackgroundRadius,
  drawnLineText,
  roundedBoxSize,
  roundedRectPath,
  subtitleDisplayLines,
} from "./subtitleBackground";

const fake = (line: string, emPx: number) => line.length * emPx * 0.5;

describe("clampBackgroundRadius", () => {
  it("clamps and rounds", () => {
    expect(clampBackgroundRadius(12.4)).toBe(12);
    expect(clampBackgroundRadius(-3)).toBe(0);
    expect(clampBackgroundRadius(500)).toBe(40);
    expect(clampBackgroundRadius(undefined)).toBe(0);
    expect(clampBackgroundRadius(Number.NaN)).toBe(0);
  });
});

describe("lines", () => {
  it("splits on all newline styles", () => {
    expect(subtitleDisplayLines("a\nb\r\nc\rd")).toEqual(["a", "b", "c", "d"]);
  });

  it("doubles backslashes like escapeAssText", () => {
    expect(drawnLineText("a\\b")).toBe("a\\\\b");
  });
});

describe("roundedBoxSize", () => {
  it("uses lines x font size for height and the widest line for width", () => {
    const size = roundedBoxSize({
      text: "Hello\nHello world",
      fontSize: 24,
      italic: false,
      lineRatio: 1.4,
      measureLine: fake,
    });
    expect(size.lineCount).toBe(2);
    expect(size.height).toBe(2 * 24 + 16);
    const em = 24 / 1.4;
    expect(size.width).toBeCloseTo("Hello world".length * em * 0.5 + 16 + 1.5, 6);
  });

  it("measures doubled backslashes", () => {
    const plain = roundedBoxSize({ text: "ab", fontSize: 24, italic: false, lineRatio: 1.4, measureLine: fake });
    const slash = roundedBoxSize({ text: "a\\", fontSize: 24, italic: false, lineRatio: 1.4, measureLine: fake });
    expect(slash.width).toBeGreaterThan(plain.width);
  });

  it("passes italic through to the measurer", () => {
    let seen: boolean | null = null;
    roundedBoxSize({
      text: "x", fontSize: 24, italic: true, lineRatio: 1.4,
      measureLine: (_line, _em, italic) => {
        seen = italic;
        return 0;
      },
    });
    expect(seen).toBe(true);
  });
});

describe("roundedRectPath", () => {
  it("starts after the corner and uses whole numbers", () => {
    const path = roundedRectPath(60, 40, 12);
    expect(path.startsWith("m 12 0 l 48 0 b ")).toBe(true);
    expect(path).not.toContain(".");
  });

  it("caps the radius at half the height (pill)", () => {
    expect(roundedRectPath(100, 40, 40).startsWith("m 20 0 ")).toBe(true);
  });

  it("with radius 0 is a plain rectangle", () => {
    expect(roundedRectPath(60, 40, 0).startsWith("m 0 0 l 60 0 ")).toBe(true);
  });
});

describe("backgroundAnchorOffset", () => {
  it("offsets only left and right", () => {
    expect(backgroundAnchorOffset("left", 8)).toBe(-8);
    expect(backgroundAnchorOffset("right", 8)).toBe(8);
    expect(backgroundAnchorOffset("center", 8)).toBe(0);
    expect(backgroundAnchorOffset(undefined, 8)).toBe(0);
  });
});
