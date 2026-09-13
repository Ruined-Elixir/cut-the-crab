type TimelineTrackLabelProps = {
  shortLabel: string;
  name: string;
  locked?: boolean;
  muted?: boolean;
  hidden?: boolean;
  canMute?: boolean;
  canHide?: boolean;
  onToggleLock?: () => void;
  onToggleMute?: () => void;
  onToggleHidden?: () => void;
};

function TimelineTrackLabel({
  shortLabel,
  name,
  locked = false,
  muted = false,
  hidden = false,
  canMute = false,
  canHide = false,
  onToggleLock,
  onToggleMute,
  onToggleHidden,
}: TimelineTrackLabelProps) {
  return (
    <div className="timeline-row-label timeline-track-label">
      <div className="timeline-track-identity">
        <span className="timeline-track-code">{shortLabel}</span>
        <span className="timeline-track-name">{name}</span>
      </div>

      <div className="timeline-track-controls">
        {canHide && (
          <button
            type="button"
            className={["timeline-track-control", hidden ? "active" : ""]
              .filter(Boolean)
              .join(" ")}
            onClick={onToggleHidden}
            aria-label={hidden ? `Show ${shortLabel}` : `Hide ${shortLabel}`}
            title={hidden ? "Show track" : "Hide track"}
          >
            {hidden ? "○" : "●"}
          </button>
        )}

        {canMute && (
          <button
            type="button"
            className={["timeline-track-control", muted ? "active" : ""]
              .filter(Boolean)
              .join(" ")}
            onClick={onToggleMute}
            aria-label={muted ? `Unmute ${shortLabel}` : `Mute ${shortLabel}`}
            title={muted ? "Unmute track" : "Mute track"}
          >
            {muted ? "M" : "S"}
          </button>
        )}

        {onToggleLock ? (
          <button
            type="button"
            className={["timeline-track-control", locked ? "active" : ""]
              .filter(Boolean)
              .join(" ")}
            onClick={onToggleLock}
            aria-label={locked ? `Unlock ${shortLabel}` : `Lock ${shortLabel}`}
            title={locked ? "Unlock track" : "Lock track"}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="4" y="7" width="8" height="6" rx="1.5" />
              <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" />
            </svg>
          </button>
        ) : locked ? (
          <span className="timeline-track-static-lock" title="Linked track">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="4" y="7" width="8" height="6" rx="1.5" />
              <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" />
            </svg>
          </span>
        ) : null}
      </div>
    </div>
  );
}

export default TimelineTrackLabel;
