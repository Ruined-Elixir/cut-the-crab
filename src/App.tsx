import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import CtcLogo from "./components/brand/CtcLogo";

import HomeScreen from "./components/home/HomeScreen";
import ProjectLoadingOverlay from "./components/loading/ProjectLoadingOverlay";
import MediaBrowser from "./components/media/MediaBrowser";
import MissingMediaModal from "./components/media/MissingMediaModal";
import VideoPlayer, {
  type VideoPlayerHandle,
} from "./components/video/VideoPlayer";
import SubtitlePanel from "./components/subtitles/SubtitlePanel";
import Timeline, { type TimelineHandle } from "./components/timeline/Timeline";
import {
  clampTimelineZoom,
  TIMELINE_ZOOM_STEP,
} from "./components/timeline/timelineZoom";
import ExportProgressModal from "./components/export/ExportProgressModal";
import ExportSettingsModal from "./components/export/ExportSettingsModal";
import SubtitleGenerationModal from "./components/subtitles/SubtitleGenerationModal";
import AdjustmentLayerPanel from "./components/adjustments/AdjustmentLayerPanel";
import EffectsStackPanel from "./components/effects/EffectsStackPanel";
import MasksPanel from "./components/masks/MasksPanel";

import { useEditorHistory } from "./hooks/useEditorHistory";
import { useSubtitleEditor } from "./hooks/useSubtitleEditor";
import { useVideoTimeline } from "./hooks/useVideoTimeline";
import { useAudioTimeline } from "./hooks/useAudioTimeline";
import { useTranscription } from "./hooks/useTranscription";
import { useWaveform } from "./hooks/useWaveform";
import { useVideoProxies } from "./hooks/useVideoProxies";

import {
  exportSrtFile,
  importSrtFile,
  loadMatchingSrtFile,
} from "./services/srtFiles";

import {
  loadMatchingProjectFile,
  projectFromLoadResult,
  saveProjectFile,
} from "./services/projectFiles";

import { setPlaybackClockTime } from "./utils/playbackClock";
import {
  loadRecentProjects,
  removeRecentProject,
  upsertRecentProject,
  videoPathExists,
} from "./services/projectRegistry";
import {
  collectProjectMediaReferences,
  findMissingProjectMedia,
  relinkProjectMediaPath,
  removeProjectMediaPath,
  type MissingMediaIssue,
} from "./services/missingMedia";

import {
  cancelVideoExport,
  DEFAULT_EXPORT_FRAME_SIZE,
  exportStyledVideo,
  type ExportFrameSize,
} from "./services/videoExport";
import {
  parseClipTranscriptionCommand,
  updateTranscriptionMenuTargets,
  useAppMenuCommands,
  type AppMenuCommand,
  type TranscriptionPreset,
} from "./services/appMenu";

import {
  DEFAULT_SUBTITLE_TRACK_ID,
  getSubtitleTrackId,
  type Subtitle,
} from "./types/subtitle";
import type { TimelineMarker } from "./types/timeline";
import { DEFAULT_TIMELINE_TRACK_SETTINGS } from "./types/timelineModel";
import type {
  AdjustmentLayerClip,
  AudioTimelineClip,
  TimelineTrackId,
  TimelineTrackKind,
  TimelineTrackSettings,
  VideoBlendMode,
  VideoEffectInstance,
  VideoMask,
  VideoTimelineClip,
} from "./types/timelineModel";
import type {
  ProjectLanguage,
  ProjectMediaAsset,
  ProjectMetadata,
  RecentProject,
} from "./types/project";

import {
  defaultTrackControlState,
  nextTimelineTrackId,
  timelineTrackIndexFromId,
  timelineTrackKindFromId,
} from "./utils/timelineModel";
import {
  normalizeVideoPlaybackRate,
  sourceTimeToTimelineTime,
} from "./utils/videoRetime";
import {
  assignCompoundMembership,
  breakApartCompound as breakApartCompoundMembers,
  buildCompoundGroups,
  canShiftCompound,
  deleteCompound as deleteCompoundMembers,
  duplicateCompound,
  insertCompoundCopy,
  nextCompoundClipName,
  shiftCompound,
  trimCompound,
  type CompoundTimelineState,
} from "./utils/compoundClips";
import {
  DEFAULT_ADJUSTMENT_LAYER_DURATION,
  DEFAULT_ADJUSTMENT_LAYER_VALUES,
  MIN_ADJUSTMENT_LAYER_DURATION,
  normalizedAdjustmentLayer,
  trimAdjustmentLayerKeyframes,
} from "./utils/adjustmentLayers";
import {
  applyTimelineRangeEdit,
  type TimelineRange,
  type TimelineRangeEditMode,
} from "./utils/timelineRangeEdits";
import {
  effectiveVideoLayer,
  normalizedProgramLayersForVideoOrder,
} from "./utils/videoLayers";
import {
  mergeRegeneratedLinkedSubtitles,
  preferredLinkedSubtitleTrack,
} from "./utils/subtitleRegeneration";
import {
  MAX_PROJECT_TITLE_LENGTH,
  normalizeProjectTitle,
  projectTitleExists,
} from "./utils/projectIdentity";
import { videoSubtitleTopologyKey } from "./utils/linkedSubtitles";

import "./App.css";

type SeekRequest = {
  time: number;
  id: number;
};

type VideoClipboardPayload = {
  clips: VideoTimelineClip[];
  groupStart: number;
  groupEnd: number;
};

type AudioClipboardPayload = {
  clips: AudioTimelineClip[];
  groupStart: number;
  groupEnd: number;
};

type CompoundClipboardPayload = {
  videoClips: VideoTimelineClip[];
  audioClips: AudioTimelineClip[];
  subtitles: Subtitle[];
  compoundId: string;
  groupStart: number;
  groupEnd: number;
};

type ExportLifecycle = "idle" | "preparing" | "encoding" | "cancelling";

type AppScreen = "home" | "editor";

type ProjectLoadBarrierState = {
  generation: number;
  dataHydrated: boolean;
  filmstripReady: boolean;
  startedAt: number;
};

type EffectsPanelTarget = {
  kind: "video" | "adjustment";
  id: string;
};

type MasksPanelTarget = EffectsPanelTarget;

const AUTOSAVE_DEBOUNCE_MS = 200;
const PROJECT_LOADING_MIN_VISIBLE_MS = 650;

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

const AUDIO_MEDIA_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "opus",
]);

function mediaKindFromPath(path: string): ProjectMediaAsset["kind"] {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_MEDIA_EXTENSIONS.has(extension) ? "audio" : "video";
}

function probeMediaDuration(
  path: string,
  kind: ProjectMediaAsset["kind"] = "video",
) {
  return new Promise<number>((resolve) => {
    const probe = document.createElement(kind === "audio" ? "audio" : "video");
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

type EditorEditCommand =
  "undo" | "redo" | "cut" | "copy" | "paste" | "duplicate" | "select-all";

function isTextEditableInput(element: HTMLInputElement) {
  return ![
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ].includes(element.type);
}

function getEditableElement(target: EventTarget | Element | null) {
  const element = target instanceof Element ? target : null;

  if (!element) {
    return null;
  }

  if (element instanceof HTMLTextAreaElement) {
    return element.disabled ? null : element;
  }

  if (element instanceof HTMLInputElement) {
    return element.disabled || !isTextEditableInput(element) ? null : element;
  }

  const contentEditable = element.closest<HTMLElement>("[contenteditable]");

  if (
    contentEditable &&
    contentEditable.contentEditable !== "false" &&
    contentEditable.isContentEditable
  ) {
    return contentEditable;
  }

  return null;
}

function tryDocumentEditCommand(command: string) {
  try {
    return document.execCommand(command);
  } catch {
    return false;
  }
}

function dispatchTextInputEvent(
  element: HTMLElement,
  inputType: string,
  data: string | null = null,
) {
  try {
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType,
        data,
      }),
    );
  } catch {
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function selectAllEditableText(element: HTMLElement) {
  element.focus();

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    try {
      element.select();
      return true;
    } catch {
      return false;
    }
  }

  const selection = window.getSelection();

  if (!selection) {
    return false;
  }

  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function getContentEditableRange(element: HTMLElement) {
  const selection = window.getSelection();

  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;

  if (!commonAncestor || !element.contains(commonAncestor)) {
    return null;
  }

  return range;
}

async function runFocusedTextEditCommand(
  command: Exclude<EditorEditCommand, "duplicate">,
  element: HTMLElement,
) {
  element.focus();

  if (command === "select-all") {
    return selectAllEditableText(element);
  }

  if (command === "undo" || command === "redo") {
    return tryDocumentEditCommand(command);
  }

  if (tryDocumentEditCommand(command)) {
    return true;
  }

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;

    if (command === "copy" || command === "cut") {
      const selectedText = element.value.slice(start, end);

      try {
        await navigator.clipboard.writeText(selectedText);
      } catch {
        return false;
      }

      if (command === "cut" && !element.readOnly && end > start) {
        try {
          element.setRangeText("", start, end, "end");
          dispatchTextInputEvent(element, "deleteByCut");
        } catch {
          return false;
        }
      }

      return true;
    }

    if (command === "paste") {
      if (element.readOnly) {
        return false;
      }

      try {
        const clipboardText = await navigator.clipboard.readText();
        element.setRangeText(clipboardText, start, end, "end");
        dispatchTextInputEvent(element, "insertFromPaste", clipboardText);
        return true;
      } catch {
        return false;
      }
    }
  }

  const range = getContentEditableRange(element);

  if (!range) {
    return false;
  }

  if (command === "copy" || command === "cut") {
    const selectedText = range.toString();

    try {
      await navigator.clipboard.writeText(selectedText);
    } catch {
      return false;
    }

    if (command === "cut" && !range.collapsed) {
      range.deleteContents();
      dispatchTextInputEvent(element, "deleteByCut");
    }

    return true;
  }

  if (command === "paste") {
    try {
      const clipboardText = await navigator.clipboard.readText();
      range.deleteContents();

      const textNode = document.createTextNode(clipboardText);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);

      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      dispatchTextInputEvent(element, "insertFromPaste", clipboardText);
      return true;
    } catch {
      return false;
    }
  }

  return false;
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
  const [pendingNewProjectTitle, setPendingNewProjectTitle] = useState<
    string | null
  >(null);
  const [newProjectRequestId, setNewProjectRequestId] = useState(0);
  const [projectMetadata, setProjectMetadata] =
    useState<ProjectMetadata | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projectLoadBarrier, setProjectLoadBarrier] =
    useState<ProjectLoadBarrierState | null>(null);
  const projectLoadBarrierActive = projectLoadBarrier !== null;

  // ==========================================================================
  // Video
  // ==========================================================================

  const [videoDuration, setVideoDuration] = useState(0);
  const currentTimeRef = useRef(0);
  const setCurrentTime = useCallback((time: number) => {
    const next = Number.isFinite(time) ? Math.max(0, time) : 0;
    currentTimeRef.current = next;
    setPlaybackClockTime(next, true);
  }, []);
  const handlePlaybackTimeChange = useCallback((time: number) => {
    if (!Number.isFinite(time)) return;
    const next = Math.max(0, time);
    currentTimeRef.current = next;
    setPlaybackClockTime(next);
  }, []);
  const [videoName, setVideoName] = useState<string | null>(null);
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null);
  const [mediaAssets, setMediaAssets] = useState<ProjectMediaAsset[]>([]);

  const [markers, setMarkers] = useState<TimelineMarker[]>([]);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [timelineRange, setTimelineRange] = useState<TimelineRange | null>(
    null,
  );
  const [rippleMode, setRippleMode] = useState(false);
  const [trackSettings, setTrackSettings] = useState<TimelineTrackSettings>(
    () => ({
      ...DEFAULT_TIMELINE_TRACK_SETTINGS,
    }),
  );
  const [activeSubtitleTrackId, setActiveSubtitleTrackId] =
    useState<TimelineTrackId>(DEFAULT_SUBTITLE_TRACK_ID);
  const [expandedCompoundId, setExpandedCompoundId] = useState<string | null>(
    null,
  );
  const [adjustmentLayers, setAdjustmentLayers] = useState<
    AdjustmentLayerClip[]
  >([]);
  const [selectedAdjustmentLayerId, setSelectedAdjustmentLayerId] = useState<
    string | null
  >(null);
  const [adjustmentPanelOpen, setAdjustmentPanelOpen] = useState(false);
  const [effectsPanelTarget, setEffectsPanelTarget] =
    useState<EffectsPanelTarget | null>(null);
  const [masksPanelTarget, setMasksPanelTarget] =
    useState<MasksPanelTarget | null>(null);

  // ==========================================================================
  // Video export UI
  // ==========================================================================

  const [exportState, setExportState] = useState<ExportLifecycle>("idle");
  const exportStateRef = useRef<ExportLifecycle>("idle");
  const activeExportJobIdRef = useRef<string | null>(null);
  const setExportLifecycle = useCallback((next: ExportLifecycle) => {
    exportStateRef.current = next;
    setExportState(next);
  }, []);
  const editorLocked = exportState !== "idle";
  const isExporting = editorLocked;
  const isCancellingExport = exportState === "cancelling";
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStatus, setExportStatus] = useState("Preparing export...");
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportCancelError, setExportCancelError] = useState<string | null>(null);
  const exportCancelRequestedRef = useRef(false);
  const [exportSettingsRequest, setExportSettingsRequest] = useState<{
    range: TimelineRange | null;
  } | null>(null);
  const [lastExportFrameSize, setLastExportFrameSize] =
    useState<ExportFrameSize>({ ...DEFAULT_EXPORT_FRAME_SIZE });

  const [missingMediaIssues, setMissingMediaIssues] = useState<
    MissingMediaIssue[]
  >([]);
  const [missingMediaDialogOpen, setMissingMediaDialogOpen] = useState(false);
  const [relinkingMissingMediaPath, setRelinkingMissingMediaPath] = useState<
    string | null
  >(null);
  const [deletingMissingMediaPath, setDeletingMissingMediaPath] = useState<
    string | null
  >(null);

  // ==========================================================================
  // Project save state
  // ==========================================================================

  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [autosaveError, setAutosaveError] = useState<string | null>(null);
  const [saveRetryTick, setSaveRetryTick] = useState(0);

  const isLoadingVideoRef = useRef(false);
  const projectLoadGenerationRef = useRef(0);
  const projectLoadWaitersRef = useRef(new Map<number, () => void>());
  const appRootRef = useRef<HTMLElement | null>(null);
  const videoPlayerRef = useRef<VideoPlayerHandle | null>(null);
  const timelineRef = useRef<TimelineHandle | null>(null);
  const handleSkimPreviewChange = useCallback((time: number | null) => {
    videoPlayerRef.current?.setSkimPreviewTime(time);
  }, []);
  const videoClipboardRef = useRef<VideoClipboardPayload | null>(null);
  const audioClipboardRef = useRef<AudioClipboardPayload | null>(null);
  const compoundClipboardRef = useRef<CompoundClipboardPayload | null>(null);
  const activeClipboardKindRef = useRef<"video" | "audio" | "compound" | null>(
    null,
  );
  const timelinePasteTargetRef = useRef<{
    trackId: TimelineTrackId;
    time: number;
  } | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const creatingProjectRef = useRef(false);
  const openingRecentProjectIdRef = useRef<string | null>(null);
  const resolveProjectLoadWaiter = useCallback((generation: number) => {
    const resolve = projectLoadWaitersRef.current.get(generation);
    if (!resolve) return;
    projectLoadWaitersRef.current.delete(generation);
    resolve();
  }, []);

  const lastSavedSnapshotRef = useRef<string>(
    JSON.stringify({
      subtitles: [],
      markers: [],
      videoClips: [],
      audioClips: [],
      adjustmentLayers: [],
      mediaAssets: [],
      trackSettings: DEFAULT_TIMELINE_TRACK_SETTINGS,
    }),
  );

  // ==========================================================================
  // Waveform
  // ==========================================================================

  const {
    waveformsBySource,
    waveformStatesBySource,
    generateWaveform,
  } = useWaveform();

  // ==========================================================================
  // Subtitles
  // ==========================================================================

  const {
    subtitles,
    filteredSubtitles,
    selectedSubtitleId,
    selectedSubtitleIds,
    subtitleSearch,

    setSubtitleSearch,
    selectSubtitle,
    selectSubtitles,
    selectAllSubtitles,
    focusSelectedSubtitle,
    clearSubtitleSelection,

    updateSubtitleText,
    updateSubtitlePosition,
    updateSubtitleStyle,
    updateSubtitleStyles,

    moveSubtitle,
    moveSubtitleToTrack,
    moveSubtitleGroup,
    nudgeSelectedSubtitles,
    resizeSubtitle,
    addSubtitle,
    splitSubtitle,
    deleteSubtitles,
    replaceSubtitles,
    replaceWithGeneratedSubtitles,
    syncLinkedSubtitlesToVideoTopology,
    syncLinkedSubtitlesToVideoTopologyFromSnapshot,
    bindPendingGeneratedSubtitlesToVideoClips,
    splitLinkedSubtitlesForVideoClip,
    syncLinkedSubtitlesToVideoWindows,
    deleteLinkedSubtitlesForVideoClips,
  } = useSubtitleEditor(videoDuration);

  useEffect(() => {
    if (activeSubtitleTrackId === DEFAULT_SUBTITLE_TRACK_ID) {
      return;
    }

    const settings = trackSettings[activeSubtitleTrackId];
    const existsInSubtitles = subtitles.some(
      (subtitle) => getSubtitleTrackId(subtitle) === activeSubtitleTrackId,
    );

    if (settings?.deleted === true || (!settings && !existsInSubtitles)) {
      setActiveSubtitleTrackId(DEFAULT_SUBTITLE_TRACK_ID);
    }
  }, [activeSubtitleTrackId, subtitles, trackSettings]);

  const {
    videoClips,
    selectedVideoClipId,
    selectedVideoClipIds,
    selectedVideoClip,
    selectVideoClip,
    selectVideoClips,
    clearVideoClipSelection,
    beginVideoClipMove,
    endVideoClipMove,
    moveVideoClip,
    moveVideoClipToTrack,
    resizeVideoClip,
    splitVideoClip,
    deleteVideoClips,
    deleteVideoTrack,
    insertVideoClipCopies,
    insertVideoClipFromMedia,
    updateVideoClipPlaybackRate,
    toggleVideoClipReverse,
    insertVideoFreezeFrame,
    updateVideoClipTransform,
    updateVideoClipEffects,
    updateVideoClipMask,
    updateVideoClipBlendMode,
    applyVideoClipCropToTrack,
    updateVideoClipTransition,
    updateVideoClipOpacityFade,
    updateVideoClipAudio,
    replaceVideoClips,
    initializeDefaultVideoClip,
  } = useVideoTimeline({
    sourcePath: videoPath,
    sourceName: videoName,
    sourceDuration: videoDuration,
    rippleMode,
  });

  const suppressNextVideoTopologySubtitleSyncRef = useRef(false);
  const previousVideoSubtitleTopologyRef = useRef({
    key: videoSubtitleTopologyKey(videoClips),
    videoClips,
    subtitles,
  });

  const videoProxySourcePaths = useMemo(
    () => [
      ...(videoPath ? [videoPath] : []),
      ...videoClips
        .slice()
        .sort((a, b) => a.timelineStart - b.timelineStart)
        .map((clip) => clip.sourcePath),
    ],
    [videoClips, videoPath],
  );

  const { proxyStatesBySource, proxyPathsBySource } = useVideoProxies(
    videoProxySourcePaths,
  );

  const {
    audioClips,
    selectedAudioClipId,
    selectedAudioClipIds,
    selectedAudioClip,
    selectAudioClip,
    selectAudioClips,
    clearAudioClipSelection,
    beginAudioClipMove,
    endAudioClipMove,
    moveAudioClip,
    moveAudioClipToTrack,
    resizeAudioClip,
    splitAudioClip,
    insertAudioClipFromMedia,
    insertAudioClipCopies,
    deleteAudioClips,
    deleteAudioTrack,
    updateAudioClip,
    replaceAudioClips,
  } = useAudioTimeline({ rippleMode });

  const waveformSourcePaths = useMemo(() => {
    const paths = new Set<string>();
    if (videoPath) paths.add(videoPath);
    for (const clip of videoClips) {
      if (clip.sourcePath) paths.add(clip.sourcePath);
    }
    for (const clip of audioClips) {
      if (clip.sourcePath) paths.add(clip.sourcePath);
    }
    return [...paths];
  }, [audioClips, videoClips, videoPath]);

  useEffect(() => {
    for (const sourcePath of waveformSourcePaths) {
      void generateWaveform(sourcePath);
    }
  }, [generateWaveform, waveformSourcePaths]);

  const handleInitialFilmstripReadyChange = useCallback((ready: boolean) => {
    setProjectLoadBarrier((current) => {
      if (!current || current.filmstripReady === ready) return current;
      return { ...current, filmstripReady: ready };
    });
  }, []);

  const projectProxyMediaReady = useMemo(
    () =>
      [...new Set(videoProxySourcePaths)].every((sourcePath) => {
        const status = proxyStatesBySource[sourcePath]?.status;
        return status === "ready" || status === "error";
      }),
    [proxyStatesBySource, videoProxySourcePaths],
  );

  const projectWaveformsReady = useMemo(
    () =>
      waveformSourcePaths.every((sourcePath) => {
        const status = waveformStatesBySource[sourcePath];
        return status === "ready" || status === "error";
      }),
    [waveformSourcePaths, waveformStatesBySource],
  );

  useEffect(() => {
    const barrier = projectLoadBarrier;
    if (!barrier || !barrier.dataHydrated || screen !== "editor") return;

    const mediaMetadataReady = videoDuration > 0 && videoClips.length > 0;
    if (
      !mediaMetadataReady ||
      !projectProxyMediaReady ||
      !projectWaveformsReady ||
      !barrier.filmstripReady
    ) {
      return;
    }

    const elapsed = performance.now() - barrier.startedAt;
    const remaining = Math.max(0, PROJECT_LOADING_MIN_VISIBLE_MS - elapsed);
    const timer = window.setTimeout(() => {
      if (projectLoadGenerationRef.current !== barrier.generation) return;

      isLoadingVideoRef.current = false;
      setProjectLoadBarrier((current) =>
        current?.generation === barrier.generation ? null : current,
      );
      resolveProjectLoadWaiter(barrier.generation);
    }, remaining);

    return () => window.clearTimeout(timer);
  }, [
    projectLoadBarrier,
    projectProxyMediaReady,
    projectWaveformsReady,
    resolveProjectLoadWaiter,
    screen,
    videoClips.length,
    videoDuration,
  ]);

  const latestSaveStateRef = useRef({
    activeProjectId,
    videoPath,
    subtitles,
    markers,
    projectMetadata,
    videoClips,
    audioClips,
    adjustmentLayers,
    mediaAssets,
    trackSettings,
    videoDuration,
    hasUnsavedChanges,
  });

  latestSaveStateRef.current = {
    activeProjectId,
    videoPath,
    subtitles,
    markers,
    projectMetadata,
    videoClips,
    audioClips,
    adjustmentLayers,
    mediaAssets,
    trackSettings,
    videoDuration,
    hasUnsavedChanges,
  };

  const editedContentEnd = Math.max(
    0,
    ...videoClips.map((clip) => clip.timelineEnd),
    ...audioClips.map((clip) => clip.timelineEnd),
    ...adjustmentLayers.map((layer) => layer.timelineEnd),
    ...subtitles.map((subtitle) => subtitle.endTime),
    ...markers.map((marker) => marker.time),
  );

  const timelineDuration =
    editedContentEnd > 0 ? editedContentEnd : videoDuration;

  // ==========================================================================
  // Undo / Redo history
  // ==========================================================================

  const historySnapshot = useMemo(
    () => ({
      subtitles,
      markers,
      videoClips,
      audioClips,
      adjustmentLayers,
      trackSettings,
    }),
    [subtitles, markers, videoClips, audioClips, adjustmentLayers, trackSettings],
  );

  const {
    canUndo,
    canRedo,
    undo,
    redo,
    resetHistory,
    markNextChangeImmediate,
    beginTransaction: beginHistoryTransaction,
    endTransaction: endHistoryTransaction,
  } = useEditorHistory({
    snapshot: historySnapshot,
    enabled: screen === "editor" && !!videoPath && !isLoadingVideoRef.current,
    onApply: (snapshot) => {
      replaceSubtitles(snapshot.subtitles);
      setMarkers(snapshot.markers);
      replaceVideoClips(snapshot.videoClips);
      replaceAudioClips(snapshot.audioClips);
      setAdjustmentLayers(snapshot.adjustmentLayers);
      setTrackSettings(snapshot.trackSettings);
    },
  });

  const selectedAdjustmentLayer = selectedAdjustmentLayerId
    ? (adjustmentLayers.find(
        (layer) => layer.id === selectedAdjustmentLayerId,
      ) ?? null)
    : null;

  const effectsPanelVideoClip =
    effectsPanelTarget?.kind === "video"
      ? (videoClips.find((clip) => clip.id === effectsPanelTarget.id) ?? null)
      : null;
  const effectsPanelAdjustmentLayer =
    effectsPanelTarget?.kind === "adjustment"
      ? (adjustmentLayers.find((layer) => layer.id === effectsPanelTarget.id) ??
        null)
      : null;

  const masksPanelVideoClip =
    masksPanelTarget?.kind === "video"
      ? (videoClips.find((clip) => clip.id === masksPanelTarget.id) ?? null)
      : null;
  const masksPanelAdjustmentLayer =
    masksPanelTarget?.kind === "adjustment"
      ? (adjustmentLayers.find((layer) => layer.id === masksPanelTarget.id) ??
        null)
      : null;

  useEffect(() => {
    if (!effectsPanelTarget) return;
    const exists =
      effectsPanelTarget.kind === "video"
        ? videoClips.some((clip) => clip.id === effectsPanelTarget.id)
        : adjustmentLayers.some((layer) => layer.id === effectsPanelTarget.id);
    if (!exists) setEffectsPanelTarget(null);
  }, [adjustmentLayers, effectsPanelTarget, videoClips]);

  useEffect(() => {
    if (!effectsPanelTarget) return;

    if (
      selectedAdjustmentLayerId &&
      adjustmentLayers.some((layer) => layer.id === selectedAdjustmentLayerId)
    ) {
      if (
        effectsPanelTarget.kind !== "adjustment" ||
        effectsPanelTarget.id !== selectedAdjustmentLayerId
      ) {
        setEffectsPanelTarget({
          kind: "adjustment",
          id: selectedAdjustmentLayerId,
        });
      }
      return;
    }

    if (
      selectedVideoClipId &&
      videoClips.some((clip) => clip.id === selectedVideoClipId)
    ) {
      if (
        effectsPanelTarget.kind !== "video" ||
        effectsPanelTarget.id !== selectedVideoClipId
      ) {
        setEffectsPanelTarget({ kind: "video", id: selectedVideoClipId });
      }
    }
  }, [
    adjustmentLayers,
    effectsPanelTarget,
    selectedAdjustmentLayerId,
    selectedVideoClipId,
    videoClips,
  ]);

  useEffect(() => {
    if (!masksPanelTarget) return;
    const exists =
      masksPanelTarget.kind === "video"
        ? videoClips.some((clip) => clip.id === masksPanelTarget.id)
        : adjustmentLayers.some((layer) => layer.id === masksPanelTarget.id);
    if (!exists) setMasksPanelTarget(null);
  }, [adjustmentLayers, masksPanelTarget, videoClips]);

  useEffect(() => {
    if (!masksPanelTarget) return;
    if (
      selectedAdjustmentLayerId &&
      adjustmentLayers.some((layer) => layer.id === selectedAdjustmentLayerId)
    ) {
      if (
        masksPanelTarget.kind !== "adjustment" ||
        masksPanelTarget.id !== selectedAdjustmentLayerId
      ) {
        setMasksPanelTarget({
          kind: "adjustment",
          id: selectedAdjustmentLayerId,
        });
      }
      return;
    }
    if (
      selectedVideoClipId &&
      videoClips.some((clip) => clip.id === selectedVideoClipId)
    ) {
      if (
        masksPanelTarget.kind !== "video" ||
        masksPanelTarget.id !== selectedVideoClipId
      ) {
        setMasksPanelTarget({ kind: "video", id: selectedVideoClipId });
      }
    }
  }, [
    adjustmentLayers,
    masksPanelTarget,
    selectedAdjustmentLayerId,
    selectedVideoClipId,
    videoClips,
  ]);

  useEffect(() => {
    if (
      selectedAdjustmentLayerId &&
      !adjustmentLayers.some((layer) => layer.id === selectedAdjustmentLayerId)
    ) {
      setSelectedAdjustmentLayerId(null);
      setAdjustmentPanelOpen(false);
    }
  }, [adjustmentLayers, selectedAdjustmentLayerId]);

  const clearAdjustmentLayerSelection = () => {
    setSelectedAdjustmentLayerId(null);
    setAdjustmentPanelOpen(false);
  };

  const selectAdjustmentLayer = (id: string, openControls = false) => {
    const layer = adjustmentLayers.find((item) => item.id === id);
    if (!layer) return;

    clearVideoClipSelection();
    clearAudioClipSelection();
    clearSubtitleSelection();
    setTimelineRange(null);
    setSelectedAdjustmentLayerId(id);
    if (openControls) setAdjustmentPanelOpen(true);
  };

  const updateAdjustmentLayer = (
    id: string,
    patch: Partial<AdjustmentLayerClip>,
  ) => {
    setAdjustmentLayers((current) =>
      current.map((layer) =>
        layer.id === id
          ? normalizedAdjustmentLayer({ ...layer, ...patch })
          : layer,
      ),
    );
  };

  const openVideoEffects = (id: string) => {
    if (!videoClips.some((clip) => clip.id === id)) return;
    setEffectsPanelTarget({ kind: "video", id });
  };

  const openAdjustmentEffects = (id: string) => {
    if (!adjustmentLayers.some((layer) => layer.id === id)) return;
    setEffectsPanelTarget({ kind: "adjustment", id });
  };

  const updateEffectsPanelStack = (effects: VideoEffectInstance[]) => {
    const target = effectsPanelTarget;
    if (!target) return;

    if (target.kind === "video") {
      updateVideoClipEffects(target.id, effects);
      return;
    }

    updateAdjustmentLayer(target.id, {
      effects:
        effects.length > 0
          ? effects.map((effect) => ({ ...effect }))
          : undefined,
    });
  };

  const openVideoMasks = (id: string) => {
    if (!videoClips.some((clip) => clip.id === id)) return;
    setMasksPanelTarget({ kind: "video", id });
  };

  const openAdjustmentMasks = (id: string) => {
    if (!adjustmentLayers.some((layer) => layer.id === id)) return;
    setMasksPanelTarget({ kind: "adjustment", id });
  };

  const updateMasksPanelMask = (mask: VideoMask | undefined) => {
    const target = masksPanelTarget;
    if (!target) return;
    if (target.kind === "video") {
      updateVideoClipMask(target.id, mask);
      return;
    }
    updateAdjustmentLayer(target.id, { mask: mask ? { ...mask } : undefined });
  };

  const createAdjustmentLayer = () => {
    const rangeStart = timelineRange
      ? Math.min(timelineRange.start, timelineRange.end)
      : currentTimeRef.current;
    const rangeEnd = timelineRange
      ? Math.max(timelineRange.start, timelineRange.end)
      : rangeStart + DEFAULT_ADJUSTMENT_LAYER_DURATION;
    const start = Math.max(0, rangeStart);
    const end = Math.max(start + MIN_ADJUSTMENT_LAYER_DURATION, rangeEnd);

    const activeVideoTrackIds = new Set<string>();
    for (const [trackId, settings] of Object.entries(trackSettings) as [
      string,
      TimelineTrackSettings[string],
    ][]) {
      if (/^video-\d+$/.test(trackId) && settings.deleted !== true)
        activeVideoTrackIds.add(trackId);
    }
    for (const clip of videoClips) {
      if (trackSettings[clip.trackId]?.deleted !== true)
        activeVideoTrackIds.add(clip.trackId);
    }
    for (const layer of adjustmentLayers) {
      if (trackSettings[layer.trackId]?.deleted !== true)
        activeVideoTrackIds.add(layer.trackId);
    }

    const topIndex = Math.max(
      0,
      ...[...activeVideoTrackIds].map(timelineTrackIndexFromId),
    );
    let targetTrackId = topIndex > 0 ? `video-${topIndex}` : "video-1";
    const topSettings = trackSettings[targetTrackId];
    const topHasOverlap =
      videoClips.some(
        (clip) =>
          clip.trackId === targetTrackId &&
          clip.timelineStart < end &&
          clip.timelineEnd > start,
      ) ||
      adjustmentLayers.some(
        (layer) =>
          layer.trackId === targetTrackId &&
          layer.timelineStart < end &&
          layer.timelineEnd > start,
      );
    const topIsSuitable =
      topIndex > 0 &&
      topSettings?.deleted !== true &&
      topSettings?.locked !== true &&
      !topSettings?.linkedTrackId &&
      !topHasOverlap;

    markNextChangeImmediate();

    if (!topIsSuitable) {
      targetTrackId = `video-${Math.max(1, topIndex + 1)}`;
      setTrackSettings((current) => ({
        ...current,
        [targetTrackId]: {
          ...defaultTrackControlState("video"),
          linkedTrackId: null,
          deleted: false,
        },
      }));
    }

    const id = `adjustment-${crypto.randomUUID()}`;
    const layer: AdjustmentLayerClip = {
      id,
      kind: "adjustment",
      trackId: targetTrackId,
      name: `Adjustment Layer ${adjustmentLayers.length + 1}`,
      timelineStart: start,
      timelineEnd: end,
      ...DEFAULT_ADJUSTMENT_LAYER_VALUES,
    };

    setAdjustmentLayers((current) => [...current, layer]);
    clearVideoClipSelection();
    clearAudioClipSelection();
    clearSubtitleSelection();
    setTimelineRange(null);
    setSelectedAdjustmentLayerId(id);
    setAdjustmentPanelOpen(true);
    requestSeek(start);
  };

  const beginAdjustmentLayerEdit = (id: string) => {
    const layer = adjustmentLayers.find((item) => item.id === id);
    if (!layer || trackSettings[layer.trackId]?.locked) return false;
    beginHistoryTransaction();
    return true;
  };

  const endAdjustmentLayerEdit = () => {
    window.requestAnimationFrame(() => endHistoryTransaction());
  };

  const moveAdjustmentLayer = (id: string, newTimelineStart: number) => {
    setAdjustmentLayers((current) =>
      current.map((layer) => {
        if (layer.id !== id || trackSettings[layer.trackId]?.locked)
          return layer;
        const duration = Math.max(
          MIN_ADJUSTMENT_LAYER_DURATION,
          layer.timelineEnd - layer.timelineStart,
        );
        const start = Math.max(0, newTimelineStart);
        return {
          ...layer,
          timelineStart: start,
          timelineEnd: start + duration,
        };
      }),
    );
  };

  const resizeAdjustmentLayer = (
    id: string,
    newStart: number,
    newEnd: number,
  ) => {
    setAdjustmentLayers((current) =>
      current.map((layer) => {
        if (layer.id !== id || trackSettings[layer.trackId]?.locked)
          return layer;
        const start = Math.max(
          0,
          Math.min(newStart, newEnd - MIN_ADJUSTMENT_LAYER_DURATION),
        );
        const end = Math.max(start + MIN_ADJUSTMENT_LAYER_DURATION, newEnd);
        return normalizedAdjustmentLayer({
          ...layer,
          timelineStart: start,
          timelineEnd: end,
          keyframes: trimAdjustmentLayerKeyframes(layer, start, end),
        });
      }),
    );
  };

  const deleteSelectedAdjustmentLayerWithHistory = () => {
    if (
      !selectedAdjustmentLayer ||
      trackSettings[selectedAdjustmentLayer.trackId]?.locked
    )
      return false;
    markNextChangeImmediate();
    setAdjustmentLayers((current) =>
      current.filter((layer) => layer.id !== selectedAdjustmentLayer.id),
    );
    setSelectedAdjustmentLayerId(null);
    setAdjustmentPanelOpen(false);
    return true;
  };

  const selectedVideoClips = videoClips.filter((clip) =>
    selectedVideoClipIds.includes(clip.id),
  );

  const selectedVideoClipsAreEditable =
    selectedVideoClips.length > 0 &&
    selectedVideoClips.every((clip) => !trackSettings[clip.trackId]?.locked);

  const selectedAudioClips = audioClips.filter((clip) =>
    selectedAudioClipIds.includes(clip.id),
  );

  const selectedAudioClipsAreEditable =
    selectedAudioClips.length > 0 &&
    selectedAudioClips.every(
      (clip) =>
        !trackSettings[clip.trackId]?.locked &&
        !trackSettings[clip.trackId]?.linkedTrackId,
    );

  const selectedSubtitlesAreEditable =
    selectedSubtitleIds.length > 0 &&
    selectedSubtitleIds.every((id) => {
      const subtitle = subtitles.find((item) => item.id === id);
      return !!subtitle && !trackSettings[getSubtitleTrackId(subtitle)]?.locked;
    });

  const compoundGroups = useMemo(
    () => buildCompoundGroups(videoClips, audioClips, subtitles),
    [audioClips, subtitles, videoClips],
  );

  const collapsedCompoundIds = useMemo(
    () =>
      new Set(
        [...compoundGroups.keys()].filter((id) => id !== expandedCompoundId),
      ),
    [compoundGroups, expandedCompoundId],
  );

  const timelineSelectableVideoClipIds = useMemo(
    () =>
      videoClips
        .filter((clip) => {
          if (!clip.compoundId || !collapsedCompoundIds.has(clip.compoundId)) {
            return true;
          }
          return compoundGroups.get(clip.compoundId)?.anchorVideoId === clip.id;
        })
        .map((clip) => clip.id),
    [collapsedCompoundIds, compoundGroups, videoClips],
  );

  const timelineSelectableAudioClipIds = useMemo(
    () =>
      audioClips
        .filter(
          (clip) =>
            !clip.compoundId || !collapsedCompoundIds.has(clip.compoundId),
        )
        .map((clip) => clip.id),
    [audioClips, collapsedCompoundIds],
  );

  const timelineSelectableSubtitleIds = useMemo(
    () => subtitles.map((subtitle) => subtitle.id),
    [subtitles],
  );

  const timelineSelectableSubtitleIdSet = useMemo(
    () => new Set(timelineSelectableSubtitleIds),
    [timelineSelectableSubtitleIds],
  );

  const programInteractiveVideoClipIds = useMemo(
    () =>
      videoClips
        .filter(
          (clip) =>
            !clip.compoundId || !collapsedCompoundIds.has(clip.compoundId),
        )
        .map((clip) => clip.id),
    [collapsedCompoundIds, videoClips],
  );

  const programInteractiveSubtitleIds = timelineSelectableSubtitleIds;

  useEffect(() => {
    if (expandedCompoundId && !compoundGroups.has(expandedCompoundId)) {
      setExpandedCompoundId(null);
    }
  }, [compoundGroups, expandedCompoundId]);

  useEffect(() => {
    const sameIds = (a: string[], b: string[]) =>
      a.length === b.length && a.every((id, index) => id === b[index]);

    const selectableVideoIds = new Set(timelineSelectableVideoClipIds);
    const normalizedVideoIds = [
      ...new Set(
        selectedVideoClipIds
          .map((id) => {
            const clip = videoClips.find((item) => item.id === id);
            if (
              !clip?.compoundId ||
              !collapsedCompoundIds.has(clip.compoundId)
            ) {
              return id;
            }
            return compoundGroups.get(clip.compoundId)?.anchorVideoId ?? id;
          })
          .filter((id) => selectableVideoIds.has(id)),
      ),
    ];
    const selectedVideoClip = selectedVideoClipId
      ? videoClips.find((clip) => clip.id === selectedVideoClipId)
      : null;
    const normalizedVideoPrimaryCandidate =
      selectedVideoClip?.compoundId &&
      collapsedCompoundIds.has(selectedVideoClip.compoundId)
        ? (compoundGroups.get(selectedVideoClip.compoundId)?.anchorVideoId ??
          null)
        : selectedVideoClipId;
    const normalizedVideoPrimary =
      normalizedVideoPrimaryCandidate &&
      normalizedVideoIds.includes(normalizedVideoPrimaryCandidate)
        ? normalizedVideoPrimaryCandidate
        : (normalizedVideoIds[0] ?? null);

    if (
      !sameIds(selectedVideoClipIds, normalizedVideoIds) ||
      normalizedVideoPrimary !== selectedVideoClipId
    ) {
      selectVideoClips(normalizedVideoIds, normalizedVideoPrimary);
    }

    const selectableAudioIds = new Set(timelineSelectableAudioClipIds);
    const normalizedAudioIds = selectedAudioClipIds.filter((id) =>
      selectableAudioIds.has(id),
    );
    const normalizedAudioPrimary =
      selectedAudioClipId && selectableAudioIds.has(selectedAudioClipId)
        ? selectedAudioClipId
        : (normalizedAudioIds[0] ?? null);
    if (
      !sameIds(selectedAudioClipIds, normalizedAudioIds) ||
      normalizedAudioPrimary !== selectedAudioClipId
    ) {
      selectAudioClips(normalizedAudioIds, normalizedAudioPrimary);
    }

    const normalizedSubtitleIds = selectedSubtitleIds.filter((id) =>
      timelineSelectableSubtitleIdSet.has(id),
    );
    const normalizedSubtitlePrimary =
      selectedSubtitleId &&
      timelineSelectableSubtitleIdSet.has(selectedSubtitleId)
        ? selectedSubtitleId
        : (normalizedSubtitleIds[0] ?? null);
    if (
      !sameIds(selectedSubtitleIds, normalizedSubtitleIds) ||
      normalizedSubtitlePrimary !== selectedSubtitleId
    ) {
      selectSubtitles(normalizedSubtitleIds, normalizedSubtitlePrimary);
    }
  }, [
    collapsedCompoundIds,
    compoundGroups,
    selectedAudioClipId,
    selectedAudioClipIds,
    selectedSubtitleId,
    selectedSubtitleIds,
    selectedVideoClipId,
    selectedVideoClipIds,
    selectAudioClips,
    selectSubtitles,
    selectVideoClips,
    timelineSelectableAudioClipIds,
    timelineSelectableSubtitleIdSet,
    timelineSelectableVideoClipIds,
    videoClips,
  ]);

  const selectedCollapsedCompound = useMemo(() => {
    if (!selectedVideoClipId) return null;
    const clip = videoClips.find((item) => item.id === selectedVideoClipId);
    if (!clip?.compoundId || clip.compoundId === expandedCompoundId) {
      return null;
    }
    const group = compoundGroups.get(clip.compoundId) ?? null;
    return group?.anchorVideoId === clip.id ? group : null;
  }, [compoundGroups, expandedCompoundId, selectedVideoClipId, videoClips]);

  const compoundGroupIsEditable = (group: {
    videoIds: string[];
    audioIds: string[];
    subtitleIds: string[];
  }) => {
    const videoLocked = group.videoIds.some((id) => {
      const clip = videoClips.find((item) => item.id === id);
      return !!clip && !!trackSettings[clip.trackId]?.locked;
    });
    const audioLocked = group.audioIds.some((id) => {
      const clip = audioClips.find((item) => item.id === id);
      return !!clip && !!trackSettings[clip.trackId]?.locked;
    });
    const subtitleLocked = group.subtitleIds.some((id) => {
      const subtitle = subtitles.find((item) => item.id === id);
      return (
        !!subtitle && !!trackSettings[getSubtitleTrackId(subtitle)]?.locked
      );
    });
    return !videoLocked && !audioLocked && !subtitleLocked;
  };

  const compoundMoveOriginRef = useRef<{
    compoundId: string;
    groupStart: number;
    state: CompoundTimelineState;
  } | null>(null);
  const compoundResizeOriginRef = useRef<{
    compoundId: string;
    state: CompoundTimelineState;
  } | null>(null);
  const videoResizeSubtitleOriginRef = useRef<{
    subtitles: Subtitle[];
    clipIds: Set<string>;
  } | null>(null);
  const videoMoveSubtitleSyncActiveRef = useRef(false);
  const videoMoveSubtitleOriginRef = useRef<{
    videoClips: VideoTimelineClip[];
    subtitles: Subtitle[];
  } | null>(null);
  const lastVideoResizeSubtitleSyncKeyRef = useRef<string | null>(null);
  const latestVideoClipsRef = useRef(videoClips);
  latestVideoClipsRef.current = videoClips;

  const syncActiveVideoResizeSubtitles = useCallback(
    (clips: VideoTimelineClip[]) => {
      const resizeOrigin = videoResizeSubtitleOriginRef.current;
      if (!resizeOrigin) return;

      const windows = clips
        .filter((clip) => resizeOrigin.clipIds.has(clip.id))
        .map((clip) => ({
          clipId: clip.id,
          timelineStart: clip.timelineStart,
          timelineEnd: clip.timelineEnd,
        }))
        .sort((a, b) => a.clipId.localeCompare(b.clipId));

      if (windows.length === 0) return;

      const syncKey = windows
        .map(
          (window) =>
            `${window.clipId}:${window.timelineStart.toFixed(6)}:${window.timelineEnd.toFixed(6)}`,
        )
        .join("|");

      if (lastVideoResizeSubtitleSyncKeyRef.current === syncKey) return;
      lastVideoResizeSubtitleSyncKeyRef.current = syncKey;

      syncLinkedSubtitlesToVideoWindows(resizeOrigin.subtitles, windows);
    },
    [syncLinkedSubtitlesToVideoWindows],
  );

  // Subtitle trimming/restoration does not need to block React's layout phase.
  // Keeping this as a passive, idempotent sync prevents rapid edge-drag updates
  // (including timeline edge auto-scroll) from nesting state updates until React
  // hits the maximum-update-depth guard.
  useEffect(() => {
    syncActiveVideoResizeSubtitles(videoClips);
  }, [syncActiveVideoResizeSubtitles, videoClips]);

  useEffect(() => {
    const previous = previousVideoSubtitleTopologyRef.current;
    const key = videoSubtitleTopologyKey(videoClips);

    // Project hydration intentionally replaces subtitles and video topology in
    // several React state updates. Never interpret those load-time transitions
    // as timeline edits: reconciling the previous in-memory project against an
    // intermediate empty/new clip list can delete perfectly valid persisted
    // linked captions. handleVideoPathChange seeds `previous...Ref` with the
    // topology that is about to be hydrated; once that exact topology is
    // committed we may safely keep its subtitle snapshot current, including
    // the legacy pending-link binder below.
    if (isLoadingVideoRef.current) {
      if (key === previous.key) {
        previousVideoSubtitleTopologyRef.current = {
          key,
          videoClips,
          subtitles,
        };
        bindPendingGeneratedSubtitlesToVideoClips(
          videoClips.filter((clip) => clip.freezeFrameSourceTime === undefined),
        );
      }
      return;
    }

    const topologyChanged = key !== previous.key;

    if (topologyChanged) {
      if (suppressNextVideoTopologySubtitleSyncRef.current) {
        suppressNextVideoTopologySubtitleSyncRef.current = false;
      } else if (
        !videoResizeSubtitleOriginRef.current &&
        !videoMoveSubtitleSyncActiveRef.current
      ) {
        syncLinkedSubtitlesToVideoTopology(
          previous.videoClips,
          videoClips,
          previous.subtitles,
        );
      }
    }

    previousVideoSubtitleTopologyRef.current = {
      key,
      videoClips,
      subtitles,
    };

    bindPendingGeneratedSubtitlesToVideoClips(
      videoClips.filter((clip) => clip.freezeFrameSourceTime === undefined),
    );
  }, [
    bindPendingGeneratedSubtitlesToVideoClips,
    subtitles,
    syncLinkedSubtitlesToVideoTopology,
    syncLinkedSubtitlesToVideoTopologyFromSnapshot,
    videoClips,
  ]);

  const applyCompoundTimelineState = (next: CompoundTimelineState) => {
    replaceVideoClips(next.videoClips);
    replaceAudioClips(next.audioClips);
    replaceSubtitles(next.subtitles);
  };

  const currentCompoundTimelineState = (): CompoundTimelineState => ({
    videoClips,
    audioClips,
    subtitles,
  });

  const createCompoundFromSelection = () => {
    const totalSelected =
      selectedVideoClipIds.length +
      selectedAudioClipIds.length +
      selectedSubtitleIds.length;
    if (totalSelected < 2 || selectedVideoClipIds.length === 0) {
      return false;
    }

    const selectedVideos = videoClips.filter((clip) =>
      selectedVideoClipIds.includes(clip.id),
    );
    const selectedAudios = audioClips.filter((clip) =>
      selectedAudioClipIds.includes(clip.id),
    );
    const selectedSubs = subtitles.filter((subtitle) =>
      selectedSubtitleIds.includes(subtitle.id),
    );

    if (
      selectedVideos.some(
        (clip) => !!clip.compoundId && compoundGroups.has(clip.compoundId),
      ) ||
      selectedAudios.some(
        (clip) => !!clip.compoundId && compoundGroups.has(clip.compoundId),
      ) ||
      selectedSubs.some(
        (subtitle) =>
          !!subtitle.compoundId && compoundGroups.has(subtitle.compoundId),
      )
    ) {
      window.alert(
        "Open or break apart the existing compound before creating a nested compound.",
      );
      return false;
    }

    const locked =
      selectedVideos.some((clip) => trackSettings[clip.trackId]?.locked) ||
      selectedAudios.some((clip) => trackSettings[clip.trackId]?.locked) ||
      selectedSubs.some(
        (subtitle) => trackSettings[getSubtitleTrackId(subtitle)]?.locked,
      );
    if (locked) return false;

    const anchor =
      selectedVideos.find((clip) => clip.id === selectedVideoClipId) ??
      [...selectedVideos].sort((a, b) => a.timelineStart - b.timelineStart)[0];
    if (!anchor) return false;

    const compoundId = crypto.randomUUID();
    const name = nextCompoundClipName(compoundGroups.values());
    const next = assignCompoundMembership(
      currentCompoundTimelineState(),
      {
        videoIds: selectedVideos.map((clip) => clip.id),
        audioIds: selectedAudios.map((clip) => clip.id),
        subtitleIds: selectedSubs.map((subtitle) => subtitle.id),
      },
      { compoundId, name, anchorVideoId: anchor.id },
    );

    markNextChangeImmediate();
    applyCompoundTimelineState(next);
    setExpandedCompoundId(null);
    selectVideoClips([anchor.id], anchor.id);
    clearAudioClipSelection();
    clearSubtitleSelection();
    return true;
  };

  const openCompound = (compoundId: string) => {
    const group = compoundGroups.get(compoundId);
    if (!group) return;
    setExpandedCompoundId(compoundId);
    selectVideoClips([group.anchorVideoId], group.anchorVideoId);
    clearAudioClipSelection();
    clearSubtitleSelection();
  };

  const closeCompound = () => {
    const group = expandedCompoundId
      ? compoundGroups.get(expandedCompoundId)
      : null;
    setExpandedCompoundId(null);
    if (group) {
      selectVideoClips([group.anchorVideoId], group.anchorVideoId);
      clearAudioClipSelection();
      clearSubtitleSelection();
    }
  };

  const breakApartCompoundWithHistory = (compoundId: string) => {
    const group = compoundGroups.get(compoundId);
    if (!group || !compoundGroupIsEditable(group)) return false;
    markNextChangeImmediate();
    applyCompoundTimelineState(
      breakApartCompoundMembers(currentCompoundTimelineState(), compoundId),
    );
    setExpandedCompoundId(null);
    selectVideoClips(group.videoIds, group.anchorVideoId);
    clearAudioClipSelection();
    clearSubtitleSelection();
    return true;
  };

  const handleCompoundAwareVideoMoveStart = (id: string) => {
    const clip = videoClips.find((item) => item.id === id);
    const candidateGroup =
      clip?.compoundId && clip.compoundId !== expandedCompoundId
        ? compoundGroups.get(clip.compoundId)
        : null;
    const group = candidateGroup?.anchorVideoId === id ? candidateGroup : null;
    if (group) {
      if (!compoundGroupIsEditable(group)) return false;
      videoMoveSubtitleSyncActiveRef.current = true;
      beginHistoryTransaction();
      compoundMoveOriginRef.current = {
        compoundId: group.id,
        groupStart: group.start,
        state: currentCompoundTimelineState(),
      };
      return true;
    }
    return handleVideoClipMoveStart(id);
  };

  const handleCompoundAwareVideoMove = (id: string, requestedStart: number) => {
    const origin = compoundMoveOriginRef.current;
    if (origin) {
      const groups = buildCompoundGroups(
        origin.state.videoClips,
        origin.state.audioClips,
        origin.state.subtitles,
      );
      const group = groups.get(origin.compoundId);
      if (!group) return;
      const delta = requestedStart - origin.groupStart;
      if (!canShiftCompound(origin.state, group, delta)) return;
      applyCompoundTimelineState(
        shiftCompound(origin.state, origin.compoundId, delta),
      );
      return;
    }
    const nextClips = moveVideoClip(id, requestedStart);
    const moveOrigin = videoMoveSubtitleOriginRef.current;
    if (moveOrigin && nextClips) {
      // Keep picture and linked captions in the same React batch. Waiting for a
      // post-render topology effect made captions visibly trail fast drags and
      // allowed a later pointer event to treat stale caption positions as if
      // they had fallen outside the clip.
      syncLinkedSubtitlesToVideoTopologyFromSnapshot(
        moveOrigin.videoClips,
        nextClips,
        moveOrigin.subtitles,
      );
    }
  };

  const handleCompoundAwareVideoMoveEnd = () => {
    if (compoundMoveOriginRef.current) {
      compoundMoveOriginRef.current = null;
      window.requestAnimationFrame(() => {
        videoMoveSubtitleSyncActiveRef.current = false;
        endHistoryTransaction();
      });
      return;
    }
    handleVideoClipMoveEnd();
  };

  const handleCompoundAwareResizeStart = (id: string) => {
    const clip = videoClips.find((item) => item.id === id);
    const candidateGroup =
      clip?.compoundId && clip.compoundId !== expandedCompoundId
        ? compoundGroups.get(clip.compoundId)
        : null;
    const group = candidateGroup?.anchorVideoId === id ? candidateGroup : null;
    if (group && !compoundGroupIsEditable(group)) return false;
    if (!clip) return false;

    beginHistoryTransaction();

    // Resize previews intentionally derive linked subtitles from the gesture-start
    // snapshot so trimming inward and then back outward restores captions exactly.
    // Other subtitle edits should therefore not be committed concurrently with an
    // active video-edge drag; the resize gesture owns subtitle timing until mouseup.
    videoResizeSubtitleOriginRef.current = {
      subtitles: subtitles.map((subtitle) => ({ ...subtitle })),
      clipIds: new Set(group ? group.videoIds : [id]),
    };
    lastVideoResizeSubtitleSyncKeyRef.current = null;

    if (group) {
      compoundResizeOriginRef.current = {
        compoundId: group.id,
        state: currentCompoundTimelineState(),
      };
    }
    return true;
  };

  const handleCompoundAwareResize = (
    id: string,
    start: number,
    end: number,
  ) => {
    const origin = compoundResizeOriginRef.current;
    if (origin) {
      const next = trimCompound(origin.state, origin.compoundId, start, end);
      applyCompoundTimelineState(next);
      const group = buildCompoundGroups(
        next.videoClips,
        next.audioClips,
        next.subtitles,
      ).get(origin.compoundId);
      if (group) {
        selectVideoClips([group.anchorVideoId], group.anchorVideoId);
      }
      return;
    }
    resizeVideoClip(id, start, end);
  };

  const handleCompoundAwareResizeEnd = () => {
    // Apply the final clip window once more from a live ref before closing the
    // history transaction. The mouseup handler was installed at gesture start,
    // so its render closure can otherwise be older than the final resize frame.
    syncActiveVideoResizeSubtitles(latestVideoClipsRef.current);
    compoundResizeOriginRef.current = null;
    videoResizeSubtitleOriginRef.current = null;
    lastVideoResizeSubtitleSyncKeyRef.current = null;
    window.requestAnimationFrame(() => endHistoryTransaction());
  };

  const addSubtitleWithHistory = (
    time: number,
    trackId: TimelineTrackId = activeSubtitleTrackId,
  ) => {
    const settings = trackSettings[trackId];
    const trackExists =
      trackId === DEFAULT_SUBTITLE_TRACK_ID ||
      (!!settings && settings.deleted !== true) ||
      subtitles.some((subtitle) => getSubtitleTrackId(subtitle) === trackId);

    if (
      timelineTrackKindFromId(trackId) !== "subtitle" ||
      !trackExists ||
      settings?.deleted === true ||
      settings?.locked
    ) {
      return;
    }

    markNextChangeImmediate();
    addSubtitle(time, trackId);
    setActiveSubtitleTrackId(trackId);
  };

  const splitSelectedVideoClipAtPlayhead = () => {
    if (selectedCollapsedCompound) {
      window.alert("Open the compound before splitting clips inside it.");
      return true;
    }
    if (!selectedVideoClipId) {
      return false;
    }

    const selectedClip = videoClips.find(
      (clip) => clip.id === selectedVideoClipId,
    );

    if (!selectedClip || trackSettings[selectedClip.trackId]?.locked) {
      return false;
    }

    if (
      currentTimeRef.current <= selectedClip.timelineStart + 0.1 ||
      currentTimeRef.current >= selectedClip.timelineEnd - 0.1
    ) {
      return false;
    }

    const rightClipId = crypto.randomUUID();
    beginHistoryTransaction();
    suppressNextVideoTopologySubtitleSyncRef.current = true;
    splitLinkedSubtitlesForVideoClip(
      selectedVideoClipId,
      rightClipId,
      currentTimeRef.current,
    );
    splitVideoClip(selectedVideoClipId, currentTimeRef.current, rightClipId);
    window.requestAnimationFrame(() => endHistoryTransaction());

    return true;
  };

  const deleteSelectedVideoClipWithHistory = () => {
    if (selectedCollapsedCompound) {
      if (!compoundGroupIsEditable(selectedCollapsedCompound)) return false;

      const videoIds = selectedCollapsedCompound.videoIds;
      beginHistoryTransaction();
      const next = deleteCompoundMembers(
        currentCompoundTimelineState(),
        selectedCollapsedCompound.id,
      );
      applyCompoundTimelineState({
        ...next,
        subtitles: next.subtitles.filter(
          (subtitle) =>
            !subtitle.linkedVideoClipId ||
            !videoIds.includes(subtitle.linkedVideoClipId),
        ),
      });
      clearVideoClipSelection();
      clearAudioClipSelection();
      clearSubtitleSelection();
      window.requestAnimationFrame(() => endHistoryTransaction());
      return true;
    }

    if (!selectedVideoClipsAreEditable) {
      return false;
    }

    beginHistoryTransaction();
    clearSubtitleSelection();
    deleteLinkedSubtitlesForVideoClips(selectedVideoClipIds);
    deleteVideoClips(selectedVideoClipIds);
    window.requestAnimationFrame(() => endHistoryTransaction());

    return true;
  };

  const copySelectedVideoClip = () => {
    if (selectedCollapsedCompound) {
      compoundClipboardRef.current = {
        videoClips: videoClips
          .filter((clip) => clip.compoundId === selectedCollapsedCompound.id)
          .map((clip) => ({ ...clip })),
        audioClips: audioClips
          .filter((clip) => clip.compoundId === selectedCollapsedCompound.id)
          .map((clip) => ({ ...clip })),
        subtitles: subtitles
          .filter(
            (subtitle) => subtitle.compoundId === selectedCollapsedCompound.id,
          )
          .map((subtitle) => ({ ...subtitle })),
        compoundId: selectedCollapsedCompound.id,
        groupStart: selectedCollapsedCompound.start,
        groupEnd: selectedCollapsedCompound.end,
      };
      activeClipboardKindRef.current = "compound";
      timelinePasteTargetRef.current = {
        trackId: selectedCollapsedCompound.trackId,
        time: selectedCollapsedCompound.end,
      };
      return true;
    }

    if (selectedVideoClips.length === 0) {
      return false;
    }

    const clips = selectedVideoClips
      .map((clip) => ({ ...clip }))
      .sort(
        (a, b) =>
          a.timelineStart - b.timelineStart ||
          a.trackId.localeCompare(b.trackId) ||
          a.timelineEnd - b.timelineEnd,
      );
    const groupStart = Math.min(...clips.map((clip) => clip.timelineStart));
    const groupEnd = Math.max(...clips.map((clip) => clip.timelineEnd));

    videoClipboardRef.current = { clips, groupStart, groupEnd };
    activeClipboardKindRef.current = "video";

    // Default multi-clip paste preserves track assignments and relative spacing,
    // placing the copied group immediately after the original group. If every
    // copied clip came from one track, a later timeline click may retarget that
    // entire group to another video track just like single-clip paste.
    timelinePasteTargetRef.current = {
      trackId: selectedVideoClip?.trackId ?? clips[0].trackId,
      time: groupEnd,
    };

    return true;
  };

  const cutSelectedVideoClipWithHistory = () => {
    if (!copySelectedVideoClip()) {
      return false;
    }

    return deleteSelectedVideoClipWithHistory();
  };

  const handleTimelinePasteTargetChange = (
    trackId: TimelineTrackId,
    time: number,
  ) => {
    const kind = timelineTrackKindFromId(trackId);
    if (kind !== "video" && kind !== "audio") return;
    if (trackSettings[trackId]?.deleted || trackSettings[trackId]?.locked)
      return;
    if (kind === "audio" && trackSettings[trackId]?.linkedTrackId) return;

    timelinePasteTargetRef.current = { trackId, time: Math.max(0, time) };
  };

  const pasteVideoClipAtTarget = () => {
    const clipboard = videoClipboardRef.current;

    if (!clipboard || clipboard.clips.length === 0) {
      return false;
    }

    const target = timelinePasteTargetRef.current ?? {
      trackId: clipboard.clips[0].trackId,
      time: clipboard.groupEnd,
    };
    const sourceTrackIds = [
      ...new Set(clipboard.clips.map((clip) => clip.trackId)),
    ];
    const targetTrackIds =
      sourceTrackIds.length === 1 ? [target.trackId] : sourceTrackIds;

    if (
      timelineTrackKindFromId(target.trackId) !== "video" ||
      targetTrackIds.some(
        (trackId) =>
          timelineTrackKindFromId(trackId) !== "video" ||
          trackSettings[trackId]?.deleted === true ||
          trackSettings[trackId]?.locked,
      )
    ) {
      return false;
    }

    beginHistoryTransaction();
    clearSubtitleSelection();
    insertVideoClipCopies(
      clipboard.clips,
      target.time,
      sourceTrackIds.length === 1 ? target.trackId : undefined,
    );
    window.requestAnimationFrame(() => endHistoryTransaction());
    return true;
  };

  const pasteCompoundAtTarget = () => {
    const clipboard = compoundClipboardRef.current;
    if (!clipboard) return false;
    const target = timelinePasteTargetRef.current ?? {
      trackId:
        clipboard.videoClips.find((clip) => clip.compoundAnchor)?.trackId ??
        "video-1",
      time: clipboard.groupEnd,
    };
    if (timelineTrackKindFromId(target.trackId) !== "video") return false;

    const sourceTrackIds = new Set<string>([
      ...clipboard.videoClips.map((clip) => clip.trackId),
      ...clipboard.audioClips.map((clip) => clip.trackId),
      ...clipboard.subtitles.map((subtitle) => getSubtitleTrackId(subtitle)),
    ]);
    if (
      [...sourceTrackIds].some(
        (trackId) =>
          trackSettings[trackId]?.deleted === true ||
          trackSettings[trackId]?.locked,
      )
    ) {
      return false;
    }

    const sourceState: CompoundTimelineState = {
      videoClips: clipboard.videoClips,
      audioClips: clipboard.audioClips,
      subtitles: clipboard.subtitles,
    };
    const result = insertCompoundCopy(
      currentCompoundTimelineState(),
      sourceState,
      clipboard.compoundId,
      target.time,
    );
    if (!result) return false;

    markNextChangeImmediate();
    applyCompoundTimelineState(result.state);
    setExpandedCompoundId(null);
    selectVideoClips([result.anchorVideoId], result.anchorVideoId);
    clearAudioClipSelection();
    clearSubtitleSelection();
    return true;
  };

  const duplicateSelectedVideoClipWithHistory = () => {
    if (selectedCollapsedCompound) {
      if (!compoundGroupIsEditable(selectedCollapsedCompound)) return false;
      const result = duplicateCompound(
        currentCompoundTimelineState(),
        selectedCollapsedCompound.id,
        selectedCollapsedCompound.end,
      );
      if (!result) return false;
      markNextChangeImmediate();
      applyCompoundTimelineState(result.state);
      selectVideoClips([result.anchorVideoId], result.anchorVideoId);
      clearAudioClipSelection();
      clearSubtitleSelection();
      return true;
    }

    if (!selectedVideoClipsAreEditable) {
      return false;
    }

    const groupEnd = Math.max(
      ...selectedVideoClips.map((clip) => clip.timelineEnd),
    );

    beginHistoryTransaction();
    clearSubtitleSelection();
    insertVideoClipCopies(selectedVideoClips, groupEnd);
    window.requestAnimationFrame(() => endHistoryTransaction());
    return true;
  };

  const deleteSelectedAudioClipsWithHistory = () => {
    if (!selectedAudioClipsAreEditable) return false;
    markNextChangeImmediate();
    clearSubtitleSelection();
    deleteAudioClips(selectedAudioClipIds);
    return true;
  };

  const copySelectedAudioClips = () => {
    if (selectedAudioClips.length === 0) return false;
    const clips = selectedAudioClips
      .map((clip) => ({ ...clip }))
      .sort(
        (a, b) =>
          a.timelineStart - b.timelineStart ||
          a.trackId.localeCompare(b.trackId),
      );
    const groupStart = Math.min(...clips.map((clip) => clip.timelineStart));
    const groupEnd = Math.max(...clips.map((clip) => clip.timelineEnd));
    audioClipboardRef.current = { clips, groupStart, groupEnd };
    activeClipboardKindRef.current = "audio";
    timelinePasteTargetRef.current = {
      trackId: selectedAudioClip?.trackId ?? clips[0].trackId,
      time: groupEnd,
    };
    return true;
  };

  const cutSelectedAudioClipsWithHistory = () => {
    if (!selectedAudioClipsAreEditable || !copySelectedAudioClips())
      return false;
    markNextChangeImmediate();
    clearSubtitleSelection();
    deleteAudioClips(selectedAudioClipIds);
    return true;
  };

  const pasteAudioClipsAtTarget = () => {
    const clipboard = audioClipboardRef.current;
    if (!clipboard || clipboard.clips.length === 0) return false;
    const sourceTrackIds = [
      ...new Set(clipboard.clips.map((clip) => clip.trackId)),
    ];
    const fallbackTrack = sourceTrackIds[0];
    const target = timelinePasteTargetRef.current ?? {
      trackId: fallbackTrack,
      time: clipboard.groupEnd,
    };
    const targetKind = timelineTrackKindFromId(target.trackId);
    const canRetarget = sourceTrackIds.length === 1 && targetKind === "audio";
    const targetTracks = canRetarget ? [target.trackId] : sourceTrackIds;
    if (
      targetTracks.some(
        (trackId) =>
          timelineTrackKindFromId(trackId) !== "audio" ||
          trackSettings[trackId]?.deleted ||
          trackSettings[trackId]?.locked ||
          !!trackSettings[trackId]?.linkedTrackId,
      )
    )
      return false;

    markNextChangeImmediate();
    clearSubtitleSelection();
    clearVideoClipSelection();
    insertAudioClipCopies(
      clipboard.clips,
      target.time,
      canRetarget ? target.trackId : undefined,
    );
    return true;
  };

  const duplicateSelectedAudioClipsWithHistory = () => {
    if (!selectedAudioClipsAreEditable) return false;
    const groupEnd = Math.max(
      ...selectedAudioClips.map((clip) => clip.timelineEnd),
    );
    markNextChangeImmediate();
    clearSubtitleSelection();
    clearVideoClipSelection();
    insertAudioClipCopies(selectedAudioClips, groupEnd);
    return true;
  };

  const handleAudioClipSelect = (
    id: string,
    mode: "single" | "toggle" | "focus" = "single",
  ) => {
    if (!timelineSelectableAudioClipIds.includes(id)) {
      return;
    }
    selectAudioClip(id, mode);
    if (mode !== "toggle") {
      clearVideoClipSelection();
      clearSubtitleSelection();
      clearAdjustmentLayerSelection();
    }
    setTimelineRange(null);
  };

  const handleAudioClipMoveStart = (id: string) => {
    const hasMulti =
      selectedAudioClipIds.includes(id) && selectedAudioClipIds.length > 1;
    if (hasMulti && !selectedAudioClipsAreEditable) return false;
    beginHistoryTransaction();
    beginAudioClipMove(id);
    return true;
  };

  const handleAudioClipMoveEnd = () => {
    endAudioClipMove();
    window.requestAnimationFrame(() => endHistoryTransaction());
  };

  const handleProgramVideoClipSelect = (
    id: string,
    mode: "single" | "toggle" | "focus" = "single",
  ) => {
    const clip = videoClips.find((item) => item.id === id);
    if (clip?.compoundId && clip.compoundId !== expandedCompoundId) {
      const group = compoundGroups.get(clip.compoundId);
      if (group) {
        selectVideoClips([group.anchorVideoId], group.anchorVideoId);
        clearAudioClipSelection();
        clearSubtitleSelection();
        clearAdjustmentLayerSelection();
        setTimelineRange(null);
        return;
      }
    }
    handleVideoClipSelect(id, mode);
  };

  const handleProgramSubtitleSelect = (id: string) => {
    const subtitle = subtitles.find((item) => item.id === id);
    if (!subtitle) return;

    setActiveSubtitleTrackId(getSubtitleTrackId(subtitle));
    clearVideoClipSelection();
    clearAudioClipSelection();
    clearAdjustmentLayerSelection();
    selectSubtitle(id, "single", timelineSelectableSubtitleIdSet);
    setTimelineRange(null);
  };

  const handleVideoClipSelect = (
    id: string,
    mode: "single" | "toggle" | "focus" = "single",
  ) => {
    selectVideoClip(id, mode);
    if (mode !== "toggle") {
      clearSubtitleSelection();
      clearAudioClipSelection();
      clearAdjustmentLayerSelection();
    }
    setTimelineRange(null);
  };

  const handleVideoClipSelectionChange = (
    ids: string[],
    primaryId?: string | null,
  ) => {
    selectVideoClips(ids, primaryId);
    clearSubtitleSelection();
    clearAudioClipSelection();
    clearAdjustmentLayerSelection();
    setTimelineRange(null);
  };

  const handleVideoClipMoveStart = (id: string) => {
    const hasMultiSelection =
      selectedVideoClipIds.includes(id) && selectedVideoClipIds.length > 1;

    if (hasMultiSelection && !selectedVideoClipsAreEditable) {
      return false;
    }

    videoMoveSubtitleSyncActiveRef.current = true;
    beginHistoryTransaction();

    // Every video move, not only Ripple, owns one immutable subtitle snapshot.
    // Each pointer frame remaps from this same source so subtitles move in the
    // exact render as the video and a fast drag can never progressively trim or
    // delete captions based on an intermediate frame.
    videoMoveSubtitleOriginRef.current = {
      videoClips: videoClips.map((clip) => ({ ...clip })),
      subtitles: subtitles.map((subtitle) => ({ ...subtitle })),
    };

    // Ripple mode needs an immutable drag-origin snapshot even for a single
    // clip. Freeform mode still only captures multi-clip moves.
    if (rippleMode || hasMultiSelection) {
      beginVideoClipMove(id);
    } else {
      endVideoClipMove();
    }

    return true;
  };

  const handleVideoClipMoveEnd = () => {
    endVideoClipMove();
    window.requestAnimationFrame(() => {
      // The final mouse position is flushed by VideoTrack before this callback,
      // so its video/subtitle pair is already committed in one batch. Do not
      // remap again from latestVideoClipsRef here; that ref can still represent
      // the previous render when mouseup happens in the same native event.
      videoMoveSubtitleOriginRef.current = null;
      videoMoveSubtitleSyncActiveRef.current = false;
      endHistoryTransaction();
    });
  };

  const splitSelectedAudioClipAtPlayhead = () => {
    if (!selectedAudioClipId) return false;
    const clip = audioClips.find((item) => item.id === selectedAudioClipId);
    if (!clip || trackSettings[clip.trackId]?.locked) return false;
    if (
      currentTimeRef.current <= clip.timelineStart + 0.05 ||
      currentTimeRef.current >= clip.timelineEnd - 0.05
    )
      return false;
    markNextChangeImmediate();
    splitAudioClip(clip.id, currentTimeRef.current);
    return true;
  };

  const applySelectedTimelineRangeEdit = (mode: TimelineRangeEditMode) => {
    if (!timelineRange) {
      return false;
    }

    const intersectsCollapsedCompound = [...compoundGroups.values()].some(
      (group) =>
        group.id !== expandedCompoundId &&
        timelineRange.end > group.start + 0.000001 &&
        timelineRange.start < group.end - 0.000001,
    );
    if (intersectsCollapsedCompound) {
      window.alert(
        "Open the compound before applying a range edit through it.",
      );
      return false;
    }

    const result = applyTimelineRangeEdit({
      range: timelineRange,
      mode,
      videoClips,
      audioClips,
      adjustmentLayers,
      subtitles,
      markers,
      trackSettings,
    });

    if (!result.changed) {
      return false;
    }

    const editStart = timelineRange.start;

    markNextChangeImmediate();
    clearSubtitleSelection();
    clearVideoClipSelection();
    clearAudioClipSelection();
    setSelectedAdjustmentLayerId(null);
    setAdjustmentPanelOpen(false);
    replaceVideoClips(result.videoClips);
    replaceAudioClips(result.audioClips);
    setAdjustmentLayers(result.adjustmentLayers);
    replaceSubtitles(result.subtitles);
    setMarkers(result.markers);
    setTimelineRange(null);
    timelinePasteTargetRef.current = null;
    requestSeek(editStart);

    return true;
  };

  // Delete Range and Lift intentionally share the same gap-preserving edit.
  // Extract uses the same cut boundaries, then ripples later unlocked content.
  const deleteTimelineRangeWithHistory = () =>
    applySelectedTimelineRangeEdit("lift");

  const liftTimelineRangeWithHistory = () =>
    applySelectedTimelineRangeEdit("lift");

  const extractTimelineRangeWithHistory = () =>
    applySelectedTimelineRangeEdit("extract");

  const toggleTrackSetting = (
    trackId: TimelineTrackId,
    setting: "locked" | "muted" | "solo" | "hidden",
  ) => {
    setTrackSettings((current) => ({
      ...current,
      [trackId]: {
        ...(current[trackId] ?? { locked: false }),
        [setting]: !(current[trackId]?.[setting] ?? false),
      },
    }));
  };

  const handleAddTimelineTrack = (kind: TimelineTrackKind | "video-audio") => {
    markNextChangeImmediate();

    if (kind === "video-audio") {
      const videoId = nextTimelineTrackId(
        "video",
        trackSettings,
        videoClips,
        audioClips,
      );
      const audioId = nextTimelineTrackId(
        "audio",
        trackSettings,
        videoClips,
        audioClips,
      );

      setTrackSettings((current) => ({
        ...current,
        [videoId]: {
          ...defaultTrackControlState("video"),
          linkedTrackId: audioId,
          deleted: false,
        },
        [audioId]: {
          ...defaultTrackControlState("audio"),
          locked: true,
          linkedTrackId: videoId,
          deleted: false,
        },
      }));
      return;
    }

    const id = nextTimelineTrackId(kind, trackSettings, videoClips, audioClips);
    setTrackSettings((current) => ({
      ...current,
      [id]: {
        ...defaultTrackControlState(kind),
        linkedTrackId: null,
        deleted: false,
      },
    }));

    if (kind === "subtitle") {
      setActiveSubtitleTrackId(id);
    }
  };

  const handleDeleteTimelineTrack = (trackId: TimelineTrackId) => {
    const kind = timelineTrackKindFromId(trackId);
    if (!kind) return;

    if (kind === "subtitle" && trackId === "subtitle-1") return;

    const linkedTrackId = trackSettings[trackId]?.linkedTrackId;

    // The audio half of a Video + Audio pair is owned by the video track.
    if (
      kind === "audio" &&
      linkedTrackId &&
      timelineTrackKindFromId(linkedTrackId) === "video"
    ) {
      return;
    }

    if (kind === "video") {
      const clipCount = videoClips.filter(
        (clip) => clip.trackId === trackId,
      ).length;
      const adjustmentCount = adjustmentLayers.filter(
        (layer) => layer.trackId === trackId,
      ).length;
      const hasLinkedAudio =
        !!linkedTrackId &&
        timelineTrackKindFromId(linkedTrackId) === "audio" &&
        trackSettings[linkedTrackId]?.deleted !== true;
      const label = `V${timelineTrackIndexFromId(trackId)}`;
      const message = hasLinkedAudio
        ? `Delete ${label} and its linked ${linkedTrackId?.replace("audio-", "A")} track?${clipCount ? ` This will remove ${clipCount} video clip${clipCount === 1 ? "" : "s"}.` : ""}${adjustmentCount ? ` This will also remove ${adjustmentCount} adjustment layer${adjustmentCount === 1 ? "" : "s"}.` : ""}`
        : `Delete ${label}?${clipCount ? ` This will remove ${clipCount} video clip${clipCount === 1 ? "" : "s"}.` : ""}${adjustmentCount ? ` This will also remove ${adjustmentCount} adjustment layer${adjustmentCount === 1 ? "" : "s"}.` : ""}`;

      if (!window.confirm(message)) return;

      const removedVideoIds = videoClips
        .filter((clip) => clip.trackId === trackId)
        .map((clip) => clip.id);

      beginHistoryTransaction();
      deleteLinkedSubtitlesForVideoClips(removedVideoIds);
      deleteVideoTrack(trackId);
      setAdjustmentLayers((current) =>
        current.filter((layer) => layer.trackId !== trackId),
      );
      if (selectedAdjustmentLayer?.trackId === trackId) {
        setSelectedAdjustmentLayerId(null);
        setAdjustmentPanelOpen(false);
      }
      setTrackSettings((current) => {
        const next = {
          ...current,
          [trackId]: {
            ...(current[trackId] ?? defaultTrackControlState("video")),
            deleted: true,
            linkedTrackId: null,
          },
        };

        if (hasLinkedAudio && linkedTrackId) {
          next[linkedTrackId] = {
            ...(current[linkedTrackId] ?? defaultTrackControlState("audio")),
            deleted: true,
            linkedTrackId: null,
          };
        }
        return next;
      });

      if (
        timelinePasteTargetRef.current?.trackId === trackId ||
        timelinePasteTargetRef.current?.trackId === linkedTrackId
      ) {
        timelinePasteTargetRef.current = null;
      }
      window.requestAnimationFrame(() => endHistoryTransaction());
      return;
    }

    if (kind === "audio") {
      const clipCount = audioClips.filter(
        (clip) => clip.trackId === trackId,
      ).length;
      const label = `A${timelineTrackIndexFromId(trackId)}`;
      if (
        !window.confirm(
          `Delete ${label}?${clipCount ? ` This will remove ${clipCount} audio clip${clipCount === 1 ? "" : "s"}.` : ""}`,
        )
      )
        return;
      markNextChangeImmediate();
      deleteAudioTrack(trackId);
      setTrackSettings((current) => ({
        ...current,
        [trackId]: {
          ...(current[trackId] ?? defaultTrackControlState("audio")),
          deleted: true,
          linkedTrackId: null,
        },
      }));
      if (timelinePasteTargetRef.current?.trackId === trackId)
        timelinePasteTargetRef.current = null;
      return;
    }

    if (kind === "subtitle") {
      const subtitleIds = subtitles
        .filter((subtitle) => getSubtitleTrackId(subtitle) === trackId)
        .map((subtitle) => subtitle.id);
      const label = `S${timelineTrackIndexFromId(trackId)}`;
      const count = subtitleIds.length;

      if (
        !window.confirm(
          `Delete ${label}?${
            count
              ? ` This will remove ${count} subtitle${count === 1 ? "" : "s"}.`
              : ""
          }`,
        )
      ) {
        return;
      }

      markNextChangeImmediate();
      if (subtitleIds.length > 0) {
        deleteSubtitles(subtitleIds);
      }
      setTrackSettings((current) => ({
        ...current,
        [trackId]: {
          ...(current[trackId] ?? defaultTrackControlState(kind)),
          deleted: true,
        },
      }));

      if (activeSubtitleTrackId === trackId) {
        setActiveSubtitleTrackId(DEFAULT_SUBTITLE_TRACK_ID);
      }
      return;
    }

    if (!window.confirm(`Delete ${trackId.replace("-", " ")}?`)) return;
    markNextChangeImmediate();
    setTrackSettings((current) => ({
      ...current,
      [trackId]: {
        ...(current[trackId] ?? defaultTrackControlState(kind)),
        deleted: true,
      },
    }));
  };

  const handleMoveSubtitleToTrack = (
    id: string,
    targetTrackId: TimelineTrackId,
    newStartTime: number,
  ) => {
    if (
      timelineTrackKindFromId(targetTrackId) !== "subtitle" ||
      trackSettings[targetTrackId]?.deleted ||
      trackSettings[targetTrackId]?.locked
    ) {
      return;
    }

    moveSubtitleToTrack(id, targetTrackId, newStartTime);
    setActiveSubtitleTrackId(targetTrackId);
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

  type ProgramLayerDirection = "forward" | "backward";

  const programVisibleVideoClipsAtTime = (atTime: number) => {
    const interactiveIds = new Set(programInteractiveVideoClipIds);
    return videoClips
      .filter(
        (clip) =>
          interactiveIds.has(clip.id) &&
          atTime >= clip.timelineStart &&
          atTime < clip.timelineEnd &&
          trackSettings[clip.trackId]?.deleted !== true &&
          trackSettings[clip.trackId]?.hidden !== true,
      )
      .sort(
        (a, b) =>
          effectiveVideoLayer(a) - effectiveVideoLayer(b) ||
          a.timelineStart - b.timelineStart ||
          a.id.localeCompare(b.id),
      );
  };

  const applyProgramVideoLayerOrder = (orderedClipIdsTopToBottom: string[]) => {
    const visibleIds = new Set(orderedClipIdsTopToBottom);
    const visibleClips = videoClips.filter((clip) => visibleIds.has(clip.id));
    if (visibleClips.length !== orderedClipIdsTopToBottom.length) return false;

    if (visibleClips.some((clip) => trackSettings[clip.trackId]?.locked)) {
      window.alert("Unlock the affected video track before changing its Program layer order.");
      return false;
    }

    const normalized = normalizedProgramLayersForVideoOrder(
      videoClips,
      adjustmentLayers,
      orderedClipIdsTopToBottom,
    );
    if (!normalized) return false;

    const videoChanged = videoClips.some(
      (clip) => normalized.videoLayers.get(clip.id) !== effectiveVideoLayer(clip),
    );
    if (!videoChanged) return true;

    markNextChangeImmediate();
    replaceVideoClips(
      videoClips.map((clip) => ({
        ...clip,
        layer: normalized.videoLayers.get(clip.id) ?? clip.layer,
      })),
    );
    setAdjustmentLayers((current) =>
      current.map((layer) => ({
        ...layer,
        layer: normalized.adjustmentLayers.get(layer.id) ?? layer.layer,
      })),
    );
    return true;
  };

  const handleProgramVideoLayerChange = (
    id: string,
    direction: ProgramLayerDirection,
    atTime: number,
  ) => {
    const visibleBottomToTop = programVisibleVideoClipsAtTime(atTime);
    const currentIndex = visibleBottomToTop.findIndex((clip) => clip.id === id);
    if (currentIndex < 0) return false;
    const neighborIndex = direction === "forward" ? currentIndex + 1 : currentIndex - 1;
    if (neighborIndex < 0 || neighborIndex >= visibleBottomToTop.length) return false;

    const requestedBottomToTop = [...visibleBottomToTop];
    [requestedBottomToTop[currentIndex], requestedBottomToTop[neighborIndex]] = [
      requestedBottomToTop[neighborIndex],
      requestedBottomToTop[currentIndex],
    ];
    return applyProgramVideoLayerOrder(
      requestedBottomToTop.map((clip) => clip.id).reverse(),
    );
  };

  const handleProgramVideoLayerReorder = (
    orderedClipIdsTopToBottom: string[],
    atTime: number,
  ) => {
    const visible = programVisibleVideoClipsAtTime(atTime);
    const visibleIds = new Set(visible.map((clip) => clip.id));
    if (
      orderedClipIdsTopToBottom.length !== visibleIds.size ||
      orderedClipIdsTopToBottom.some((id) => !visibleIds.has(id)) ||
      new Set(orderedClipIdsTopToBottom).size !== visibleIds.size
    ) {
      return false;
    }
    return applyProgramVideoLayerOrder(orderedClipIdsTopToBottom);
  };

  const handleVideoPlaybackRateChange = (id: string, requestedRate: number) => {
    const clip = videoClips.find((item) => item.id === id);

    if (!clip || trackSettings[clip.trackId]?.locked) {
      return;
    }

    const sourceSpan = Math.max(0, clip.sourceOut - clip.sourceIn);
    if (sourceSpan <= 0) {
      return;
    }

    const effectiveRate = normalizeVideoPlaybackRate(requestedRate);
    const nextDuration = sourceSpan / effectiveRate;

    if (nextDuration < 0.1) {
      window.alert(
        "This source fragment is too short for that playback speed.",
      );
      return;
    }

    const nextEnd = clip.timelineStart + nextDuration;

    if (!rippleMode) {
      const collides = videoClips.some(
        (other) =>
          other.id !== id &&
          other.trackId === clip.trackId &&
          nextEnd > other.timelineStart + 0.000001 &&
          clip.timelineStart < other.timelineEnd - 0.000001,
      );

      if (collides) {
        window.alert(
          "There is not enough room to slow this clip without overlapping another clip. Move the neighbouring clip or enable Ripple mode first.",
        );
        return;
      }
    }

    beginHistoryTransaction();
    updateVideoClipPlaybackRate(id, effectiveRate);
    window.requestAnimationFrame(() => endHistoryTransaction());
  };

  const handleToggleVideoReverse = (id: string) => {
    const clip = videoClips.find((item) => item.id === id);
    if (
      !clip ||
      trackSettings[clip.trackId]?.locked ||
      clip.freezeFrameSourceTime !== undefined
    ) {
      return;
    }
    beginHistoryTransaction();
    toggleVideoClipReverse(id);
    window.requestAnimationFrame(() => endHistoryTransaction());
  };

  const handleInsertFreezeFrame = (id: string) => {
    const clip = videoClips.find((item) => item.id === id);
    if (!clip || trackSettings[clip.trackId]?.locked) return;
    if (clip.freezeFrameSourceTime !== undefined) {
      window.alert("This clip is already a freeze frame.");
      return;
    }
    if (
      currentTimeRef.current <= clip.timelineStart + 0.1 ||
      currentTimeRef.current >= clip.timelineEnd - 0.1
    ) {
      window.alert(
        "Move the playhead inside the selected clip before creating a freeze frame.",
      );
      return;
    }
    beginHistoryTransaction();
    suppressNextVideoTopologySubtitleSyncRef.current = true;
    const freezeResult = insertVideoFreezeFrame(
      id,
      currentTimeRef.current,
      2,
    );
    if (freezeResult) {
      syncLinkedSubtitlesToVideoTopologyFromSnapshot(
        videoClips,
        freezeResult.clips,
        subtitles,
      );
    } else {
      // No topology change occurred, so there is no effect pass that could
      // consume this one-shot suppression flag.
      suppressNextVideoTopologySubtitleSyncRef.current = false;
    }
    window.requestAnimationFrame(() => endHistoryTransaction());
  };

  const handleVideoTransformChange = (
    id: string,
    transform: {
      positionX?: number;
      positionY?: number;
      scale?: number;
      rotation?: number;
      opacity?: number;
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

    updateVideoClipTransform(id, transform, currentTimeRef.current);
  };

  const handleVideoMaskChange = (id: string, mask: VideoMask | undefined) => {
    const clip = videoClips.find((item) => item.id === id);

    if (!clip || trackSettings[clip.trackId]?.locked) {
      return;
    }

    updateVideoClipMask(id, mask);
  };

  const handleVideoBlendModeChange = (
    id: string,
    blendMode: VideoBlendMode,
  ) => {
    const clip = videoClips.find((item) => item.id === id);

    if (!clip || trackSettings[clip.trackId]?.locked) {
      return;
    }

    markNextChangeImmediate();
    updateVideoClipBlendMode(id, blendMode);
  };

  const handleApplyVideoCropToTrack = (id: string) => {
    const clip = videoClips.find((item) => item.id === id);

    if (!clip || trackSettings[clip.trackId]?.locked) {
      return;
    }

    markNextChangeImmediate();
    applyVideoClipCropToTrack(id);
  };

  const handleVideoTransitionChange = (
    id: string,
    edge: "in" | "out",
    transition: {
      type?: "none" | "cross-dissolve" | "fade-black";
      duration?: number;
    },
  ) => {
    const clip = videoClips.find((item) => item.id === id);

    if (!clip || trackSettings[clip.trackId]?.locked) {
      return;
    }

    updateVideoClipTransition(id, edge, transition);
  };

  const handleVideoFadeChange = (
    id: string,
    edge: "in" | "out",
    duration: number,
  ) => {
    const clip = videoClips.find((item) => item.id === id);

    if (!clip || trackSettings[clip.trackId]?.locked) {
      return;
    }

    updateVideoClipOpacityFade(id, edge, duration);
  };

  const handleAudioFadeChange = (
    id: string,
    edge: "in" | "out",
    duration: number,
  ) => {
    const clip = videoClips.find((item) => item.id === id);

    if (!clip) {
      return;
    }

    updateVideoClipAudio(
      id,
      edge === "in"
        ? { fadeInDuration: duration }
        : { fadeOutDuration: duration },
    );
  };

  const handleAudioVolumeChange = (id: string, volume: number) => {
    const clip = videoClips.find((item) => item.id === id);

    if (!clip) {
      return;
    }

    updateVideoClipAudio(id, { volume });
  };

  const handleAudioMuteChange = (id: string, muted: boolean) => {
    const clip = videoClips.find((item) => item.id === id);

    if (!clip) {
      return;
    }

    markNextChangeImmediate();
    updateVideoClipAudio(id, { muted });
  };

  const handleStandaloneAudioFadeChange = (
    id: string,
    edge: "in" | "out",
    duration: number,
  ) => {
    const clip = audioClips.find((item) => item.id === id);
    if (
      !clip ||
      trackSettings[clip.trackId]?.locked ||
      trackSettings[clip.trackId]?.linkedTrackId
    ) {
      return;
    }
    updateAudioClip(
      id,
      edge === "in"
        ? { fadeInDuration: duration }
        : { fadeOutDuration: duration },
    );
  };

  const handleStandaloneAudioVolumeChange = (id: string, volume: number) => {
    const clip = audioClips.find((item) => item.id === id);
    if (
      !clip ||
      trackSettings[clip.trackId]?.locked ||
      trackSettings[clip.trackId]?.linkedTrackId
    ) {
      return;
    }
    updateAudioClip(id, { volume });
  };

  const handleStandaloneAudioMuteChange = (id: string, muted: boolean) => {
    const clip = audioClips.find((item) => item.id === id);
    if (
      !clip ||
      trackSettings[clip.trackId]?.locked ||
      trackSettings[clip.trackId]?.linkedTrackId
    ) {
      return;
    }
    markNextChangeImmediate();
    updateAudioClip(id, { muted });
  };

  const handleSubtitleTrackSelect = (
    id: string,
    mode: "single" | "toggle" | "range" = "single",
  ) => {
    if (mode !== "toggle") {
      clearVideoClipSelection();
      clearAudioClipSelection();
    }
    const subtitle = subtitles.find((item) => item.id === id);
    if (subtitle) {
      setActiveSubtitleTrackId(getSubtitleTrackId(subtitle));
    }
    selectSubtitle(id, mode, timelineSelectableSubtitleIdSet);
  };

  const splitSelectedSubtitleAtPlayhead = () => {
    if (!selectedSubtitleId) {
      return;
    }

    const selectedSubtitle = subtitles.find(
      (subtitle) => subtitle.id === selectedSubtitleId,
    );

    if (
      !selectedSubtitle ||
      trackSettings[getSubtitleTrackId(selectedSubtitle)]?.locked
    ) {
      return;
    }

    const MIN_SPLIT_GAP = 0.05;

    if (
      currentTimeRef.current <= selectedSubtitle.startTime + MIN_SPLIT_GAP ||
      currentTimeRef.current >= selectedSubtitle.endTime - MIN_SPLIT_GAP
    ) {
      return;
    }

    markNextChangeImmediate();

    splitSubtitle(selectedSubtitleId, currentTimeRef.current);
  };

  const editableSubtitleIds = (ids: string[]) =>
    ids.filter((id) => {
      const subtitle = subtitles.find((item) => item.id === id);
      return !!subtitle && !trackSettings[getSubtitleTrackId(subtitle)]?.locked;
    });

  const deleteSubtitleWithHistory = (id: string) => {
    const requestedIds =
      selectedSubtitleIds.includes(id) && selectedSubtitleIds.length > 1
        ? selectedSubtitleIds
        : [id];
    const idsToDelete = editableSubtitleIds(requestedIds);

    if (idsToDelete.length === 0) {
      return;
    }

    markNextChangeImmediate();
    deleteSubtitles(idsToDelete);
  };

  const deleteSelectionWithHistory = () => {
    const idsToDelete = editableSubtitleIds(selectedSubtitleIds);

    if (idsToDelete.length === 0) {
      return;
    }

    markNextChangeImmediate();
    deleteSubtitles(idsToDelete);
  };

  const updateSubtitleTextIfEditable = (id: string, text: string) => {
    const subtitle = subtitles.find((item) => item.id === id);
    if (!subtitle || trackSettings[getSubtitleTrackId(subtitle)]?.locked) {
      return;
    }
    updateSubtitleText(id, text);
  };

  const updateSubtitlePositionIfEditable = (
    id: string,
    positionX: number,
    positionY: number,
  ) => {
    const subtitle = subtitles.find((item) => item.id === id);
    if (!subtitle || trackSettings[getSubtitleTrackId(subtitle)]?.locked) {
      return;
    }
    updateSubtitlePosition(id, positionX, positionY);
  };

  const updateSubtitleStyleWithSelection = (
    id: string,
    style: Parameters<typeof updateSubtitleStyle>[1],
  ) => {
    const subtitle = subtitles.find((item) => item.id === id);
    if (!subtitle || trackSettings[getSubtitleTrackId(subtitle)]?.locked) {
      return;
    }

    if (selectedSubtitleIds.includes(id) && selectedSubtitleIds.length > 1) {
      updateSubtitleStyles(editableSubtitleIds(selectedSubtitleIds), style);
      return;
    }

    updateSubtitleStyle(id, style);
  };

  const applySubtitleAppearance = (
    sourceSubtitleId: string,
    scope: "track" | "all",
    style: Parameters<typeof updateSubtitleStyle>[1],
  ) => {
    const sourceSubtitle = subtitles.find(
      (subtitle) => subtitle.id === sourceSubtitleId,
    );
    if (!sourceSubtitle) {
      return;
    }

    const sourceTrackId = getSubtitleTrackId(sourceSubtitle);
    const ids = subtitles
      .filter((subtitle) => {
        const trackId = getSubtitleTrackId(subtitle);

        if (trackSettings[trackId]?.locked) {
          return false;
        }

        return scope === "all" || trackId === sourceTrackId;
      })
      .map((subtitle) => subtitle.id);

    if (ids.length === 0) {
      return;
    }

    markNextChangeImmediate();
    updateSubtitleStyles(ids, style);
  };

  const setMarkersWithHistory = (nextMarkers: TimelineMarker[]) => {
    markNextChangeImmediate();
    setMarkers(nextMarkers);
  };

  const replaceSubtitleTrackWithHistory = (
    trackId: TimelineTrackId,
    nextSubtitles: typeof subtitles,
  ) => {
    if (trackSettings[trackId]?.locked) {
      return;
    }

    markNextChangeImmediate();
    replaceSubtitles([
      ...subtitles.filter(
        (subtitle) => getSubtitleTrackId(subtitle) !== trackId,
      ),
      ...nextSubtitles.map((subtitle) => ({
        ...subtitle,
        trackId,
      })),
    ]);
    setActiveSubtitleTrackId(trackId);
  };

  const reserveSubtitleTrackForTranscription = () => {
    const activeTrackIds = new Set<TimelineTrackId>([
      DEFAULT_SUBTITLE_TRACK_ID,
    ]);

    for (const [trackId, settings] of Object.entries(trackSettings) as [
      TimelineTrackId,
      TimelineTrackSettings[TimelineTrackId],
    ][]) {
      if (
        timelineTrackKindFromId(trackId) === "subtitle" &&
        settings?.deleted !== true
      ) {
        activeTrackIds.add(trackId);
      }
    }

    for (const subtitle of subtitles) {
      const trackId = getSubtitleTrackId(subtitle);
      if (trackSettings[trackId]?.deleted !== true) {
        activeTrackIds.add(trackId);
      }
    }

    const orderedTrackIds = [...activeTrackIds].sort(
      (a, b) => timelineTrackIndexFromId(a) - timelineTrackIndexFromId(b),
    );
    const emptyEditableTrack = orderedTrackIds.find(
      (trackId) =>
        !trackSettings[trackId]?.locked &&
        !subtitles.some(
          (subtitle) => getSubtitleTrackId(subtitle) === trackId,
        ),
    );

    if (emptyEditableTrack) {
      setActiveSubtitleTrackId(emptyEditableTrack);
      return emptyEditableTrack;
    }

    let nextIndex = 1;
    while (activeTrackIds.has(`subtitle-${nextIndex}`)) {
      nextIndex += 1;
    }

    const trackId = `subtitle-${nextIndex}` as TimelineTrackId;
    setTrackSettings((current) => ({
      ...current,
      [trackId]: {
        ...defaultTrackControlState("subtitle"),
        linkedTrackId: null,
        deleted: false,
      },
    }));
    setActiveSubtitleTrackId(trackId);
    return trackId;
  };

  const replaceGeneratedSubtitlesWithHistory = (
    segments: {
      startTime: number;
      endTime: number;
      text: string;
    }[],
    generatedFromPath: string,
  ) => {
    const sourceClip = videoClips
      .filter(
        (clip) =>
          clip.sourcePath === generatedFromPath &&
          clip.freezeFrameSourceTime === undefined,
      )
      .sort(
        (a, b) =>
          a.timelineStart - b.timelineStart ||
          a.sourceIn - b.sourceIn ||
          a.sourceOut - b.sourceOut,
      )[0];

    const linkedSegments = sourceClip
      ? segments.flatMap((segment) => {
          const sourceStart = Math.max(segment.startTime, sourceClip.sourceIn);
          const sourceEnd = Math.min(segment.endTime, sourceClip.sourceOut);

          if (sourceEnd <= sourceStart) return [];

          const mappedStart = sourceTimeToTimelineTime(sourceClip, sourceStart);
          const mappedEnd = sourceTimeToTimelineTime(sourceClip, sourceEnd);

          return [
            {
              ...segment,
              startTime: Math.min(mappedStart, mappedEnd),
              endTime: Math.max(mappedStart, mappedEnd),
              linkedVideoClipId: sourceClip.id,
              linkedVideoSourcePath: generatedFromPath,
            },
          ];
        })
      : segments.map((segment) => ({
          ...segment,
          linkedVideoSourcePath: generatedFromPath,
        }));

    if (linkedSegments.length === 0) {
      return;
    }

    markNextChangeImmediate();
    const targetTrackId = reserveSubtitleTrackForTranscription();
    replaceWithGeneratedSubtitles(linkedSegments, targetTrackId);
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

  const createSaveFingerprint = (state: {
    subtitles: typeof subtitles;
    markers: TimelineMarker[];
    videoClips: VideoTimelineClip[];
    audioClips: AudioTimelineClip[];
    adjustmentLayers: AdjustmentLayerClip[];
    mediaAssets: ProjectMediaAsset[];
    trackSettings: TimelineTrackSettings;
  }) =>
    JSON.stringify({
      subtitles: state.subtitles,
      markers: state.markers,
      videoClips: state.videoClips,
      audioClips: state.audioClips,
      adjustmentLayers: state.adjustmentLayers,
      mediaAssets: state.mediaAssets,
      trackSettings: state.trackSettings,
    });

  const enqueueProjectSave = (state: {
    activeProjectId: string;
    videoPath: string;
    subtitles: typeof subtitles;
    markers: TimelineMarker[];
    projectMetadata: ProjectMetadata | null;
    videoClips: VideoTimelineClip[];
    audioClips: AudioTimelineClip[];
    adjustmentLayers: AdjustmentLayerClip[];
    mediaAssets: ProjectMediaAsset[];
    trackSettings: TimelineTrackSettings;
  }) => {
    const fingerprint = createSaveFingerprint(state);

    const task = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await saveProjectFile(
          state.activeProjectId,
          state.videoPath,
          state.subtitles,
          state.markers,
          state.projectMetadata ?? undefined,
          state.videoClips,
          state.audioClips,
          state.adjustmentLayers,
          state.mediaAssets,
          state.trackSettings,
        );

        const latest = latestSaveStateRef.current;
        if (
          latest.activeProjectId === state.activeProjectId &&
          latest.videoPath === state.videoPath
        ) {
          // A queued save may finish after the user has already switched to a
          // different project. Never let that old save replace the current
          // project's dirty-state baseline.
          lastSavedSnapshotRef.current = fingerprint;
          const latestFingerprint = createSaveFingerprint(latest);
          setHasUnsavedChanges(latestFingerprint !== fingerprint);
        }
      });

    saveQueueRef.current = task.then(
      () => undefined,
      () => undefined,
    );

    return task;
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

    const currentSnapshot = JSON.stringify({
      subtitles,
      markers,
      videoClips,
      audioClips,
      adjustmentLayers,
      mediaAssets,
      trackSettings,
    });

    setHasUnsavedChanges(currentSnapshot !== lastSavedSnapshotRef.current);
  }, [
    subtitles,
    markers,
    videoClips,
    audioClips,
    adjustmentLayers,
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

        await enqueueProjectSave({
          activeProjectId,
          videoPath,
          subtitles,
          markers,
          projectMetadata,
          videoClips,
          audioClips,
          adjustmentLayers,
          mediaAssets,
          trackSettings,
        });

        setAutosaveError(null);
      } catch (error) {
        console.error("Autosave failed:", error);
        setAutosaveError(error instanceof Error ? error.message : String(error));
        window.setTimeout(() => setSaveRetryTick((tick) => tick + 1), 5000);
      } finally {
        setIsSavingProject(false);
      }
    }, autosaveError ? 0 : AUTOSAVE_DEBOUNCE_MS);

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
    audioClips,
    adjustmentLayers,
    mediaAssets,
    trackSettings,
    hasUnsavedChanges,
    saveRetryTick,
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
                label: `Clip ${index + 1} — ${clip.sourceName} · ${`V${clip.trackId.split("-")[1] ?? "1"}`} ${formatClipMenuTime(clip.timelineStart)}`,
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
    const generatedSegments = await generateSubtitles(clip.sourcePath, {
      ...transcriptionOptionsForPreset(preset),
      commitResult: false,
    });

    if (!generatedSegments) {
      return;
    }

    const mappedSegments = generatedSegments.flatMap((segment) => {
      const sourceStart = Math.max(segment.startTime, clip.sourceIn);
      const sourceEnd = Math.min(segment.endTime, clip.sourceOut);

      if (sourceEnd <= sourceStart) {
        return [];
      }

      return [
        {
          startTime: Math.min(
            sourceTimeToTimelineTime(clip, sourceStart),
            sourceTimeToTimelineTime(clip, sourceEnd),
          ),
          endTime: Math.max(
            sourceTimeToTimelineTime(clip, sourceStart),
            sourceTimeToTimelineTime(clip, sourceEnd),
          ),
          text: segment.text,
          linkedVideoClipId: clip.id,
          linkedVideoSourcePath: clip.sourcePath,
        },
      ];
    });

    if (mappedSegments.length === 0) {
      return;
    }

    markNextChangeImmediate();
    const targetTrackId = reserveSubtitleTrackForTranscription();
    const mappedSubtitles = mappedSegments.map((segment) => ({
      ...segment,
      id: crypto.randomUUID(),
      trackId: targetTrackId,
    }));
    replaceSubtitles([...subtitles, ...mappedSubtitles]);
  };

  const restoreMissingSubtitlesForVideoClip = async (
    clip: VideoTimelineClip,
  ) => {
    if (isGenerating || clip.freezeFrameSourceTime !== undefined) return;

    const language =
      projectMetadata?.languages.length === 1
        ? projectMetadata.languages[0]
        : "mixed";
    const generatedSegments = await generateSubtitles(clip.sourcePath, {
      ...transcriptionOptionsForLanguage(language),
      commitResult: false,
    });

    if (!generatedSegments) return;

    const latest = latestSaveStateRef.current;
    const currentClip = latest.videoClips.find((item) => item.id === clip.id);
    if (!currentClip || currentClip.freezeFrameSourceTime !== undefined) return;

    const mappedSegments = generatedSegments.flatMap((segment) => {
      const sourceStart = Math.max(segment.startTime, currentClip.sourceIn);
      const sourceEnd = Math.min(segment.endTime, currentClip.sourceOut);
      if (sourceEnd <= sourceStart) return [];

      const mappedStart = sourceTimeToTimelineTime(currentClip, sourceStart);
      const mappedEnd = sourceTimeToTimelineTime(currentClip, sourceEnd);
      return [
        {
          startTime: Math.min(mappedStart, mappedEnd),
          endTime: Math.max(mappedStart, mappedEnd),
          text: segment.text,
          linkedVideoClipId: currentClip.id,
          linkedVideoSourcePath: currentClip.sourcePath,
        },
      ];
    });

    if (mappedSegments.length === 0) return;

    const currentSubtitles = latest.subtitles;
    const targetTrackId = preferredLinkedSubtitleTrack(
      currentSubtitles,
      currentClip.id,
    ) as TimelineTrackId;
    const merged = mergeRegeneratedLinkedSubtitles(
      currentSubtitles,
      currentClip,
      mappedSegments,
      targetTrackId,
    );

    if (JSON.stringify(merged) === JSON.stringify(currentSubtitles)) return;

    markNextChangeImmediate();
    replaceSubtitles(merged);
    setActiveSubtitleTrackId(targetTrackId);
  };

  // ==========================================================================
  // Seek
  // ==========================================================================

  const requestSeek = (time: number) => {
    const nextTime = Math.max(0, Number.isFinite(time) ? time : 0);

    // The playback clock is canonical timeline time. Update it immediately
    // so list/timeline selection and the Program Monitor subtitle reflect the
    // requested subtitle in the same render, before the media elements finish
    // processing the seek.
    setCurrentTime(nextTime);

    setSeekRequest({
      time: nextTime,
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
    const loadGeneration = projectLoadGenerationRef.current + 1;
    projectLoadGenerationRef.current = loadGeneration;
    isLoadingVideoRef.current = true;

    // Cancel any gesture-owned topology state from the editor we just left and
    // establish a neutral hydration baseline. App stays mounted on the Home
    // screen, so these refs otherwise survive a Home -> project round-trip and
    // can make the load look like a real ripple/trim/move edit.
    suppressNextVideoTopologySubtitleSyncRef.current = false;
    videoResizeSubtitleOriginRef.current = null;
    lastVideoResizeSubtitleSyncKeyRef.current = null;
    videoMoveSubtitleOriginRef.current = null;
    videoMoveSubtitleSyncActiveRef.current = false;
    compoundMoveOriginRef.current = null;
    compoundResizeOriginRef.current = null;
    previousVideoSubtitleTopologyRef.current = {
      key: videoSubtitleTopologyKey([]),
      videoClips: [],
      subtitles: [],
    };

    for (const [generation, resolve] of projectLoadWaitersRef.current) {
      if (generation === loadGeneration) continue;
      projectLoadWaitersRef.current.delete(generation);
      resolve();
    }

    const projectReadyPromise = new Promise<void>((resolve) => {
      projectLoadWaitersRef.current.set(loadGeneration, resolve);
    });

    setProjectLoadBarrier({
      generation: loadGeneration,
      dataHydrated: false,
      filmstripReady: false,
      startedAt: performance.now(),
    });

    const projectId = requestedProjectId ?? crypto.randomUUID();

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
    setMissingMediaIssues([]);
    setMissingMediaDialogOpen(false);
    setRelinkingMissingMediaPath(null);
    setTimelineRange(null);

    replaceSubtitles([]);
    replaceVideoClips([]);
    replaceAudioClips([]);
    setAdjustmentLayers([]);
    setSelectedAdjustmentLayerId(null);
    setAdjustmentPanelOpen(false);
    setMarkers([]);
    setSubtitleSearch("");
    setTimelineZoom(1);
    setTrackSettings({ ...DEFAULT_TIMELINE_TRACK_SETTINGS });
    setActiveSubtitleTrackId(DEFAULT_SUBTITLE_TRACK_ID);
    setProjectMetadata(fallbackMetadata);

    void generateWaveform(path);

    let resolvedMetadata = fallbackMetadata;
    let loadedHistorySnapshot = {
      subtitles: [] as typeof subtitles,
      markers: [] as TimelineMarker[],
      videoClips: [] as VideoTimelineClip[],
      audioClips: [] as AudioTimelineClip[],
      adjustmentLayers: [] as AdjustmentLayerClip[],
      mediaAssets: [] as ProjectMediaAsset[],
      trackSettings: {
        ...DEFAULT_TIMELINE_TRACK_SETTINGS,
      } as TimelineTrackSettings,
    };

    try {
      const loadResult = await loadMatchingProjectFile(projectId, path);
      if (projectLoadGenerationRef.current !== loadGeneration) return;

      if (loadResult.status === "error") {
        isLoadingVideoRef.current = false;
        setProjectLoadBarrier(null);
        resolveProjectLoadWaiter(loadGeneration);
        setActiveProjectId(null);
        setVideoPath(null);
        setVideoName(null);
        setHasUnsavedChanges(false);
        lastSavedSnapshotRef.current = "";
        setScreen("home");
        setHomeError(
          `This project could not be opened: ${loadResult.message}` +
            (loadResult.backupPath
              ? ` A copy of the file was saved to ${loadResult.backupPath}.`
              : ""),
        );
        return;
      }

      if (loadResult.status === "ok") {
        const matchingProject = loadResult.project;

        if (loadResult.recoveredFromBackup) {
          setHomeError(
            "The latest save was unreadable, so the previous version was restored.",
          );
        }
        const loadedSubtitles = matchingProject.subtitles;
        const loadedMarkers = matchingProject.markers;
        const loadedVideoClips = matchingProject.videoClips;
        const loadedAudioClips = matchingProject.audioClips;
        const loadedAdjustmentLayers = matchingProject.adjustmentLayers;
        const loadedMediaAssets = matchingProject.mediaAssets;

        resolvedMetadata = {
          title: matchingProject.title,
          languages:
            matchingProject.languages.length > 0
              ? matchingProject.languages
              : fallbackMetadata.languages,
        };

        // Seed the topology synchronizer BEFORE React commits the hydrated
        // project. This makes persisted state the baseline rather than treating
        // the old project (or the deliberate empty reset above) as an edit that
        // needs caption reconciliation.
        previousVideoSubtitleTopologyRef.current = {
          key: videoSubtitleTopologyKey(loadedVideoClips),
          videoClips: loadedVideoClips,
          subtitles: loadedSubtitles,
        };

        replaceSubtitles(loadedSubtitles);
        replaceVideoClips(loadedVideoClips, {
          markSourceInitializedFor: path,
        });
        replaceAudioClips(loadedAudioClips);
        setAdjustmentLayers(loadedAdjustmentLayers);
        setMarkers(loadedMarkers);
        setMediaAssets(loadedMediaAssets);
        setTrackSettings(matchingProject.trackSettings);
        setProjectMetadata(resolvedMetadata);

        try {
          const missingIssues = await findMissingProjectMedia({
            primaryVideoPath: path,
            videoClips: loadedVideoClips,
            audioClips: loadedAudioClips,
            mediaAssets: loadedMediaAssets,
          });
          if (projectLoadGenerationRef.current !== loadGeneration) return;
          setMissingMediaIssues(missingIssues);
          setMissingMediaDialogOpen(missingIssues.length > 0);
        } catch (availabilityError) {
          console.warn("Unable to inspect all project media paths:", availabilityError);
        }

        loadedHistorySnapshot = {
          subtitles: loadedSubtitles,
          markers: loadedMarkers,
          videoClips: loadedVideoClips,
          audioClips: loadedAudioClips,
          adjustmentLayers: loadedAdjustmentLayers,
          mediaAssets: loadedMediaAssets,
          trackSettings: matchingProject.trackSettings,
        };

        lastSavedSnapshotRef.current = JSON.stringify({
          subtitles: loadedSubtitles,
          markers: loadedMarkers,
          videoClips: loadedVideoClips,
          audioClips: loadedAudioClips,
          adjustmentLayers: loadedAdjustmentLayers,
          mediaAssets: loadedMediaAssets,
          trackSettings: matchingProject.trackSettings,
        });

        setHasUnsavedChanges(false);
      } else {
        const matchingSubtitles = await loadMatchingSrtFile(path);
        if (projectLoadGenerationRef.current !== loadGeneration) return;

        if (matchingSubtitles) {
          previousVideoSubtitleTopologyRef.current = {
            key: videoSubtitleTopologyKey([]),
            videoClips: [],
            subtitles: matchingSubtitles,
          };
          replaceSubtitles(matchingSubtitles);

          loadedHistorySnapshot = {
            subtitles: matchingSubtitles,
            markers: [],
            videoClips: [],
            audioClips: [],
            adjustmentLayers: [],
            mediaAssets: [],
            trackSettings: { ...DEFAULT_TIMELINE_TRACK_SETTINGS },
          };

          lastSavedSnapshotRef.current = JSON.stringify({
            subtitles: matchingSubtitles,
            markers: [],
            videoClips: [],
            audioClips: [],
            adjustmentLayers: [],
            mediaAssets: [],
            trackSettings: DEFAULT_TIMELINE_TRACK_SETTINGS,
          });
        } else {
          previousVideoSubtitleTopologyRef.current = {
            key: videoSubtitleTopologyKey([]),
            videoClips: [],
            subtitles: [],
          };
          lastSavedSnapshotRef.current = JSON.stringify({
            subtitles: [],
            markers: [],
            videoClips: [],
            audioClips: [],
            adjustmentLayers: [],
            mediaAssets: [],
            trackSettings: DEFAULT_TIMELINE_TRACK_SETTINGS,
          });
        }

        setHasUnsavedChanges(false);
      }
    } catch (error) {
      console.error("Failed to load project data:", error);
      if (projectLoadGenerationRef.current !== loadGeneration) return;
      isLoadingVideoRef.current = false;
      setProjectLoadBarrier(null);
      resolveProjectLoadWaiter(loadGeneration);
      setActiveProjectId(null);
      setVideoPath(null);
      setVideoName(null);
      setScreen("home");
      setHomeError(
        error instanceof Error
          ? error.message
          : "The project could not be loaded safely. The original project file was not overwritten.",
      );
      return;
    }

    if (projectLoadGenerationRef.current !== loadGeneration) return;
    resetHistory(loadedHistorySnapshot);

    setScreen("editor");
    setProjectLoadBarrier((current) =>
      current?.generation === loadGeneration
        ? { ...current, dataHydrated: true, filmstripReady: false }
        : current,
    );
    setHomeError("");

    try {
      await recordRecentProject(projectId, path, resolvedMetadata);
      if (projectLoadGenerationRef.current !== loadGeneration) return;
    } catch (error) {
      console.error("Failed to update recent projects:", error);
    }

    await projectReadyPromise;
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

  const chooseReplacementMediaPath = async (issue: MissingMediaIssue) => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        issue.kind === "audio"
          ? {
              name: "Audio",
              extensions: ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"],
            }
          : {
              name: "Video",
              extensions: ["mp4", "mov", "webm", "mkv"],
            },
      ],
    });

    if (!selected || Array.isArray(selected)) return null;
    return selected;
  };

  const handleRelinkMissingMedia = async (issue: MissingMediaIssue) => {
    if (relinkingMissingMediaPath) return;

    const replacementPath = await chooseReplacementMediaPath(issue);
    if (!replacementPath) return;

    setRelinkingMissingMediaPath(issue.path);

    try {
      const replacementName = getFileName(replacementPath);
      const replacementDuration = await probeMediaDuration(
        replacementPath,
        issue.kind,
      );

      if (issue.requiredDuration > 0 && replacementDuration <= 0) {
        window.alert(
          `Cut The Crab could not determine the duration of ${replacementName}. ` +
            "Choose a readable replacement before relinking so existing clip ranges stay valid.",
        );
        return;
      }

      if (
        issue.requiredDuration > 0 &&
        replacementDuration + 0.05 < issue.requiredDuration
      ) {
        window.alert(
          `${replacementName} is too short for the media ranges used by this project.\n\n` +
            `Replacement duration: ${replacementDuration.toFixed(2)} s\n` +
            `Required source range: ${issue.requiredDuration.toFixed(2)} s\n\n` +
            "Choose a replacement that covers the full source range. This prevents out-of-range playback and export after relinking.",
        );
        return;
      }

      const relinked = relinkProjectMediaPath({
        primaryVideoPath: videoPath ?? issue.path,
        videoClips,
        audioClips,
        mediaAssets,
        missingPath: issue.path,
        replacementPath,
        replacementName,
        replacementDuration,
      });

      replaceVideoClips(relinked.videoClips,
        issue.isPrimary
          ? { markSourceInitializedFor: replacementPath }
          : undefined,
      );
      replaceAudioClips(relinked.audioClips);
      setMediaAssets(relinked.mediaAssets);
      void generateWaveform(replacementPath);

      if (issue.isPrimary) {
        setVideoPath(replacementPath);
        setVideoName(replacementName);

        if (activeProjectId && projectMetadata) {
          await removeRecentProject(activeProjectId);
          await recordRecentProject(
            activeProjectId,
            replacementPath,
            projectMetadata,
            replacementDuration || videoDuration,
          );
        }
      }

      const remainingIssues = missingMediaIssues.filter(
        (item) => item.path !== issue.path,
      );
      setMissingMediaIssues(remainingIssues);
      if (remainingIssues.length === 0) {
        setMissingMediaDialogOpen(false);
      }
    } catch (error) {
      console.error("Failed to relink missing media:", error);
      window.alert(
        error instanceof Error
          ? `Unable to relink media: ${error.message}`
          : "Unable to relink the selected media file.",
      );
    } finally {
      setRelinkingMissingMediaPath(null);
    }
  };

  const handleDeleteProjectMedia = async (
    path: string,
    name: string,
  ): Promise<boolean> => {
    const isPrimary = path === videoPath;
    const fallbackPrimary = isPrimary
      ? mediaAssets.find(
          (asset) =>
            asset.kind === "video" &&
            asset.path !== path &&
            !missingMediaIssues.some((issue) => issue.path === asset.path),
        ) ?? null
      : null;

    if (isPrimary && !fallbackPrimary) {
      window.alert(
        "The primary project video cannot be removed until another available video is imported. Import another video first, or relink this source.",
      );
      return false;
    }

    const videoReferenceCount = videoClips.filter(
      (clip) => clip.sourcePath === path,
    ).length;
    const audioReferenceCount = audioClips.filter(
      (clip) => clip.sourcePath === path,
    ).length;
    const timelineReferenceCount = videoReferenceCount + audioReferenceCount;

    const confirmed = window.confirm(
      `Delete “${name}” from this project?` +
        (timelineReferenceCount > 0
          ? `\n\nThis will also remove ${timelineReferenceCount} timeline clip${timelineReferenceCount === 1 ? "" : "s"} that use this media.`
          : "") +
        "\n\nThe original file on your Mac will not be deleted.",
    );

    if (!confirmed) return false;

    const next = removeProjectMediaPath({
      primaryVideoPath: videoPath ?? path,
      videoClips,
      audioClips,
      mediaAssets,
      subtitles,
      removedPath: path,
    });

    markNextChangeImmediate();
    replaceVideoClips(
      next.videoClips,
      isPrimary && fallbackPrimary
        ? { markSourceInitializedFor: fallbackPrimary.path }
        : undefined,
    );
    replaceAudioClips(next.audioClips);
    replaceSubtitles(next.subtitles);
    setMediaAssets(next.mediaAssets);

    const remainingIssues = missingMediaIssues.filter(
      (issue) => issue.path !== path,
    );
    setMissingMediaIssues(remainingIssues);
    if (remainingIssues.length === 0) {
      setMissingMediaDialogOpen(false);
    }

    if (isPrimary && fallbackPrimary) {
      setVideoPath(fallbackPrimary.path);
      setVideoName(fallbackPrimary.name);
      setVideoDuration(fallbackPrimary.duration);
      void generateWaveform(fallbackPrimary.path);

      if (activeProjectId && projectMetadata) {
        await recordRecentProject(
          activeProjectId,
          fallbackPrimary.path,
          projectMetadata,
          fallbackPrimary.duration,
        );
      }
    }

    return true;
  };

  const handleDeleteMediaAsset = async (asset: ProjectMediaAsset) => {
    try {
      await handleDeleteProjectMedia(asset.path, asset.name);
    } catch (error) {
      console.error("Failed to delete project media:", error);
      window.alert("Unable to delete that media from the project.");
    }
  };

  const handleDeleteMissingMedia = async (issue: MissingMediaIssue) => {
    if (relinkingMissingMediaPath || deletingMissingMediaPath) return;

    setDeletingMissingMediaPath(issue.path);
    try {
      await handleDeleteProjectMedia(issue.path, issue.name);
    } finally {
      setDeletingMissingMediaPath(null);
    }
  };

  const handleImportMedia = async () => {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: "Media",
          extensions: [
            "mp4",
            "mov",
            "webm",
            "mkv",
            "mp3",
            "wav",
            "m4a",
            "aac",
            "flac",
            "ogg",
            "opus",
          ],
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

      const kind = mediaKindFromPath(path);
      const duration = await probeMediaDuration(path, kind);

      additions.push({
        id: crypto.randomUUID(),
        kind,
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

  const firstEditableStandaloneAudioTrack = () =>
    Object.keys(trackSettings)
      .filter(
        (id) =>
          timelineTrackKindFromId(id) === "audio" &&
          trackSettings[id]?.deleted !== true &&
          !trackSettings[id]?.locked &&
          !trackSettings[id]?.linkedTrackId,
      )
      .sort(
        (a, b) => timelineTrackIndexFromId(a) - timelineTrackIndexFromId(b),
      )[0] ?? null;

  const ensureStandaloneAudioTrack = () => {
    const existing = firstEditableStandaloneAudioTrack();
    if (existing) return existing;

    const id = nextTimelineTrackId(
      "audio",
      trackSettings,
      videoClips,
      audioClips,
    );
    setTrackSettings((current) => ({
      ...current,
      [id]: { ...defaultTrackControlState("audio"), deleted: false },
    }));
    return id;
  };

  const insertMediaAssetOnTimeline = (
    asset: ProjectMediaAsset,
    timelineTime: number,
    trackId: TimelineTrackId,
  ) => {
    if (asset.duration <= 0) return;

    const trackKind = timelineTrackKindFromId(trackId);

    if (trackKind === "video") {
      if (asset.kind !== "video" || trackSettings[trackId]?.locked) return;
      beginHistoryTransaction();
      clearSubtitleSelection();
      clearAudioClipSelection();
      insertVideoClipFromMedia(asset, timelineTime, trackId);
      window.requestAnimationFrame(() => endHistoryTransaction());
      return;
    }

    if (trackKind === "audio") {
      // A linked audio row mirrors its owning video track and does not accept
      // independent media. Standalone audio rows accept audio files and the
      // audio stream of imported video files.
      if (
        trackSettings[trackId]?.linkedTrackId ||
        trackSettings[trackId]?.locked
      )
        return;
      markNextChangeImmediate();
      clearSubtitleSelection();
      clearVideoClipSelection();
      insertAudioClipFromMedia(asset, timelineTime, trackId);
    }
  };

  const handleInsertMediaAtPlayhead = (asset: ProjectMediaAsset) => {
    if (asset.kind === "audio") {
      const target =
        (selectedAudioClip &&
        !trackSettings[selectedAudioClip.trackId]?.linkedTrackId
          ? selectedAudioClip.trackId
          : null) ??
        firstEditableStandaloneAudioTrack() ??
        ensureStandaloneAudioTrack();
      insertMediaAssetOnTimeline(asset, currentTimeRef.current, target);
      return;
    }

    insertMediaAssetOnTimeline(
      asset,
      currentTimeRef.current,
      selectedVideoClip?.trackId ?? "video-1",
    );
  };

  const handleMediaDropOnTimeline = (
    assetId: string,
    trackId: TimelineTrackId,
    timelineTime: number,
  ) => {
    const asset = mediaAssets.find((item) => item.id === assetId);
    if (!asset) return;
    insertMediaAssetOnTimeline(asset, timelineTime, trackId);
  };

  const handleChooseVideo = async () => {
    const selected = await chooseVideoPath();

    if (!selected) {
      return;
    }

    await handleVideoPathChange(selected);
  };

  const handleChooseNewProjectVideo = async (requestedTitle: string) => {
    const title = normalizeProjectTitle(requestedTitle);

    if (!title) {
      setHomeError("Enter a project name before choosing a video.");
      return false;
    }

    if (projectTitleExists(recentProjects, title)) {
      setHomeError(`A project named “${title}” already exists. Choose a unique project name.`);
      return false;
    }

    const selected = await chooseVideoPath();

    if (!selected) {
      return false;
    }

    setHomeError("");
    setPendingNewProjectTitle(title);
    setPendingNewProjectPath(selected);
    return true;
  };

  const cancelNewProject = () => {
    setPendingNewProjectPath(null);
    setPendingNewProjectTitle(null);
    setHomeError("");
  };

  const handleCreateProject = async (language: ProjectLanguage) => {
    if (!pendingNewProjectPath || !pendingNewProjectTitle) {
      return;
    }

    const path = pendingNewProjectPath;
    const title = normalizeProjectTitle(pendingNewProjectTitle);

    if (!title) {
      setHomeError("Enter a project name before creating the project.");
      return;
    }

    if (projectTitleExists(recentProjects, title)) {
      setHomeError(`A project named “${title}” already exists. Choose a unique project name.`);
      setPendingNewProjectPath(null);
      setPendingNewProjectTitle(null);
      setNewProjectRequestId((value) => value + 1);
      return;
    }

    // Guard against a double-click starting two UUID-backed projects before
    // the first save/registry refresh has completed.
    if (creatingProjectRef.current) return;
    creatingProjectRef.current = true;

    // Project identity is intentionally independent from the selected media.
    // Two projects may use the same source video, but every project receives a
    // fresh UUID and therefore its own save/autosave/subtitle/timeline state.
    const projectId = crypto.randomUUID();

    const metadata: ProjectMetadata = {
      title,
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
        [],
        [],
        DEFAULT_TIMELINE_TRACK_SETTINGS,
      );

      setPendingNewProjectPath(null);
      setPendingNewProjectTitle(null);

      await handleVideoPathChange(path, metadata, projectId);

      void generateSubtitles(path, transcriptionOptionsForLanguage(language));
    } catch (error) {
      console.error("Failed to create project:", error);
      setHomeError(
        error instanceof Error ? error.message : "Failed to create project.",
      );
    } finally {
      creatingProjectRef.current = false;
    }
  };

  const handleRenameRecentProject = async (
    project: RecentProject,
    nextTitle: string,
  ) => {
    const title = normalizeProjectTitle(nextTitle);

    if (!title || title === project.title) {
      return;
    }

    if (title.length > MAX_PROJECT_TITLE_LENGTH) {
      setHomeError(`Project names can be up to ${MAX_PROJECT_TITLE_LENGTH} characters.`);
      return;
    }

    if (projectTitleExists(recentProjects, title, project.projectId)) {
      setHomeError(`A project named “${title}” already exists. Project names must be unique.`);
      return;
    }

    try {
      setHomeError("");

      const matchingProject = projectFromLoadResult(
        await loadMatchingProjectFile(project.projectId, project.videoPath),
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
          matchingProject.audioClips,
          matchingProject.adjustmentLayers,
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

      const oldProject = projectFromLoadResult(
        await loadMatchingProjectFile(project.projectId, project.videoPath),
      );
      let replacementDurationForRecent = project.duration;

      if (oldProject) {
        const replacementName = getFileName(replacementPath);
        const replacementDuration = await probeMediaDuration(
          replacementPath,
          "video",
        );
        if (replacementDuration > 0) {
          replacementDurationForRecent = replacementDuration;
        }
        const primaryReference = collectProjectMediaReferences({
          primaryVideoPath: project.videoPath,
          videoClips: oldProject.videoClips,
          audioClips: oldProject.audioClips,
          mediaAssets: oldProject.mediaAssets,
        }).find((item) => item.path === project.videoPath);

        if (
          primaryReference &&
          primaryReference.requiredDuration > 0 &&
          replacementDuration <= 0
        ) {
          window.alert(
            `Cut The Crab could not determine the duration of ${replacementName}. ` +
              "Choose a readable replacement before relinking so existing clip ranges stay valid.",
          );
          return;
        }

        if (
          primaryReference &&
          primaryReference.requiredDuration > 0 &&
          replacementDuration + 0.05 < primaryReference.requiredDuration
        ) {
          window.alert(
            `${replacementName} is too short for the source range used by this project.\n\n` +
              `Replacement duration: ${replacementDuration.toFixed(2)} s\n` +
              `Required source range: ${primaryReference.requiredDuration.toFixed(2)} s\n\n` +
              "Choose a replacement that covers the full source range. This prevents out-of-range playback and export after relinking.",
          );
          return;
        }

        const relinked = relinkProjectMediaPath({
          primaryVideoPath: project.videoPath,
          videoClips: oldProject.videoClips,
          audioClips: oldProject.audioClips,
          mediaAssets: oldProject.mediaAssets,
          missingPath: project.videoPath,
          replacementPath,
          replacementName,
          replacementDuration,
        });

        await saveProjectFile(
          project.projectId,
          relinked.primaryVideoPath,
          oldProject.subtitles,
          oldProject.markers,
          {
            title: oldProject.title || project.title,
            languages:
              oldProject.languages.length > 0
                ? oldProject.languages
                : project.languages,
          },
          relinked.videoClips,
          relinked.audioClips,
          oldProject.adjustmentLayers,
          relinked.mediaAssets,
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
        duration: replacementDurationForRecent,
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
    // A browser double-click dispatches two click events. Ignore a duplicate
    // open of the same project while its first load is still in flight.
    if (openingRecentProjectIdRef.current === project.projectId) return;
    openingRecentProjectIdRef.current = project.projectId;

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
    } finally {
      if (openingRecentProjectIdRef.current === project.projectId) {
        openingRecentProjectIdRef.current = null;
      }
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

    if (duration > 0 && videoClips.length === 0) {
      // loadedmetadata fires before React has committed videoDuration to the
      // hook closure, so pass the known metadata duration directly.
      initializeDefaultVideoClip(duration);
    }

    if (!activeProjectId || !videoPath || !projectMetadata || duration <= 0) {
      return;
    }

    void recordRecentProject(
      activeProjectId,
      videoPath,
      projectMetadata,
      duration,
    ).catch((error) => {
      console.error("Failed to update recent-project duration:", error);
    });
  };

  // ==========================================================================
  // Project saving
  // ==========================================================================

  const handleSaveProject = async (): Promise<boolean> => {
    if (!activeProjectId || !videoPath) {
      return true;
    }

    try {
      setIsSavingProject(true);

      await enqueueProjectSave({
        activeProjectId,
        videoPath,
        subtitles,
        markers,
        projectMetadata,
        videoClips,
        audioClips,
        adjustmentLayers,
        mediaAssets,
        trackSettings,
      });

      if (projectMetadata) {
        await recordRecentProject(
          activeProjectId,
          videoPath,
          projectMetadata,
          videoDuration,
        );
      }

      setAutosaveError(null);
      return true;
    } catch (error) {
      console.error("Failed to save project:", error);
      setAutosaveError(error instanceof Error ? error.message : String(error));
      return false;
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
    if (!timelineSelectableSubtitleIdSet.has(id)) {
      return;
    }
    clearVideoClipSelection();
    clearAudioClipSelection();
    clearAdjustmentLayerSelection();
    const subtitle = subtitles.find((item) => item.id === id);
    if (subtitle) {
      setActiveSubtitleTrackId(getSubtitleTrackId(subtitle));
    }
    selectSubtitle(id, mode, timelineSelectableSubtitleIdSet);

    // The subtitle browser is also a visual navigator: whichever subtitle the
    // user chooses as the new primary selection should appear in the Program
    // Monitor immediately, including range/toggle selection.
    requestSeek(startTime);
  };

  // ==========================================================================
  // SRT import/export
  // ==========================================================================

  const handleImportSrt = async () => {
    const importedSubtitles = await importSrtFile();

    if (importedSubtitles) {
      replaceSubtitleTrackWithHistory(activeSubtitleTrackId, importedSubtitles);
    }
  };

  const handleExportSrt = async () => {
    await exportSrtFile(
      subtitles.filter(
        (subtitle) => getSubtitleTrackId(subtitle) === activeSubtitleTrackId,
      ),
      videoPath,
    );
  };

  // ==========================================================================
  // Exporting
  // ==========================================================================

  const performExportStyledVideo = async (
    range: TimelineRange | null,
    frameSize: ExportFrameSize,
  ) => {
    if (!videoPath || exportStateRef.current !== "idle") return;
    const isRangeExport = range !== null;
    setExportLifecycle("preparing");
    setExportError(null);
    setExportCancelError(null);
    setExportProgress(0);
    setExportStatus("Choose where to save the export...");
    activeExportJobIdRef.current = null;
    exportCancelRequestedRef.current = false;

    try {
      const outputPath = await exportStyledVideo(videoPath, subtitles, {
        timelineDuration,
        videoClips,
        audioClips,
        adjustmentLayers,
        trackSettings,
        range,
        frameSize,
        programPreviewSize:
          videoPlayerRef.current?.getProgramPreviewSize() ?? undefined,
        isCancelled: () => exportCancelRequestedRef.current,
        onJobCreated: (jobId) => {
          activeExportJobIdRef.current = jobId;
        },
        onStart: () => {
          setExportProgress(0);
          setExportStatus(
            isRangeExport
              ? `Preparing selected range export · ${frameSize.width}×${frameSize.height}...`
              : `Preparing edited timeline export · ${frameSize.width}×${frameSize.height}...`,
          );
          if (!exportCancelRequestedRef.current) setExportLifecycle("encoding");
        },
        onProgress: ({ progress, status }) => {
          setExportProgress(progress);
          if (!exportCancelRequestedRef.current) {
            setExportStatus(status);
          } else {
            // Retry an early cancel after native registration is observable.
            const jobId = activeExportJobIdRef.current;
            if (jobId) void cancelVideoExport(jobId).catch(() => undefined);
          }
        },
      });
      if (outputPath && !exportCancelRequestedRef.current) {
        setExportProgress(100);
        setExportStatus("Export complete.");
      }
    } catch (error) {
      if (exportCancelRequestedRef.current) {
        setExportStatus("Export cancelled.");
      } else {
        console.error(
          isRangeExport
            ? "Selected timeline range export failed:"
            : "Edited timeline export failed:",
          error,
        );
        const message = error instanceof Error ? error.message :
          typeof error === "string" ? error : "The export could not be completed.";
        setExportError(message || "The export could not be completed.");
      }
    } finally {
      setExportLifecycle("idle");
        activeExportJobIdRef.current = null;
      exportCancelRequestedRef.current = false;
    }
  };

  const handleCancelExport = async () => {
    const previous = exportStateRef.current;
    if (previous !== "preparing" && previous !== "encoding") return;
    exportCancelRequestedRef.current = true;
    setExportLifecycle("cancelling");
    setExportCancelError(null);
    setExportStatus("Stopping export…");
    const jobId = activeExportJobIdRef.current;
    if (!jobId) return;
    try {
      await cancelVideoExport(jobId);
    } catch (error) {
      exportCancelRequestedRef.current = false;
      setExportLifecycle(previous);
      setExportStatus("Export is still running…");
      const rawMessage = error instanceof Error ? error.message :
        typeof error === "string" ? error : "Unable to cancel the export.";
      const missingNativeCommand = rawMessage.includes("cancel_video_export") ||
        rawMessage.toLowerCase().includes("command not found");
      setExportCancelError(missingNativeCommand
        ? "This build does not include the native export-cancellation command yet. The export is still running."
        : `Could not cancel the export: ${rawMessage}`);
    }
  };

  const openExportSettings = (range: TimelineRange | null = null) => {
    if (!videoPath || isExporting) {
      return;
    }

    setExportError(null);
    setExportCancelError(null);
    setExportSettingsRequest({
      range: range
        ? {
            start: range.start,
            end: range.end,
          }
        : null,
    });
  };

  const handleExportSelectedRange = () => {
    if (!timelineRange) {
      return;
    }

    openExportSettings(timelineRange);
  };

  const executeEditorEditCommand = async (
    command: EditorEditCommand,
    target: EventTarget | Element | null = document.activeElement,
  ) => {
    const editableElement = getEditableElement(target);

    if (editableElement && command !== "duplicate") {
      return runFocusedTextEditCommand(command, editableElement);
    }

    if (screen !== "editor") {
      return false;
    }

    switch (command) {
      case "undo":
        undo();
        return true;

      case "redo":
        redo();
        return true;

      case "cut":
        return selectedAudioClipIds.length > 0
          ? cutSelectedAudioClipsWithHistory()
          : cutSelectedVideoClipWithHistory();

      case "copy":
        return selectedAudioClipIds.length > 0
          ? copySelectedAudioClips()
          : copySelectedVideoClip();

      case "paste":
        if (activeClipboardKindRef.current === "compound") {
          return pasteCompoundAtTarget();
        }
        return activeClipboardKindRef.current === "audio"
          ? pasteAudioClipsAtTarget()
          : pasteVideoClipAtTarget();

      case "duplicate":
        return selectedAudioClipIds.length > 0
          ? duplicateSelectedAudioClipsWithHistory()
          : duplicateSelectedVideoClipWithHistory();

      case "select-all":
        if (selectedAudioClipIds.length > 0) {
          selectAudioClips(
            timelineSelectableAudioClipIds,
            timelineSelectableAudioClipIds.includes(selectedAudioClipId ?? "")
              ? selectedAudioClipId
              : (timelineSelectableAudioClipIds[0] ?? null),
          );
          clearVideoClipSelection();
          clearSubtitleSelection();
        } else if (selectedVideoClipIds.length > 0) {
          selectVideoClips(
            timelineSelectableVideoClipIds,
            timelineSelectableVideoClipIds.includes(selectedVideoClipId ?? "")
              ? selectedVideoClipId
              : (timelineSelectableVideoClipIds[0] ?? null),
          );
          clearAudioClipSelection();
          clearSubtitleSelection();
        } else {
          selectAllSubtitles(
            activeSubtitleTrackId,
            timelineSelectableSubtitleIdSet,
          );
        }
        return true;
    }
  };

  // ==========================================================================
  // Application command dispatch
  // ==========================================================================

  const handleAppMenuCommand = async (command: AppMenuCommand) => {
    if (projectLoadBarrierActive || exportStateRef.current !== "idle") return;

    const clipTranscription = parseClipTranscriptionCommand(command);

    if (clipTranscription) {
      if (screen !== "editor") {
        return;
      }

      const clip = videoClips.find(
        (item) => item.id === clipTranscription.clipId,
      );

      if (clip) {
        await generateSubtitlesForVideoClip(clip, clipTranscription.preset);
      }

      return;
    }

    switch (command) {
      case "file.new-project":
        if (screen === "editor" && hasUnsavedChanges) {
          const saved = await handleSaveProject();
          if (
            !saved &&
            !window.confirm(
              "The project could not be saved. Leave anyway and lose unsaved changes?",
            )
          ) {
            return;
          }
        }

        setPendingNewProjectPath(null);
        setPendingNewProjectTitle(null);
        setHomeError("");
        setNewProjectRequestId((value) => value + 1);
        setScreen("home");
        return;

      case "file.show-home":
        if (screen === "editor" && hasUnsavedChanges) {
          const saved = await handleSaveProject();
          if (
            !saved &&
            !window.confirm(
              "The project could not be saved. Leave anyway and lose unsaved changes?",
            )
          ) {
            return;
          }
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
        openExportSettings();
        return;

      case "file.export-range":
        handleExportSelectedRange();
        return;

      case "edit.undo":
        await executeEditorEditCommand("undo");
        return;

      case "edit.redo":
        await executeEditorEditCommand("redo");
        return;

      case "edit.cut":
        await executeEditorEditCommand("cut");
        return;

      case "edit.copy":
        await executeEditorEditCommand("copy");
        return;

      case "edit.paste":
        await executeEditorEditCommand("paste");
        return;

      case "edit.duplicate":
        await executeEditorEditCommand("duplicate");
        return;

      case "edit.select-all":
        await executeEditorEditCommand("select-all");
        return;

      case "edit.delete-range":
        if (screen === "editor") {
          if (rippleMode) {
            extractTimelineRangeWithHistory();
          } else {
            deleteTimelineRangeWithHistory();
          }
        }
        return;

      case "edit.lift-range":
        if (screen === "editor") {
          liftTimelineRangeWithHistory();
        }
        return;

      case "edit.extract-range":
        if (screen === "editor") {
          extractTimelineRangeWithHistory();
        }
        return;

      case "edit.split-subtitle":
        if (screen === "editor") {
          if (
            !splitSelectedAudioClipAtPlayhead() &&
            !splitSelectedVideoClipAtPlayhead()
          ) {
            splitSelectedSubtitleAtPlayhead();
          }
        }
        return;

      case "edit.select-all-subtitles":
        if (screen === "editor") {
          selectAllSubtitles(
            activeSubtitleTrackId,
            timelineSelectableSubtitleIdSet,
          );
        }
        return;

      case "edit.deselect-all-subtitles":
        if (screen === "editor") {
          clearSubtitleSelection();
        }
        return;

      case "edit.add-subtitle":
        if (screen === "editor") {
          addSubtitleWithHistory(currentTimeRef.current);
        }
        return;

      case "edit.delete-subtitle":
        if (screen === "editor") {
          if (
            !deleteSelectedAdjustmentLayerWithHistory() &&
            !deleteSelectedAudioClipsWithHistory() &&
            !deleteSelectedVideoClipWithHistory()
          ) {
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

  const trimPrimarySubtitleToPlayhead = (edge: "start" | "end") => {
    if (!selectedSubtitleId) {
      return;
    }

    const subtitle = subtitles.find((item) => item.id === selectedSubtitleId);

    if (!subtitle || trackSettings[getSubtitleTrackId(subtitle)]?.locked) {
      return;
    }

    const MIN_SUBTITLE_DURATION = 0.1;

    if (
      currentTimeRef.current <= subtitle.startTime ||
      currentTimeRef.current >= subtitle.endTime
    ) {
      return;
    }

    if (
      edge === "start" &&
      currentTimeRef.current > subtitle.endTime - MIN_SUBTITLE_DURATION
    ) {
      return;
    }

    if (
      edge === "end" &&
      currentTimeRef.current < subtitle.startTime + MIN_SUBTITLE_DURATION
    ) {
      return;
    }

    markNextChangeImmediate();

    if (edge === "start") {
      resizeSubtitle(subtitle.id, currentTimeRef.current, subtitle.endTime);
      return;
    }

    resizeSubtitle(subtitle.id, subtitle.startTime, currentTimeRef.current);
  };

  useEffect(() => {
    if (!projectLoadBarrierActive) return;

    const blockKeyboardInput = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    window.addEventListener("keydown", blockKeyboardInput, true);
    window.addEventListener("keyup", blockKeyboardInput, true);

    return () => {
      window.removeEventListener("keydown", blockKeyboardInput, true);
      window.removeEventListener("keyup", blockKeyboardInput, true);
    };
  }, [projectLoadBarrierActive]);

  useEffect(() => {
    const handleEditorShortcutKeyDown = (event: KeyboardEvent) => {
      if (
        screen !== "editor" ||
        isGenerating ||
        isExporting ||
        projectLoadBarrierActive
      ) {
        return;
      }

      const isEditingText = getEditableElement(event.target) !== null;

      if (!isEditingText && event.key === "Escape") {
        if (timelineRange) {
          event.preventDefault();
          setTimelineRange(null);
          return;
        }

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

        trimPrimarySubtitleToPlayhead(event.key === "[" ? "start" : "end");

        return;
      }

      if (
        !isEditingText &&
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        if (!selectedSubtitlesAreEditable) {
          return;
        }

        event.preventDefault();

        const step = event.shiftKey ? 1 : 0.1;
        const direction = event.key === "ArrowLeft" ? -1 : 1;

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
          .filter((subtitle) => selectedSubtitleIds.includes(subtitle.id))
          .sort((a, b) => a.startTime - b.startTime);

        if (orderedSelected.length === 0) {
          return;
        }

        event.preventDefault();

        const currentIndex = orderedSelected.findIndex(
          (subtitle) => subtitle.id === selectedSubtitleId,
        );

        const delta = event.key === "[" ? -1 : 1;
        const fallbackIndex = delta > 0 ? -1 : orderedSelected.length;

        const nextIndex =
          ((currentIndex >= 0 ? currentIndex : fallbackIndex) +
            delta +
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
        (event.key === "Delete" || event.key === "Backspace")
      ) {
        if (timelineRange) {
          event.preventDefault();
          if (rippleMode) {
            extractTimelineRangeWithHistory();
          } else {
            deleteTimelineRangeWithHistory();
          }
          return;
        }

        if (selectedAdjustmentLayerId) {
          event.preventDefault();
          deleteSelectedAdjustmentLayerWithHistory();
          return;
        }

        if (selectedAudioClipIds.length > 0) {
          event.preventDefault();
          deleteSelectedAudioClipsWithHistory();
          return;
        }

        if (selectedVideoClipIds.length > 0) {
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

      if (
        !isEditingText &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "r"
      ) {
        event.preventDefault();
        setRippleMode((current) => !current);
        return;
      }

      const commandModifier = event.metaKey || event.ctrlKey;

      if (!commandModifier || event.altKey) {
        return;
      }

      const key = event.key.toLowerCase();

      if (key === "x" && !event.shiftKey) {
        if (isEditingText) {
          return;
        }

        if (
          selectedVideoClipIds.length > 0 ||
          selectedAudioClipIds.length > 0
        ) {
          event.preventDefault();
          void executeEditorEditCommand("cut", event.target);
        }

        return;
      }

      if (key === "c" && !event.shiftKey) {
        if (isEditingText) {
          return;
        }

        if (
          selectedVideoClipIds.length > 0 ||
          selectedAudioClipIds.length > 0
        ) {
          event.preventDefault();
          void executeEditorEditCommand("copy", event.target);
        }

        return;
      }

      if (key === "v" && !event.shiftKey) {
        if (isEditingText) {
          return;
        }

        if (
          videoClipboardRef.current ||
          audioClipboardRef.current ||
          compoundClipboardRef.current
        ) {
          event.preventDefault();
          void executeEditorEditCommand("paste", event.target);
        }

        return;
      }

      if (key === "d" && !event.shiftKey) {
        if (isEditingText) {
          return;
        }

        if (
          selectedVideoClipIds.length > 0 ||
          selectedAudioClipIds.length > 0
        ) {
          event.preventDefault();
          void executeEditorEditCommand("duplicate", event.target);
        }

        return;
      }

      if (key === "z") {
        if (isEditingText) {
          return;
        }

        event.preventDefault();
        void executeEditorEditCommand(
          event.shiftKey ? "redo" : "undo",
          event.target,
        );
        return;
      }

      if (key === "a" && !event.shiftKey) {
        if (isEditingText) {
          return;
        }

        event.preventDefault();
        void executeEditorEditCommand("select-all", event.target);
        return;
      }

      if (key === "b" && !event.shiftKey) {
        if (isEditingText) {
          return;
        }

        event.preventDefault();

        if (
          !splitSelectedAudioClipAtPlayhead() &&
          !splitSelectedVideoClipAtPlayhead()
        ) {
          splitSelectedSubtitleAtPlayhead();
        }
      }
    };

    window.addEventListener("keydown", handleEditorShortcutKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleEditorShortcutKeyDown, true);
    };
  }, [
    screen,
    isGenerating,
    isExporting,
    projectLoadBarrierActive,
    undo,
    redo,
    selectAllSubtitles,
    clearSubtitleSelection,
    focusSelectedSubtitle,
    nudgeSelectedSubtitles,
    resizeSubtitle,
    markNextChangeImmediate,
    timelineRange,
    rippleMode,
    trackSettings,
    videoClips,
    selectedVideoClipId,
    selectedVideoClipIds,
    selectedVideoClip,
    selectedSubtitleId,
    selectedSubtitleIds,
    subtitles,
  ]);

  useAppMenuCommands(handleAppMenuCommand);

  useEffect(() => {
    if (!editorLocked) return;
    const block = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.(".export-progress-backdrop")) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", block, true);
    window.addEventListener("keyup", block, true);
    return () => {
      window.removeEventListener("keydown", block, true);
      window.removeEventListener("keyup", block, true);
    };
  }, [editorLocked]);

  useEffect(() => {
    const root = appRootRef.current;
    if (!root) return;
    const regions = root.querySelectorAll<HTMLElement>(
      ":scope > .topbar, :scope > .workspace",
    );
    regions.forEach((element) => element.toggleAttribute("inert", editorLocked));
    if (editorLocked) (document.activeElement as HTMLElement | null)?.blur?.();
    return () => regions.forEach((element) => element.removeAttribute("inert"));
  }, [editorLocked]);

  const selectedSubtitle =
    subtitles.find((subtitle) => subtitle.id === selectedSubtitleId) ?? null;

  const selectedProgramVideoClipId =
    selectedVideoClip &&
    (!selectedVideoClip.compoundId ||
      !collapsedCompoundIds.has(selectedVideoClip.compoundId))
      ? selectedVideoClipId
      : null;

  const selectedProgramSubtitleId = selectedSubtitle
    ? selectedSubtitleId
    : null;

  const selectedSubtitleForActiveTrack =
    selectedSubtitle &&
    getSubtitleTrackId(selectedSubtitle) === activeSubtitleTrackId
      ? selectedSubtitle
      : null;

  const filteredSubtitlesForActiveTrack = filteredSubtitles.filter(
    (subtitle) => getSubtitleTrackId(subtitle) === activeSubtitleTrackId,
  );

  const selectedSubtitleIdsForActiveTrack = selectedSubtitleIds.filter((id) => {
    const subtitle = subtitles.find((item) => item.id === id);
    return !!subtitle && getSubtitleTrackId(subtitle) === activeSubtitleTrackId;
  });

  const selectedSubtitleIdForActiveTrack =
    selectedSubtitle &&
    getSubtitleTrackId(selectedSubtitle) === activeSubtitleTrackId
      ? selectedSubtitle.id
      : null;


  // ==========================================================================
  // Home UI
  // ==========================================================================

  if (screen === "home") {
    return (
      <>
        <HomeScreen
          projects={recentProjects}
          pendingVideoPath={pendingNewProjectPath}
          pendingProjectTitle={pendingNewProjectTitle}
          newProjectRequestId={newProjectRequestId}
          errorMessage={homeError}
          onChooseNewVideo={handleChooseNewProjectVideo}
          onCancelNewProject={cancelNewProject}
          onCreateProject={handleCreateProject}
          onOpenProject={handleOpenRecentProject}
          onRenameProject={handleRenameRecentProject}
          onRelinkProject={handleRelinkRecentProject}
          onRemoveProject={handleRemoveRecentProject}
        />
        <ProjectLoadingOverlay open={projectLoadBarrierActive} />
      </>
    );
  }

  // ==========================================================================
  // Editor UI
  // ==========================================================================

  return (
    <main ref={appRootRef} className="app" data-can-undo={canUndo} data-can-redo={canRedo}>
      <header className="topbar">
        <button
          type="button"
          className="topbar-home-button"
          onClick={() => {
            void (async () => {
              if (hasUnsavedChanges) {
                const saved = await handleSaveProject();
                if (
                  !saved &&
                  !window.confirm(
                    "The project could not be saved. Leave anyway and lose unsaved changes?",
                  )
                ) {
                  return;
                }
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

        <CtcLogo className="topbar-brand-logo" decorative />

        <div className="topbar-project-title">
          <h1>{projectMetadata?.title ?? videoName ?? "Untitled Project"}</h1>
          <span className="topbar-app-name">CUT THE CRAB</span>
        </div>

        {videoPath && (
          <div className="topbar-status-group">
            {missingMediaIssues.length > 0 && (
              <button
                type="button"
                className="missing-media-status-button"
                onClick={() => setMissingMediaDialogOpen(true)}
                title="Relink missing project media"
              >
                {missingMediaIssues.length} media missing
              </button>
            )}
            <span
              className={`project-save-status ${autosaveError ? "save-status-error" : ""}`}
              role={autosaveError ? "alert" : undefined}
              title={autosaveError ?? undefined}
            >
              {isSavingProject
                ? "Saving..."
                : autosaveError
                  ? "Save failed - retrying"
                  : hasUnsavedChanges
                    ? "Unsaved changes..."
                    : "Saved"}
            </span>
          </div>
        )}
      </header>

      <div className="workspace">
        <MediaBrowser
          assets={mediaAssets}
          primaryVideoPath={videoPath}
          onImportMedia={handleImportMedia}
          onInsertMedia={handleInsertMediaAtPlayhead}
          onDeleteMedia={handleDeleteMediaAsset}
          timelineDuration={timelineDuration}
          onDropMedia={handleMediaDropOnTimeline}
          proxyStatesBySource={proxyStatesBySource}
        />

        <section className="preview-panel">
          <VideoPlayer
            locked={editorLocked}
            ref={videoPlayerRef}
            videoPath={videoPath}
            videoName={videoName}
            onChooseVideo={handleChooseVideo}
            onDurationChange={handleVideoDurationChange}
            onTimeChange={handlePlaybackTimeChange}
            seekRequest={seekRequest}
            videoClips={videoClips}
            audioClips={audioClips}
            adjustmentLayers={adjustmentLayers}
            timelineDuration={timelineDuration}
            trackSettings={trackSettings}
            selectedVideoClipId={selectedProgramVideoClipId}
            interactiveVideoClipIds={programInteractiveVideoClipIds}
            onVideoClipSelect={handleProgramVideoClipSelect}
            onVideoLayerChange={handleProgramVideoLayerChange}
            onVideoLayerReorder={handleProgramVideoLayerReorder}
            onVideoTransformChange={handleVideoTransformChange}
            onOpenVideoEffects={openVideoEffects}
            onOpenVideoMasks={openVideoMasks}
            editingMask={
              masksPanelVideoClip?.mask
                ? {
                    ownerKind: "video",
                    ownerId: masksPanelVideoClip.id,
                    mask: masksPanelVideoClip.mask,
                    locked: Boolean(
                      trackSettings[masksPanelVideoClip.trackId]?.locked,
                    ),
                    label: masksPanelVideoClip.sourceName,
                  }
                : masksPanelAdjustmentLayer?.mask
                  ? {
                      ownerKind: "adjustment",
                      ownerId: masksPanelAdjustmentLayer.id,
                      mask: masksPanelAdjustmentLayer.mask,
                      locked: Boolean(
                        trackSettings[masksPanelAdjustmentLayer.trackId]
                          ?.locked,
                      ),
                      label: masksPanelAdjustmentLayer.name,
                    }
                  : null
            }
            onEditingMaskChange={(mask) => updateMasksPanelMask(mask)}
            onVideoMaskChange={handleVideoMaskChange}
            onVideoBlendModeChange={handleVideoBlendModeChange}
            onMaskEditStart={beginHistoryTransaction}
            onMaskEditEnd={() =>
              window.requestAnimationFrame(() => endHistoryTransaction())
            }
            onApplyVideoCropToTrack={handleApplyVideoCropToTrack}
            proxyPathsBySource={proxyPathsBySource}
            subtitles={subtitles}
            selectedSubtitleId={selectedProgramSubtitleId}
            interactiveSubtitleIds={programInteractiveSubtitleIds}
            onSubtitleSelect={handleProgramSubtitleSelect}
            onSubtitlePositionChange={updateSubtitlePositionIfEditable}
          />
        </section>

        <SubtitlePanel
          subtitles={filteredSubtitlesForActiveTrack}
          activeTrackId={activeSubtitleTrackId}
          selectedSubtitle={selectedSubtitleForActiveTrack}
          selectedSubtitleId={selectedSubtitleIdForActiveTrack}
          selectedSubtitleIds={selectedSubtitleIdsForActiveTrack}
          selectedSubtitleCount={selectedSubtitleIdsForActiveTrack.length}
          search={subtitleSearch}
          onSearchChange={setSubtitleSearch}
          onSelect={handleSubtitleSelect}
          onTextChange={updateSubtitleTextIfEditable}
          onStyleChange={updateSubtitleStyleWithSelection}
          onApplyAppearance={applySubtitleAppearance}
          onAdd={() => addSubtitleWithHistory(currentTimeRef.current)}
          onDelete={deleteSubtitleWithHistory}
          onReveal={(id) => {
            const subtitle = subtitles.find((item) => item.id === id);
            if (subtitle) {
              setActiveSubtitleTrackId(getSubtitleTrackId(subtitle));
              selectSubtitle(id, "single", timelineSelectableSubtitleIdSet);
              requestSeek(subtitle.startTime);
            }
            window.requestAnimationFrame(() => {
              timelineRef.current?.revealSubtitle(id);
            });
          }}
        />
      </div>

      <Timeline
        ref={timelineRef}
        duration={timelineDuration}
        scaleDuration={videoDuration}
        waveformsBySource={waveformsBySource}
        proxyPathsBySource={proxyPathsBySource}
        videoClips={videoClips}
        audioClips={audioClips}
        adjustmentLayers={adjustmentLayers}
        subtitles={subtitles}
        markers={markers}
        zoom={timelineZoom}
        trackSettings={trackSettings}
        timelineRange={timelineRange}
        rippleMode={rippleMode}
        selectedSubtitleId={selectedSubtitleId}
        selectedSubtitleIds={selectedSubtitleIds}
        selectedVideoClipId={selectedVideoClipId}
        selectedVideoClipIds={selectedVideoClipIds}
        selectedAudioClipId={selectedAudioClipId}
        selectedAudioClipIds={selectedAudioClipIds}
        selectedAdjustmentLayerId={selectedAdjustmentLayerId}
        activeSubtitleTrackId={activeSubtitleTrackId}
        onAddTrack={handleAddTimelineTrack}
        onCreateAdjustmentLayer={createAdjustmentLayer}
        onAdjustmentLayerSelect={(id) => selectAdjustmentLayer(id, false)}
        onAdjustmentLayerOpen={(id) => selectAdjustmentLayer(id, true)}
        onAdjustmentLayerEditStart={beginAdjustmentLayerEdit}
        onAdjustmentLayerEditEnd={endAdjustmentLayerEdit}
        onAdjustmentLayerMove={moveAdjustmentLayer}
        onAdjustmentLayerResize={resizeAdjustmentLayer}
        onOpenAdjustmentControls={() => {
          if (selectedAdjustmentLayerId) setAdjustmentPanelOpen(true);
        }}
        onDeleteTrack={handleDeleteTimelineTrack}
        onPasteTargetChange={handleTimelinePasteTargetChange}
        onTimelineRangeChange={setTimelineRange}
        onRippleModeChange={setRippleMode}
        onDeleteRange={
          rippleMode
            ? extractTimelineRangeWithHistory
            : deleteTimelineRangeWithHistory
        }
        onLiftRange={liftTimelineRangeWithHistory}
        onExtractRange={extractTimelineRangeWithHistory}
        onExportRange={() => {
          handleExportSelectedRange();
        }}
        onClearSubtitleSelection={() => {
          clearSubtitleSelection();
          clearVideoClipSelection();
          clearAudioClipSelection();
        }}
        onVideoClipSelect={handleVideoClipSelect}
        onVideoClipSelectionChange={handleVideoClipSelectionChange}
        onVideoClipMoveStart={handleCompoundAwareVideoMoveStart}
        onVideoClipMoveEnd={handleCompoundAwareVideoMoveEnd}
        onVideoClipMove={handleCompoundAwareVideoMove}
        onVideoClipMoveToTrack={handleMoveVideoClipToTrack}
        onVideoClipResizeStart={handleCompoundAwareResizeStart}
        onVideoClipResize={handleCompoundAwareResize}
        onVideoClipResizeEnd={handleCompoundAwareResizeEnd}
        onVideoPlaybackRateChange={handleVideoPlaybackRateChange}
        onToggleVideoReverse={handleToggleVideoReverse}
        onInsertFreezeFrame={handleInsertFreezeFrame}
        onVideoTransitionChange={handleVideoTransitionChange}
        onVideoFadeChange={handleVideoFadeChange}
        onAudioFadeChange={handleAudioFadeChange}
        onAudioVolumeChange={handleAudioVolumeChange}
        onAudioMuteChange={handleAudioMuteChange}
        onCopyVideoClip={copySelectedVideoClip}
        onRegenerateMissingSubtitles={restoreMissingSubtitlesForVideoClip}
        onAudioClipSelect={handleAudioClipSelect}
        onAudioClipMoveStart={handleAudioClipMoveStart}
        onAudioClipMoveEnd={handleAudioClipMoveEnd}
        onAudioClipMove={moveAudioClip}
        onAudioClipMoveToTrack={moveAudioClipToTrack}
        onAudioClipResize={resizeAudioClip}
        onStandaloneAudioFadeChange={handleStandaloneAudioFadeChange}
        onStandaloneAudioVolumeChange={handleStandaloneAudioVolumeChange}
        onStandaloneAudioMuteChange={handleStandaloneAudioMuteChange}
        onSubtitleSelect={handleSubtitleTrackSelect}
        onSubtitleMove={moveSubtitle}
        onSubtitleMoveToTrack={handleMoveSubtitleToTrack}
        onSubtitleTrackActivate={setActiveSubtitleTrackId}
        onSubtitleGroupMove={moveSubtitleGroup}
        onSubtitleResize={resizeSubtitle}
        onMarkersChange={setMarkersWithHistory}
        onZoomChange={setTimelineZoom}
        onToggleTrackLock={(trackId) => toggleTrackSetting(trackId, "locked")}
        onToggleTrackMute={(trackId) => toggleTrackSetting(trackId, "muted")}
        onToggleTrackSolo={(trackId) => toggleTrackSetting(trackId, "solo")}
        onToggleTrackHidden={(trackId) => toggleTrackSetting(trackId, "hidden")}
        expandedCompoundId={expandedCompoundId}
        onCreateCompound={createCompoundFromSelection}
        onBreakApartCompound={breakApartCompoundWithHistory}
        onOpenCompound={openCompound}
        onCloseCompound={closeCompound}
        onSkimPreviewChange={handleSkimPreviewChange}
        onInitialFilmstripReadyChange={handleInitialFilmstripReadyChange}
        onSeek={requestSeek}
      />

      <AdjustmentLayerPanel
        layer={
          adjustmentLayers.find(
            (layer) => layer.id === selectedAdjustmentLayerId,
          ) ?? null
        }
        open={adjustmentPanelOpen}
        onClose={() => setAdjustmentPanelOpen(false)}
        onChange={updateAdjustmentLayer}
        onSeek={requestSeek}
        onOpenEffects={() => {
          if (selectedAdjustmentLayerId)
            openAdjustmentEffects(selectedAdjustmentLayerId);
        }}
        onOpenMasks={() => {
          if (selectedAdjustmentLayerId)
            openAdjustmentMasks(selectedAdjustmentLayerId);
        }}
      />

      <EffectsStackPanel
        open={effectsPanelTarget !== null}
        targetName={
          effectsPanelVideoClip?.sourceName ??
          effectsPanelAdjustmentLayer?.name ??
          "Effects"
        }
        targetDetail={
          effectsPanelVideoClip
            ? effectsPanelVideoClip.trackId.replace("video-", "V")
            : effectsPanelAdjustmentLayer
              ? effectsPanelAdjustmentLayer.trackId.replace("video-", "V")
              : undefined
        }
        effects={
          effectsPanelVideoClip?.effects ?? effectsPanelAdjustmentLayer?.effects
        }
        disabled={Boolean(
          effectsPanelVideoClip
            ? trackSettings[effectsPanelVideoClip.trackId]?.locked
            : effectsPanelAdjustmentLayer
              ? trackSettings[effectsPanelAdjustmentLayer.trackId]?.locked
              : false,
        )}
        onChange={updateEffectsPanelStack}
        onBeginContinuousChange={beginHistoryTransaction}
        onEndContinuousChange={() => {
          window.requestAnimationFrame(() => endHistoryTransaction());
        }}
        onDiscreteChange={markNextChangeImmediate}
        onClose={() => setEffectsPanelTarget(null)}
      />

      <MasksPanel
        open={masksPanelTarget !== null}
        targetName={
          masksPanelVideoClip?.sourceName ??
          masksPanelAdjustmentLayer?.name ??
          "Masks"
        }
        targetDetail={
          masksPanelVideoClip
            ? masksPanelVideoClip.trackId.replace("video-", "V")
            : masksPanelAdjustmentLayer
              ? masksPanelAdjustmentLayer.trackId.replace("video-", "V")
              : undefined
        }
        ownerKind={masksPanelTarget?.kind}
        mask={masksPanelVideoClip?.mask ?? masksPanelAdjustmentLayer?.mask}
        disabled={Boolean(
          masksPanelVideoClip
            ? trackSettings[masksPanelVideoClip.trackId]?.locked
            : masksPanelAdjustmentLayer
              ? trackSettings[masksPanelAdjustmentLayer.trackId]?.locked
              : false,
        )}
        onChange={updateMasksPanelMask}
        getDefaultGeometry={
          masksPanelTarget?.kind === "video"
            ? () =>
                videoPlayerRef.current?.getVideoMaskDefaultGeometry(
                  masksPanelTarget.id,
                ) ?? null
            : undefined
        }
        onBeginContinuousChange={beginHistoryTransaction}
        onEndContinuousChange={() =>
          window.requestAnimationFrame(() => endHistoryTransaction())
        }
        onDiscreteChange={markNextChangeImmediate}
        onClose={() => setMasksPanelTarget(null)}
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

      <ExportSettingsModal
        open={exportSettingsRequest !== null && !isExporting}
        rangeExport={Boolean(exportSettingsRequest?.range)}
        initialFrameSize={lastExportFrameSize}
        onCancel={() => setExportSettingsRequest(null)}
        onExport={(frameSize) => {
          const request = exportSettingsRequest;
          if (!request) return;

          setLastExportFrameSize(frameSize);
          setExportSettingsRequest(null);
          void performExportStyledVideo(request.range, frameSize);
        }}
      />

      {missingMediaDialogOpen && missingMediaIssues.length > 0 && (
        <MissingMediaModal
          issues={missingMediaIssues}
          relinkingPath={relinkingMissingMediaPath}
          deletingPath={deletingMissingMediaPath}
          onRelink={handleRelinkMissingMedia}
          onDelete={handleDeleteMissingMedia}
          onClose={() => setMissingMediaDialogOpen(false)}
        />
      )}

      {(isExporting || exportError) && (
        <ExportProgressModal
          progress={exportProgress}
          status={exportStatus}
          exporting={isExporting}
          cancelling={isCancellingExport}
          errorMessage={exportError}
          cancelError={exportCancelError}
          onCancel={isExporting && !isCancellingExport ? () => void handleCancelExport() : undefined}
          onDismissError={() => setExportError(null)}
        />
      )}

      <ProjectLoadingOverlay open={projectLoadBarrierActive} />
    </main>
  );
}

export default App;
