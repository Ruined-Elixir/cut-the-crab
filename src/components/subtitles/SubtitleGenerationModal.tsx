import type { TranscriptionEngine } from "../../services/transcriptionService";

import "./SubtitleGenerationModal.css";

type SubtitleGenerationModalProps = {
  isGenerating: boolean;
  generationStatus: string;
  generationPercent: number;
  modelDownloadPercent: number;
  generationError: string;
  engine: TranscriptionEngine;
  onDismissError: () => void;
};

function clampPercent(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, value));
}

function SubtitleGenerationModal({
  isGenerating,
  generationStatus,
  generationPercent,
  modelDownloadPercent,
  generationError,
  engine,
  onDismissError,
}: SubtitleGenerationModalProps) {
  const safeGenerationPercent = clampPercent(generationPercent);
  const safeDownloadPercent = clampPercent(modelDownloadPercent);

  const isDownloadingModel =
    isGenerating && safeDownloadPercent > 0 && safeDownloadPercent < 100;

  const showDeterminateProgress = isDownloadingModel || engine === "whisper";

  const primaryProgress = isDownloadingModel
    ? safeDownloadPercent
    : safeGenerationPercent;

  const progressLabel = isDownloadingModel
    ? "Downloading model"
    : safeGenerationPercent > 0
      ? "Generating subtitles"
      : "Preparing transcription";

  const statusText =
    generationError ||
    generationStatus ||
    (isGenerating ? "Preparing transcription..." : "Transcription failed.");

  return (
    <div
      className="subtitle-generation-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="subtitle-generation-modal-title"
      aria-describedby="subtitle-generation-modal-status"
    >
      <section
        className={[
          "subtitle-generation-modal",
          generationError ? "has-error" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {!generationError && (
          <div
            className="subtitle-generation-modal-spinner"
            aria-hidden="true"
          />
        )}

        <h2 id="subtitle-generation-modal-title">
          {generationError
            ? "Subtitle generation failed"
            : "Generating subtitles"}
        </h2>

        <p
          id="subtitle-generation-modal-status"
          className="subtitle-generation-modal-status"
        >
          {statusText}
        </p>

        {!generationError && (
          <>
            {showDeterminateProgress && (
              <>
                <div className="subtitle-generation-modal-phase">
                  <span>{progressLabel}</span>
                  <span>{Math.round(primaryProgress)}%</span>
                </div>

                <div
                  className="subtitle-generation-modal-progress-track"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(primaryProgress)}
                  aria-label={progressLabel}
                >
                  <div
                    className="subtitle-generation-modal-progress-fill"
                    style={{
                      width: `${primaryProgress}%`,
                    }}
                  />
                </div>
              </>
            )}

            {!showDeterminateProgress && (
              <div className="subtitle-generation-modal-indeterminate">
                Processing with SenseVoice…
              </div>
            )}

            {isDownloadingModel && (
              <p className="subtitle-generation-modal-secondary-status">
                The transcription model is being prepared. This only needs to
                happen when the required local model is not already available.
              </p>
            )}

            {!isDownloadingModel && (
              <p className="subtitle-generation-modal-secondary-status">
                {engine === "sensevoice"
                  ? "SenseVoice is processing the video locally."
                  : "Subtitle Editor is temporarily locked while the local transcription model processes this video."}
              </p>
            )}

            <p className="subtitle-generation-modal-hint">
              Please keep Subtitle Editor open until generation finishes.
            </p>
          </>
        )}

        {generationError && (
          <>
            <div className="subtitle-generation-modal-error-box">
              {generationError}
            </div>

            <div className="subtitle-generation-modal-actions">
              <button
                type="button"
                className="subtitle-generation-modal-close-button"
                onClick={onDismissError}
              >
                Close
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

export default SubtitleGenerationModal;
