import { describe, expect, it } from "vitest";

import {
  clampSplit,
  parseGridTrackSizes,
  parseStoredLayout,
  sizeFromDrag,
  splitterBounds,
  type LayoutMeasure,
} from "./workspaceLayout";

const measure: LayoutMeasure = {
  workspaceWidth: 1600,
  mediaWidth: 220,
  subtitleWidth: 480,
  workspaceHeight: 560,
  timelineHeight: 380,
};

describe("splitterBounds", () => {
  it("keeps the program monitor at least 420 px wide", () => {
    // media may grow until 1600 - 480 - 420 = 700, but its own max is 420
    expect(splitterBounds("media", measure)).toEqual({ min: 160, max: 420 });
    // subtitle: 1600 - 220 - 420 = 960, capped at 720
    expect(splitterBounds("subtitle", measure)).toEqual({ min: 280, max: 720 });
  });

  it("shrinks the maximum in a narrow window", () => {
    const narrow = { ...measure, workspaceWidth: 1100 };
    // media: 1100 - 480 - 420 = 200
    expect(splitterBounds("media", narrow).max).toBe(200);
    // subtitle: 1100 - 220 - 420 = 460
    expect(splitterBounds("subtitle", narrow).max).toBe(460);
  });

  it("never returns a maximum below the minimum", () => {
    const tiny = { ...measure, workspaceWidth: 600 };
    expect(splitterBounds("media", tiny).max).toBe(160);
    expect(splitterBounds("subtitle", tiny).max).toBe(280);
  });

  it("keeps the top workspace at least 300 px tall", () => {
    // total 940, max timeline = 640
    expect(splitterBounds("timeline", measure)).toEqual({ min: 170, max: 640 });
  });
});

describe("clampSplit", () => {
  it("clamps into the bounds", () => {
    expect(clampSplit("media", 50, measure)).toBe(160);
    expect(clampSplit("media", 999, measure)).toBe(420);
    expect(clampSplit("media", 250.4, measure)).toBe(250);
    expect(clampSplit("timeline", 100, measure)).toBe(170);
    expect(clampSplit("timeline", 900, measure)).toBe(640);
  });

  it("leaves an unmeasured layout alone", () => {
    const empty: LayoutMeasure = { ...measure, workspaceWidth: 0, workspaceHeight: 0 };
    expect(clampSplit("media", 999, empty)).toBe(999);
    expect(clampSplit("timeline", 999, empty)).toBe(999);
  });
});

describe("sizeFromDrag", () => {
  it("grows media to the right, subtitles to the left, timeline upward", () => {
    expect(sizeFromDrag("media", 220, 30, 99)).toBe(250);
    expect(sizeFromDrag("subtitle", 480, 30, 99)).toBe(450);
    expect(sizeFromDrag("subtitle", 480, -30, 99)).toBe(510);
    expect(sizeFromDrag("timeline", 380, 99, 40)).toBe(340);
    expect(sizeFromDrag("timeline", 380, 99, -40)).toBe(420);
  });
});

describe("parseGridTrackSizes", () => {
  it("reads resolved pixel tracks", () => {
    expect(parseGridTrackSizes("218px 0px 903.5px 0px 490px")).toEqual([218, 0, 903.5, 0, 490]);
  });
});

describe("parseStoredLayout", () => {
  it("accepts valid numbers only", () => {
    expect(parseStoredLayout('{"media":240,"subtitle":"x","timeline":-5,"other":1}')).toEqual({ media: 240 });
  });

  it("ignores missing or corrupt data", () => {
    expect(parseStoredLayout(null)).toEqual({});
    expect(parseStoredLayout("nope")).toEqual({});
    expect(parseStoredLayout("[1,2]")).toEqual({});
  });
});
