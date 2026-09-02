import "./SubtitleGenerationProgress.css";

type SubtitleGenerationProgressProps = {
  isGenerating: boolean;
  generationStatus: string;
  generationPercent: number;
  modelDownloadPercent: number;
  generationError: string;
};

function SubtitleGenerationProgress({
  isGenerating,
  generationStatus,
  generationPercent,
  modelDownloadPercent,
  generationError,
}: SubtitleGenerationProgressProps) {
  const showModelDownload =
    isGenerating && modelDownloadPercent > 0 && modelDownloadPercent < 100;

  const showGenerationProgress = isGenerating && generationPercent > 0;

  return (
    <>
      {isGenerating && generationStatus && (
        <div className="subtitle-generation-status">{generationStatus}</div>
      )}

      {showModelDownload && (
        <div className="subtitle-generation-progress">
          <div className="subtitle-progress-label">
            Model download
            <span>{Math.round(modelDownloadPercent)}%</span>
          </div>

          <progress value={modelDownloadPercent} max={100} />
        </div>
      )}

      {showGenerationProgress && (
        <div className="subtitle-generation-progress">
          <div className="subtitle-progress-label">
            Generation
            <span>{Math.round(generationPercent)}%</span>
          </div>

          <progress value={generationPercent} max={100} />
        </div>
      )}

      {generationError && (
        <div className="subtitle-generation-error">{generationError}</div>
      )}
    </>
  );
}

export default SubtitleGenerationProgress;
