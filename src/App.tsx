import { useEffect, useRef, useState } from "react";

import { open } from "@tauri-apps/plugin-dialog";

import VideoPlayer from "./components/video/VideoPlayer";
import SubtitlePanel from "./components/subtitles/SubtitlePanel";
import Timeline from "./components/timeline/Timeline";
import ExportProgressModal from "./components/export/ExportProgressModal";
import SubtitleGenerationProgress from "./components/subtitles/SubtitleGenerationProgress";

import { useSubtitleEditor } from "./hooks/useSubtitleEditor";
import { useTranscription } from "./hooks/useTranscription";
import { useWaveform } from "./hooks/useWaveform";

import {
  exportSrtFile,
  importSrtFile,
  loadMatchingSrtFile,
} from "./services/srtFiles";

import {
  loadMatchingProjectFile,
  saveProjectFile,
} from "./services/projectFiles";

import "./App.css";

import { exportStyledVideo } from "./services/videoExport";
import {
  useAppMenuCommands,
  type AppMenuCommand,
} from "./services/appMenu";

type SeekRequest = {
  time: number;
  id: number;
};

const AUTOSAVE_DEBOUNCE_MS = 3000;

function App() {
  // ==========================================================================
  // Video
  // ==========================================================================

  const [videoDuration, setVideoDuration] = useState(0);

  const [currentTime, setCurrentTime] = useState(0);

  const [videoName, setVideoName] = useState<string | null>(null);

  const [videoPath, setVideoPath] = useState<string | null>(null);

  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null);

  // ==========================================================================
  // Video export UI
  // ==========================================================================

  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStatus, setExportStatus] = useState("Preparing export...");

  // ==========================================================================
  // Project save state
  // ==========================================================================

  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const [isSavingProject, setIsSavingProject] = useState(false);

  /*
   * Prevent subtitle changes caused by loading
   * a new video/project from being treated as
   * user edits.
   */
  const isLoadingVideoRef = useRef(false);

  /*
   * Stores the subtitle state that was last
   * loaded or successfully saved.
   *
   * Comparing against this is more reliable
   * than marking every subtitle state update
   * as dirty.
   */
  const lastSavedSnapshotRef = useRef<string>(JSON.stringify([]));

  // ==========================================================================
  // Waveform
  // ==========================================================================

  const { waveform, generateWaveform } = useWaveform();

  // ==========================================================================
  // Subtitles
  // ==========================================================================

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
    updateSubtitleStyle,
    updateAllSubtitleStyles,

    moveSubtitle,
    resizeSubtitle,
    addSubtitle,
    deleteSubtitle,
    replaceSubtitles,
    replaceWithGeneratedSubtitles,
  } = useSubtitleEditor(currentTime, videoDuration);

  // ==========================================================================
  // Dirty-state detection
  // ==========================================================================

  useEffect(() => {
    if (!videoPath) {
      setHasUnsavedChanges(false);
      return;
    }

    if (isLoadingVideoRef.current) {
      return;
    }

    const currentSnapshot = JSON.stringify(subtitles);

    setHasUnsavedChanges(currentSnapshot !== lastSavedSnapshotRef.current);
  }, [subtitles, videoPath]);

  // ==========================================================================
  // Autosave
  // ==========================================================================

  useEffect(() => {
    if (!videoPath || !hasUnsavedChanges || isLoadingVideoRef.current) {
      return;
    }

    const timeout = window.setTimeout(async () => {
      try {
        setIsSavingProject(true);

        await saveProjectFile(videoPath, subtitles);

        /*
         * Only mark this exact subtitle
         * state as saved.
         */
        lastSavedSnapshotRef.current = JSON.stringify(subtitles);

        setHasUnsavedChanges(false);
      } catch (error) {
        console.error("Autosave failed:", error);
      } finally {
        setIsSavingProject(false);
      }
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [videoPath, subtitles, hasUnsavedChanges]);

  // ==========================================================================
  // Transcription
  // ==========================================================================

  const {
    isGenerating,
    generationStatus,
    generationPercent,
    modelDownloadPercent,
    generationError,
    generateSubtitles,
  } = useTranscription({
    onGenerated: replaceWithGeneratedSubtitles,
  });

  // ==========================================================================
  // Seek
  // ==========================================================================

  const requestSeek = (time: number) => {
    setSeekRequest({
      time,
      id: Date.now(),
    });
  };

  // ==========================================================================
  // Video loading
  // ==========================================================================

  const handleVideoPathChange = async (path: string) => {
    isLoadingVideoRef.current = true;

    const name = path.split(/[\\/]/).pop() ?? "Unknown video";

    setHasUnsavedChanges(false);
    setCurrentTime(0);
    setVideoDuration(0);
    setVideoName(name);
    setVideoPath(path);

    replaceSubtitles([]);
    setSubtitleSearch("");

    void generateWaveform(path);

    try {
      // --------------------------------------------------------------
      // 1. Prefer subtitle project
      // --------------------------------------------------------------

      const matchingProject = await loadMatchingProjectFile(path);

      if (matchingProject) {
        const loadedSubtitles = matchingProject.subtitles;

        replaceSubtitles(loadedSubtitles);

        lastSavedSnapshotRef.current = JSON.stringify(loadedSubtitles);

        setHasUnsavedChanges(false);

        return;
      }

      // --------------------------------------------------------------
      // 2. Fall back to matching SRT
      // --------------------------------------------------------------

      const matchingSubtitles = await loadMatchingSrtFile(path);

      if (matchingSubtitles) {
        replaceSubtitles(matchingSubtitles);

        /*
         * Treat the imported SRT as the
         * initial clean state.
         *
         * A project JSON will only be
         * created after editing/autosaving
         * or pressing Save Project.
         */
        lastSavedSnapshotRef.current = JSON.stringify(matchingSubtitles);

        setHasUnsavedChanges(false);

        return;
      }

      // --------------------------------------------------------------
      // 3. No project or SRT
      // --------------------------------------------------------------

      lastSavedSnapshotRef.current = JSON.stringify([]);

      setHasUnsavedChanges(false);
    } catch (error) {
      console.error("Failed to load subtitle data:", error);

      lastSavedSnapshotRef.current = JSON.stringify([]);

      setHasUnsavedChanges(false);
    } finally {
      isLoadingVideoRef.current = false;
    }
  };

  const handleChooseVideo = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: "Video",
          extensions: ["mp4", "mov", "webm", "mkv"],
        },
      ],
    });

    if (!selected || Array.isArray(selected)) {
      return;
    }

    await handleVideoPathChange(selected);
  };

  // ==========================================================================
  // Project saving
  // ==========================================================================

  const handleSaveProject = async () => {
    if (!videoPath || isSavingProject) {
      return;
    }

    try {
      setIsSavingProject(true);

      await saveProjectFile(videoPath, subtitles);

      lastSavedSnapshotRef.current = JSON.stringify(subtitles);

      setHasUnsavedChanges(false);

      console.log("Project saved.");
    } catch (error) {
      console.error("Failed to save project:", error);
    } finally {
      setIsSavingProject(false);
    }
  };

  // ==========================================================================
  // Subtitle selection
  // ==========================================================================

  const handleSubtitleSelect = (id: string, startTime: number) => {
    selectSubtitle(id);

    requestSeek(startTime);
  };

  // ==========================================================================
  // SRT import/export
  // ==========================================================================

  const handleImportSrt = async () => {
    const importedSubtitles = await importSrtFile();

    if (importedSubtitles) {
      replaceSubtitles(importedSubtitles);

      /*
       * Importing an SRT changes the
       * current project content, so it
       * should be considered unsaved.
       *
       * We intentionally DO NOT update
       * lastSavedSnapshotRef here.
       */
    }
  };

  const handleExportSrt = async () => {
    await exportSrtFile(subtitles, videoPath);
  };

  // =====================
  // Exporting
  // =====================

  const handleExportStyledVideo = async () => {
    if (!videoPath || isExporting) {
      return;
    }

    try {
      const outputPath = await exportStyledVideo(videoPath, subtitles, {
        videoDuration,

        onStart: () => {
          setExportProgress(0);
          setExportStatus("Preparing video export...");
          setIsExporting(true);
        },

        onProgress: ({ progress, status }) => {
          setExportProgress(progress);
          setExportStatus(status);
        },
      });

      if (outputPath) {
        setExportProgress(100);
        setExportStatus("Export complete.");

        console.log("Styled video exported:", outputPath);
      }
    } catch (error) {
      console.error("Styled video export failed:", error);
    } finally {
      setIsExporting(false);
    }
  };

  // ==========================================================================
  // Application command dispatch
  // ==========================================================================

  const handleAppMenuCommand = async (command: AppMenuCommand) => {
    switch (command) {
      case "file.open-video":
        await handleChooseVideo();
        return;

      case "file.save-project":
        await handleSaveProject();
        return;

      case "file.import-srt":
        await handleImportSrt();
        return;

      case "file.export-srt":
        await handleExportSrt();
        return;

      case "file.export-video":
        await handleExportStyledVideo();
        return;

      case "edit.add-subtitle":
        addSubtitle(currentTime);
        return;

      case "edit.delete-subtitle":
        if (selectedSubtitleId) {
          deleteSubtitle(selectedSubtitleId);
        }
        return;

      case "transcription.whisper-base":
        await generateSubtitles(videoPath, {
          engine: "whisper",
          model: "base",
        });
        return;

      case "transcription.whisper-small":
        await generateSubtitles(videoPath, {
          engine: "whisper",
          model: "small",
        });
        return;

      case "transcription.sensevoice":
        await generateSubtitles(videoPath, {
          engine: "sensevoice",
        });
        return;
    }
  };

  useAppMenuCommands(handleAppMenuCommand);

  // ==========================================================================
  // UI
  // ==========================================================================

  return (
    <main className="app">
      <header className="topbar">
        <h1>Subtitle Editor</h1>

        {videoPath && (
          <span className="project-save-status">
            {isSavingProject
              ? "Saving..."
              : hasUnsavedChanges
                ? "Unsaved changes..."
                : "Saved"}
          </span>
        )}
      </header>

      <div className="workspace">
        <section className="preview-panel">
          <VideoPlayer
            videoPath={videoPath}

            videoName={videoName}

            onChooseVideo={handleChooseVideo}

            onDurationChange={setVideoDuration}

            onTimeChange={setCurrentTime}

            seekRequest={seekRequest}

            subtitles={subtitles}

            currentTime={currentTime}

            selectedSubtitleId={selectedSubtitleId}

            onSubtitleSelect={selectSubtitle}

            onSubtitlePositionChange={updateSubtitlePosition}

            onSubtitleTextChange={updateSubtitleText}

            onSubtitleStyleChange={updateSubtitleStyle}

            onAllSubtitleStylesChange={updateAllSubtitleStyles}
          />
        </section>

        <SubtitlePanel
          subtitles={filteredSubtitles}
          selectedSubtitleId={selectedSubtitleId}
          activeSubtitleId={activeSubtitleId}
          search={subtitleSearch}
          onSearchChange={setSubtitleSearch}
          onSelect={handleSubtitleSelect}
          onTextChange={updateSubtitleText}
          onAdd={() => addSubtitle(currentTime)}
          onDelete={deleteSubtitle}
        />
      </div>

      {(isGenerating || generationError) && (
        <div className="app-transcription-status">
          <SubtitleGenerationProgress
            isGenerating={isGenerating}
            generationStatus={generationStatus}
            generationPercent={generationPercent}
            modelDownloadPercent={modelDownloadPercent}
            generationError={generationError}
          />
        </div>
      )}

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

      {isExporting && (
        <ExportProgressModal progress={exportProgress} status={exportStatus} />
      )}
    </main>
  );
}

export default App;
