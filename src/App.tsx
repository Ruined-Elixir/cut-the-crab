import { useEffect, useRef, useState } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import CtcLogo from "./components/brand/CtcLogo";

import HomeScreen from "./components/home/HomeScreen";
import MediaBrowser from "./components/media/MediaBrowser";
import VideoPlayer from "./components/video/VideoPlayer";
import VideoInspector from "./components/video/VideoInspector";
import SubtitlePanel from "./components/subtitles/SubtitlePanel";
import Timeline, {
  clampTimelineZoom,
  TIMELINE_ZOOM_STEP,
} from "./components/timeline/Timeline";
import ExportProgressModal from "./components/export/ExportProgressModal";
import SubtitleGenerationModal from "./components/subtitles/SubtitleGenerationModal";

import { useEditorHistory } from "./hooks/useEditorHistory";
import { useSubtitleEditor } from "./hooks/useSubtitleEditor";
import { useVideoTimeline } from "./hooks/useVideoTimeline";
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
  parseClipTranscriptionCommand,
  updateTranscriptionMenuTargets,
  useAppMenuCommands,
  type AppMenuCommand,
  type TranscriptionPreset,
} from "./services/appMenu";

import type { TimelineMarker } from "./types/timeline";
import { DEFAULT_TIMELINE_TRACK_SETTINGS } from "./types/timelineModel";
import type {
  TimelineTrackId,
  TimelineTrackSettings,
  VideoTimelineClip,
} from "./types/timelineModel";
import type {
  ProjectLanguage,
  ProjectMediaAsset,
  ProjectMetadata,
  RecentProject,
} from "./types/project";

import "./App.css";

type SeekRequest = {
  time: number;
  id: number;
};

type AppScreen = "home" | "editor";

const AUTOSAVE_DEBOUNCE_MS = 750;

function getVideoTitle(path: string) {
  const fileName = path.split(/[\\/]/).pop() ?? "Untitled Project";

  return fileName.replace(/\.[^/.\\]+$/, "") || "Untitled Project";
}

function getFileName(path: string) {
  return path.split(/[\\/]/).pop() ?? "Video";
}

function formatClipMenuTime(time: number) {
  const safeTime = Math.max(0, Number.isFinite(time) ? time : 0);
  const totalSeconds = Math.floor(safeTime);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function transcriptionOptionsForPreset(preset: TranscriptionPreset) {
  switch (preset) {
    case "whisper-small":
      return {
        engine: "whisper" as const,
        model: "small" as const,
      };

    case "sensevoice":
      return {
        engine: "sensevoice" as const,
      };

    case "whisper-base":
    default:
      return {
        engine: "whisper" as const,
        model: "base" as const,
      };
  }
}

function probeVideoDuration(path: string) {
  return new Promise<number>((resolve) => {
    const probe = document.createElement("video");
    const cleanup = () => {
      probe.removeAttribute("src");
      probe.load();
    };

    probe.preload = "metadata";
    probe.src = convertFileSrc(path);

    probe.onloadedmetadata = () => {
      const duration = Number.isFinite(probe.duration) ? probe.duration : 0;
      cleanup();
      resolve(Math.max(0, duration));
    };

    probe.onerror = () => {
      cleanup();
      resolve(0);
    };
  });
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
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  // ==========================================================================
  // Video
  // ==========================================================================

  const [videoDuration, setVideoDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoName, setVideoName] = useState<string | null>(null);
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null);
  const [mediaAssets, setMediaAssets] = useState<ProjectMediaAsset[]>([]);

  const [markers, setMarkers] = useState<TimelineMarker[]>([]);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [trackSettings, setTrackSettings] = useState<TimelineTrackSettings>(() => ({
    ...DEFAULT_TIMELINE_TRACK_SETTINGS,
  }));

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
  const videoClipboardRef = useRef<VideoTimelineClip | null>(null);

  const lastSavedSnapshotRef = useRef<string>(
    JSON.stringify({ subtitles: [], markers: [], videoClips: [], mediaAssets: [], trackSettings: DEFAULT_TIMELINE_TRACK_SETTINGS }),
  );

  // ==========================================================================
  // Waveform
  // ==========================================================================

  const { waveformsBySource, generateWaveform } = useWaveform();

  useEffect(() => {
    for (const asset of mediaAssets) {
      void generateWaveform(asset.path);
    }
  }, [mediaAssets, generateWaveform]);

  // ==========================================================================
  // Subtitles
  // ==========================================================================

  const {
    subtitles,
    filteredSubtitles,
    selectedSubtitleId,
    selectedSubtitleIds,
    subtitleSearch,
    activeSubtitleId,

    setSubtitleSearch,
    selectSubtitle,
    selectAllSubtitles,
    focusSelectedSubtitle,
    clearSubtitleSelection,

    updateSubtitleText,
    updateSubtitlePosition,
    updateSubtitleStyle,
    updateSubtitleStyles,
    updateAllSubtitleStyles,

    moveSubtitle,
    moveSubtitleGroup,
    nudgeSelectedSubtitles,
    resizeSubtitle,
    addSubtitle,
    splitSubtitle,
    deleteSubtitles,
    replaceSubtitles,
    replaceWithGeneratedSubtitles,
  } = useSubtitleEditor(currentTime, videoDuration);

  const {
    videoClips,
    selectedVideoClipId,
    selectedVideoClip,
    selectVideoClip,
    clearVideoClipSelection,
    moveVideoClip,
    moveVideoClipToTrack,
    resizeVideoClip,
    splitVideoClip,
    deleteVideoClip,
    insertVideoClipCopy,
    duplicateVideoClip,
    insertVideoClipFromMedia,
    updateVideoClipTransform,
    resetVideoClipTransform,
    replaceVideoClips,
    initializeDefaultVideoClip,
  } = useVideoTimeline({
    sourcePath: videoPath,
    sourceName: videoName,
    sourceDuration: videoDuration,
  });

  const editedContentEnd = Math.max(
    0,
    ...videoClips.map((clip) => clip.timelineEnd),
    ...subtitles.map((subtitle) => subtitle.endTime),
    ...markers.map((marker) => marker.time),
  );

  const timelineDuration =
    editedContentEnd > 0 ? editedContentEnd : videoDuration;

  // ==========================================================================
  // Undo / Redo history
  // ==========================================================================

  const {
    canUndo,
    canRedo,
    undo,
    redo,
    resetHistory,
    markNextChangeImmediate,
  } = useEditorHistory({
    snapshot: {
      subtitles,
      markers,
      videoClips,
    },
    enabled:
      screen === "editor" &&
      !!videoPath &&
      !isLoadingVideoRef.current,
    onApply: (snapshot) => {
      replaceSubtitles(snapshot.subtitles);
      setMarkers(snapshot.markers);
      replaceVideoClips(snapshot.videoClips);
    },
  });

  const addSubtitleWithHistory = (time: number) => {
    markNextChangeImmediate();
    addSubtitle(time);
  };

  const splitSelectedVideoClipAtPlayhead = () => {
    if (!selectedVideoClipId) {
      return false;
    }

    const selectedClip = videoClips.find(
      (clip) =>
        clip.id === selectedVideoClipId,
    );

    if (!selectedClip || trackSettings[selectedClip.trackId]?.locked) {
      return false;
    }

    if (
      currentTime <= selectedClip.timelineStart + 0.1 ||
      currentTime >= selectedClip.timelineEnd - 0.1
    ) {
      return false;
    }

    markNextChangeImmediate();
    splitVideoClip(
      selectedVideoClipId,
      currentTime,
    );

    return true;
  };

  const deleteSelectedVideoClipWithHistory = () => {
    if (!selectedVideoClipId) {
      return false;
    }

    const selectedClip = videoClips.find((clip) => clip.id === selectedVideoClipId);

    if (!selectedClip || trackSettings[selectedClip.trackId]?.locked) {
      return false;
    }

    markNextChangeImmediate();
    deleteVideoClip(selectedVideoClipId);

    return true;
  };

  const copySelectedVideoClip = () => {
    if (!selectedVideoClip) {
      return false;
    }

    videoClipboardRef.current = { ...selectedVideoClip };
    return true;
  };

  const pasteVideoClipAtPlayhead = () => {
    const clipboardClip = videoClipboardRef.current;

    if (!clipboardClip || trackSettings[clipboardClip.trackId]?.locked) {
      return false;
    }

    markNextChangeImmediate();
    clearSubtitleSelection();
    insertVideoClipCopy(clipboardClip, currentTime);
    return true;
  };

  const duplicateSelectedVideoClipWithHistory = () => {
    if (!selectedVideoClipId || !selectedVideoClip) {
      return false;
    }

    if (trackSettings[selectedVideoClip.trackId]?.locked) {
      return false;
    }

    markNextChangeImmediate();
    clearSubtitleSelection();
    duplicateVideoClip(selectedVideoClipId);
    return true;
  };

  const handleVideoClipSelect = (id: string) => {
    selectVideoClip(id);
    clearSubtitleSelection();
  };

  const toggleTrackSetting = (
    trackId: TimelineTrackId,
    setting: "locked" | "muted" | "hidden",
  ) => {
    setTrackSettings((current) => ({
      ...current,
      [trackId]: {
        ...(current[trackId] ?? { locked: false }),
        [setting]: !(current[trackId]?.[setting] ?? false),
      },
    }));
  };

  const handleMoveVideoClipToTrack = (
    id: string,
    targetTrackId: TimelineTrackId,
    newTimelineStart: number,
  ) => {
    if (trackSettings[targetTrackId]?.locked) {
      return;
    }

    markNextChangeImmediate();
    moveVideoClipToTrack(id, targetTrackId, newTimelineStart);
  };


  const handleVideoTransformChange = (
    id: string,
    transform: {
      positionX?: number;
      positionY?: number;
      scale?: number;
      rotation?: number;
      cropTop?: number;
      cropRight?: number;
      cropBottom?: number;
      cropLeft?: number;
    },
  ) => {
    const clip = videoClips.find((item) => item.id === id);

    if (!clip || trackSettings[clip.trackId]?.locked) {
      return;
    }

    updateVideoClipTransform(id, transform);
  };

  const handleResetVideoTransform = (id: string) => {
    const clip = videoClips.find((item) => item.id === id);

    if (!clip || trackSettings[clip.trackId]?.locked) {
      return;
    }

    markNextChangeImmediate();
    resetVideoClipTransform(id);
  };

  const handleSubtitleTrackSelect = (
    id: string,
    mode:
      | "single"
      | "toggle"
      | "range" = "single",
  ) => {
    clearVideoClipSelection();
    selectSubtitle(id, mode);
  };

  const splitSelectedSubtitleAtPlayhead = () => {
    if (!selectedSubtitleId) {
      return;
    }

    const selectedSubtitle = subtitles.find(
      (subtitle) => subtitle.id === selectedSubtitleId,
    );

    if (!selectedSubtitle) {
      return;
    }

    const MIN_SPLIT_GAP = 0.05;

    if (
      currentTime <=
        selectedSubtitle.startTime + MIN_SPLIT_GAP ||
      currentTime >=
        selectedSubtitle.endTime - MIN_SPLIT_GAP
    ) {
      return;
    }

    markNextChangeImmediate();

    splitSubtitle(
      selectedSubtitleId,
      currentTime,
    );
  };

  const deleteSubtitleWithHistory = (id: string) => {
    const idsToDelete =
      selectedSubtitleIds.includes(id) &&
      selectedSubtitleIds.length > 1
        ? selectedSubtitleIds
        : [id];

    markNextChangeImmediate();
    deleteSubtitles(idsToDelete);
  };

  const deleteSelectionWithHistory = () => {
    if (selectedSubtitleIds.length === 0) {
      return;
    }

    markNextChangeImmediate();
    deleteSubtitles(selectedSubtitleIds);
  };

  const updateSubtitleStyleWithSelection = (
    id: string,
    style: Parameters<typeof updateSubtitleStyle>[1],
  ) => {
    if (
      selectedSubtitleIds.includes(id) &&
      selectedSubtitleIds.length > 1
    ) {
      updateSubtitleStyles(
        selectedSubtitleIds,
        style,
      );
      return;
    }

    updateSubtitleStyle(id, style);
  };

  const setMarkersWithHistory = (
    nextMarkers: TimelineMarker[],
  ) => {
    markNextChangeImmediate();
    setMarkers(nextMarkers);
  };

  const replaceSubtitlesWithHistory = (
    nextSubtitles: typeof subtitles,
  ) => {
    markNextChangeImmediate();
    replaceSubtitles(nextSubtitles);
  };

  const replaceGeneratedSubtitlesWithHistory = (
    segments: {
      startTime: number;
      endTime: number;
      text: string;
    }[],
  ) => {
    markNextChangeImmediate();
    replaceWithGeneratedSubtitles(segments);
  };

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
    projectId: string,
    path: string,
    metadata: ProjectMetadata,
    duration = 0,
  ) => {
    await upsertRecentProject({
      projectId,
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

    const currentSnapshot = JSON.stringify({ subtitles, markers, videoClips, mediaAssets, trackSettings });

    setHasUnsavedChanges(currentSnapshot !== lastSavedSnapshotRef.current);
  }, [
    subtitles,
    markers,
    videoClips,
    mediaAssets,
    trackSettings,
    videoPath,
  ]);

  // ==========================================================================
  // Autosave
  // ==========================================================================

  useEffect(() => {
    if (
      !activeProjectId ||
      !videoPath ||
      !hasUnsavedChanges ||
      isLoadingVideoRef.current
    ) {
      return;
    }

    const timeout = window.setTimeout(async () => {
      try {
        setIsSavingProject(true);

        await saveProjectFile(
          activeProjectId,
          videoPath,
          subtitles,
          markers,
          projectMetadata ?? undefined,
          videoClips,
          mediaAssets,
          trackSettings,
        );

        lastSavedSnapshotRef.current = JSON.stringify({ subtitles, markers, videoClips, mediaAssets, trackSettings });
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
    activeProjectId,
    videoPath,
    subtitles,
    markers,
    projectMetadata,
    videoClips,
    mediaAssets,
    trackSettings,
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
    onGenerated: replaceGeneratedSubtitlesWithHistory,
  });

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const targets =
        screen === "editor"
          ? [...videoClips]
              .sort(
                (a, b) =>
                  a.timelineStart - b.timelineStart ||
                  a.trackId.localeCompare(b.trackId),
              )
              .map((clip, index) => ({
                clipId: clip.id,
                label: `Clip ${index + 1} — ${clip.sourceName} · ${
                  clip.trackId === "video-2" ? "V2" : "V1"
                } ${formatClipMenuTime(clip.timelineStart)}`,
              }))
          : [];

      void updateTranscriptionMenuTargets(targets).catch((error) => {
        console.error("Failed to update Transcription menu targets:", error);
      });
    }, 200);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [screen, videoClips]);

  const generateSubtitlesForVideoClip = async (
    clip: VideoTimelineClip,
    preset: TranscriptionPreset,
  ) => {
    const generatedSegments = await generateSubtitles(
      clip.sourcePath,
      {
        ...transcriptionOptionsForPreset(preset),
        commitResult: false,
      },
    );

    if (!generatedSegments) {
      return;
    }

    const mappedSubtitles = generatedSegments.flatMap((segment) => {
      const sourceStart = Math.max(segment.startTime, clip.sourceIn);
      const sourceEnd = Math.min(segment.endTime, clip.sourceOut);

      if (sourceEnd <= sourceStart) {
        return [];
      }

      return [
        {
          id: crypto.randomUUID(),
          startTime:
            clip.timelineStart + (sourceStart - clip.sourceIn),
          endTime:
            clip.timelineStart + (sourceEnd - clip.sourceIn),
          text: segment.text,
        },
      ];
    });

    if (mappedSubtitles.length === 0) {
      return;
    }

    replaceSubtitlesWithHistory([
      ...subtitles,
      ...mappedSubtitles,
    ]);
  };

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
    requestedProjectId?: string,
  ) => {
    isLoadingVideoRef.current = true;

    const projectId =
      requestedProjectId ?? crypto.randomUUID();

    setActiveProjectId(projectId);

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
    setMediaAssets([]);

    replaceSubtitles([]);
    replaceVideoClips([]);
    setMarkers([]);
    setSubtitleSearch("");
    setTimelineZoom(1);
    setTrackSettings({ ...DEFAULT_TIMELINE_TRACK_SETTINGS });
    setProjectMetadata(fallbackMetadata);

    void generateWaveform(path);

    let resolvedMetadata = fallbackMetadata;
    let loadedHistorySnapshot = {
      subtitles: [] as typeof subtitles,
      markers: [] as TimelineMarker[],
      videoClips: [] as VideoTimelineClip[],
      mediaAssets: [] as ProjectMediaAsset[],
    };

    try {
      const matchingProject = await loadMatchingProjectFile(
        projectId,
        path,
      );

      if (matchingProject) {
        const loadedSubtitles = matchingProject.subtitles;
        const loadedMarkers = matchingProject.markers;
        const loadedVideoClips =
          matchingProject.videoClips;
        const loadedMediaAssets = matchingProject.mediaAssets;

        resolvedMetadata = {
          title: matchingProject.title,
          languages:
            matchingProject.languages.length > 0
              ? matchingProject.languages
              : fallbackMetadata.languages,
        };

        replaceSubtitles(loadedSubtitles);
        replaceVideoClips(loadedVideoClips, {
          markSourceInitialized: true,
        });
        setMarkers(loadedMarkers);
        setMediaAssets(loadedMediaAssets);
        setTrackSettings(matchingProject.trackSettings);
        setProjectMetadata(resolvedMetadata);

        loadedHistorySnapshot = {
          subtitles: loadedSubtitles,
          markers: loadedMarkers,
          videoClips: loadedVideoClips,
          mediaAssets: loadedMediaAssets,
        };

        lastSavedSnapshotRef.current = JSON.stringify({
          subtitles: loadedSubtitles,
          markers: loadedMarkers,
          videoClips: loadedVideoClips,
          mediaAssets: loadedMediaAssets,
          trackSettings: matchingProject.trackSettings,
        });

        setHasUnsavedChanges(false);
      } else {
        const matchingSubtitles = await loadMatchingSrtFile(path);

        if (matchingSubtitles) {
          replaceSubtitles(matchingSubtitles);

          loadedHistorySnapshot = {
            subtitles: matchingSubtitles,
            markers: [],
            videoClips: [],
            mediaAssets: [],
          };

          lastSavedSnapshotRef.current = JSON.stringify({
            subtitles: matchingSubtitles,
            markers: [],
            videoClips: [],
            mediaAssets: [],
            trackSettings: DEFAULT_TIMELINE_TRACK_SETTINGS,
          });
        } else {
          lastSavedSnapshotRef.current = JSON.stringify({
            subtitles: [],
            markers: [],
            videoClips: [],
            mediaAssets: [],
            trackSettings: DEFAULT_TIMELINE_TRACK_SETTINGS,
          });
        }

        setHasUnsavedChanges(false);
      }
    } catch (error) {
      console.error("Failed to load subtitle data:", error);

      loadedHistorySnapshot = {
        subtitles: [],
        markers: [],
        videoClips: [],
        mediaAssets: [],
      };

      lastSavedSnapshotRef.current = JSON.stringify({
        subtitles: [],
        markers: [],
        videoClips: [],
        mediaAssets: [],
        trackSettings: DEFAULT_TIMELINE_TRACK_SETTINGS,
      });

      setHasUnsavedChanges(false);
    } finally {
      isLoadingVideoRef.current = false;
    }

    resetHistory(loadedHistorySnapshot);

    setScreen("editor");
    setHomeError("");

    try {
      await recordRecentProject(
        projectId,
        path,
        resolvedMetadata,
      );
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

  const handleImportMedia = async () => {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: "Video",
          extensions: ["mp4", "mov", "webm", "mkv"],
        },
      ],
    });

    if (!selected) {
      return;
    }

    const paths = Array.isArray(selected) ? selected : [selected];
    const existingPaths = new Set(mediaAssets.map((asset) => asset.path));
    const additions: ProjectMediaAsset[] = [];

    for (const path of paths) {
      if (existingPaths.has(path)) {
        continue;
      }

      const duration = await probeVideoDuration(path);

      additions.push({
        id: crypto.randomUUID(),
        kind: "video",
        path,
        name: getFileName(path),
        duration,
      });

      existingPaths.add(path);
    }

    if (additions.length > 0) {
      setMediaAssets((current) => [...current, ...additions]);
    }
  };

  const insertMediaAssetOnTimeline = (
    asset: ProjectMediaAsset,
    timelineTime: number,
    trackId: TimelineTrackId,
  ) => {
    if (asset.duration <= 0) {
      return;
    }

    markNextChangeImmediate();
    clearSubtitleSelection();
    insertVideoClipFromMedia(asset, timelineTime, trackId);
  };

  const handleInsertMediaAtPlayhead = (asset: ProjectMediaAsset) => {
    insertMediaAssetOnTimeline(
      asset,
      currentTime,
      selectedVideoClip?.trackId ?? "video-1",
    );
  };

  const handleMediaDropOnTimeline = (
    assetId: string,
    trackId: TimelineTrackId,
    timelineTime: number,
  ) => {
    const asset = mediaAssets.find((item) => item.id === assetId);

    if (!asset) {
      return;
    }

    insertMediaAssetOnTimeline(asset, timelineTime, trackId);
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
    const projectId = crypto.randomUUID();

    const metadata: ProjectMetadata = {
      title: getVideoTitle(path),
      languages: [language],
    };

    try {
      await saveProjectFile(
        projectId,
        path,
        [],
        [],
        metadata,
        [],
        [],
        DEFAULT_TIMELINE_TRACK_SETTINGS,
      );

      setPendingNewProjectPath(null);

      await handleVideoPathChange(
        path,
        metadata,
        projectId,
      );

      void generateSubtitles(path, transcriptionOptionsForLanguage(language));
    } catch (error) {
      console.error("Failed to create project:", error);
      setHomeError(
        error instanceof Error ? error.message : "Failed to create project.",
      );
    }
  };

  const handleRenameRecentProject = async (
    project: RecentProject,
    nextTitle: string,
  ) => {
    const title = nextTitle.trim();

    if (!title || title === project.title) {
      return;
    }

    try {
      setHomeError("");

      const matchingProject = await loadMatchingProjectFile(
        project.projectId,
        project.videoPath,
      );

      if (matchingProject) {
        await saveProjectFile(
          project.projectId,
          project.videoPath,
          matchingProject.subtitles,
          matchingProject.markers,
          {
            title,
            languages:
              matchingProject.languages.length > 0
                ? matchingProject.languages
                : project.languages,
          },
          matchingProject.videoClips,
          matchingProject.mediaAssets,
          matchingProject.trackSettings,
        );
      }

      await upsertRecentProject({
        ...project,
        title,
      });

      if (activeProjectId === project.projectId) {
        setProjectMetadata((current) => ({
          title,
          languages: current?.languages ?? project.languages,
        }));
      }

      await refreshRecentProjects();
    } catch (error) {
      console.error("Failed to rename project:", error);

      setHomeError(
        error instanceof Error ? error.message : "Failed to rename project.",
      );
    }
  };

  const handleRelinkRecentProject = async (project: RecentProject) => {
    const replacementPath = await chooseVideoPath();

    if (!replacementPath) {
      return;
    }

    try {
      setHomeError("");

      const oldProject = await loadMatchingProjectFile(
        project.projectId,
        project.videoPath,
      );

      if (oldProject) {
        await saveProjectFile(
          project.projectId,
          replacementPath,
          oldProject.subtitles,
          oldProject.markers,
          {
            title: oldProject.title || project.title,
            languages:
              oldProject.languages.length > 0
                ? oldProject.languages
                : project.languages,
          },
          oldProject.videoClips,
          oldProject.mediaAssets,
          oldProject.trackSettings,
        );
      }

      await removeRecentProject(project.projectId);

      await upsertRecentProject({
        projectId: project.projectId,
        videoPath: replacementPath,
        title: oldProject?.title || project.title,
        languages:
          oldProject && oldProject.languages.length > 0
            ? oldProject.languages
            : project.languages,
        lastOpenedAt: new Date().toISOString(),
        duration: project.duration,
      });

      await refreshRecentProjects();

      await handleVideoPathChange(
        replacementPath,
        {
          title: oldProject?.title || project.title,
          languages:
            oldProject && oldProject.languages.length > 0
              ? oldProject.languages
              : project.languages,
        },
        project.projectId,
      );
    } catch (error) {
      console.error("Failed to relink project media:", error);

      setHomeError(
        error instanceof Error
          ? error.message
          : "Failed to relink the selected project.",
      );
    }
  };

  const handleOpenRecentProject = async (project: RecentProject) => {
    try {
      const exists = await videoPathExists(project.videoPath);

      if (!exists) {
        await handleRelinkRecentProject(project);
        return;
      }

      await handleVideoPathChange(
        project.videoPath,
        {
          title: project.title,
          languages: project.languages,
        },
        project.projectId,
      );
    } catch (error) {
      console.error("Failed to open recent project:", error);
      setHomeError("Failed to open the selected recent project.");
    }
  };

  const handleRemoveRecentProject = async (project: RecentProject) => {
    try {
      await removeRecentProject(project.projectId);
      await refreshRecentProjects();
    } catch (error) {
      console.error("Failed to remove recent project:", error);
    }
  };

  const handleVideoDurationChange = (duration: number) => {
    setVideoDuration(duration);

    if (duration > 0 && videoPath && videoName) {
      setMediaAssets((current) => {
        const existing = current.find((asset) => asset.path === videoPath);

        if (existing) {
          if (existing.duration === duration && existing.name === videoName) {
            return current;
          }

          return current.map((asset) =>
            asset.id === existing.id
              ? { ...asset, duration, name: videoName }
              : asset,
          );
        }

        return [
          {
            id: `primary:${activeProjectId ?? videoPath}`,
            kind: "video",
            path: videoPath,
            name: videoName,
            duration,
          },
          ...current,
        ];
      });
    }

    if (
      duration > 0 &&
      videoClips.length === 0
    ) {
      initializeDefaultVideoClip();
    }

    if (
      !activeProjectId ||
      !videoPath ||
      !projectMetadata ||
      duration <= 0
    ) {
      return;
    }

    void recordRecentProject(
      activeProjectId,
      videoPath,
      projectMetadata,
      duration,
    ).catch(
      (error) => {
        console.error("Failed to update recent-project duration:", error);
      },
    );
  };

  // ==========================================================================
  // Project saving
  // ==========================================================================

  const handleSaveProject = async () => {
    if (!activeProjectId || !videoPath || isSavingProject) {
      return;
    }

    try {
      setIsSavingProject(true);

      await saveProjectFile(
        activeProjectId,
        videoPath,
        subtitles,
        markers,
        projectMetadata ?? undefined,
        videoClips,
        mediaAssets,
        trackSettings,
      );

      lastSavedSnapshotRef.current = JSON.stringify({ subtitles, markers, videoClips, mediaAssets, trackSettings });
      setHasUnsavedChanges(false);

      if (projectMetadata) {
        await recordRecentProject(
          activeProjectId,
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

  const handleSubtitleSelect = (
    id: string,
    startTime: number,
    mode: "single" | "toggle" | "range" = "single",
  ) => {
    clearVideoClipSelection();
    selectSubtitle(id, mode);

    if (mode === "single") {
      requestSeek(startTime);
    }
  };

  // ==========================================================================
  // SRT import/export
  // ==========================================================================

  const handleImportSrt = async () => {
    const importedSubtitles = await importSrtFile();

    if (importedSubtitles) {
      replaceSubtitlesWithHistory(importedSubtitles);
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
    const clipTranscription = parseClipTranscriptionCommand(command);

    if (clipTranscription) {
      if (screen !== "editor") {
        return;
      }

      const clip = videoClips.find(
        (item) => item.id === clipTranscription.clipId,
      );

      if (clip) {
        await generateSubtitlesForVideoClip(
          clip,
          clipTranscription.preset,
        );
      }

      return;
    }

    switch (command) {
      case "file.new-project":
        if (screen === "editor" && hasUnsavedChanges) {
          await handleSaveProject();
        }

        setScreen("home");
        await handleChooseNewProjectVideo();
        return;

      case "file.show-home":
        if (screen === "editor" && hasUnsavedChanges) {
          await handleSaveProject();
        }

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

      case "edit.undo":
        if (screen === "editor") {
          undo();
        }
        return;

      case "edit.redo":
        if (screen === "editor") {
          redo();
        }
        return;

      case "edit.split-subtitle":
        if (screen === "editor") {
          if (!splitSelectedVideoClipAtPlayhead()) {
            splitSelectedSubtitleAtPlayhead();
          }
        }
        return;

      case "edit.select-all-subtitles":
        if (screen === "editor") {
          selectAllSubtitles();
        }
        return;

      case "edit.deselect-all-subtitles":
        if (screen === "editor") {
          clearSubtitleSelection();
        }
        return;

      case "edit.add-subtitle":
        if (screen === "editor") {
          addSubtitleWithHistory(currentTime);
        }
        return;

      case "edit.delete-subtitle":
        if (screen === "editor") {
          if (!deleteSelectedVideoClipWithHistory()) {
            deleteSelectionWithHistory();
          }
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

  const trimPrimarySubtitleToPlayhead = (
    edge: "start" | "end",
  ) => {
    if (!selectedSubtitleId) {
      return;
    }

    const subtitle = subtitles.find(
      (item) => item.id === selectedSubtitleId,
    );

    if (!subtitle) {
      return;
    }

    const MIN_SUBTITLE_DURATION = 0.1;

    if (
      currentTime <= subtitle.startTime ||
      currentTime >= subtitle.endTime
    ) {
      return;
    }

    if (
      edge === "start" &&
      currentTime >
        subtitle.endTime - MIN_SUBTITLE_DURATION
    ) {
      return;
    }

    if (
      edge === "end" &&
      currentTime <
        subtitle.startTime + MIN_SUBTITLE_DURATION
    ) {
      return;
    }

    markNextChangeImmediate();

    if (edge === "start") {
      resizeSubtitle(
        subtitle.id,
        currentTime,
        subtitle.endTime,
      );
      return;
    }

    resizeSubtitle(
      subtitle.id,
      subtitle.startTime,
      currentTime,
    );
  };

  useEffect(() => {
    const handleEditorShortcutKeyDown = (
      event: KeyboardEvent,
    ) => {
      if (
        screen !== "editor" ||
        isGenerating ||
        isExporting
      ) {
        return;
      }

      const target = event.target as HTMLElement;
      const isEditingText =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      if (!isEditingText && event.key === "Escape") {
        if (selectedSubtitleIds.length > 0) {
          event.preventDefault();
          clearSubtitleSelection();
        }

        return;
      }

      if (
        !isEditingText &&
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        (event.key === "[" || event.key === "]")
      ) {
        event.preventDefault();

        trimPrimarySubtitleToPlayhead(
          event.key === "[" ? "start" : "end",
        );

        return;
      }

      if (
        !isEditingText &&
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        (event.key === "ArrowLeft" ||
          event.key === "ArrowRight")
      ) {
        if (selectedSubtitleIds.length === 0) {
          return;
        }

        event.preventDefault();

        const step = event.shiftKey ? 1 : 0.1;
        const direction =
          event.key === "ArrowLeft" ? -1 : 1;

        nudgeSelectedSubtitles(step * direction);
        return;
      }

      if (
        !isEditingText &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (event.key === "[" || event.key === "]")
      ) {
        if (selectedSubtitleIds.length === 0) {
          return;
        }

        const orderedSelected = subtitles
          .filter((subtitle) =>
            selectedSubtitleIds.includes(subtitle.id),
          )
          .sort((a, b) => a.startTime - b.startTime);

        if (orderedSelected.length === 0) {
          return;
        }

        event.preventDefault();

        const currentIndex = orderedSelected.findIndex(
          (subtitle) =>
            subtitle.id === selectedSubtitleId,
        );

        const delta = event.key === "[" ? -1 : 1;
        const fallbackIndex =
          delta > 0 ? -1 : orderedSelected.length;

        const nextIndex =
          ((
            (currentIndex >= 0
              ? currentIndex
              : fallbackIndex) +
            delta
          ) +
            orderedSelected.length) %
          orderedSelected.length;

        const nextSubtitle = orderedSelected[nextIndex];

        focusSelectedSubtitle(nextSubtitle.id);
        requestSeek(nextSubtitle.startTime);
        return;
      }

      if (
        !isEditingText &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (event.key === "Delete" ||
          event.key === "Backspace")
      ) {
        if (selectedVideoClipId) {
          event.preventDefault();
          deleteSelectedVideoClipWithHistory();
          return;
        }

        if (selectedSubtitleIds.length > 0) {
          event.preventDefault();
          deleteSelectionWithHistory();
        }

        return;
      }

      const commandModifier =
        event.metaKey || event.ctrlKey;

      if (!commandModifier || event.altKey) {
        return;
      }

      const key = event.key.toLowerCase();

      if (!isEditingText && key === "c" && !event.shiftKey) {
        if (selectedVideoClipId) {
          event.preventDefault();
          copySelectedVideoClip();
        }

        return;
      }

      if (!isEditingText && key === "v" && !event.shiftKey) {
        if (videoClipboardRef.current) {
          event.preventDefault();
          pasteVideoClipAtPlayhead();
        }

        return;
      }

      if (!isEditingText && key === "d" && !event.shiftKey) {
        if (selectedVideoClipId) {
          event.preventDefault();
          duplicateSelectedVideoClipWithHistory();
        }

        return;
      }

      if (key === "z") {
        event.preventDefault();

        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }

        return;
      }

      if (key === "a" && !event.shiftKey) {
        if (isEditingText) {
          return;
        }

        event.preventDefault();
        selectAllSubtitles();
        return;
      }

      if (key === "b" && !event.shiftKey) {
        if (isEditingText) {
          return;
        }

        event.preventDefault();

        if (!splitSelectedVideoClipAtPlayhead()) {
          splitSelectedSubtitleAtPlayhead();
        }
      }
    };

    window.addEventListener(
      "keydown",
      handleEditorShortcutKeyDown,
      true,
    );

    return () => {
      window.removeEventListener(
        "keydown",
        handleEditorShortcutKeyDown,
        true,
      );
    };
  }, [
    screen,
    isGenerating,
    isExporting,
    undo,
    redo,
    selectAllSubtitles,
    clearSubtitleSelection,
    focusSelectedSubtitle,
    nudgeSelectedSubtitles,
    resizeSubtitle,
    markNextChangeImmediate,
    currentTime,
    selectedVideoClipId,
    selectedVideoClip,
    selectedSubtitleId,
    selectedSubtitleIds,
    subtitles,
  ]);

  useAppMenuCommands(handleAppMenuCommand);

  const selectedSubtitle =
    subtitles.find(
      (subtitle) => subtitle.id === selectedSubtitleId,
    ) ?? null;

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
        onRenameProject={handleRenameRecentProject}
        onRelinkProject={handleRelinkRecentProject}
        onRemoveProject={handleRemoveRecentProject}
      />
    );
  }

  // ==========================================================================
  // Editor UI
  // ==========================================================================

  return (
    <main
      className="app"
      data-can-undo={canUndo}
      data-can-redo={canRedo}
    >
      <header className="topbar">
        <button
          type="button"
          className="topbar-home-button"
          onClick={() => {
            void (async () => {
              if (hasUnsavedChanges) {
                await handleSaveProject();
              }

              setScreen("home");
              setHomeError("");
              await refreshRecentProjects();
            })();
          }}
          aria-label="Back to Home"
          title="Home"
        >
          ‹
        </button>

        <CtcLogo
          className="topbar-brand-logo"
          decorative
        />

        <div className="topbar-project-title">
          <h1>{projectMetadata?.title ?? videoName ?? "Untitled Project"}</h1>
          <span className="topbar-app-name">CUT THE CRAB</span>
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
        <MediaBrowser
          assets={mediaAssets}
          primaryVideoPath={videoPath}
          onImportMedia={handleImportMedia}
          onInsertMedia={handleInsertMediaAtPlayhead}
          timelineDuration={timelineDuration}
          onDropMedia={handleMediaDropOnTimeline}
        />

        <section className="preview-panel">
          <VideoPlayer
            videoPath={videoPath}
            videoName={videoName}
            onChooseVideo={handleChooseVideo}
            onDurationChange={handleVideoDurationChange}
            onTimeChange={setCurrentTime}
            seekRequest={seekRequest}
            videoClips={videoClips}
            timelineDuration={timelineDuration}
            trackSettings={trackSettings}
            selectedVideoClipId={selectedVideoClipId}
            onVideoClipSelect={handleVideoClipSelect}
            onVideoTransformChange={handleVideoTransformChange}
            subtitles={subtitles}
            currentTime={currentTime}
            selectedSubtitleId={selectedSubtitleId}
            onSubtitleSelect={selectSubtitle}
            onSubtitlePositionChange={updateSubtitlePosition}
            onSubtitleTextChange={updateSubtitleText}
            onSubtitleStyleChange={updateSubtitleStyleWithSelection}
            onAllSubtitleStylesChange={updateAllSubtitleStyles}
          />
        </section>

        {selectedVideoClip ? (
          <VideoInspector
            clip={selectedVideoClip}
            disabled={trackSettings[selectedVideoClip.trackId]?.locked ?? false}
            onTransformChange={handleVideoTransformChange}
            onResetTransform={handleResetVideoTransform}
          />
        ) : (
          <SubtitlePanel
            subtitles={filteredSubtitles}
            selectedSubtitle={selectedSubtitle}
            selectedSubtitleId={selectedSubtitleId}
            selectedSubtitleIds={selectedSubtitleIds}
            selectedSubtitleCount={selectedSubtitleIds.length}
            activeSubtitleId={activeSubtitleId}
            search={subtitleSearch}
            onSearchChange={setSubtitleSearch}
            onSelect={handleSubtitleSelect}
            onTextChange={updateSubtitleText}
            onStyleChange={updateSubtitleStyleWithSelection}
            onAdd={() => addSubtitleWithHistory(currentTime)}
            onDelete={deleteSubtitleWithHistory}
          />
        )}
      </div>

      <Timeline
        duration={timelineDuration}
        currentTime={currentTime}
        waveformsBySource={waveformsBySource}
        videoClips={videoClips}
        subtitles={subtitles}
        markers={markers}
        zoom={timelineZoom}
        trackSettings={trackSettings}
        selectedSubtitleId={selectedSubtitleId}
        selectedSubtitleIds={selectedSubtitleIds}
        selectedVideoClipId={selectedVideoClipId}
        onClearSubtitleSelection={() => {
          clearSubtitleSelection();
          clearVideoClipSelection();
        }}
        onVideoClipSelect={handleVideoClipSelect}
        onVideoClipMove={moveVideoClip}
        onVideoClipMoveToTrack={handleMoveVideoClipToTrack}
        onMediaDrop={handleMediaDropOnTimeline}
        onVideoClipResize={resizeVideoClip}
        onCopyVideoClip={copySelectedVideoClip}
        onPasteVideoClip={pasteVideoClipAtPlayhead}
        onDuplicateVideoClip={duplicateSelectedVideoClipWithHistory}
        canPasteVideoClip={videoClipboardRef.current !== null}
        onSubtitleSelect={handleSubtitleTrackSelect}
        onSubtitleMove={moveSubtitle}
        onSubtitleGroupMove={moveSubtitleGroup}
        onSubtitleResize={resizeSubtitle}
        onMarkersChange={setMarkersWithHistory}
        onZoomChange={setTimelineZoom}
        onToggleTrackLock={(trackId) => toggleTrackSetting(trackId, "locked")}
        onToggleTrackMute={(trackId) => toggleTrackSetting(trackId, "muted")}
        onToggleTrackHidden={(trackId) => toggleTrackSetting(trackId, "hidden")}
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
