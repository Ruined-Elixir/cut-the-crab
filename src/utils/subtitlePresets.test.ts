import { describe, expect, it } from "vitest";

import {
  BUILT_IN_SUBTITLE_PRESETS,
  PRESET_STORAGE_KEY,
  addCustomPreset,
  checkPresetName,
  deleteCustomPreset,
  loadCustomPresets,
  normalizePreset,
  presetStyleFrom,
  renameCustomPreset,
  saveCustomPresets,
  stylePatchFromPreset,
} from "./subtitlePresets";

function memoryStorage(initial?: string) {
  let value: string | null = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
    read: () => value,
  };
}

describe("presetStyleFrom", () => {
  it("fills defaults and clamps", () => {
    const style = presetStyleFrom({ fontSize: 500, color: "red" });
    expect(style.fontSize).toBe(96);
    expect(style.color).toBe("#ffffff");
    expect(style.backgroundColor).toBe("transparent");
    expect(style.isBold).toBe(false);
  });

  it("never carries position or alignment", () => {
    const style = presetStyleFrom({ textAlign: "left" } as never) as Record<string, unknown>;
    expect("textAlign" in style).toBe(false);
    expect("positionX" in style).toBe(false);
  });
});

describe("stylePatchFromPreset", () => {
  it("contains appearance fields only", () => {
    const patch = stylePatchFromPreset(BUILT_IN_SUBTITLE_PRESETS[1]) as Record<string, unknown>;
    expect(Object.keys(patch).sort()).toEqual(
      ["backgroundColor", "backgroundRadius", "color", "fontFamily", "fontSize", "isBold", "isItalic", "isUnderlined"],
    );
  });
});

describe("storage", () => {
  it("round-trips custom presets", () => {
    const storage = memoryStorage();
    const { presets } = addCustomPreset([], "Mine", { fontSize: 30, color: "#00ff00" }, () => "p1");
    expect(saveCustomPresets(presets, storage)).toBe(true);
    const loaded = loadCustomPresets(storage);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("Mine");
    expect(loaded[0].style.fontSize).toBe(30);
    expect(storage.read()).toContain("Mine");
    expect(PRESET_STORAGE_KEY).toBe("ctc.subtitlePresets.v1");
  });

  it("ignores corrupt data", () => {
    expect(loadCustomPresets(memoryStorage("not json"))).toEqual([]);
    expect(loadCustomPresets(memoryStorage('{"a":1}'))).toEqual([]);
  });

  it("drops invalid and duplicate entries", () => {
    const text = JSON.stringify([
      { id: "a", name: "Good", style: {} },
      { id: "a", name: "Duplicate id", style: {} },
      { id: "b", name: "", style: {} },
      { id: "c", name: "No style" },
      42,
    ]);
    const loaded = loadCustomPresets(memoryStorage(text));
    expect(loaded.map((preset) => preset.id)).toEqual(["a"]);
  });
});

describe("names", () => {
  it("rejects empty, long, built-in and duplicate names", () => {
    const { presets } = addCustomPreset([], "Mine", {}, () => "p1");
    expect(checkPresetName("  ", presets).ok).toBe(false);
    expect(checkPresetName("x".repeat(41), presets).ok).toBe(false);
    expect(checkPresetName("classic white", presets).ok).toBe(false);
    expect(checkPresetName("MINE", presets).ok).toBe(false);
    expect(checkPresetName("Other", presets).ok).toBe(true);
  });

  it("allows renaming to the same name", () => {
    const { presets } = addCustomPreset([], "Mine", {}, () => "p1");
    expect(renameCustomPreset(presets, "p1", "Mine").error).toBeUndefined();
    expect(renameCustomPreset(presets, "p1", "Renamed").presets[0].name).toBe("Renamed");
  });

  it("deletes by id", () => {
    const { presets } = addCustomPreset([], "Mine", {}, () => "p1");
    expect(deleteCustomPreset(presets, "p1")).toEqual([]);
  });
});

describe("normalizePreset", () => {
  it("rejects non-objects", () => {
    expect(normalizePreset(null)).toBeNull();
    expect(normalizePreset("x")).toBeNull();
  });
});
