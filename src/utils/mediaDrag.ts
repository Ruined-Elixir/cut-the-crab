import type { ProjectMediaAsset } from "../types/project";

export const SUBCUT_MEDIA_DRAG_TYPE = "application/x-subcut-media-asset";

export type MediaDragPayload = {
  assetId: string;
  duration: number;
};

let activeMediaDrag: MediaDragPayload | null = null;

export function beginMediaDrag(asset: ProjectMediaAsset) {
  activeMediaDrag = {
    assetId: asset.id,
    duration: Math.max(0, asset.duration),
  };

  return activeMediaDrag;
}

export function getActiveMediaDrag() {
  return activeMediaDrag;
}

export function endMediaDrag() {
  activeMediaDrag = null;
}
