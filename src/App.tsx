import { useState } from "react";

import VideoPlayer from "./components/video/VideoPlayer";
import SubtitlePanel from "./components/subtitles/SubtitlePanel";
import Timeline from "./components/timeline/Timeline";

import { useSubtitleEditor } from "./hooks/useSubtitleEditor";
import { useTranscription } from "./hooks/useTranscription";
import { useWaveform } from "./hooks/useWaveform";

import {
  exportSrtFile,
  importSrtFile,
  loadMatchingSrtFile,
} from "./services/srtFiles";

import "./App.css";

type SeekRequest = {
  time: number;
  id: number;
};

function App() {
  // Video
  const [videoDuration, setVideoDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  const [videoName, setVideoName] =
    useState<string | null>(null);

  const [videoPath, setVideoPath] =
    useState<string | null>(null);

  const [seekRequest, setSeekRequest] =
    useState<SeekRequest | null>(null);

  const {
    waveform,
    generateWaveform,
  } = useWaveform();

  // Subtitles
  const {
    subtitles,
    filteredSubtitles,
    selectedSubtitleId,
    subtitleSearch,
    activeSubtitleId,
    setSubtitleSearch,
    selectSubtitle,
    updateSubtitleText,
    updateSubtitlePosition,
    moveSubtitle,
    resizeSubtitle,
    addSubtitle,
    deleteSubtitle,
    replaceSubtitles,
    replaceWithGeneratedSubtitles,
  } = useSubtitleEditor(
    currentTime,
    videoDuration
  );

  // Transcription
  const {
    isGenerating,
    generationStatus,
    generationPercent,
    modelDownloadPercent,
    generationError,
    whisperModel,
    setWhisperModel,
    transcriptionEngine,
    setTranscriptionEngine,
    generateSubtitles,
  } = useTranscription({
    onGenerated:
      replaceWithGeneratedSubtitles,
  });

  const requestSeek = (time: number) => {
    setSeekRequest({
      time,
      id: Date.now(),
    });
  };

  const handleVideoPathChange = async (
    path: string
  ) => {
    setVideoPath(path);

    replaceSubtitles([]);
    setSubtitleSearch("");

    void generateWaveform(path);

    const matchingSubtitles =
      await loadMatchingSrtFile(path);

    if (matchingSubtitles) {
      replaceSubtitles(
        matchingSubtitles
      );
    }
  };

  const handleSubtitleSelect = (
    id: string,
    startTime: number
  ) => {
    selectSubtitle(id);
    requestSeek(startTime);
  };

  const handleImportSrt = async () => {
    const importedSubtitles =
      await importSrtFile();

    if (importedSubtitles) {
      replaceSubtitles(
        importedSubtitles
      );
    }
  };

  const handleExportSrt = async () => {
    await exportSrtFile(
      subtitles,
      videoPath
    );
  };

  return (
    <main className="app">
      <header className="topbar">
        <h1>Subtitle Editor</h1>
      </header>

      <div className="workspace">
        <section className="preview-panel">
          <VideoPlayer
            onDurationChange={
              setVideoDuration
            }
            onTimeChange={
              setCurrentTime
            }
            onVideoNameChange={
              setVideoName
            }
            onVideoPathChange={
              handleVideoPathChange
            }
            seekRequest={seekRequest}
            subtitles={subtitles}
            currentTime={currentTime}
            selectedSubtitleId={
              selectedSubtitleId
            }
            onSubtitleSelect={
              selectSubtitle
            }
            onSubtitlePositionChange={
              updateSubtitlePosition
            }
            onSubtitleTextChange={
              updateSubtitleText
            }
          />
        </section>

        <SubtitlePanel
          subtitles={
            filteredSubtitles
          }
          selectedSubtitleId={
            selectedSubtitleId
          }
          activeSubtitleId={
            activeSubtitleId
          }
          search={subtitleSearch}
          onSearchChange={
            setSubtitleSearch
          }
          onSelect={
            handleSubtitleSelect
          }
          onTextChange={
            updateSubtitleText
          }
          onAdd={() =>
            addSubtitle(currentTime)
          }
          onDelete={
            deleteSubtitle
          }
          onImport={
            handleImportSrt
          }
          onExport={
            handleExportSrt
          }
          onGenerate={() =>
            generateSubtitles(
              videoPath
            )
          }
          isGenerating={
            isGenerating
          }
          generationStatus={
            generationStatus
          }
          generationPercent={
            generationPercent
          }
          modelDownloadPercent={
            modelDownloadPercent
          }
          whisperModel={
            whisperModel
          }
          onWhisperModelChange={
            setWhisperModel
          }
          transcriptionEngine={
            transcriptionEngine
          }
          onTranscriptionEngineChange={
            setTranscriptionEngine
          }
          generationError={
            generationError
          }
        />
      </div>

      <Timeline
        duration={videoDuration}
        currentTime={currentTime}
        videoName={videoName}
        waveform={waveform}
        subtitles={subtitles}
        selectedSubtitleId={
          selectedSubtitleId
        }
        onSubtitleSelect={
          selectSubtitle
        }
        onSubtitleMove={
          moveSubtitle
        }
        onSubtitleResize={
          resizeSubtitle
        }
        onSeek={requestSeek}
      />
    </main>
  );
}

export default App;