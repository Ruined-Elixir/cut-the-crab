import type { CSSProperties } from "react";
import type { VideoBlendMode } from "../types/timelineModel";

export const VIDEO_BLEND_MODES: VideoBlendMode[] = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "difference",
  "soft-light",
  "hard-light",
];

export const VIDEO_BLEND_MODE_LABELS: Record<VideoBlendMode, string> = {
  normal: "Normal",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  darken: "Darken",
  lighten: "Lighten",
  "color-dodge": "Color Dodge",
  "color-burn": "Color Burn",
  difference: "Difference",
  "soft-light": "Soft Light",
  "hard-light": "Hard Light",
};

const VIDEO_BLEND_MODE_SET = new Set<string>(VIDEO_BLEND_MODES);

export function normalizeVideoBlendMode(value: unknown): VideoBlendMode {
  return typeof value === "string" && VIDEO_BLEND_MODE_SET.has(value)
    ? (value as VideoBlendMode)
    : "normal";
}

export function isNormalBlendMode(value: unknown) {
  return normalizeVideoBlendMode(value) === "normal";
}

export function cssBlendMode(value: unknown): CSSProperties["mixBlendMode"] {
  return normalizeVideoBlendMode(value);
}

export function ffmpegBlendMode(value: unknown): string {
  switch (normalizeVideoBlendMode(value)) {
    case "color-dodge":
      return "dodge";
    case "color-burn":
      return "burn";
    case "soft-light":
      return "softlight";
    case "hard-light":
      return "hardlight";
    default:
      return normalizeVideoBlendMode(value);
  }
}
