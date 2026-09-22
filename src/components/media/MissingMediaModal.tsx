import type { MissingMediaIssue } from "../../services/missingMedia";

import "./MissingMediaModal.css";

type MissingMediaModalProps = {
  issues: MissingMediaIssue[];
  relinkingPath: string | null;
  deletingPath: string | null;
  onRelink: (issue: MissingMediaIssue) => void | Promise<void>;
  onDelete: (issue: MissingMediaIssue) => void | Promise<void>;
  onClose: () => void;
};

function formatDuration(value: number) {
  if (!Number.isFinite(value) || value <= 0) return null;

  const totalSeconds = Math.ceil(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function MissingMediaModal({
  issues,
  relinkingPath,
  deletingPath,
  onRelink,
  onDelete,
  onClose,
}: MissingMediaModalProps) {
  if (issues.length === 0) return null;

  return (
    <div
      className="missing-media-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="missing-media-title"
    >
      <section className="missing-media-modal">
        <div className="missing-media-heading">
          <div>
            <h2 id="missing-media-title">Missing media</h2>
            <p>
              {issues.length === 1
                ? "This project references a file that can no longer be found."
                : `This project references ${issues.length} files that can no longer be found.`}
            </p>
          </div>
          <span className="missing-media-count" aria-label={`${issues.length} missing`}>
            {issues.length}
          </span>
        </div>

        <div className="missing-media-list">
          {issues.map((issue) => {
            const requiredDuration = formatDuration(issue.requiredDuration);
            const isRelinking = relinkingPath === issue.path;
            const isDeleting = deletingPath === issue.path;
            const actionBusy = relinkingPath !== null || deletingPath !== null;

            return (
              <article className="missing-media-item" key={issue.path}>
                <div className="missing-media-item-copy">
                  <div className="missing-media-item-title-row">
                    <strong title={issue.name}>{issue.name}</strong>
                    <span className="missing-media-kind">
                      {issue.kind === "audio" ? "Audio" : "Video"}
                    </span>
                    {issue.isPrimary && (
                      <span className="missing-media-primary">Primary</span>
                    )}
                  </div>

                  <div className="missing-media-path" title={issue.path}>
                    {issue.path}
                  </div>

                  <div className="missing-media-meta">
                    {issue.referenceCount > 0 && (
                      <span>
                        {issue.referenceCount} timeline/media reference
                        {issue.referenceCount === 1 ? "" : "s"}
                      </span>
                    )}
                    {requiredDuration && (
                      <span>Needs at least {requiredDuration} of source media</span>
                    )}
                  </div>
                </div>

                <div className="missing-media-item-actions">
                  <button
                    type="button"
                    className="missing-media-delete-button"
                    disabled={actionBusy}
                    onClick={() => void onDelete(issue)}
                  >
                    {isDeleting ? "Deleting…" : "Delete"}
                  </button>
                  <button
                    type="button"
                    className="missing-media-relink-button"
                    disabled={actionBusy}
                    onClick={() => void onRelink(issue)}
                  >
                    {isRelinking ? "Relinking…" : "Relink…"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>

        <div className="missing-media-footer">
          <p>
            You can continue editing, but missing clips may stay offline and
            export or transcription can fail until their sources are restored.
          </p>
          <button type="button" className="missing-media-close-button" onClick={onClose}>
            Continue Editing
          </button>
        </div>
      </section>
    </div>
  );
}

export default MissingMediaModal;
