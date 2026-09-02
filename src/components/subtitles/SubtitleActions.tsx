import type {
  TranscriptionEngine,
  WhisperModel,
} from "../../services/transcriptionService";
import "./SubtitleActions.css";

type SubtitleActionsProps = {
  onAdd: () => void;

  onImport: () => void | Promise<void>;
  onExport: () => void | Promise<void>;
  onSaveProject: () => void | Promise<void>;

  onGenerate: () => void | Promise<void>;
  isGenerating: boolean;
  generationStatus: string;

  whisperModel: WhisperModel;
  onWhisperModelChange: (model: WhisperModel) => void;

  transcriptionEngine: TranscriptionEngine;
  onTranscriptionEngineChange: (engine: TranscriptionEngine) => void;

  onExportStyledVideo: () => void | Promise<void>;
};

function SubtitleActions({
  onAdd,
  onImport,
  onExport,
  onSaveProject,
  onGenerate,
  isGenerating,
  generationStatus,
  whisperModel,
  onWhisperModelChange,
  transcriptionEngine,
  onTranscriptionEngineChange,
  onExportStyledVideo,
}: SubtitleActionsProps) {
  return (
    <div className="subtitle-actions">
      <select
        value={transcriptionEngine}
        onChange={(event) =>
          onTranscriptionEngineChange(event.target.value as TranscriptionEngine)
        }
        disabled={isGenerating}
      >
        <option value="whisper">Whisper</option>

        <option value="sensevoice">SenseVoice — Cantonese / Chinese</option>
      </select>

      {transcriptionEngine === "whisper" && (
        <select
          value={whisperModel}
          onChange={(event) =>
            onWhisperModelChange(event.target.value as WhisperModel)
          }
          disabled={isGenerating}
        >
          <option value="base">Base - Fast</option>

          <option value="small">Small - More Accurate</option>
        </select>
      )}

      <button onClick={onAdd}>Add</button>

      <button onClick={() => void onGenerate()} disabled={isGenerating}>
        {isGenerating ? generationStatus || "Generating..." : "Generate"}
      </button>

      <button onClick={() => void onImport()}>Import SRT</button>

      <button onClick={() => void onExport()}>Export SRT</button>

      <button type="button" onClick={() => void onSaveProject()}>
        Save Project
      </button>

      <button type="button" onClick={() => void onExportStyledVideo()}>
        Export Styled Video
      </button>
    </div>
  );
}

export default SubtitleActions;
