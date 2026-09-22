import "./ExportProgressModal.css";

type ExportProgressModalProps = {
  progress: number;
  status: string;
  exporting: boolean;
  cancelling?: boolean;
  errorMessage?: string | null;
  cancelError?: string | null;
  onCancel?: () => void;
  onDismissError?: () => void;
};

function ExportProgressModal({
  progress,
  status,
  exporting,
  cancelling = false,
  errorMessage = null,
  cancelError = null,
  onCancel,
  onDismissError,
}: ExportProgressModalProps) {
  const safeProgress = Math.max(0, Math.min(100, progress));
  const failed = !exporting && Boolean(errorMessage);

  return (
    <div
      className={`export-progress-backdrop${failed ? " export-progress-failed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-progress-title"
      aria-describedby="export-progress-status"
    >
      <div className="export-progress-modal">
        {failed ? (
          <div className="export-progress-error-icon" aria-hidden="true">
            !
          </div>
        ) : (
          <div className="export-progress-spinner" aria-hidden="true" />
        )}

        <h2 id="export-progress-title">
          {failed ? "Export failed" : cancelling ? "Cancelling export" : "Exporting video"}
        </h2>

        <p
          id="export-progress-status"
          className={failed ? "export-progress-error-message" : undefined}
        >
          {failed ? errorMessage : status}
        </p>

        {!failed && (
          <>
            <div
              className="export-progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(safeProgress)}
            >
              <div
                className="export-progress-fill"
                style={{
                  width: `${safeProgress}%`,
                }}
              />
            </div>

            <div className="export-progress-percent">
              {Math.round(safeProgress)}%
            </div>

            {cancelError && (
              <p className="export-progress-inline-error">{cancelError}</p>
            )}

            <p className="export-progress-hint">
              Keep Cut The Crab open until the export finishes or cancellation completes.
            </p>
          </>
        )}

        <div className="export-progress-actions">
          {failed ? (
            <button
              type="button"
              className="export-progress-button export-progress-primary"
              onClick={onDismissError}
            >
              Close
            </button>
          ) : (
            <button
              type="button"
              className="export-progress-button"
              disabled={cancelling || !onCancel}
              onClick={onCancel}
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default ExportProgressModal;
