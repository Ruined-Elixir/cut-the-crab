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
import { useAudioTimeline } from "./hooks/useAudioTimeline";
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
  AudioTimelineClip,
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
} from "./utils/timelineModel";
import {
  applyTimelineRangeEdit,
  type TimelineRange,
  type TimelineRangeEditMode,
} from "./utils/timelineRangeEdits";

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

const AUDIO_MEDIA_EXTENSIONS = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"]);

function mediaKindFromPath(path: string): ProjectMediaAsset["kind"] {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_MEDIA_EXTENSIONS.has(extension) ? "audio" : "video";
}

function probeMediaDuration(path: string, kind: ProjectMediaAsset["kind"] = "video") {
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
  const [timelineRange, setTimelineRange] = useState<TimelineRange | null>(null);
  const [rippleMode, setRippleMode] = useState(false);
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
  const videoClipboardRef = useRef<VideoClipboardPayload | null>(null);
  const audioClipboardRef = useRef<AudioClipboardPayload | null>(null);
  const activeClipboardKindRef = useRef<"video" | "audio" | null>(null);
  const timelinePasteTargetRef = useRef<{
    trackId: TimelineTrackId;
    time: number;
  } | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const lastSavedSnapshotRef = useRef<string>(
    JSON.stringify({ subtitles: [], markers: [], videoClips: [], audioClips: [], mediaAssets: [], trackSettings: DEFAULT_TIMELINE_TRACK_SETTINGS }),
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
    rippleMode,
  });

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

  const latestSaveStateRef = useRef({
    activeProjectId,
    videoPath,
    subtitles,
    markers,
    projectMetadata,
    videoClips,
    audioClips,
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
    mediaAssets,
    trackSettings,
    videoDuration,
    hasUnsavedChanges,
  };

  const editedContentEnd = Math.max(
    0,
    ...videoClips.map((clip) => clip.timelineEnd),
    ...audioClips.map((clip) => clip.timelineEnd),
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
    beginTransaction: beginHistoryTransaction,
    endTransaction: endHistoryTransaction,
  } = useEditorHistory({
    snapshot: {
      subtitles,
      markers,
      videoClips,
      audioClips,
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
      replaceAudioClips(snapshot.audioClips);
      setTrackSettings(snapshot.trackSettings);
    },
  });

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
    if (!selectedVideoClipsAreEditable) {
      return false;
    }

    markNextChangeImmediate();
    clearSubtitleSelection();
    deleteVideoClips(selectedVideoClipIds);

    return true;
  };

  const copySelectedVideoClip = () => {
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
    if (!selectedVideoClipsAreEditable) {
      return false;
    }

    if (!copySelectedVideoClip()) {
      return false;
    }

    markNextChangeImmediate();
    clearSubtitleSelection();
    deleteVideoClips(selectedVideoClipIds);
    return true;
  };

  const handleTimelinePasteTargetChange = (
    trackId: TimelineTrackId,
    time: number,
  ) => {
    const kind = timelineTrackKindFromId(trackId);
    if (kind !== "video" && kind !== "audio") return;
    if (trackSettings[trackId]?.deleted || trackSettings[trackId]?.locked) return;
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
    const sourceTrackIds = [...new Set(clipboard.clips.map((clip) => clip.trackId))];
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

    markNextChangeImmediate();
    clearSubtitleSelection();
    insertVideoClipCopies(
      clipboard.clips,
      target.time,
      sourceTrackIds.length === 1 ? target.trackId : undefined,
    );
    return true;
  };

  const duplicateSelectedVideoClipWithHistory = () => {
    if (!selectedVideoClipsAreEditable) {
      return false;
    }

    const groupEnd = Math.max(...selectedVideoClips.map((clip) => clip.timelineEnd));

    markNextChangeImmediate();
    clearSubtitleSelection();
    insertVideoClipCopies(selectedVideoClips, groupEnd);
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
      .sort((a, b) => a.timelineStart - b.timelineStart || a.trackId.localeCompare(b.trackId));
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
    if (!selectedAudioClipsAreEditable || !copySelectedAudioClips()) return false;
    markNextChangeImmediate();
    clearSubtitleSelection();
    deleteAudioClips(selectedAudioClipIds);
    return true;
  };

  const pasteAudioClipsAtTarget = () => {
    const clipboard = audioClipboardRef.current;
    if (!clipboard || clipboard.clips.length === 0) return false;
    const sourceTrackIds = [...new Set(clipboard.clips.map((clip) => clip.trackId))];
    const fallbackTrack = sourceTrackIds[0];
    const target = timelinePasteTargetRef.current ?? { trackId: fallbackTrack, time: clipboard.groupEnd };
    const targetKind = timelineTrackKindFromId(target.trackId);
    const canRetarget = sourceTrackIds.length === 1 && targetKind === "audio";
    const targetTracks = canRetarget ? [target.trackId] : sourceTrackIds;
    if (targetTracks.some((trackId) =>
      timelineTrackKindFromId(trackId) !== "audio" ||
      trackSettings[trackId]?.deleted ||
      trackSettings[trackId]?.locked ||
      !!trackSettings[trackId]?.linkedTrackId
    )) return false;

    markNextChangeImmediate();
    clearSubtitleSelection();
    clearVideoClipSelection();
    insertAudioClipCopies(clipboard.clips, target.time, canRetarget ? target.trackId : undefined);
    return true;
  };

  const duplicateSelectedAudioClipsWithHistory = () => {
    if (!selectedAudioClipsAreEditable) return false;
    const groupEnd = Math.max(...selectedAudioClips.map((clip) => clip.timelineEnd));
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
    selectAudioClip(id, mode);
    clearVideoClipSelection();
    clearSubtitleSelection();
    setTimelineRange(null);
  };

  const handleAudioClipMoveStart = (id: string) => {
    const hasMulti = selectedAudioClipIds.includes(id) && selectedAudioClipIds.length > 1;
    if (hasMulti && !selectedAudioClipsAreEditable) return false;
    beginHistoryTransaction();
    beginAudioClipMove(id);
    return true;
  };

  const handleAudioClipMoveEnd = () => {
    endAudioClipMove();
    window.requestAnimationFrame(() => endHistoryTransaction());
  };

  const handleVideoClipSelect = (
    id: string,
    mode: "single" | "toggle" | "focus" = "single",
  ) => {
    selectVideoClip(id, mode);
    clearSubtitleSelection();
    clearAudioClipSelection();
    setTimelineRange(null);
  };

  const handleVideoClipSelectionChange = (
    ids: string[],
    primaryId?: string | null,
  ) => {
    selectVideoClips(ids, primaryId);
    clearSubtitleSelection();
    clearAudioClipSelection();
    setTimelineRange(null);
  };

  const handleVideoClipMoveStart = (id: string) => {
    const hasMultiSelection =
      selectedVideoClipIds.includes(id) && selectedVideoClipIds.length > 1;

    if (hasMultiSelection && !selectedVideoClipsAreEditable) {
      return false;
    }

    beginHistoryTransaction();

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
      endHistoryTransaction();
    });
  };

  const splitSelectedAudioClipAtPlayhead = () => {
    if (!selectedAudioClipId) return false;
    const clip = audioClips.find((item) => item.id === selectedAudioClipId);
    if (!clip || trackSettings[clip.trackId]?.locked) return false;
    if (currentTime <= clip.timelineStart + 0.05 || currentTime >= clip.timelineEnd - 0.05) return false;
    markNextChangeImmediate();
    splitAudioClip(clip.id, currentTime);
    return true;
  };

  const applySelectedTimelineRangeEdit = (mode: TimelineRangeEditMode) => {
    if (!timelineRange) {
      return false;
    }

    const result = applyTimelineRangeEdit({
      range: timelineRange,
      mode,
      videoClips,
      audioClips,
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
    replaceVideoClips(result.videoClips);
    replaceAudioClips(result.audioClips);
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
      const videoId = nextTimelineTrackId("video", trackSettings, videoClips, audioClips);
      const audioId = nextTimelineTrackId("audio", trackSettings, videoClips, audioClips);

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
  };

  const handleDeleteTimelineTrack = (trackId: TimelineTrackId) => {
    const kind = timelineTrackKindFromId(trackId);
    if (!kind) return;

    if (kind === "subtitle" && trackId === "subtitle-1") return;

    const linkedTrackId = trackSettings[trackId]?.linkedTrackId;

    // The audio half of a Video + Audio pair is owned by the video track.
    if (kind === "audio" && linkedTrackId && timelineTrackKindFromId(linkedTrackId) === "video") {
      return;
    }

    if (kind === "video") {
      const clipCount = videoClips.filter((clip) => clip.trackId === trackId).length;
      const hasLinkedAudio =
        !!linkedTrackId &&
        timelineTrackKindFromId(linkedTrackId) === "audio" &&
        trackSettings[linkedTrackId]?.deleted !== true;
      const label = `V${timelineTrackIndexFromId(trackId)}`;
      const message = hasLinkedAudio
        ? `Delete ${label} and its linked ${linkedTrackId?.replace("audio-", "A")} track?${clipCount ? ` This will remove ${clipCount} video clip${clipCount === 1 ? "" : "s"}.` : ""}`
        : `Delete ${label}?${clipCount ? ` This will remove ${clipCount} video clip${clipCount === 1 ? "" : "s"}.` : ""}`;

      if (!window.confirm(message)) return;

      markNextChangeImmediate();
      deleteVideoTrack(trackId);
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

      if (timelinePasteTargetRef.current?.trackId === trackId || timelinePasteTargetRef.current?.trackId === linkedTrackId) {
        timelinePasteTargetRef.current = null;
      }
      return;
    }

    if (kind === "audio") {
      const clipCount = audioClips.filter((clip) => clip.trackId === trackId).length;
      const label = `A${timelineTrackIndexFromId(trackId)}`;
      if (!window.confirm(`Delete ${label}?${clipCount ? ` This will remove ${clipCount} audio clip${clipCount === 1 ? "" : "s"}.` : ""}`)) return;
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
      if (timelinePasteTargetRef.current?.trackId === trackId) timelinePasteTargetRef.current = null;
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
    if (!clip || trackSettings[clip.trackId]?.locked || trackSettings[clip.trackId]?.linkedTrackId) {
      return;
    }
    updateAudioClip(
      id,
      edge === "in"
        ? { fadeInDuration: duration }
        : { fadeOutDuration: duration },
    );
  };

  const handleStandaloneAudioVolumeChange = (
    id: string,
    volume: number,
  ) => {
    const clip = audioClips.find((item) => item.id === id);
    if (!clip || trackSettings[clip.trackId]?.locked || trackSettings[clip.trackId]?.linkedTrackId) {
      return;
    }
    updateAudioClip(id, { volume });
  };

  const handleStandaloneAudioMuteChange = (id: string, muted: boolean) => {
    const clip = audioClips.find((item) => item.id === id);
    if (!clip || trackSettings[clip.trackId]?.locked || trackSettings[clip.trackId]?.linkedTrackId) {
      return;
    }
    markNextChangeImmediate();
    updateAudioClip(id, { muted });
  };


  const handleSubtitleTrackSelect = (
    id: string,
    mode:
      | "single"
      | "toggle"
      | "range" = "single",
  ) => {
    clearVideoClipSelection();
    clearAudioClipSelection();
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
    audioClips: AudioTimelineClip[];
    mediaAssets: ProjectMediaAsset[];
    trackSettings: TimelineTrackSettings;
  }) =>
    JSON.stringify({
      subtitles: state.subtitles,
      markers: state.markers,
      videoClips: state.videoClips,
      audioClips: state.audioClips,
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

    const currentSnapshot = JSON.stringify({ subtitles, markers, videoClips, audioClips, mediaAssets, trackSettings });

    setHasUnsavedChanges(currentSnapshot !== lastSavedSnapshotRef.current);
  }, [
    subtitles,
    markers,
    videoClips,
    audioClips,
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
    audioClips,
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
    setTimelineRange(null);

    replaceSubtitles([]);
    replaceVideoClips([]);
    replaceAudioClips([]);
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
      audioClips: [] as AudioTimelineClip[],
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
        const loadedAudioClips = matchingProject.audioClips;
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
        replaceAudioClips(loadedAudioClips);
        setMarkers(loadedMarkers);
        setMediaAssets(loadedMediaAssets);
        setTrackSettings(matchingProject.trackSettings);
        setProjectMetadata(resolvedMetadata);

        loadedHistorySnapshot = {
          subtitles: loadedSubtitles,
          markers: loadedMarkers,
          videoClips: loadedVideoClips,
          audioClips: loadedAudioClips,
          mediaAssets: loadedMediaAssets,
          trackSettings: matchingProject.trackSettings,
        };

        lastSavedSnapshotRef.current = JSON.stringify({
          subtitles: loadedSubtitles,
          markers: loadedMarkers,
          videoClips: loadedVideoClips,
          audioClips: loadedAudioClips,
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
            audioClips: [],
            mediaAssets: [],
            trackSettings: { ...DEFAULT_TIMELINE_TRACK_SETTINGS },
          };

          lastSavedSnapshotRef.current = JSON.stringify({
            subtitles: matchingSubtitles,
            markers: [],
            videoClips: [],
            audioClips: [],
            mediaAssets: [],
            trackSettings: DEFAULT_TIMELINE_TRACK_SETTINGS,
          });
        } else {
          lastSavedSnapshotRef.current = JSON.stringify({
            subtitles: [],
            markers: [],
            videoClips: [],
            audioClips: [],
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
        audioClips: [],
        mediaAssets: [],
        trackSettings: { ...DEFAULT_TIMELINE_TRACK_SETTINGS },
      };

      lastSavedSnapshotRef.current = JSON.stringify({
        subtitles: [],
        markers: [],
        videoClips: [],
        audioClips: [],
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
          name: "Media",
          extensions: ["mp4", "mov", "webm", "mkv", "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"],
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
      .filter((id) =>
        timelineTrackKindFromId(id) === "audio" &&
        trackSettings[id]?.deleted !== true &&
        !trackSettings[id]?.locked &&
        !trackSettings[id]?.linkedTrackId,
      )
      .sort((a, b) => timelineTrackIndexFromId(a) - timelineTrackIndexFromId(b))[0] ?? null;

  const ensureStandaloneAudioTrack = () => {
    const existing = firstEditableStandaloneAudioTrack();
    if (existing) return existing;

    const id = nextTimelineTrackId("audio", trackSettings, videoClips, audioClips);
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
      markNextChangeImmediate();
      clearSubtitleSelection();
      clearAudioClipSelection();
      insertVideoClipFromMedia(asset, timelineTime, trackId);
      return;
    }

    if (trackKind === "audio") {
      // A linked audio row mirrors its owning video track and does not accept
      // independent media. Standalone audio rows accept audio files and the
      // audio stream of imported video files.
      if (trackSettings[trackId]?.linkedTrackId || trackSettings[trackId]?.locked) return;
      markNextChangeImmediate();
      clearSubtitleSelection();
      clearVideoClipSelection();
      insertAudioClipFromMedia(asset, timelineTime, trackId);
    }
  };

  const handleInsertMediaAtPlayhead = (asset: ProjectMediaAsset) => {
    if (asset.kind === "audio") {
      const target =
        (selectedAudioClip && !trackSettings[selectedAudioClip.trackId]?.linkedTrackId
          ? selectedAudioClip.trackId
          : null) ??
        firstEditableStandaloneAudioTrack() ??
        ensureStandaloneAudioTrack();
      insertMediaAssetOnTimeline(asset, currentTime, target);
      return;
    }

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
          matchingProject.audioClips,
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
          oldProject.audioClips,
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
        audioClips,
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
    clearAudioClipSelection();
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

  const handleExportStyledVideo = async (
    range: TimelineRange | null = null,
  ) => {
    if (!videoPath || isExporting) {
      return;
    }

    const isRangeExport = range !== null;

    try {
      const outputPath = await exportStyledVideo(videoPath, subtitles, {
        timelineDuration,
        videoClips,
        audioClips,
        trackSettings,
        range,

        onStart: () => {
          setExportProgress(0);
          setExportStatus(
            isRangeExport
              ? "Preparing selected range export..."
              : "Preparing edited timeline export...",
          );
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

      }
    } catch (error) {
      console.error(
        isRangeExport
          ? "Selected timeline range export failed:"
          : "Edited timeline export failed:",
        error,
      );
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportSelectedRange = async () => {
    if (!timelineRange) {
      return;
    }

    await handleExportStyledVideo(timelineRange);
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
        return activeClipboardKindRef.current === "audio"
          ? pasteAudioClipsAtTarget()
          : pasteVideoClipAtTarget();

      case "duplicate":
        return selectedAudioClipIds.length > 0
          ? duplicateSelectedAudioClipsWithHistory()
          : duplicateSelectedVideoClipWithHistory();

      case "select-all":
        if (selectedAudioClipIds.length > 0) {
          selectAudioClips(audioClips.map((clip) => clip.id), selectedAudioClipId);
          clearVideoClipSelection();
          clearSubtitleSelection();
        } else if (selectedVideoClipIds.length > 0) {
          selectVideoClips(videoClips.map((clip) => clip.id), selectedVideoClipId);
          clearAudioClipSelection();
          clearSubtitleSelection();
        } else {
          selectAllSubtitles();
        }
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

      case "file.export-range":
        await handleExportSelectedRange();
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
          if (!splitSelectedAudioClipAtPlayhead() && !splitSelectedVideoClipAtPlayhead()) {
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
          if (!deleteSelectedAudioClipsWithHistory() && !deleteSelectedVideoClipWithHistory()) {
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
        if (timelineRange) {
          event.preventDefault();
          if (rippleMode) {
            extractTimelineRangeWithHistory();
          } else {
            deleteTimelineRangeWithHistory();
          }
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

        if (selectedVideoClipIds.length > 0 || selectedAudioClipIds.length > 0) {
          event.preventDefault();
          void executeEditorEditCommand("cut", event.target);
        }

        return;
      }

      if (key === "c" && !event.shiftKey) {
        if (isEditingText) {
          return;
        }

        if (selectedVideoClipIds.length > 0 || selectedAudioClipIds.length > 0) {
          event.preventDefault();
          void executeEditorEditCommand("copy", event.target);
        }

        return;
      }

      if (key === "v" && !event.shiftKey) {
        if (isEditingText) {
          return;
        }

        if (videoClipboardRef.current || audioClipboardRef.current) {
          event.preventDefault();
          void executeEditorEditCommand("paste", event.target);
        }

        return;
      }

      if (key === "d" && !event.shiftKey) {
        if (isEditingText) {
          return;
        }

        if (selectedVideoClipIds.length > 0 || selectedAudioClipIds.length > 0) {
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

        if (!splitSelectedAudioClipAtPlayhead() && !splitSelectedVideoClipAtPlayhead()) {
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
            audioClips={audioClips}
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
        audioClips={audioClips}
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
        onAddTrack={handleAddTimelineTrack}
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
          void handleExportSelectedRange();
        }}
        onClearSubtitleSelection={() => {
          clearSubtitleSelection();
          clearVideoClipSelection();
          clearAudioClipSelection();
        }}
        onVideoClipSelect={handleVideoClipSelect}
        onVideoClipSelectionChange={handleVideoClipSelectionChange}
        onVideoClipMoveStart={handleVideoClipMoveStart}
        onVideoClipMoveEnd={handleVideoClipMoveEnd}
        onVideoClipMove={moveVideoClip}
        onVideoClipMoveToTrack={handleMoveVideoClipToTrack}
        onVideoClipResize={resizeVideoClip}
        onVideoTransitionChange={handleVideoTransitionChange}
        onVideoFadeChange={handleVideoFadeChange}
        onAudioFadeChange={handleAudioFadeChange}
        onAudioVolumeChange={handleAudioVolumeChange}
        onAudioMuteChange={handleAudioMuteChange}
        onCopyVideoClip={copySelectedVideoClip}
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
        onSubtitleGroupMove={moveSubtitleGroup}
        onSubtitleResize={resizeSubtitle}
        onMarkersChange={setMarkersWithHistory}
        onZoomChange={setTimelineZoom}
        onToggleTrackLock={(trackId) => toggleTrackSetting(trackId, "locked")}
        onToggleTrackMute={(trackId) => toggleTrackSetting(trackId, "muted")}
        onToggleTrackSolo={(trackId) => toggleTrackSetting(trackId, "solo")}
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
