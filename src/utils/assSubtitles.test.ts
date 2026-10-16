import { describe, expect, it } from "vitest";

import type { Subtitle } from "../types/subtitle";
import { buildAssTrack, type AssBackgroundMetrics } from "./assSubtitles";

const ready: AssBackgroundMetrics = {
  isReady: () => true,
  lineRatio: () => 1.4,
  measureLine: (line, emPx) => line.length * emPx * 0.5,
};
const notReady: AssBackgroundMetrics = { ...ready, isReady: () => false };

function sub(patch: Partial<Subtitle> = {}): Subtitle {
  return {
    id: "a",
    trackId: "subtitle-1",
    startTime: 0,
    endTime: 2,
    text: "Hello",
    ...patch,
  };
}

const dialogues = (ass: string) => ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
const styles = (ass: string) => ass.split("\n").filter((l) => l.startsWith("Style:"));
const pos = (line: string) => {
  const match = /\\pos\(([\d.]+),([\d.]+)\)/.exec(line)!;
  return { x: Number(match[1]), y: Number(match[2]) };
};

describe("square background (unchanged behavior)", () => {
  it("keeps BorderStyle 3 with padding 8 when no radius is set", () => {
    const ass = buildAssTrack([sub({ backgroundColor: "#000000" })], { backgroundMetrics: ready });
    const style = styles(ass)[0].split(",");
    expect(style[15]).toBe("3");
    expect(style[16]).toBe("8");
    expect(styles(ass)).toHaveLength(1);
    expect(dialogues(ass)).toHaveLength(1);
  });

  it("has no background and a 2 px outline without a background colour", () => {
    const ass = buildAssTrack([sub()], { backgroundMetrics: ready });
    const style = styles(ass)[0].split(",");
    expect(style[15]).toBe("1");
    expect(style[16]).toBe("2");
  });
});

describe("rounded background", () => {
  const rounded = sub({ backgroundColor: "#000000", backgroundRadius: 12 });

  it("emits a background drawing below the text", () => {
    const ass = buildAssTrack([rounded], { backgroundMetrics: ready });
    const lines = dialogues(ass);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(",Background0,");
    expect(lines[0]).toContain("\\p1");
    expect(lines[0].startsWith("Dialogue: 0,")).toBe(true);
    expect(lines[1].startsWith("Dialogue: 1,")).toBe(true);
    expect(lines[1]).toContain(",Subtitle0,");
  });

  it("draws the text with no box and no outline", () => {
    const ass = buildAssTrack([rounded], { backgroundMetrics: ready });
    const textStyle = styles(ass)[0].split(",");
    expect(textStyle[15]).toBe("1");
    expect(textStyle[16]).toBe("0");
    expect(styles(ass)).toHaveLength(2);
    expect(styles(ass)[1]).toContain("Style: Background0");
  });

  it("sizes the box from the measured text", () => {
    const ass = buildAssTrack([rounded], { backgroundMetrics: ready });
    // "Hello": 5 chars x (24 / 1.4) x 0.5 = 42.86, + 16 + 1.5 = 60.36 -> 60 wide, 40 tall
    expect(dialogues(ass)[0]).toContain("m 12 0 l 48 0 b ");
  });

  it("caps the radius at half the box height", () => {
    const pill = sub({ backgroundColor: "#000000", backgroundRadius: 40 });
    const ass = buildAssTrack([pill], { backgroundMetrics: ready });
    expect(dialogues(ass)[0]).toContain("m 20 0 ");
  });

  it("offsets the box by the padding for left and right alignment", () => {
    const left = buildAssTrack([sub({ ...rounded, textAlign: "left", positionX: 20 })], { backgroundMetrics: ready });
    const [bgLeft, textLeft] = dialogues(left);
    expect(pos(textLeft).x - pos(bgLeft).x).toBeCloseTo(8, 1);

    const right = buildAssTrack([sub({ ...rounded, textAlign: "right", positionX: 80 })], { backgroundMetrics: ready });
    const [bgRight, textRight] = dialogues(right);
    expect(pos(bgRight).x - pos(textRight).x).toBeCloseTo(8, 1);

    const centre = buildAssTrack([rounded], { backgroundMetrics: ready });
    const [bgCentre, textCentre] = dialogues(centre);
    expect(pos(bgCentre).x).toBe(pos(textCentre).x);
  });

  it("keeps two layers per subtitle track so tracks do not interleave", () => {
    const second = sub({ id: "b", trackId: "subtitle-2", backgroundColor: "#000000", backgroundRadius: 12 });
    const ass = buildAssTrack([second], { backgroundMetrics: ready });
    const lines = dialogues(ass);
    expect(lines[0].startsWith("Dialogue: 2,")).toBe(true);
    expect(lines[1].startsWith("Dialogue: 3,")).toBe(true);
  });
});

describe("fallback to the square box", () => {
  const rounded = sub({ backgroundColor: "#000000", backgroundRadius: 12 });

  it("when the font cannot be measured", () => {
    const ass = buildAssTrack([rounded], { backgroundMetrics: notReady });
    expect(dialogues(ass)).toHaveLength(1);
    expect(styles(ass)[0].split(",")[15]).toBe("3");
  });

  it("when rounded backgrounds are switched off", () => {
    const ass = buildAssTrack([rounded], { backgroundMetrics: ready, roundedBackgrounds: false });
    expect(dialogues(ass)).toHaveLength(1);
  });

  it("when there is no background colour", () => {
    const ass = buildAssTrack([sub({ backgroundRadius: 12 })], { backgroundMetrics: ready });
    expect(dialogues(ass)).toHaveLength(1);
    expect(styles(ass)).toHaveLength(1);
  });

  it("when the box is wider than the frame", () => {
    const wide = sub({ backgroundColor: "#000000", backgroundRadius: 12, text: "x".repeat(300) });
    const ass = buildAssTrack([wide], { backgroundMetrics: ready });
    expect(dialogues(ass)).toHaveLength(1);
    expect(styles(ass)[0].split(",")[15]).toBe("3");
  });

  it("when the box is wider than a narrow export viewport", () => {
    const text = sub({ backgroundColor: "#000000", backgroundRadius: 12, text: "x".repeat(70) });
    const full = buildAssTrack([text], { backgroundMetrics: ready });
    expect(dialogues(full)).toHaveLength(2);
    const narrow = buildAssTrack([text], {
      backgroundMetrics: ready,
      playResWidth: 1080,
      playResHeight: 1920,
      sourceViewport: { left: 656.25, top: 0, width: 607.5, height: 1080 },
    });
    expect(dialogues(narrow)).toHaveLength(1);
  });
});
