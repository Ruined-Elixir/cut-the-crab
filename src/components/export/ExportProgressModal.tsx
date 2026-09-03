import "./ExportProgressModal.css";

type ExportProgressModalProps = {
  progress: number;
  status: string;
};

function ExportProgressModal({ progress, status }: ExportProgressModalProps) {
  const safeProgress = Math.max(0, Math.min(100, progress));

  return (
    <div
      className="export-progress-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-progress-title"
      aria-describedby="export-progress-status"
    >
      <div className="export-progress-modal">
        <div className="export-progress-spinner" aria-hidden="true" />

        <h2 id="export-progress-title">Exporting video</h2>

        <p id="export-progress-status">{status}</p>

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

        <p className="export-progress-hint">
          Please keep Subtitle Editor open until the export finishes.
        </p>
      </div>
    </div>
  );
}

export default ExportProgressModal;
