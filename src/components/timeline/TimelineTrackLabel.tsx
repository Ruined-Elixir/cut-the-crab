type TimelineTrackLabelProps = {
  shortLabel: string;
  name: string;
  locked?: boolean;
  muted?: boolean;
  solo?: boolean;
  hidden?: boolean;
  canMute?: boolean;
  canSolo?: boolean;
  canHide?: boolean;
  onToggleLock?: () => void;
  onToggleMute?: () => void;
  onToggleSolo?: () => void;
  onToggleHidden?: () => void;
  onDelete?: () => void;
};

function TimelineTrackLabel({
  shortLabel,
  name,
  locked = false,
  muted = false,
  solo = false,
  hidden = false,
  canMute = false,
  canSolo = false,
  canHide = false,
  onToggleLock,
  onToggleMute,
  onToggleSolo,
  onToggleHidden,
  onDelete,
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
            M
          </button>
        )}

        {canSolo && (
          <button
            type="button"
            className={["timeline-track-control", solo ? "active" : ""]
              .filter(Boolean)
              .join(" ")}
            onClick={onToggleSolo}
            aria-label={solo ? `Unsolo ${shortLabel}` : `Solo ${shortLabel}`}
            title={solo ? "Unsolo track" : "Solo track"}
          >
            S
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

        {onDelete && (
          <button
            type="button"
            className="timeline-track-control timeline-track-delete"
            onClick={onDelete}
            aria-label={`Delete ${shortLabel}`}
            title="Delete track"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 5.5v6M8 5.5v6M11 5.5v6" />
              <path d="M3.5 4h9M6 4V2.8h4V4M4.5 4l.6 9h5.8l.6-9" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

export default TimelineTrackLabel;
