import { useEffect, useState } from "react";
import "./App.css";


import VideoPlayer from "./components/video/VideoPlayer";
import Timeline from "./components/timeline/Timeline";
import SubtitlePanel from "./components/subtitles/SubtitlePanel";

import { useWaveform } from "./hooks/useWaveform";
import { useSubtitleEditor } from "./hooks/useSubtitleEditor";
import { exportSrtFile, importSrtFile } from "./services/srtFiles";

import {
  transcribeVideo,
  type WhisperModel,
  type TranscriptionEngine,
} from "./services/transcriptionService";

import { listen } from "@tauri-apps/api/event";





type SeekRequest = {
  time: number;
  id: number;
};

function App() {
  const [videoDuration, setVideoDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoName, setVideoName] = useState<string | null>(null);
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null);

  const { waveform, generateWaveform } = useWaveform();

  const [isGeneratingSubtitles, setIsGeneratingSubtitles] = useState(false);
  const [transcriptionStatus, setTranscriptionStatus] = useState("");
  const [transcriptionPercent, setTranscriptionPercent] = useState(0);
  const [modelDownloadPercent, setModelDownloadPercent] = useState(0);
  const [whisperModel, setWhisperModel] =
  useState<WhisperModel>("base");

  const [transcriptionEngine, setTranscriptionEngine] =
  useState<TranscriptionEngine>("whisper");

  const [generationError, setGenerationError] = useState("");

  const {
    subtitles,
    filteredSubtitles,
    selectedSubtitleId,
    subtitleSearch,
    activeSubtitleId,
    setSubtitleSearch,
    selectSubtitle,
    updateSubtitleText,
    moveSubtitle,
    resizeSubtitle,
    addSubtitle,
    deleteSubtitle,
    replaceSubtitles,
    replaceWithGeneratedSubtitles,
    updateSubtitlePosition,
  } = useSubtitleEditor(currentTime, videoDuration);

  const requestSeek = (time: number) => {
    setSeekRequest({
      time,
      id: Date.now(),
    });
  };

  const handleImportSrt = async () => {
    const importedSubtitles = await importSrtFile();

    if (importedSubtitles) {
      replaceSubtitles(importedSubtitles);
    }
  };

  const handleExportSrt = async () => {
    await exportSrtFile(subtitles);
  };

  async function generateSubtitles() {
    if (!videoPath) {
      setGenerationError("Please choose a video first.");
      return;
    }

    setIsGeneratingSubtitles(true);
    setGenerationError("");
    setTranscriptionStatus("Checking models...");
    setTranscriptionPercent(0);
    setModelDownloadPercent(0);

    try {
      const result = await transcribeVideo(
        videoPath,
        transcriptionEngine,
        whisperModel
      );

      replaceWithGeneratedSubtitles(result.segments);

      setTranscriptionStatus("Finished");
      setTranscriptionPercent(100);
    } catch (error) {
      console.error("Failed to generate subtitles:", error);

      setTranscriptionStatus("Failed");

      setGenerationError(
        error instanceof Error
          ? error.message
          : String(error)
      );
    } finally {
      setIsGeneratingSubtitles(false);
    }
  }

  useEffect(() => {
    const unlistenStatusPromise = listen<string>(
      "transcription-progress",
      (event) => {
        setTranscriptionStatus(event.payload);
      }
    );

    const unlistenPercentPromise = listen<number>(
      "transcription-percent",
      (event) => {
        setTranscriptionPercent(event.payload);
      }
    );

    const unlistenModelDownloadPromise = listen<number>(
      "model-download-percent",
      (event) => {
        setModelDownloadPercent(event.payload);
      }
    );

    return () => {
      void unlistenStatusPromise.then((unlisten) => unlisten());
      void unlistenPercentPromise.then((unlisten) => unlisten());
      void unlistenModelDownloadPromise.then((unlisten) => unlisten());
    };
  }, []);

  

  return (
    <main className="app">
      <header className="topbar">
        <h1>Subtitle Editor</h1>
      </header>

      <div className="workspace">
        <section className="preview-panel">
          <VideoPlayer
            onDurationChange={setVideoDuration}
            onTimeChange={setCurrentTime}
            onVideoNameChange={setVideoName}
            onVideoPathChange={(path) => {
              setVideoPath(path);
              void generateWaveform(path);
            }}
            seekRequest={seekRequest}

            subtitles={subtitles}
            currentTime={currentTime}

              onSubtitleSelect={selectSubtitle}
              selectedSubtitleId={selectedSubtitleId}
              onSubtitlePositionChange={updateSubtitlePosition}
              onSubtitleTextChange={updateSubtitleText}
          />
        </section>

        <SubtitlePanel
          subtitles={filteredSubtitles}
          selectedSubtitleId={selectedSubtitleId}
          activeSubtitleId={activeSubtitleId}
          search={subtitleSearch}
          onSearchChange={setSubtitleSearch}
          onSelect={(id, startTime) => {
            selectSubtitle(id);
            requestSeek(startTime);
          }}
          onTextChange={updateSubtitleText}
          onAdd={() => addSubtitle(currentTime)}
          onDelete={deleteSubtitle}
          onImport={handleImportSrt}
          onExport={handleExportSrt}
          onGenerate={generateSubtitles}
          isGenerating={isGeneratingSubtitles}
          generationStatus={transcriptionStatus}
          generationPercent={transcriptionPercent}
          modelDownloadPercent={modelDownloadPercent}
          whisperModel={whisperModel}
          onWhisperModelChange={setWhisperModel}
          transcriptionEngine={transcriptionEngine}
          onTranscriptionEngineChange={setTranscriptionEngine}
          generationError={generationError}
        />
      </div>

      <Timeline
        duration={videoDuration}
        currentTime={currentTime}
        videoName={videoName}
        waveform={waveform}
        subtitles={subtitles}
        selectedSubtitleId={selectedSubtitleId}
        onSubtitleSelect={selectSubtitle}
        onSubtitleMove={moveSubtitle}
        onSubtitleResize={resizeSubtitle}
        onSeek={requestSeek}
      />
    </main>
  );
}

export default App;
