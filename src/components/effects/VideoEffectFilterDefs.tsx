import type { ReactNode } from "react";
import type { VideoEffectInstance } from "../../types/timelineModel";
import {
  enabledVideoEffects,
  hasRasterVideoEffects,
} from "../../utils/videoEffects";

type VideoEffectFilterDefsProps = {
  filterId: string;
  effects?: VideoEffectInstance[];
  previewScale: number;
};

export default function VideoEffectFilterDefs({
  filterId,
  effects,
  previewScale,
}: VideoEffectFilterDefsProps) {
  const active = enabledVideoEffects(effects);
  if (!hasRasterVideoEffects(active)) return null;

  let input = "SourceGraphic";
  let stage = 0;
  const nodes: ReactNode[] = [];

  for (const effect of active) {
    if (effect.kind === "gaussian-blur") {
      const result = `fx-${stage++}`;
      const radius = Math.max(0, effect.radius) * Math.max(0.05, previewScale);
      nodes.push(
        <feGaussianBlur
          key={effect.id}
          in={input}
          stdDeviation={radius}
          edgeMode="duplicate"
          result={result}
        />,
      );
      input = result;
      continue;
    }

    if (effect.kind === "sharpen") {
      const result = `fx-${stage++}`;
      const strength = Math.max(0, Math.min(100, effect.amount)) / 100;
      const edge = -1.25 * strength;
      const center = 1 - 4 * edge;
      nodes.push(
        <feConvolveMatrix
          key={effect.id}
          in={input}
          order="3"
          kernelMatrix={`0 ${edge} 0 ${edge} ${center} ${edge} 0 ${edge} 0`}
          divisor="1"
          bias="0"
          preserveAlpha="true"
          edgeMode="duplicate"
          result={result}
        />,
      );
      input = result;
    }
  }

  return (
    <svg
      width="0"
      height="0"
      aria-hidden="true"
      focusable="false"
      style={{ position: "absolute", pointerEvents: "none" }}
    >
      <defs>
        <filter
          id={filterId}
          x="-50%"
          y="-50%"
          width="200%"
          height="200%"
          colorInterpolationFilters="sRGB"
        >
          {nodes}
        </filter>
      </defs>
    </svg>
  );
}
