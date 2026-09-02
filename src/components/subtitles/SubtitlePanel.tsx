import type { Subtitle } from "../../types/subtitle";

import type {
  TranscriptionEngine,
  WhisperModel,
} from "../../services/transcriptionService";

import SubtitleActions from "./SubtitleActions";
import SubtitleGenerationProgress from "./SubtitleGenerationProgress";
import SubtitleList from "./SubtitleList";

import "./SubtitlePanel.css";

type SubtitlePanelProps = {
  subtitles: Subtitle[];

  selectedSubtitleId: string | null;
  activeSubtitleId: string | null;

  search: string;
  onSearchChange: (value: string) => void;

  onSelect: (id: string, startTime: number) => void;

  onTextChange: (id: string, text: string) => void;

  onAdd: () => void;
  onDelete: (id: string) => void;

  onImport: () => void | Promise<void>;
  onExport: () => void | Promise<void>;
  onSaveProject: () => void | Promise<void>;

  onGenerate: () => void | Promise<void>;
  isGenerating: boolean;

  generationStatus: string;
  generationPercent: number;
  modelDownloadPercent: number;
  generationError: string;

  whisperModel: WhisperModel;

  onWhisperModelChange: (model: WhisperModel) => void;

  transcriptionEngine: TranscriptionEngine;

  onTranscriptionEngineChange: (engine: TranscriptionEngine) => void;

  onExportStyledVideo: () => void | Promise<void>;
};

function SubtitlePanel({
  subtitles,
  selectedSubtitleId,
  activeSubtitleId,
  search,
  onSearchChange,
  onSelect,
  onTextChange,
  onAdd,
  onDelete,
  onImport,
  onExport,
  onSaveProject,
  onGenerate,
  isGenerating,
  generationStatus,
  generationPercent,
  modelDownloadPercent,
  generationError,
  whisperModel,
  onWhisperModelChange,
  transcriptionEngine,
  onTranscriptionEngineChange,
  onExportStyledVideo,
}: SubtitlePanelProps) {
  return (
    <aside className="subtitle-panel">
      <div className="subtitle-panel-header">
        <h2>Subtitles</h2>

        <SubtitleActions
          onAdd={onAdd}
          onImport={onImport}
          onExport={onExport}
          onSaveProject={onSaveProject}
          onGenerate={onGenerate}
          isGenerating={isGenerating}
          generationStatus={generationStatus}
          whisperModel={whisperModel}
          onWhisperModelChange={onWhisperModelChange}
          transcriptionEngine={transcriptionEngine}
          onTranscriptionEngineChange={onTranscriptionEngineChange}
          onExportStyledVideo={onExportStyledVideo}
        />

        <SubtitleGenerationProgress
          isGenerating={isGenerating}
          generationStatus={generationStatus}
          generationPercent={generationPercent}
          modelDownloadPercent={modelDownloadPercent}
          generationError={generationError}
        />

        <input
          type="text"
          className="subtitle-search"
          placeholder="Search subtitles"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>

      <SubtitleList
        subtitles={subtitles}
        selectedSubtitleId={selectedSubtitleId}
        activeSubtitleId={activeSubtitleId}
        search={search}
        onSelect={onSelect}
        onTextChange={onTextChange}
        onDelete={onDelete}
      />
    </aside>
  );
}

export default SubtitlePanel;
