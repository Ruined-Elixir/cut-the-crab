import type { SubtitleStyle } from "../types/subtitle";
import { DEFAULT_ASS_FONT_FAMILY } from "./assSubtitles";
import { clampBackgroundRadius } from "./subtitleBackground";

/*
 * Subtitle style presets (pure logic, no React).
 *
 * A preset is appearance only. It never contains position (positionX/Y) or
 * text alignment, so applying a preset never moves a subtitle.
 *
 * Built-in presets live in code. Custom presets are stored app-wide in
 * localStorage so they are available in every project.
 */

export type PresetStyle = Required<
  Pick<
    SubtitleStyle,
    | "fontSize"
    | "fontFamily"
    | "color"
    | "backgroundColor"
    | "backgroundRadius"
    | "isBold"
    | "isItalic"
    | "isUnderlined"
  >
>;

export type SubtitleStylePreset = {
  id: string;
  name: string;
  style: PresetStyle;
  builtIn?: boolean;
};

export const PRESET_STORAGE_KEY = "ctc.subtitlePresets.v1";
export const MAX_PRESET_NAME_LENGTH = 40;
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 96;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function base(overrides: Partial<PresetStyle>): PresetStyle {
  return {
    fontSize: 24,
    fontFamily: DEFAULT_ASS_FONT_FAMILY,
    color: "#ffffff",
    backgroundColor: "transparent",
    backgroundRadius: 0,
    isBold: false,
    isItalic: false,
    isUnderlined: false,
    ...overrides,
  };
}

export const BUILT_IN_SUBTITLE_PRESETS: SubtitleStylePreset[] = [
  { id: "builtin-rounded-box", name: "Rounded Box", builtIn: true, style: base({ fontSize: 28, backgroundColor: "#000000", backgroundRadius: 14 }) },
  { id: "builtin-classic", name: "Classic White", builtIn: true, style: base({}) },
  {
    id: "builtin-black-box",
    name: "Black Box",
    builtIn: true,
    style: base({ fontSize: 28, backgroundColor: "#000000" }),
  },
  {
    id: "builtin-yellow",
    name: "Yellow Caption",
    builtIn: true,
    style: base({ fontSize: 28, color: "#ffd60a", isBold: true }),
  },
  {
    id: "builtin-large-title",
    name: "Large Title",
    builtIn: true,
    style: base({ fontSize: 48, isBold: true }),
  },
  {
    id: "builtin-white-on-blue",
    name: "White on Blue",
    builtIn: true,
    style: base({ fontSize: 28, backgroundColor: "#0a3d91" }),
  },
];

function clampFontSize(value: number) {
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(value)));
}

function normalizeColor(value: unknown, fallback: string) {
  return typeof value === "string" && HEX_COLOR.test(value)
    ? value.toLowerCase()
    : fallback;
}

function normalizeBackground(value: unknown) {
  if (value === "transparent") return "transparent";
  return normalizeColor(value, "transparent");
}

/** Pick the appearance fields from any style, filling defaults. */
export function presetStyleFrom(style: SubtitleStyle): PresetStyle {
  return {
    fontSize: clampFontSize(
      typeof style.fontSize === "number" && Number.isFinite(style.fontSize)
        ? style.fontSize
        : 24,
    ),
    fontFamily: style.fontFamily?.trim() || DEFAULT_ASS_FONT_FAMILY,
    color: normalizeColor(style.color, "#ffffff"),
    backgroundColor: normalizeBackground(style.backgroundColor),
    backgroundRadius: clampBackgroundRadius(style.backgroundRadius),
    isBold: Boolean(style.isBold),
    isItalic: Boolean(style.isItalic),
    isUnderlined: Boolean(style.isUnderlined),
  };
}

/** The patch to hand to the existing style-update functions. */
export function stylePatchFromPreset(preset: SubtitleStylePreset): SubtitleStyle {
  return { ...preset.style };
}

export function normalizePreset(value: unknown): SubtitleStylePreset | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!name || !id || name.length > MAX_PRESET_NAME_LENGTH) return null;
  if (typeof raw.style !== "object" || raw.style === null) return null;
  return { id, name, style: presetStyleFrom(raw.style as SubtitleStyle) };
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function loadCustomPresets(storage?: StorageLike): SubtitleStylePreset[] {
  try {
    const source = storage ?? window.localStorage;
    const text = source.getItem(PRESET_STORAGE_KEY);
    if (!text) return [];
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const result: SubtitleStylePreset[] = [];
    for (const item of parsed) {
      const preset = normalizePreset(item);
      if (!preset || seen.has(preset.id)) continue;
      seen.add(preset.id);
      result.push(preset);
    }
    return result;
  } catch {
    return [];
  }
}

export function saveCustomPresets(
  presets: SubtitleStylePreset[],
  storage?: StorageLike,
): boolean {
  try {
    const source = storage ?? window.localStorage;
    source.setItem(
      PRESET_STORAGE_KEY,
      JSON.stringify(presets.map(({ id, name, style }) => ({ id, name, style }))),
    );
    return true;
  } catch {
    return false;
  }
}

export type NameCheck = { ok: true; name: string } | { ok: false; error: string };

/** Names are unique (case-insensitive) across built-in and custom presets. */
export function checkPresetName(
  rawName: string,
  custom: SubtitleStylePreset[],
  ignoreId?: string,
): NameCheck {
  const name = rawName.trim();
  if (!name) return { ok: false, error: "Enter a name." };
  if (name.length > MAX_PRESET_NAME_LENGTH) {
    return { ok: false, error: `Use ${MAX_PRESET_NAME_LENGTH} characters or fewer.` };
  }
  const key = name.toLowerCase();
  if (BUILT_IN_SUBTITLE_PRESETS.some((preset) => preset.name.toLowerCase() === key)) {
    return { ok: false, error: "That name is used by a built-in preset." };
  }
  if (custom.some((preset) => preset.id !== ignoreId && preset.name.toLowerCase() === key)) {
    return { ok: false, error: "A preset with that name already exists." };
  }
  return { ok: true, name };
}

export function addCustomPreset(
  custom: SubtitleStylePreset[],
  name: string,
  style: SubtitleStyle,
  makeId: () => string,
): { presets: SubtitleStylePreset[]; error?: string } {
  const check = checkPresetName(name, custom);
  if (!check.ok) return { presets: custom, error: check.error };
  return {
    presets: [...custom, { id: makeId(), name: check.name, style: presetStyleFrom(style) }],
  };
}

export function renameCustomPreset(
  custom: SubtitleStylePreset[],
  id: string,
  name: string,
): { presets: SubtitleStylePreset[]; error?: string } {
  const check = checkPresetName(name, custom, id);
  if (!check.ok) return { presets: custom, error: check.error };
  return {
    presets: custom.map((preset) =>
      preset.id === id ? { ...preset, name: check.name } : preset,
    ),
  };
}

export function deleteCustomPreset(custom: SubtitleStylePreset[], id: string) {
  return custom.filter((preset) => preset.id !== id);
}
