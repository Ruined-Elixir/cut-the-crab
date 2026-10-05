export type TimelineDragScrollContext = {
  scrollElement: HTMLElement | null;
  startScrollLeft: number;
};

export function captureTimelineDragScroll(
  element: HTMLElement | null,
): TimelineDragScrollContext {
  const scrollElement = element?.closest<HTMLElement>(".timeline-scroll") ?? null;
  return {
    scrollElement,
    startScrollLeft: scrollElement?.scrollLeft ?? 0,
  };
}

export function timelineDragDeltaSeconds(
  clientX: number,
  startClientX: number,
  widthPx: number,
  durationSeconds: number,
  scrollContext: TimelineDragScrollContext,
) {
  const scrollDelta =
    (scrollContext.scrollElement?.scrollLeft ?? scrollContext.startScrollLeft) -
    scrollContext.startScrollLeft;
  return (
    ((clientX - startClientX + scrollDelta) / Math.max(1, widthPx)) *
    durationSeconds
  );
}
