import { useEffect, useState } from "react";

import loadingFrame1 from "../../assets/loading1.png";
import loadingFrame2 from "../../assets/loading2.png";
import loadingFrame3 from "../../assets/loading3.png";

import "./ProjectLoadingOverlay.css";

const LOADING_FRAMES = [loadingFrame1, loadingFrame2, loadingFrame3];
const LOADING_FRAME_DELAY_MS = 500;

type ProjectLoadingOverlayProps = {
  open: boolean;
};

export default function ProjectLoadingOverlay({
  open,
}: ProjectLoadingOverlayProps) {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    for (const src of LOADING_FRAMES) {
      const image = new Image();
      image.src = src;
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setFrameIndex(0);
      return;
    }

    setFrameIndex(0);
    let cancelled = false;
    let timer = 0;

    const scheduleNext = () => {
      timer = window.setTimeout(() => {
        if (cancelled) return;
        setFrameIndex((current) => (current + 1) % LOADING_FRAMES.length);
        scheduleNext();
      }, LOADING_FRAME_DELAY_MS);
    };

    scheduleNext();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="project-loading-overlay"
      role="status"
      aria-live="polite"
      aria-label="Loading project"
    >
      <img
        className="project-loading-animation"
        src={LOADING_FRAMES[frameIndex]}
        alt="Cut The Crab loading"
        draggable={false}
      />
    </div>
  );
}
