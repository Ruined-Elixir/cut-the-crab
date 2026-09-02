export type RenderedVideoRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function getRenderedVideoRect(
  video: HTMLVideoElement,
  container: HTMLElement,
): RenderedVideoRect | null {
  if (!video.videoWidth || !video.videoHeight) {
    return null;
  }

  const containerRect = container.getBoundingClientRect();

  const videoAspect = video.videoWidth / video.videoHeight;

  const containerAspect = containerRect.width / containerRect.height;

  let width: number;
  let height: number;
  let left: number;
  let top: number;

  if (containerAspect > videoAspect) {
    // Letterboxing on left/right
    height = containerRect.height;
    width = height * videoAspect;

    left = (containerRect.width - width) / 2;

    top = 0;
  } else {
    // Letterboxing on top/bottom
    width = containerRect.width;
    height = width / videoAspect;

    left = 0;

    top = (containerRect.height - height) / 2;
  }

  return {
    left,
    top,
    width,
    height,
  };
}
