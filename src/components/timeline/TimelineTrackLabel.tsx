type TimelineTrackLabelProps = {
  shortLabel: string;
  name: string;
  locked?: boolean;
};

function TimelineTrackLabel({
  shortLabel,
  name,
  locked = false,
}: TimelineTrackLabelProps) {
  return (
    <div className="timeline-row-label timeline-track-label">
      <span className="timeline-track-code">
        {shortLabel}
      </span>

      <span className="timeline-track-name">
        {name}
      </span>

      {locked && (
        <svg
          className="timeline-track-lock"
          viewBox="0 0 16 16"
          aria-label="Locked track"
        >
          <rect
            x="4"
            y="7"
            width="8"
            height="6"
            rx="1.5"
          />
          <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" />
        </svg>
      )}
    </div>
  );
}

export default TimelineTrackLabel;
