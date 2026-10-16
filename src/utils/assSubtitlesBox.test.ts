import { describe, expect, it } from "vitest";

import type { Subtitle } from "../types/subtitle";
import { buildAssTrack, type AssBackgroundMetrics } from "./assSubtitles";

// Each character is em * 0.5 wide; the line ratio is 1, so em = font size.
const ready: AssBackgroundMetrics = {
  isReady: () => true,
  lineRatio: () => 1,
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
    fontSize: 20,
    ...patch,
  };
}

const dialogues = (ass: string) => ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
const styles = (ass: string) => ass.split("\n").filter((l) => l.startsWith("Style:"));

describe("plain subtitles are unchanged by the box feature", () => {
  it("has no \\q2, \\org or \\frz", () => {
    const ass = buildAssTrack([sub({ backgroundColor: "#000000" })], { backgroundMetrics: ready });
    const text = dialogues(ass).join("\n");
    expect(text).not.toContain("\\q2");
    expect(text).not.toContain("\\org");
    expect(text).not.toContain("\\frz");
    expect(styles(ass)[0].split(",")[15]).toBe("3");
  });
});

describe("boxed subtitles", () => {
  const long = "aaaa bbbb cccc dddd";

  it("wraps to the box width and disables libass wrapping", () => {
    const ass = buildAssTrack([sub({ text: long, boxWidth: 200 })], { backgroundMetrics: ready });
    const [line] = dialogues(ass);
    expect(line).toContain("\\q2");
    // text width 200 - 16 - 1.5 = 182.5; 10 px per character -> 18 characters per line
    expect(line).toContain("aaaa bbbb cccc\\Ndddd");
  });

  it("draws a background box of the box width", () => {
    const ass = buildAssTrack([sub({ text: long, boxWidth: 200, backgroundColor: "#000000" })], {
      backgroundMetrics: ready,
    });
    const lines = dialogues(ass);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(",Background0,");
    // radius 0: square path, width 200, height 2 lines x 20 + 16 = 56
    expect(lines[0]).toContain("m 0 0 l 200 0 ");
    expect(lines[0]).toContain(" 56 ");
    expect(styles(ass)[0].split(",")[15]).toBe("1");
  });

  it("rotates the text and the background around the box centre", () => {
    const ass = buildAssTrack(
      [sub({ boxWidth: 300, rotation: 15, backgroundColor: "#000000", backgroundRadius: 10 })],
      { backgroundMetrics: ready },
    );
    const [background, text] = dialogues(ass);
    const org = /\\org\(([\d.]+),([\d.]+)\)/;
    expect(org.exec(background)![0]).toBe(org.exec(text)![0]);
    expect(background).toContain("\\frz-15.00");
    expect(text).toContain("\\frz-15.00");
  });

  it("does not need a box width to rotate", () => {
    const ass = buildAssTrack([sub({ rotation: -30 })], { backgroundMetrics: ready });
    expect(dialogues(ass)[0]).toContain("\\frz30.00");
  });

  it("skips the background event without a background colour", () => {
    const ass = buildAssTrack([sub({ boxWidth: 300 })], { backgroundMetrics: ready });
    expect(dialogues(ass)).toHaveLength(1);
    expect(styles(ass)[0].split(",")[16]).toBe("2");
  });

  it("anchors left-aligned text at the left of the box", () => {
    const ass = buildAssTrack(
      [sub({ boxWidth: 400, textAlign: "left", positionX: 50 })],
      { backgroundMetrics: ready },
    );
    // centre x = 960, left anchor = 960 - 200 + 8 = 768
    expect(dialogues(ass)[0]).toContain("\\an4");
    expect(dialogues(ass)[0]).toContain("\\pos(768.00,");
  });

  it("falls back to the plain layout when the font cannot be measured", () => {
    const ass = buildAssTrack([sub({ text: long, boxWidth: 200, rotation: 10 })], {
      backgroundMetrics: notReady,
    });
    const text = dialogues(ass).join("\n");
    expect(text).not.toContain("\\q2");
    expect(text).not.toContain("\\frz");
  });

  it("falls back when rounded backgrounds are switched off", () => {
    const ass = buildAssTrack([sub({ boxWidth: 200 })], {
      backgroundMetrics: ready,
      roundedBackgrounds: false,
    });
    expect(dialogues(ass).join("\n")).not.toContain("\\q2");
  });
});
