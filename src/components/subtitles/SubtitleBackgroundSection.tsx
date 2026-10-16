import { useEffect, useState } from "react";

import { MAX_BACKGROUND_RADIUS } from "../../utils/subtitleBackground";

import "./SubtitleBackgroundSection.css";

type SubtitleBackgroundSectionProps = {
  radius: number;
  hasBackground: boolean;
  onChange: (radius: number) => void;
};

function SubtitleBackgroundSection({
  radius,
  hasBackground,
  onChange,
}: SubtitleBackgroundSectionProps) {
  // Keep the dragged value local and commit once on release, so one drag is
  // one undo step and the libass renderer is rebuilt once.
  const [draft, setDraft] = useState(radius);

  useEffect(() => {
    setDraft(radius);
  }, [radius]);

  const commit = () => {
    if (draft !== radius) onChange(draft);
  };

  return (
    <section className="inspector-section subtitle-background-section">
      <div className="inspector-section-header">
        <span>Corner radius</span>
      </div>

      <div className="subtitle-background-row">
        <input
          type="range"
          min={0}
          max={MAX_BACKGROUND_RADIUS}
          step={1}
          value={draft}
          disabled={!hasBackground}
          aria-label="Background corner radius"
          onChange={(event) => setDraft(Number(event.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        <span className="subtitle-background-value">{draft}</span>
      </div>

      {!hasBackground && (
        <p className="inspector-section-note">
          Choose a background colour to use rounded corners.
        </p>
      )}
    </section>
  );
}

export default SubtitleBackgroundSection;
