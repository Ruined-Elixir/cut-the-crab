import { useEffect, useRef, useState } from "react";

import { open } from "@tauri-apps/plugin-dialog";

import HomeScreen from "./components/home/HomeScreen";
import VideoPlayer from "./components/video/VideoPlayer";
import SubtitlePanel from "./components/subtitles/SubtitlePanel";
import Timeline, {
  clampTimelineZoom,
  TIMELINE_ZOOM_STEP,
} from "./components/timeline/Timeline";
import ExportProgressModal from "./components/export/ExportProgressModal";
import SubtitleGenerationModal from "./components/subtitles/SubtitleGenerationModal";

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

import {
  loadRecentProjects,
  removeRecentProject,
  upsertRecentProject,
  videoPathExists,
} from "./services/projectRegistry";

import { exportStyledVideo } from "./services/videoExport";
import {
  useAppMenuCommands,
  type AppMenuCommand,
} from "./services/appMenu";

import type { TimelineMarker } from "./types/timeline";
import type {
  ProjectLanguage,
  ProjectMetadata,
  RecentProject,
} from "./types/project";

import "./App.css";

type SeekRequest = {
  time: number;
  id: number;
};

type AppScreen = "home" | "editor";

const AUTOSAVE_DEBOUNCE_MS = 3000;

function getVideoTitle(path: string) {
  const fileName = path.split(/[\\/]/).pop() ?? "Untitled Project";

  return fileName.replace(/\.[^/.\\]+$/, "") || "Untitled Project";
}

function transcriptionOptionsForLanguage(language: ProjectLanguage) {
  switch (language) {
    case "cantonese":
      return {
        engine: "sensevoice" as const,
      };

    case "mixed":
      return {
        engine: "whisper" as const,
        model: "small" as const,
      };

    case "english":
    case "mandarin":
    case "french":
    default:
      return {
        engine: "whisper" as const,
        model: "base" as const,
      };
  }
}

function App() {
  // ==========================================================================
  // Application / Home
  // ==========================================================================

  const [screen, setScreen] = useState<AppScreen>("home");
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [homeError, setHomeError] = useState("");
  const [pendingNewProjectPath, setPendingNewProjectPath] = useState<
    string | null
  >(null);
  const [projectMetadata, setProjectMetadata] = useState<ProjectMetadata | null>(
    null,
  );

  // ==========================================================================
  // Video
  // ==========================================================================

  const [videoDuration, setVideoDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoName, setVideoName] = useState<string | null>(null);
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null);

  const [markers, setMarkers] = useState<TimelineMarker[]>([]);
  const [timelineZoom, setTimelineZoom] = useState(1);

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

  const isLoadingVideoRef = useRef(false);

  const lastSavedSnapshotRef = useRef<string>(
    JSON.stringify({ subtitles: [], markers: [] }),
  );

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
  // Recent projects
  // ==========================================================================

  const refreshRecentProjects = async () => {
    setRecentProjects(await loadRecentProjects());
  };

  useEffect(() => {
    void refreshRecentProjects();
  }, []);

  const recordRecentProject = async (
    path: string,
    metadata: ProjectMetadata,
    duration = 0,
  ) => {
    await upsertRecentProject({
      videoPath: path,
      title: metadata.title,
      languages: metadata.languages,
      lastOpenedAt: new Date().toISOString(),
      duration,
    });

    await refreshRecentProjects();
  };

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

    const currentSnapshot = JSON.stringify({ subtitles, markers });

    setHasUnsavedChanges(currentSnapshot !== lastSavedSnapshotRef.current);
  }, [subtitles, markers, videoPath]);

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

        await saveProjectFile(
          videoPath,
          subtitles,
          markers,
          projectMetadata ?? undefined,
        );

        lastSavedSnapshotRef.current = JSON.stringify({ subtitles, markers });
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
  }, [
    videoPath,
    subtitles,
    markers,
    projectMetadata,
    hasUnsavedChanges,
  ]);

  // ==========================================================================
  // Transcription
  // ==========================================================================

  const {
    isGenerating,
    generationStatus,
    generationPercent,
    modelDownloadPercent,
    generationError,
    clearGenerationError,
    transcriptionEngine,
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
  // Video / project loading
  // ==========================================================================

  const handleVideoPathChange = async (
    path: string,
    preferredMetadata?: ProjectMetadata,
  ) => {
    isLoadingVideoRef.current = true;

    const name = path.split(/[\\/]/).pop() ?? "Unknown video";
    const fallbackMetadata: ProjectMetadata = preferredMetadata ?? {
      title: getVideoTitle(path),
      languages: [],
    };

    setHasUnsavedChanges(false);
    setCurrentTime(0);
    setVideoDuration(0);
    setVideoName(name);
    setVideoPath(path);

    replaceSubtitles([]);
    setMarkers([]);
    setSubtitleSearch("");
    setTimelineZoom(1);
    setProjectMetadata(fallbackMetadata);

    void generateWaveform(path);

    let resolvedMetadata = fallbackMetadata;

    try {
      const matchingProject = await loadMatchingProjectFile(path);

      if (matchingProject) {
        const loadedSubtitles = matchingProject.subtitles;
        const loadedMarkers = matchingProject.markers;

        resolvedMetadata = {
          title: matchingProject.title,
          languages:
            matchingProject.languages.length > 0
              ? matchingProject.languages
              : fallbackMetadata.languages,
        };

        replaceSubtitles(loadedSubtitles);
        setMarkers(loadedMarkers);
        setProjectMetadata(resolvedMetadata);

        lastSavedSnapshotRef.current = JSON.stringify({
          subtitles: loadedSubtitles,
          markers: loadedMarkers,
        });

        setHasUnsavedChanges(false);
      } else {
        const matchingSubtitles = await loadMatchingSrtFile(path);

        if (matchingSubtitles) {
          replaceSubtitles(matchingSubtitles);

          lastSavedSnapshotRef.current = JSON.stringify({
            subtitles: matchingSubtitles,
            markers: [],
          });
        } else {
          lastSavedSnapshotRef.current = JSON.stringify({
            subtitles: [],
            markers: [],
          });
        }

        setHasUnsavedChanges(false);
      }
    } catch (error) {
      console.error("Failed to load subtitle data:", error);

      lastSavedSnapshotRef.current = JSON.stringify({
        subtitles: [],
        markers: [],
      });

      setHasUnsavedChanges(false);
    } finally {
      isLoadingVideoRef.current = false;
    }

    setScreen("editor");
    setHomeError("");

    try {
      await recordRecentProject(path, resolvedMetadata);
    } catch (error) {
      console.error("Failed to update recent projects:", error);
    }
  };

  const chooseVideoPath = async () => {
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
      return null;
    }

    return selected;
  };

  const handleChooseVideo = async () => {
    const selected = await chooseVideoPath();

    if (!selected) {
      return;
    }

    await handleVideoPathChange(selected);
  };

  const handleChooseNewProjectVideo = async () => {
    const selected = await chooseVideoPath();

    if (!selected) {
      return;
    }

    setHomeError("");
    setPendingNewProjectPath(selected);
  };

  const handleCreateProject = async (language: ProjectLanguage) => {
    if (!pendingNewProjectPath) {
      return;
    }

    const path = pendingNewProjectPath;
    const metadata: ProjectMetadata = {
      title: getVideoTitle(path),
      languages: [language],
    };

    try {
      await saveProjectFile(path, [], [], metadata);
      setPendingNewProjectPath(null);

      await handleVideoPathChange(path, metadata);

      void generateSubtitles(path, transcriptionOptionsForLanguage(language));
    } catch (error) {
      console.error("Failed to create project:", error);
      setHomeError(
        error instanceof Error ? error.message : "Failed to create project.",
      );
    }
  };

  const handleOpenRecentProject = async (project: RecentProject) => {
    try {
      const exists = await videoPathExists(project.videoPath);

      if (!exists) {
        setHomeError(
          `The video for "${project.title}" could not be found. ` +
            "The file may have been moved or deleted.",
        );
        return;
      }

      await handleVideoPathChange(project.videoPath, {
        title: project.title,
        languages: project.languages,
      });
    } catch (error) {
      console.error("Failed to open recent project:", error);
      setHomeError("Failed to open the selected recent project.");
    }
  };

  const handleRemoveRecentProject = async (project: RecentProject) => {
    try {
      await removeRecentProject(project.videoPath);
      await refreshRecentProjects();
    } catch (error) {
      console.error("Failed to remove recent project:", error);
    }
  };

  const handleVideoDurationChange = (duration: number) => {
    setVideoDuration(duration);

    if (!videoPath || !projectMetadata || duration <= 0) {
      return;
    }

    void recordRecentProject(videoPath, projectMetadata, duration).catch(
      (error) => {
        console.error("Failed to update recent-project duration:", error);
      },
    );
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

      await saveProjectFile(
        videoPath,
        subtitles,
        markers,
        projectMetadata ?? undefined,
      );

      lastSavedSnapshotRef.current = JSON.stringify({ subtitles, markers });
      setHasUnsavedChanges(false);

      if (projectMetadata) {
        await recordRecentProject(
          videoPath,
          projectMetadata,
          videoDuration,
        );
      }

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
    }
  };

  const handleExportSrt = async () => {
    await exportSrtFile(subtitles, videoPath);
  };

  // ==========================================================================
  // Exporting
  // ==========================================================================

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
      case "file.new-project":
        setScreen("home");
        await handleChooseNewProjectVideo();
        return;

      case "file.show-home":
        setScreen("home");
        setHomeError("");
        await refreshRecentProjects();
        return;

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
        if (screen === "editor") {
          addSubtitle(currentTime);
        }
        return;

      case "edit.delete-subtitle":
        if (screen === "editor" && selectedSubtitleId) {
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

      case "view.timeline-zoom-in":
        setTimelineZoom((current) =>
          clampTimelineZoom(current + TIMELINE_ZOOM_STEP),
        );
        return;

      case "view.timeline-zoom-out":
        setTimelineZoom((current) =>
          clampTimelineZoom(current - TIMELINE_ZOOM_STEP),
        );
        return;

      case "view.timeline-zoom-reset":
        setTimelineZoom(1);
        return;
    }
  };

  useAppMenuCommands(handleAppMenuCommand);

  // ==========================================================================
  // Home UI
  // ==========================================================================

  if (screen === "home") {
    return (
      <HomeScreen
        projects={recentProjects}
        pendingVideoPath={pendingNewProjectPath}
        errorMessage={homeError}
        onChooseNewVideo={handleChooseNewProjectVideo}
        onCancelNewProject={() => setPendingNewProjectPath(null)}
        onCreateProject={handleCreateProject}
        onOpenProject={handleOpenRecentProject}
        onRemoveProject={handleRemoveRecentProject}
      />
    );
  }

  // ==========================================================================
  // Editor UI
  // ==========================================================================

  return (
    <main className="app">
      <header className="topbar">
        <button
          type="button"
          className="topbar-home-button"
          onClick={() => {
            setScreen("home");
            setHomeError("");
            void refreshRecentProjects();
          }}
          aria-label="Back to Home"
          title="Home"
        >
          ‹
        </button>

        <div className="topbar-project-title">
          <h1>{projectMetadata?.title ?? videoName ?? "Untitled Project"}</h1>
          <span className="topbar-app-name">Subtitle Editor</span>
        </div>

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
            onDurationChange={handleVideoDurationChange}
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

      <Timeline
        duration={videoDuration}
        currentTime={currentTime}
        videoName={videoName}
        waveform={waveform}
        subtitles={subtitles}
        markers={markers}
        zoom={timelineZoom}
        selectedSubtitleId={selectedSubtitleId}
        onSubtitleSelect={selectSubtitle}
        onSubtitleMove={moveSubtitle}
        onSubtitleResize={resizeSubtitle}
        onMarkersChange={setMarkers}
        onZoomChange={setTimelineZoom}
        onSeek={requestSeek}
      />

      {(isGenerating || generationError) && (
        <SubtitleGenerationModal
          isGenerating={isGenerating}
          generationStatus={generationStatus}
          generationPercent={generationPercent}
          modelDownloadPercent={modelDownloadPercent}
          generationError={generationError}
          engine={transcriptionEngine}
          onDismissError={clearGenerationError}
        />
      )}

      {isExporting && (
        <ExportProgressModal progress={exportProgress} status={exportStatus} />
      )}
    </main>
  );
}

export default App;
