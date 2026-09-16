import { useCallback, useEffect, useRef, useState } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import CtcLogo from "./components/brand/CtcLogo";

import HomeScreen from "./components/home/HomeScreen";
import MediaBrowser from "./components/media/MediaBrowser";
import VideoPlayer, { type VideoPlayerHandle } from "./components/video/VideoPlayer";
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
  TimelineTrackKind,
  TimelineTrackSettings,
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
  timelineTrackId,
} from "./utils/timelineModel";

import "./App.css";

type SeekRequest = {
  time: number;
  id: number;
};

type AppScreen = "home" | "editor";

const AUTOSAVE_DEBOUNCE_MS = 200;

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


type EditorEditCommand =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "duplicate"
  | "select-all";

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
  const videoPlayerRef = useRef<VideoPlayerHandle | null>(null);
  const handleSkimPreviewChange = useCallback((time: number | null) => {
    videoPlayerRef.current?.setSkimPreviewTime(time);
  }, []);
  const videoClipboardRef = useRef<VideoTimelineClip | null>(null);
  const timelinePasteTargetRef = useRef<{
    trackId: TimelineTrackId;
    time: number;
  } | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

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
    deleteVideoTrack,
    insertVideoClipCopy,
    duplicateVideoClip,
    insertVideoClipFromMedia,
    updateVideoClipTransform,
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
  });

  const latestSaveStateRef = useRef({
    activeProjectId,
    videoPath,
    subtitles,
    markers,
    projectMetadata,
    videoClips,
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
    mediaAssets,
    trackSettings,
    videoDuration,
    hasUnsavedChanges,
  };

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
      trackSettings,
    },
    enabled:
      screen === "editor" &&
      !!videoPath &&
      !isLoadingVideoRef.current,
    onApply: (snapshot) => {
      replaceSubtitles(snapshot.subtitles);
      setMarkers(snapshot.markers);
      replaceVideoClips(snapshot.videoClips);
      setTrackSettings(snapshot.trackSettings);
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
    // Default paste behaves like a normal NLE duplicate: place the copy
    // immediately after the copied clip on the same video track. A later
    // click on another video track/time replaces this destination.
    timelinePasteTargetRef.current = {
      trackId: selectedVideoClip.trackId,
      time: selectedVideoClip.timelineEnd,
    };

    return true;
  };

  const cutSelectedVideoClipWithHistory = () => {
    if (!selectedVideoClipId || !selectedVideoClip) {
      return false;
    }

    if (trackSettings[selectedVideoClip.trackId]?.locked) {
      return false;
    }

    if (!copySelectedVideoClip()) {
      return false;
    }

    markNextChangeImmediate();
    clearSubtitleSelection();
    deleteVideoClip(selectedVideoClipId);
    return true;
  };

  const handleTimelinePasteTargetChange = (
    trackId: TimelineTrackId,
    time: number,
  ) => {
    if (timelineTrackKindFromId(trackId) !== "video") {
      return;
    }

    timelinePasteTargetRef.current = {
      trackId,
      time: Math.max(0, time),
    };
  };

  const pasteVideoClipAtTarget = () => {
    const clipboardClip = videoClipboardRef.current;

    if (!clipboardClip) {
      return false;
    }

    const target = timelinePasteTargetRef.current ?? {
      trackId: clipboardClip.trackId,
      time: clipboardClip.timelineEnd,
    };
    const targetSettings = trackSettings[target.trackId];

    if (
      timelineTrackKindFromId(target.trackId) !== "video" ||
      targetSettings?.deleted === true ||
      targetSettings?.locked
    ) {
      return false;
    }

    markNextChangeImmediate();
    clearSubtitleSelection();
    insertVideoClipCopy(clipboardClip, target.time, target.trackId);
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

  const handleAddTimelineTrack = (kind: TimelineTrackKind) => {
    const id = nextTimelineTrackId(kind, trackSettings, videoClips);

    setTrackSettings((current) => {
      const next = {
        ...current,
        [id]: defaultTrackControlState(kind),
      };

      // Video tracks are always created with their linked audio partner.
      // V3 -> A3, V4 -> A4, etc. Standalone audio tracks can still be
      // created explicitly from the + menu when needed for music/SFX.
      if (kind === "video") {
        const match = /^video-(\d+)$/.exec(id);
        if (match) {
          const audioId = `audio-${match[1]}`;
          if (!next[audioId] || next[audioId].deleted) {
            next[audioId] = defaultTrackControlState("audio");
          }
        }
      }

      return next;
    });
  };

  const handleDeleteTimelineTrack = (trackId: TimelineTrackId) => {
    const kind = timelineTrackKindFromId(trackId);

    if (!kind) {
      return;
    }

    // S1 is the canonical subtitle data track in the current subtitle model.
    // Extra subtitle rows can be removed safely; S1 stays until subtitle
    // routing is generalized to per-track subtitle data.
    if (kind === "subtitle" && trackId === "subtitle-1") {
      return;
    }

    if (kind === "audio") {
      const index = timelineTrackIndexFromId(trackId);
      const pairedVideoId = timelineTrackId("video", index);
      const pairedVideoActive =
        trackSettings[pairedVideoId]?.deleted !== true &&
        (trackSettings[pairedVideoId] !== undefined ||
          videoClips.some((clip) => clip.trackId === pairedVideoId));

      // Linked A-tracks are owned by their V-track and are removed together.
      if (pairedVideoActive) {
        return;
      }
    }

    if (kind === "video") {
      const index = timelineTrackIndexFromId(trackId);
      const pairedAudioId = timelineTrackId("audio", index);
      const clipCount = videoClips.filter((clip) => clip.trackId === trackId).length;
      const message =
        clipCount > 0
          ? `Delete V${index} and A${index}? This will remove ${clipCount} clip${clipCount === 1 ? "" : "s"} from the project.`
          : `Delete V${index} and its linked A${index} track?`;

      if (!window.confirm(message)) {
        return;
      }

      markNextChangeImmediate();
      deleteVideoTrack(trackId);
      setTrackSettings((current) => ({
        ...current,
        [trackId]: {
          ...(current[trackId] ?? defaultTrackControlState("video")),
          deleted: true,
        },
        [pairedAudioId]: {
          ...(current[pairedAudioId] ?? defaultTrackControlState("audio")),
          deleted: true,
        },
      }));

      if (timelinePasteTargetRef.current?.trackId === trackId) {
        timelinePasteTargetRef.current = null;
      }

      return;
    }

    if (!window.confirm(`Delete ${trackId.replace("-", " ")}?`)) {
      return;
    }

    markNextChangeImmediate();
    setTrackSettings((current) => ({
      ...current,
      [trackId]: {
        ...(current[trackId] ?? defaultTrackControlState(kind)),
        deleted: true,
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

    updateVideoClipAudio(id,
      edge === "in"
        ? { fadeInDuration: duration }
        : { fadeOutDuration: duration },
    );
  };

  const handleAudioVolumeChange = (
    id: string,
    volume: number,
  ) => {
    const clip = videoClips.find((item) => item.id === id);

    if (!clip) {
      return;
    }

    updateVideoClipAudio(id, { volume });
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

  const createSaveFingerprint = (state: {
    subtitles: typeof subtitles;
    markers: TimelineMarker[];
    videoClips: VideoTimelineClip[];
    mediaAssets: ProjectMediaAsset[];
    trackSettings: TimelineTrackSettings;
  }) =>
    JSON.stringify({
      subtitles: state.subtitles,
      markers: state.markers,
      videoClips: state.videoClips,
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
          state.mediaAssets,
          state.trackSettings,
        );

        lastSavedSnapshotRef.current = fingerprint;

        const latest = latestSaveStateRef.current;
        if (
          latest.activeProjectId === state.activeProjectId &&
          latest.videoPath === state.videoPath
        ) {
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

        await enqueueProjectSave({
          activeProjectId,
          videoPath,
          subtitles,
          markers,
          projectMetadata,
          videoClips,
          mediaAssets,
          trackSettings,
        });
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
                  `V${clip.trackId.split("-")[1] ?? "1"}`
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
      trackSettings: { ...DEFAULT_TIMELINE_TRACK_SETTINGS } as TimelineTrackSettings,
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
          markSourceInitializedFor: path,
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
          trackSettings: matchingProject.trackSettings,
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
            trackSettings: { ...DEFAULT_TIMELINE_TRACK_SETTINGS },
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
        trackSettings: { ...DEFAULT_TIMELINE_TRACK_SETTINGS },
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
    if (!activeProjectId || !videoPath) {
      return;
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
        timelineDuration,
        videoClips,
        trackSettings,

        onStart: () => {
          setExportProgress(0);
          setExportStatus("Preparing edited timeline export...");
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

        console.log("Edited timeline exported:", outputPath);
      }
    } catch (error) {
      console.error("Edited timeline export failed:", error);
    } finally {
      setIsExporting(false);
    }
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
        return cutSelectedVideoClipWithHistory();

      case "copy":
        return copySelectedVideoClip();

      case "paste":
        return pasteVideoClipAtTarget();

      case "duplicate":
        return duplicateSelectedVideoClipWithHistory();

      case "select-all":
        selectAllSubtitles();
        return true;
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

      const isEditingText = getEditableElement(event.target) !== null;

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

      if (key === "x" && !event.shiftKey) {
        if (isEditingText) {
          return;
        }

        if (selectedVideoClipId) {
          event.preventDefault();
          void executeEditorEditCommand("cut", event.target);
        }

        return;
      }

      if (key === "c" && !event.shiftKey) {
        if (isEditingText) {
          return;
        }

        if (selectedVideoClipId) {
          event.preventDefault();
          void executeEditorEditCommand("copy", event.target);
        }

        return;
      }

      if (key === "v" && !event.shiftKey) {
        if (isEditingText) {
          return;
        }

        if (videoClipboardRef.current) {
          event.preventDefault();
          void executeEditorEditCommand("paste", event.target);
        }

        return;
      }

      if (key === "d" && !event.shiftKey) {
        if (isEditingText) {
          return;
        }

        if (selectedVideoClipId) {
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
            ref={videoPlayerRef}
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
            onApplyVideoCropToTrack={handleApplyVideoCropToTrack}
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
      </div>

      <Timeline
        duration={timelineDuration}
        scaleDuration={videoDuration}
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
        onAddTrack={handleAddTimelineTrack}
        onDeleteTrack={handleDeleteTimelineTrack}
        onPasteTargetChange={handleTimelinePasteTargetChange}
        onClearSubtitleSelection={() => {
          clearSubtitleSelection();
          clearVideoClipSelection();
        }}
        onVideoClipSelect={handleVideoClipSelect}
        onVideoClipMove={moveVideoClip}
        onVideoClipMoveToTrack={handleMoveVideoClipToTrack}
        onMediaDrop={handleMediaDropOnTimeline}
        onVideoClipResize={resizeVideoClip}
        onVideoTransitionChange={handleVideoTransitionChange}
        onVideoFadeChange={handleVideoFadeChange}
        onAudioFadeChange={handleAudioFadeChange}
        onAudioVolumeChange={handleAudioVolumeChange}
        onCopyVideoClip={copySelectedVideoClip}
        onSubtitleSelect={handleSubtitleTrackSelect}
        onSubtitleMove={moveSubtitle}
        onSubtitleGroupMove={moveSubtitleGroup}
        onSubtitleResize={resizeSubtitle}
        onMarkersChange={setMarkersWithHistory}
        onZoomChange={setTimelineZoom}
        onToggleTrackLock={(trackId) => toggleTrackSetting(trackId, "locked")}
        onToggleTrackMute={(trackId) => toggleTrackSetting(trackId, "muted")}
        onToggleTrackHidden={(trackId) => toggleTrackSetting(trackId, "hidden")}
        onSkimPreviewChange={handleSkimPreviewChange}
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
