import type {
  AdjustmentLayerClip,
  TimelineTrackSettings,
  VideoEffectInstance,
  VideoEffectKind,
  VideoTimelineClip,
  VignetteVideoEffect,
} from "../types/timelineModel";
import { adjustmentLayersAffectingVideoTrack } from "./adjustmentLayers";

export const VIDEO_EFFECT_KINDS: VideoEffectKind[] = [
  "gaussian-blur",
  "sharpen",
  "vignette",
];

export const VIDEO_EFFECT_LABELS: Record<VideoEffectKind, string> = {
  "gaussian-blur": "Gaussian Blur",
  sharpen: "Sharpen",
  vignette: "Vignette",
};

function finite(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number, fallback: number) {
  return Math.max(min, Math.min(max, finite(value, fallback)));
}

export function createVideoEffect(kind: VideoEffectKind): VideoEffectInstance {
  const id = `effect-${crypto.randomUUID()}`;

  switch (kind) {
    case "gaussian-blur":
      return {
        id,
        kind,
        enabled: true,
        radius: 8,
      };
    case "sharpen":
      return {
        id,
        kind,
        enabled: true,
        amount: 35,
      };
    case "vignette":
      return {
        id,
        kind,
        enabled: true,
        amount: 45,
        softness: 60,
      };
  }
}

export function resetVideoEffect(
  effect: VideoEffectInstance,
): VideoEffectInstance {
  const fresh = createVideoEffect(effect.kind);
  return {
    ...fresh,
    id: effect.id,
    enabled: effect.enabled !== false,
  } as VideoEffectInstance;
}

export function duplicateVideoEffect(
  effect: VideoEffectInstance,
): VideoEffectInstance {
  return {
    ...effect,
    id: `effect-${crypto.randomUUID()}`,
  } as VideoEffectInstance;
}

export function videoEffectSummary(effect: VideoEffectInstance): string {
  switch (effect.kind) {
    case "gaussian-blur":
      return `${Math.round(effect.radius)} px`;
    case "sharpen":
      return `${Math.round(effect.amount)}%`;
    case "vignette":
      return `${Math.round(effect.amount)}% · soft ${Math.round(effect.softness)}%`;
  }
}

export function normalizeVideoEffect(
  effect: VideoEffectInstance,
): VideoEffectInstance {
  switch (effect.kind) {
    case "gaussian-blur":
      return {
        id: effect.id,
        kind: effect.kind,
        enabled: effect.enabled !== false,
        radius: clamp(effect.radius, 0, 50, 8),
      };
    case "sharpen":
      return {
        id: effect.id,
        kind: effect.kind,
        enabled: effect.enabled !== false,
        amount: clamp(effect.amount, 0, 100, 35),
      };
    case "vignette":
      return {
        id: effect.id,
        kind: effect.kind,
        enabled: effect.enabled !== false,
        amount: clamp(effect.amount, 0, 100, 45),
        softness: clamp(effect.softness, 0, 100, 60),
      };
  }
}

export function normalizeVideoEffects(
  effects: VideoEffectInstance[] | undefined,
): VideoEffectInstance[] | undefined {
  if (!effects || effects.length === 0) return undefined;
  const normalized = effects.map(normalizeVideoEffect);
  return normalized.length > 0 ? normalized : undefined;
}

export function cloneVideoEffects(
  effects: VideoEffectInstance[] | undefined,
): VideoEffectInstance[] | undefined {
  return effects?.map((effect) => ({ ...effect }) as VideoEffectInstance);
}

export function videoEffectStacksEqual(
  left: VideoEffectInstance[] | undefined,
  right: VideoEffectInstance[] | undefined,
) {
  return (
    JSON.stringify(normalizeVideoEffects(left) ?? []) ===
    JSON.stringify(normalizeVideoEffects(right) ?? [])
  );
}

export function enabledVideoEffects(
  effects: VideoEffectInstance[] | undefined,
) {
  return (effects ?? []).filter((effect) => effect.enabled !== false);
}

export function videoEffectsForClipAtTime(
  clip: VideoTimelineClip,
  adjustmentLayers: AdjustmentLayerClip[],
  timelineTime: number,
  trackSettings: TimelineTrackSettings,
): VideoEffectInstance[] {
  const adjustmentEffects = adjustmentLayersAffectingVideoTrack(
    adjustmentLayers,
    timelineTime,
    clip.trackId,
    trackSettings,
  ).flatMap((layer) => layer.effects ?? []);

  return [...(clip.effects ?? []), ...adjustmentEffects].filter(
    (effect) => effect.enabled !== false,
  );
}

export function hasRasterVideoEffects(
  effects: VideoEffectInstance[] | undefined,
) {
  return enabledVideoEffects(effects).some(
    (effect) => effect.kind === "gaussian-blur" || effect.kind === "sharpen",
  );
}

export function videoEffectFilterDomId(ownerId: string) {
  const safe = ownerId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `ctc-video-fx-${safe}`;
}

export type CombinedVignette = {
  amount: number;
  softness: number;
};

export function combinedVignette(
  effects: VideoEffectInstance[] | undefined,
): CombinedVignette | null {
  const vignettes = enabledVideoEffects(effects).filter(
    (effect): effect is VignetteVideoEffect => effect.kind === "vignette",
  );

  if (vignettes.length === 0) return null;

  // Multiple vignette instances compound like stacked translucent edge masks.
  let remainingLight = 1;
  let weightedSoftness = 0;
  let totalWeight = 0;

  for (const effect of vignettes) {
    const amount = clamp(effect.amount, 0, 100, 45) / 100;
    remainingLight *= 1 - amount;
    weightedSoftness +=
      clamp(effect.softness, 0, 100, 60) * Math.max(0.001, amount);
    totalWeight += Math.max(0.001, amount);
  }

  return {
    amount: (1 - remainingLight) * 100,
    softness: totalWeight > 0 ? weightedSoftness / totalWeight : 60,
  };
}

export function updateVideoEffect(
  effects: VideoEffectInstance[] | undefined,
  id: string,
  patch: Partial<{
    enabled: boolean;
    radius: number;
    amount: number;
    softness: number;
  }>,
) {
  return (effects ?? []).map((effect) =>
    effect.id === id
      ? normalizeVideoEffect({ ...effect, ...patch } as VideoEffectInstance)
      : effect,
  );
}

export function reorderVideoEffects(
  effects: VideoEffectInstance[] | undefined,
  sourceId: string,
  targetId: string,
  placement: "before" | "after" = "before",
) {
  const list = [...(effects ?? [])];
  const sourceIndex = list.findIndex((effect) => effect.id === sourceId);
  if (sourceIndex < 0 || sourceId === targetId) return list;

  const [moved] = list.splice(sourceIndex, 1);
  const targetIndex = list.findIndex((effect) => effect.id === targetId);
  if (targetIndex < 0) return [...list, moved];

  list.splice(targetIndex + (placement === "after" ? 1 : 0), 0, moved);
  return list;
}

export function moveVideoEffect(
  effects: VideoEffectInstance[] | undefined,
  id: string,
  direction: "up" | "down",
) {
  const list = [...(effects ?? [])];
  const index = list.findIndex((effect) => effect.id === id);
  if (index < 0) return list;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= list.length) return list;
  [list[index], list[target]] = [list[target], list[index]];
  return list;
}

function ffNumber(value: number, digits = 5) {
  return Number.isFinite(value) ? value.toFixed(digits) : "0";
}

export function videoEffectFfmpegFilters(
  effects: VideoEffectInstance[] | undefined,
  enableExpression?: string,
): string[] {
  const enabledSuffix = enableExpression ? `:enable='${enableExpression}'` : "";
  const filters: string[] = [];

  for (const effect of enabledVideoEffects(effects)) {
    if (effect.kind === "gaussian-blur") {
      const sigma = Math.max(0, Math.min(50, effect.radius));
      if (sigma > 0.001)
        filters.push(`gblur=sigma=${ffNumber(sigma, 4)}${enabledSuffix}`);
      continue;
    }

    if (effect.kind === "sharpen") {
      const amount = (Math.max(0, Math.min(100, effect.amount)) / 100) * 1.5;
      if (amount > 0.001) {
        filters.push(
          `unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=${ffNumber(amount, 5)}:chroma_amount=0${enabledSuffix}`,
        );
      }
      continue;
    }

    const amount = Math.max(0, Math.min(100, effect.amount)) / 100;
    if (amount <= 0.001) continue;
    const softness = Math.max(0, Math.min(100, effect.softness)) / 100;
    // FFmpeg's optimized vignette filter exposes lens angle rather than a
    // separate feather control. Map Amount to overall strength and use
    // Softness to temper the angle so higher softness produces a gentler edge.
    const angle = amount * (1.08 - softness * 0.48);
    filters.push(
      `vignette=angle=${ffNumber(angle, 5)}:eval=init${enabledSuffix}`,
    );
  }

  return filters;
}
