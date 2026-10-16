/** Pure Program Monitor hit-testing, frontmost layer first. Masks are not modeled. */
export type HitTestLayer = {
  id: string; sourceWidth: number; sourceHeight: number;
  positionX?: number; positionY?: number; scale?: number; rotation?: number;
  cropTop?: number; cropRight?: number; cropBottom?: number; cropLeft?: number;
};
export type HitTestPoint = { x: number; y: number };
export type HitTestShell = { width: number; height: number };
export function hitTestLayers(point: HitTestPoint, shell: HitTestShell, layers: HitTestLayer[]): string[] {
  if (shell.width <= 0 || shell.height <= 0) return [];
  return layers.filter(layer => {
    if (layer.sourceWidth <= 0 || layer.sourceHeight <= 0) return false;
    const fit = Math.min(shell.width / layer.sourceWidth, shell.height / layer.sourceHeight);
    const halfW = layer.sourceWidth * fit / 2, halfH = layer.sourceHeight * fit / 2;
    const cx = shell.width / 2 + (layer.positionX ?? 0) / 100 * shell.width;
    const cy = shell.height / 2 + (layer.positionY ?? 0) / 100 * shell.height;
    const scale = (layer.scale ?? 100) / 100;
    if (scale <= 0) return false;
    const r = (layer.rotation ?? 0) * Math.PI / 180;
    const dx = point.x - cx, dy = point.y - cy;
    const x = (dx * Math.cos(r) + dy * Math.sin(r)) / scale;
    const y = (-dx * Math.sin(r) + dy * Math.cos(r)) / scale;
    const crop = (value: number | undefined) => Math.min(49, Math.max(0, value ?? 0)) / 100;
    return x >= -halfW + crop(layer.cropLeft) * 2 * halfW &&
      x <= halfW - crop(layer.cropRight) * 2 * halfW &&
      y >= -halfH + crop(layer.cropTop) * 2 * halfH &&
      y <= halfH - crop(layer.cropBottom) * 2 * halfH;
  }).map(layer => layer.id);
}
