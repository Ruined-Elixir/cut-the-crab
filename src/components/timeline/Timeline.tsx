import ToolbarMenu, { type ToolbarMenuItem } from "../common/ToolbarMenu";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { getSubtitleTrackId, type Subtitle } from "../../types/subtitle";
import type { TimelineMarker } from "../../types/timeline";
import type {
  AdjustmentLayerClip,
  AudioTimelineClip,
  TimelineTrack as TimelineTrackModel,
  TimelineTrackId,
  TimelineTrackKind,
  TimelineTrackSettings,
  VideoTimelineClip,
  VideoTransitionType,
} from "../../types/timelineModel";

import { useVideoClipFrames } from "../../hooks/useVideoClipFrames";
import {
  usePlaybackClockPlaying,
  usePlaybackClockTime,
} from "../../utils/playbackClock";
import { buildTimelineModel } from "../../utils/timelineModel";
import type { TimelineRange } from "../../utils/timelineRangeEdits";
import { videoPlaybackRate } from "../../utils/videoRetime";
import {
  collapsedCompoundTrackRegions,
  collapsedTimelineMedia,
} from "../../utils/compoundClips";

import SubtitleTrack from "./SubtitleTrack";
import TimelineRuler from "./TimelineRuler";
import TimelineTrackLabel from "./TimelineTrackLabel";
import VideoTrack, { type VideoMoveSnapTarget } from "./VideoTrack";
import WaveformTrack from "./WaveformTrack";
import {
  MAX_TIMELINE_ZOOM,
  MIN_TIMELINE_ZOOM,
  TIMELINE_ZOOM_STEP,
} from "./timelineZoom";

import "./Timeline.css";

export type TimelineHandle = {
  revealSelection: () => boolean;
  frameSelection: () => boolean;
  revealVideoClip: (id: string) => boolean;
  revealAudioClip: (id: string) => boolean;
  revealSubtitle: (id: string) => boolean;
};

type TimelineRevealTarget = {
  start: number;
  end: number;
  trackId: TimelineTrackId;
};

type TimelineProps = {
  duration: number;
  scaleDuration: number;
  waveformsBySource: Record<string, number[]>;
  proxyPathsBySource?: Record<string, string>;
  videoClips: VideoTimelineClip[];
  audioClips: AudioTimelineClip[];
  adjustmentLayers: AdjustmentLayerClip[];
  subtitles: Subtitle[];
  markers: TimelineMarker[];
  zoom: number;
  trackSettings: TimelineTrackSettings;
  timelineRange: TimelineRange | null;
  rippleMode: boolean;

  selectedSubtitleId: string | null;
  selectedSubtitleIds: string[];
  selectedVideoClipId: string | null;
  selectedVideoClipIds: string[];
  selectedAudioClipId: string | null;
  selectedAudioClipIds: string[];
  selectedAdjustmentLayerId: string | null;
  activeSubtitleTrackId: TimelineTrackId;

  onSeek?: (time: number) => void;
  onSkimPreviewChange?: (time: number | null) => void;
  onInitialFilmstripReadyChange?: (ready: boolean) => void;
  onAddTrack?: (kind: TimelineTrackKind | "video-audio") => void;
  onCreateAdjustmentLayer?: () => void;
  onAdjustmentLayerSelect?: (id: string) => void;
  onAdjustmentLayerOpen?: (id: string) => void;
  onAdjustmentLayerEditStart?: (id: string) => boolean | void;
  onAdjustmentLayerEditEnd?: () => void;
  onAdjustmentLayerMove?: (id: string, newTimelineStart: number) => void;
  onAdjustmentLayerResize?: (
    id: string,
    newTimelineStart: number,
    newTimelineEnd: number,
  ) => void;
  onOpenAdjustmentControls?: () => void;
  onDeleteTrack?: (trackId: TimelineTrackId) => void;
  onPasteTargetChange?: (trackId: TimelineTrackId, time: number) => void;
  onClearSubtitleSelection?: () => void;
  onTimelineRangeChange?: (range: TimelineRange | null) => void;
  onRippleModeChange?: (enabled: boolean) => void;
  onDeleteRange?: () => void;
  onLiftRange?: () => void;
  onExtractRange?: () => void;
  onExportRange?: () => void;

  onVideoClipSelect?: (
    id: string,
    mode?: "single" | "toggle" | "focus",
  ) => void;
  onVideoClipSelectionChange?: (
    ids: string[],
    primaryId?: string | null,
  ) => void;
  onVideoClipMoveStart?: (id: string) => boolean | void;
  onVideoClipMoveEnd?: () => void;
  onVideoClipMove?: (id: string, newTimelineStart: number) => void;
  onVideoClipResizeStart?: (id: string) => boolean | void;
  onVideoClipResize?: (
    id: string,
    newTimelineStart: number,
    newTimelineEnd: number,
  ) => void;
  onVideoClipResizeEnd?: () => void;
  onVideoPlaybackRateChange?: (id: string, playbackRate: number) => void;
  onToggleVideoReverse?: (id: string) => void;
  onInsertFreezeFrame?: (id: string) => void;
  onVideoClipMoveToTrack?: (
    id: string,
    targetTrackId: TimelineTrackId,
    newTimelineStart: number,
  ) => void;
  onCopyVideoClip?: () => void;
  onRegenerateMissingSubtitles?: (clip: VideoTimelineClip) => void | Promise<void>;

  onAudioClipSelect?: (
    id: string,
    mode?: "single" | "toggle" | "focus",
  ) => void;
  onAudioClipMoveStart?: (id: string) => boolean | void;
  onAudioClipMoveEnd?: () => void;
  onAudioClipMove?: (id: string, newTimelineStart: number) => void;
  onAudioClipMoveToTrack?: (
    id: string,
    targetTrackId: TimelineTrackId,
    newTimelineStart: number,
  ) => void;
  onAudioClipResize?: (
    id: string,
    newTimelineStart: number,
    newTimelineEnd: number,
  ) => void;
  onStandaloneAudioFadeChange?: (
    id: string,
    edge: "in" | "out",
    duration: number,
  ) => void;
  onStandaloneAudioVolumeChange?: (id: string, volume: number) => void;
  onStandaloneAudioMuteChange?: (id: string, muted: boolean) => void;

  onSubtitleSelect?: (id: string, mode?: "single" | "toggle" | "range") => void;
  onSubtitleMove?: (id: string, newStartTime: number) => void;
  onSubtitleMoveToTrack?: (
    id: string,
    targetTrackId: TimelineTrackId,
    newStartTime: number,
  ) => void;
  onSubtitleTrackActivate?: (trackId: TimelineTrackId) => void;
  onSubtitleGroupMove?: (
    ids: string[],
    anchorId: string,
    newAnchorStartTime: number,
  ) => void;
  onSubtitleResize?: (
    id: string,
    newStartTime: number,
    newEndTime: number,
  ) => void;
  onMarkersChange?: (markers: TimelineMarker[]) => void;
  onZoomChange?: (zoom: number) => void;
  onToggleTrackLock?: (trackId: TimelineTrackId) => void;
  onToggleTrackMute?: (trackId: TimelineTrackId) => void;
  onToggleTrackSolo?: (trackId: TimelineTrackId) => void;
  onToggleTrackHidden?: (trackId: TimelineTrackId) => void;
  onVideoTransitionChange?: (
    id: string,
    edge: "in" | "out",
    transition: { type?: VideoTransitionType; duration?: number },
  ) => void;
  onVideoFadeChange?: (
    id: string,
    edge: "in" | "out",
    duration: number,
  ) => void;
  onAudioFadeChange?: (
    id: string,
    edge: "in" | "out",
    duration: number,
  ) => void;
  onAudioVolumeChange?: (id: string, volume: number) => void;
  onAudioMuteChange?: (id: string, muted: boolean) => void;

  expandedCompoundId?: string | null;
  onCreateCompound?: () => void;
  onBreakApartCompound?: (compoundId: string) => void;
  onOpenCompound?: (compoundId: string) => void;
  onCloseCompound?: () => void;
};

const HALF_SECOND_RULER_THRESHOLD_SECONDS = 10;

const MIN_TRAILING_WORKSPACE_SECONDS = 10;
const MAX_TRAILING_WORKSPACE_SECONDS = 120;
const TRAILING_WORKSPACE_RATIO = 0.25;

function trailingWorkspaceDuration(contentDuration: number) {
  if (!Number.isFinite(contentDuration) || contentDuration <= 0) {
    return 30;
  }

  return Math.max(
    MIN_TRAILING_WORKSPACE_SECONDS,
    Math.min(
      MAX_TRAILING_WORKSPACE_SECONDS,
      contentDuration * TRAILING_WORKSPACE_RATIO,
    ),
  );
}

const Timeline = forwardRef<TimelineHandle, TimelineProps>(function Timeline(
  {
    duration,
    scaleDuration,
      waveformsBySource,
    proxyPathsBySource = {},
    videoClips,
    audioClips,
    adjustmentLayers,
    subtitles,
    markers,
    zoom,
    trackSettings,
    timelineRange,
    rippleMode,
    selectedSubtitleId,
    selectedSubtitleIds,
    selectedVideoClipId,
    selectedVideoClipIds,
    selectedAudioClipId,
    selectedAudioClipIds,
    selectedAdjustmentLayerId,
    activeSubtitleTrackId,
    onSeek,
    onSkimPreviewChange,
    onInitialFilmstripReadyChange,
    onAddTrack,
    onCreateAdjustmentLayer,
    onAdjustmentLayerSelect,
    onAdjustmentLayerOpen,
    onAdjustmentLayerEditStart,
    onAdjustmentLayerEditEnd,
    onAdjustmentLayerMove,
    onAdjustmentLayerResize,
    onOpenAdjustmentControls,
    onDeleteTrack,
    onPasteTargetChange,
    onClearSubtitleSelection,
    onTimelineRangeChange,
    onRippleModeChange,
    onDeleteRange,
    onLiftRange,
    onExtractRange,
    onExportRange,
    onVideoClipSelect,
    onVideoClipSelectionChange,
    onVideoClipMoveStart,
    onVideoClipMoveEnd,
    onVideoClipMove,
    onVideoClipResizeStart,
    onVideoClipResize,
    onVideoClipResizeEnd,
    onVideoPlaybackRateChange,
    onToggleVideoReverse,
    onInsertFreezeFrame,
    onVideoClipMoveToTrack,
    onCopyVideoClip,
    onRegenerateMissingSubtitles,
    onAudioClipSelect,
    onAudioClipMoveStart,
    onAudioClipMoveEnd,
    onAudioClipMove,
    onAudioClipMoveToTrack,
    onAudioClipResize,
    onStandaloneAudioFadeChange,
    onStandaloneAudioVolumeChange,
    onStandaloneAudioMuteChange,
    onSubtitleSelect,
    onSubtitleMove,
    onSubtitleMoveToTrack,
    onSubtitleTrackActivate,
    onSubtitleGroupMove,
    onSubtitleResize,
    onMarkersChange,
    onZoomChange,
    onToggleTrackLock,
    onToggleTrackMute,
    onToggleTrackSolo,
    onToggleTrackHidden,
    onVideoTransitionChange,
    onVideoFadeChange,
    onAudioFadeChange,
    onAudioVolumeChange,
    onAudioMuteChange,
    expandedCompoundId = null,
    onCreateCompound,
    onBreakApartCompound,
    onOpenCompound,
    onCloseCompound,
  }: TimelineProps,
  ref,
) {
  const currentTime = usePlaybackClockTime();
  const playbackActive = usePlaybackClockPlaying();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const skimmerRef = useRef<HTMLDivElement | null>(null);
  const skimmerTimeRef = useRef<HTMLSpanElement | null>(null);
  const skimmerFrameRef = useRef<number | null>(null);
  const skimmerActiveRef = useRef(false);
  const snapGuideRef = useRef<HTMLDivElement | null>(null);
  const rangeDragRef = useRef<{
    anchorTime: number;
    startClientX: number;
    moved: boolean;
  } | null>(null);
  const marqueeDragRef = useRef<{
    startClientX: number;
    startClientY: number;
    startLocalX: number;
    startLocalY: number;
    baseSelectedIds: string[];
    moved: boolean;
  } | null>(null);
  const suppressRangeClickRef = useRef(false);
  const suppressSelectionRevealWhileDraggingRef = useRef(false);
  const timelinePointerEditCleanupRef = useRef<(() => void) | null>(null);
  const previousZoomRef = useRef(zoom);
  const pendingFrameTargetRef = useRef<TimelineRevealTarget | null>(null);
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(0);
  const [timelineScrollLeft, setTimelineScrollLeft] = useState(0);
  const [workspaceDuration, setWorkspaceDuration] = useState(30);
  const [addTrackMenuOpen, setAddTrackMenuOpen] = useState(false);
  const [marqueeRect, setMarqueeRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  const setTimelineRange = (range: TimelineRange | null) => {
    onTimelineRangeChange?.(range);
  };

  /*
   * Timeline scale is expressed as pixels per second. `scaleDuration` is the
   * stable project/source duration supplied by App, so moving or trimming clips
   * cannot alter visual scale. Workspace duration only controls how much blank
   * timeline exists to the right.
   */
  const scaleReferenceDuration = Math.max(1, scaleDuration || duration || 1);

  /*
   * Do not let normal projects zoom far enough for the ruler to switch from
   * 1-second major labels to 0.5-second labels. Besides being more useful for
   * editing, this bounds thumbnail density at the most expensive zoom level.
   *
   * TimelineRuler switches to 0.5 s once visibleDuration <= 10 s. Round the
   * cap down to our existing 0.25 zoom increments so we remain safely on the
   * 1-second side of that boundary. Very short projects may already be below
   * 10 seconds at 100%, in which case 100% remains the minimum/maximum.
   */
  const oneSecondRulerZoomLimit =
    scaleReferenceDuration > HALF_SECOND_RULER_THRESHOLD_SECONDS
      ? Math.max(
          MIN_TIMELINE_ZOOM,
          Math.floor(
            scaleReferenceDuration /
              (HALF_SECOND_RULER_THRESHOLD_SECONDS + 0.001) /
              TIMELINE_ZOOM_STEP,
          ) * TIMELINE_ZOOM_STEP,
        )
      : 1;
  const effectiveMaxZoom = Math.max(
    MIN_TIMELINE_ZOOM,
    Math.min(MAX_TIMELINE_ZOOM, oneSecondRulerZoomLimit),
  );

  // 100% keeps the editor's established working scale. Zooming below 100%
  // is allowed only as far as the complete workspace can still fit inside the
  // viewport, which keeps timeline coordinates and hit-testing exact.
  const effectiveMinZoom = Math.max(
    MIN_TIMELINE_ZOOM,
    Math.min(
      1,
      workspaceDuration > 0 ? scaleReferenceDuration / workspaceDuration : 1,
    ),
  );

  // Fit focuses on edited content rather than the intentionally blank trailing
  // workspace. Five percent padding keeps the last clip from touching the edge.
  const fitContentDuration = Math.max(
    scaleReferenceDuration,
    Math.max(0.001, duration) * 1.05,
  );
  const fitContentZoom = Math.max(
    effectiveMinZoom,
    Math.min(1, scaleReferenceDuration / fitContentDuration),
  );

  const baseTrackWidthPx = Math.max(1, timelineViewportWidth);
  const pixelsPerSecondAt100 = baseTrackWidthPx / scaleReferenceDuration;
  const pixelsPerSecond = pixelsPerSecondAt100 * zoom;
  const timelineTrackWidthPx = Math.max(1, workspaceDuration * pixelsPerSecond);

  const workspaceWidthRatio = workspaceDuration / scaleReferenceDuration;
  const playheadPosition =
    workspaceDuration > 0 ? (currentTime / workspaceDuration) * 100 : 0;
  const visibleTimelineStart =
    pixelsPerSecond > 0 ? timelineScrollLeft / pixelsPerSecond : 0;
  const visibleTimelineEnd =
    pixelsPerSecond > 0
      ? (timelineScrollLeft + timelineViewportWidth) / pixelsPerSecond
      : workspaceDuration;

  const compoundDisplay = useMemo(
    () =>
      collapsedTimelineMedia(
        videoClips,
        audioClips,
        subtitles,
        expandedCompoundId,
      ),
    [audioClips, expandedCompoundId, subtitles, videoClips],
  );
  const displayVideoClips = compoundDisplay.videoClips;
  const displayAudioClips = compoundDisplay.audioClips;
  const displaySubtitles = compoundDisplay.subtitles;
  const expandedCompoundGroup = expandedCompoundId
    ? (compoundDisplay.groups.get(expandedCompoundId) ?? null)
    : null;
  const compoundTrackRegions = useMemo(
    () =>
      collapsedCompoundTrackRegions(
        videoClips,
        audioClips,
        subtitles,
        trackSettings,
        expandedCompoundId,
      ),
    [audioClips, expandedCompoundId, subtitles, trackSettings, videoClips],
  );
  const selectedCollapsedCompoundIds = useMemo(
    () =>
      [...compoundDisplay.groups.values()]
        .filter(
          (group) =>
            group.id !== expandedCompoundId &&
            selectedVideoClipIds.includes(group.anchorVideoId),
        )
        .map((group) => group.id),
    [compoundDisplay.groups, expandedCompoundId, selectedVideoClipIds],
  );

  const filmstripVideoClips = useMemo(
    () => displayVideoClips.filter((clip) => !clip.compoundDisplay),
    [displayVideoClips],
  );

  const { framesByClipId, initialFramesReady } = useVideoClipFrames(
    filmstripVideoClips,
    pixelsPerSecond,
    visibleTimelineStart,
    visibleTimelineEnd,
    proxyPathsBySource,
    playbackActive,
  );

  useEffect(() => {
    onInitialFilmstripReadyChange?.(initialFramesReady);
  }, [
    filmstripVideoClips,
    initialFramesReady,
    onInitialFilmstripReadyChange,
    proxyPathsBySource,
  ]);

  const markerTimes = useMemo(
    () => markers.map((marker) => marker.time).sort((a, b) => a - b),
    [markers],
  );

  const videoMoveSnapTargets = useMemo<VideoMoveSnapTarget[]>(() => {
    const clipTargets = displayVideoClips.flatMap((clip) => [
      { time: clip.timelineStart, kind: "clip" as const, clipId: clip.id },
      { time: clip.timelineEnd, kind: "clip" as const, clipId: clip.id },
    ]);

    const adjustmentTargets = adjustmentLayers.flatMap((layer) => [
      { time: layer.timelineStart, kind: "clip" as const, clipId: layer.id },
      { time: layer.timelineEnd, kind: "clip" as const, clipId: layer.id },
    ]);

    const markerTargets = markers.map((marker) => ({
      time: marker.time,
      kind: "marker" as const,
    }));

    return [
      { time: 0, kind: "timeline" as const },
      ...clipTargets,
      ...adjustmentTargets,
      ...markerTargets,
      { time: currentTime, kind: "playhead" as const },
    ];
  }, [adjustmentLayers, currentTime, displayVideoClips, markers]);

  const timelineTracks = useMemo(
    () =>
      buildTimelineModel({
        duration: workspaceDuration,
        videoClips: displayVideoClips,
        audioClips: displayAudioClips,
        subtitles: displaySubtitles,
        trackSettings,
      }),
    [
      workspaceDuration,
      displayVideoClips,
      displayAudioClips,
      displaySubtitles,
      trackSettings,
    ],
  );

  const selectionRevealTarget = useMemo<TimelineRevealTarget | null>(() => {
    if (selectedAudioClipIds.length > 0) {
      const selected = audioClips.filter((clip) =>
        selectedAudioClipIds.includes(clip.id),
      );
      if (selected.length > 0) {
        const primary =
          selected.find((clip) => clip.id === selectedAudioClipId) ??
          selected[0];
        return {
          start: Math.min(...selected.map((clip) => clip.timelineStart)),
          end: Math.max(...selected.map((clip) => clip.timelineEnd)),
          trackId: primary.trackId,
        };
      }
    }

    if (selectedVideoClipIds.length > 0) {
      const selected = videoClips.filter((clip) =>
        selectedVideoClipIds.includes(clip.id),
      );
      if (selected.length > 0) {
        const primary =
          selected.find((clip) => clip.id === selectedVideoClipId) ??
          selected[0];
        if (primary.compoundId && primary.compoundId !== expandedCompoundId) {
          const group = compoundDisplay.groups.get(primary.compoundId);
          if (group?.anchorVideoId === primary.id) {
            return {
              start: group.start,
              end: group.end,
              trackId: group.trackId,
            };
          }
        }
        return {
          start: Math.min(...selected.map((clip) => clip.timelineStart)),
          end: Math.max(...selected.map((clip) => clip.timelineEnd)),
          trackId: primary.trackId,
        };
      }
    }

    if (selectedSubtitleIds.length > 0) {
      const selected = subtitles.filter((subtitle) =>
        selectedSubtitleIds.includes(subtitle.id),
      );
      if (selected.length > 0) {
        const primary =
          selected.find((subtitle) => subtitle.id === selectedSubtitleId) ??
          selected[0];
        return {
          start: Math.min(...selected.map((subtitle) => subtitle.startTime)),
          end: Math.max(...selected.map((subtitle) => subtitle.endTime)),
          trackId: getSubtitleTrackId(primary),
        };
      }
    }

    return null;
  }, [
    audioClips,
    compoundDisplay.groups,
    expandedCompoundId,
    selectedAudioClipId,
    selectedAudioClipIds,
    selectedSubtitleId,
    selectedSubtitleIds,
    selectedVideoClipId,
    selectedVideoClipIds,
    subtitles,
    videoClips,
  ]);

  const setTimelineZoom = (nextZoom: number) => {
    const clamped = Math.max(
      effectiveMinZoom,
      Math.min(effectiveMaxZoom, nextZoom),
    );
    onZoomChange?.(clamped);
  };

  useEffect(() => {
    if (zoom > effectiveMaxZoom + 0.0001) {
      onZoomChange?.(effectiveMaxZoom);
      return;
    }

    if (zoom < effectiveMinZoom - 0.0001) {
      onZoomChange?.(effectiveMinZoom);
    }
  }, [effectiveMaxZoom, effectiveMinZoom, onZoomChange, zoom]);

  useEffect(() => {
    const stableDuration = Math.max(0, scaleDuration || duration || 0);

    if (stableDuration <= 0) {
      setWorkspaceDuration(30);
      return;
    }

    setWorkspaceDuration((current) => {
      const reserve = trailingWorkspaceDuration(stableDuration);
      const minimumWorkspace = stableDuration + reserve;
      const contentNeeds = Math.max(duration, stableDuration);
      const growThreshold = current - Math.max(4, reserve * 0.25);

      if (current < minimumWorkspace) {
        return minimumWorkspace;
      }

      if (contentNeeds >= growThreshold) {
        return Math.max(current, contentNeeds + reserve);
      }

      return current;
    });
  }, [duration, scaleDuration]);

  useEffect(() => {
    const scroll = scrollRef.current;

    if (!scroll) {
      return;
    }

    const updateViewportMetrics = () => {
      setTimelineViewportWidth(scroll.clientWidth);
      setTimelineScrollLeft(scroll.scrollLeft);
    };

    updateViewportMetrics();

    const handleScroll = () => setTimelineScrollLeft(scroll.scrollLeft);
    scroll.addEventListener("scroll", handleScroll, { passive: true });

    const observer = new ResizeObserver(updateViewportMetrics);
    observer.observe(scroll);

    return () => {
      observer.disconnect();
      scroll.removeEventListener("scroll", handleScroll);
    };
  }, []);

  useEffect(() => {
    const scroll = scrollRef.current;
    const previousZoom = previousZoomRef.current;

    previousZoomRef.current = zoom;

    if (!scroll || previousZoom === zoom || pixelsPerSecondAt100 <= 0) {
      return;
    }

    const previousPixelsPerSecond = pixelsPerSecondAt100 * previousZoom;
    const viewportCenterX = scroll.scrollLeft + scroll.clientWidth / 2;
    const centerTime = Math.max(
      0,
      viewportCenterX / Math.max(0.0001, previousPixelsPerSecond),
    );

    window.requestAnimationFrame(() => {
      const nextCenterX = centerTime * pixelsPerSecond;
      scroll.scrollLeft = Math.max(0, nextCenterX - scroll.clientWidth / 2);
    });
  }, [zoom, pixelsPerSecond, pixelsPerSecondAt100]);

  const zoomOut = () => setTimelineZoom(zoom - TIMELINE_ZOOM_STEP);
  const zoomIn = () => setTimelineZoom(zoom + TIMELINE_ZOOM_STEP);
  const fitTimelineContent = () => {
    setTimelineZoom(fitContentZoom);
    window.requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollLeft = 0;
      }
    });
  };

  const trackSelector = (trackId: TimelineTrackId) => {
    if (trackId.startsWith("video-")) {
      return `.video-track[data-video-track-id="${trackId}"]`;
    }
    if (trackId.startsWith("audio-")) {
      return `.waveform-track[data-audio-track-id="${trackId}"]`;
    }
    return `.subtitle-track[data-subtitle-track-id="${trackId}"]`;
  };

  const revealTarget = (
    target: TimelineRevealTarget,
    options: { center?: boolean; behavior?: ScrollBehavior } = {},
  ) => {
    const scroll = scrollRef.current;
    const body = bodyRef.current;
    if (!scroll || !body || pixelsPerSecond <= 0) return false;

    const safeStart = Math.max(0, Math.min(workspaceDuration, target.start));
    const safeEnd = Math.max(
      safeStart,
      Math.min(workspaceDuration, target.end),
    );
    const startPx = safeStart * pixelsPerSecond;
    const endPx = safeEnd * pixelsPerSecond;
    const behavior = options.behavior ?? "smooth";
    const horizontalMargin = Math.min(
      80,
      Math.max(24, scroll.clientWidth * 0.08),
    );

    let nextLeft = scroll.scrollLeft;
    if (options.center) {
      const centerPx = (startPx + endPx) / 2;
      nextLeft = centerPx - scroll.clientWidth / 2;
    } else if (startPx < scroll.scrollLeft + horizontalMargin) {
      nextLeft = startPx - horizontalMargin;
    } else if (
      endPx >
      scroll.scrollLeft + scroll.clientWidth - horizontalMargin
    ) {
      nextLeft = endPx - scroll.clientWidth + horizontalMargin;
    }

    const maxLeft = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
    nextLeft = Math.max(0, Math.min(maxLeft, nextLeft));
    if (
      !suppressSelectionRevealWhileDraggingRef.current &&
      Math.abs(nextLeft - scroll.scrollLeft) > 1
    ) {
      scroll.scrollTo({ left: nextLeft, behavior });
    }

    const rowTrack = scroll.querySelector(trackSelector(target.trackId));
    const row = rowTrack?.closest(".timeline-row");
    if (row instanceof HTMLElement) {
      const bodyRect = body.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const verticalMargin = 8;
      let nextTop = body.scrollTop;

      if (options.center) {
        nextTop +=
          rowRect.top +
          rowRect.height / 2 -
          (bodyRect.top + bodyRect.height / 2);
      } else if (rowRect.top < bodyRect.top + verticalMargin) {
        nextTop += rowRect.top - bodyRect.top - verticalMargin;
      } else if (rowRect.bottom > bodyRect.bottom - verticalMargin) {
        nextTop += rowRect.bottom - bodyRect.bottom + verticalMargin;
      }

      const maxTop = Math.max(0, body.scrollHeight - body.clientHeight);
      nextTop = Math.max(0, Math.min(maxTop, nextTop));
      if (Math.abs(nextTop - body.scrollTop) > 1) {
        body.scrollTo({ top: nextTop, behavior });
      }
    }

    return true;
  };

  const revealVideoClip = (id: string) => {
    const clip = videoClips.find((item) => item.id === id);
    return clip
      ? revealTarget({
          start: clip.timelineStart,
          end: clip.timelineEnd,
          trackId: clip.trackId,
        })
      : false;
  };

  const revealAudioClip = (id: string) => {
    const clip = audioClips.find((item) => item.id === id);
    return clip
      ? revealTarget({
          start: clip.timelineStart,
          end: clip.timelineEnd,
          trackId: clip.trackId,
        })
      : false;
  };

  const revealSubtitle = (id: string) => {
    const subtitle = subtitles.find((item) => item.id === id);
    return subtitle
      ? revealTarget({
          start: subtitle.startTime,
          end: subtitle.endTime,
          trackId: getSubtitleTrackId(subtitle),
        })
      : false;
  };

  const revealSelection = () =>
    selectionRevealTarget ? revealTarget(selectionRevealTarget) : false;

  const startVideoDragWithoutReveal = (id: string) => {
    suppressSelectionRevealWhileDraggingRef.current = true;
    const result = onVideoClipMoveStart?.(id);

    if (result === false) {
      suppressSelectionRevealWhileDraggingRef.current = false;
    }

    return result;
  };

  const endVideoDragWithoutReveal = () => {
    suppressSelectionRevealWhileDraggingRef.current = false;
    onVideoClipMoveEnd?.();
  };

  const startVideoResizeWithoutReveal = (id: string) => {
    suppressSelectionRevealWhileDraggingRef.current = true;
    const result = onVideoClipResizeStart?.(id);

    if (result === false) {
      suppressSelectionRevealWhileDraggingRef.current = false;
    }

    return result;
  };

  const endVideoResizeWithoutReveal = () => {
    suppressSelectionRevealWhileDraggingRef.current = false;
    onVideoClipResizeEnd?.();
  };

  const startAudioDragWithoutReveal = (id: string) => {
    suppressSelectionRevealWhileDraggingRef.current = true;
    const result = onAudioClipMoveStart?.(id);

    if (result === false) {
      suppressSelectionRevealWhileDraggingRef.current = false;
    }

    return result;
  };

  const endAudioDragWithoutReveal = () => {
    suppressSelectionRevealWhileDraggingRef.current = false;
    onAudioClipMoveEnd?.();
  };

  const startFadeResizeWithoutReveal = () => {
    suppressSelectionRevealWhileDraggingRef.current = true;
  };

  const endFadeResizeWithoutReveal = () => {
    suppressSelectionRevealWhileDraggingRef.current = false;
  };

  const frameSelection = () => {
    if (!selectionRevealTarget) return false;

    const span = Math.max(
      0.05,
      selectionRevealTarget.end - selectionRevealTarget.start,
    );
    const paddedDuration = Math.max(0.5, span * 1.4);
    const targetZoom = Math.max(
      effectiveMinZoom,
      Math.min(effectiveMaxZoom, scaleReferenceDuration / paddedDuration),
    );

    pendingFrameTargetRef.current = selectionRevealTarget;
    if (Math.abs(targetZoom - zoom) > 0.0001) {
      setTimelineZoom(targetZoom);
    } else {
      window.requestAnimationFrame(() => {
        const pending = pendingFrameTargetRef.current;
        pendingFrameTargetRef.current = null;
        if (pending) revealTarget(pending, { center: true });
      });
    }

    return true;
  };

  useImperativeHandle(ref, () => ({
    revealSelection,
    frameSelection,
    revealVideoClip,
    revealAudioClip,
    revealSubtitle,
  }));

  useEffect(() => {
    if (!selectionRevealTarget) return;
    if (suppressSelectionRevealWhileDraggingRef.current) return;
    revealTarget(selectionRevealTarget);
  }, [
    selectedAudioClipId,
    selectedAudioClipIds,
    selectedSubtitleId,
    selectedSubtitleIds,
    selectedVideoClipId,
    selectedVideoClipIds,
  ]);

  useEffect(() => {
    const pending = pendingFrameTargetRef.current;
    if (!pending) return;

    const frame = window.requestAnimationFrame(() => {
      pendingFrameTargetRef.current = null;
      revealTarget(pending, { center: true });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [zoom, pixelsPerSecond, timelineViewportWidth]);

  const addMarker = (time: number) => {
    if (workspaceDuration <= 0) {
      return;
    }

    const safeTime = Math.max(0, Math.min(workspaceDuration, time));
    const existing = markers.find(
      (marker) => Math.abs(marker.time - safeTime) < 0.05,
    );

    if (existing) {
      return;
    }

    onMarkersChange?.(
      [...markers, { id: crypto.randomUUID(), time: safeTime }].sort(
        (a, b) => a.time - b.time,
      ),
    );
  };

  const addMarkerAtEvent = (event: ReactMouseEvent<HTMLElement>) => {
    if (workspaceDuration <= 0) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);

    addMarker(ratio * workspaceDuration);
  };

  const removeMarker = (id: string) => {
    onMarkersChange?.(markers.filter((marker) => marker.id !== id));
  };

  const removeNearestMarkerAtPlayhead = () => {
    if (markers.length === 0) {
      return;
    }

    const nearest = markers.reduce((best, marker) =>
      Math.abs(marker.time - currentTime) < Math.abs(best.time - currentTime)
        ? marker
        : best,
    );

    // Only remove a marker that is reasonably close to the playhead.
    // 0.5 seconds keeps Shift+M predictable rather than deleting a distant marker.
    if (Math.abs(nearest.time - currentTime) <= 0.5) {
      removeMarker(nearest.id);
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;

      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }

      if (event.key === "Escape" && timelineRange) {
        event.preventDefault();
        setTimelineRange(null);
        return;
      }

      if (event.key.toLowerCase() === "m") {
        event.preventDefault();

        if (event.shiftKey) {
          removeNearestMarkerAtPlayhead();
        } else {
          addMarker(currentTime);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [currentTime, workspaceDuration, markers, timelineRange]);

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.metaKey && !event.ctrlKey) {
      return;
    }

    event.preventDefault();
    setTimelineZoom(
      zoom + (event.deltaY < 0 ? TIMELINE_ZOOM_STEP : -TIMELINE_ZOOM_STEP),
    );
  };

  const formatSkimmerTime = (time: number) => {
    const safeTime = Math.max(0, Number.isFinite(time) ? time : 0);
    const minutes = Math.floor(safeTime / 60);
    const seconds = safeTime - minutes * 60;

    return `${String(minutes).padStart(2, "0")}:${seconds
      .toFixed(1)
      .padStart(4, "0")}`;
  };

  const timelineTimeFromClientX = (clientX: number, element: HTMLElement) => {
    if (workspaceDuration <= 0) {
      return 0;
    }

    const rect = element.getBoundingClientRect();
    const ratio = Math.max(
      0,
      Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)),
    );

    return ratio * workspaceDuration;
  };

  const setSnapGuideTime = (time: number | null) => {
    const guide = snapGuideRef.current;

    if (!guide) {
      return;
    }

    if (time === null || workspaceDuration <= 0) {
      guide.hidden = true;
      return;
    }

    const safeTime = Math.max(0, Math.min(workspaceDuration, time));
    guide.hidden = false;
    guide.style.left = `${(safeTime / workspaceDuration) * 100}%`;
  };

  const startRangeHandleDrag = (
    event: ReactMouseEvent<HTMLButtonElement>,
    edge: "in" | "out",
  ) => {
    if (!timelineRange || workspaceDuration <= 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    hideSkimmer();

    const content = event.currentTarget.closest(
      ".timeline-content",
    ) as HTMLElement | null;

    if (!content) {
      return;
    }

    const fixedStart = timelineRange.start;
    const fixedEnd = timelineRange.end;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const time = timelineTimeFromClientX(moveEvent.clientX, content);

      setTimelineRange(
        edge === "in"
          ? { start: Math.min(time, fixedEnd), end: fixedEnd }
          : { start: fixedStart, end: Math.max(time, fixedStart) },
      );
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const beginTimelinePointerEdit = (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;

    const scroll = scrollRef.current;
    if (!scroll) return;

    timelinePointerEditCleanupRef.current?.();
    suppressSelectionRevealWhileDraggingRef.current = true;
    // A drag owns the timeline pointer until mouseup. Clear a live skim once
    // here instead of sending setSkimPreviewTime(null) on every pointermove.
    hideSkimmer();

    const target = event.target as HTMLElement;
    const autoScrollEnabled = !target.closest(
      ".audio-volume-handle, .timeline-user-marker, input, select, textarea",
    );
    const startClientX = event.clientX;
    let lastClientX = event.clientX;
    let lastClientY = event.clientY;
    let moved = false;
    let frameId: number | null = null;
    let disposed = false;

    const scheduleAutoScroll = () => {
      if (disposed || frameId !== null || !moved || !autoScrollEnabled) return;
      frameId = window.requestAnimationFrame(runAutoScroll);
    };

    const runAutoScroll = () => {
      frameId = null;
      if (disposed || !moved) return;

      const rect = scroll.getBoundingClientRect();
      const edgeSize = Math.min(48, Math.max(32, rect.width * 0.055));
      const maxStep = 18;
      let step = 0;

      if (lastClientX <= rect.left + edgeSize) {
        const strength = Math.max(
          0,
          Math.min(1, (rect.left + edgeSize - lastClientX) / edgeSize),
        );
        step = -Math.max(2, maxStep * strength);
      } else if (lastClientX >= rect.right - edgeSize) {
        const strength = Math.max(
          0,
          Math.min(1, (lastClientX - (rect.right - edgeSize)) / edgeSize),
        );
        step = Math.max(2, maxStep * strength);
      }

      if (step !== 0) {
        const maxLeft = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
        const nextLeft = Math.max(0, Math.min(maxLeft, scroll.scrollLeft + step));
        if (Math.abs(nextLeft - scroll.scrollLeft) > 0.25) {
          scroll.scrollLeft = nextLeft;
          // Keep the active drag/trim advancing even when the pointer is held
          // still against the viewport edge. Track drag handlers include the
          // scroll delta in their time calculation, so this synthetic move
          // turns the newly revealed space into real object movement.
          window.dispatchEvent(
            new MouseEvent("mousemove", {
              clientX: lastClientX,
              clientY: lastClientY,
              buttons: 1,
            }),
          );
        }
        scheduleAutoScroll();
      }
    };

    const handleMove = (moveEvent: MouseEvent) => {
      if ((moveEvent.buttons & 1) === 0) {
        cleanup();
        return;
      }

      lastClientX = moveEvent.clientX;
      lastClientY = moveEvent.clientY;
      if (!moved && Math.abs(lastClientX - startClientX) >= 4) moved = true;
      scheduleAutoScroll();
    };

    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = null;
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", cleanup);
      window.removeEventListener("blur", cleanup);
      suppressSelectionRevealWhileDraggingRef.current = false;
      if (timelinePointerEditCleanupRef.current === cleanup) {
        timelinePointerEditCleanupRef.current = null;
      }
    };

    timelinePointerEditCleanupRef.current = cleanup;
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", cleanup);
    window.addEventListener("blur", cleanup);
  };

  const handleTimelineMouseDownCapture = (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    beginTimelinePointerEdit(event);
    handleRangeMouseDownCapture(event);
  };

  const handleRangeMouseDownCapture = (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0 || workspaceDuration <= 0) {
      return;
    }

    const target = event.target as HTMLElement;
    const editableSurface = target.closest(
      ".timeline-ruler-scale, .video-track, .subtitle-track, .waveform-track",
    );

    if (!editableSurface) {
      return;
    }

    if (
      target.closest(
        ".timeline-video-clip, .timeline-adjustment-layer, .subtitle-clip, .audio-clip-label, .timeline-user-marker, .timeline-range-handle, button, input",
      )
    ) {
      return;
    }

    const marqueeSurface = target.closest(
      ".video-track, .subtitle-track, .waveform-track",
    );

    if (event.shiftKey && marqueeSurface) {
      event.preventDefault();
      event.stopPropagation();
      hideSkimmer();

      const content = event.currentTarget;
      const contentRect = content.getBoundingClientRect();
      const startLocalX = event.clientX - contentRect.left;
      const startLocalY = event.clientY - contentRect.top;

      marqueeDragRef.current = {
        startClientX: event.clientX,
        startClientY: event.clientY,
        startLocalX,
        startLocalY,
        baseSelectedIds:
          event.metaKey || event.ctrlKey ? [...selectedVideoClipIds] : [],
        moved: false,
      };
      suppressRangeClickRef.current = true;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const drag = marqueeDragRef.current;

        if (!drag) {
          return;
        }

        const dx = moveEvent.clientX - drag.startClientX;
        const dy = moveEvent.clientY - drag.startClientY;

        if (!drag.moved && Math.hypot(dx, dy) < 4) {
          return;
        }

        drag.moved = true;
        moveEvent.preventDefault();

        const currentLocalX = Math.max(
          0,
          Math.min(contentRect.width, moveEvent.clientX - contentRect.left),
        );
        const currentLocalY = Math.max(
          0,
          Math.min(contentRect.height, moveEvent.clientY - contentRect.top),
        );
        const left = Math.min(drag.startLocalX, currentLocalX);
        const top = Math.min(drag.startLocalY, currentLocalY);
        const width = Math.abs(currentLocalX - drag.startLocalX);
        const height = Math.abs(currentLocalY - drag.startLocalY);

        setMarqueeRect({ left, top, width, height });

        const selectionLeft = contentRect.left + left;
        const selectionRight = selectionLeft + width;
        const selectionTop = contentRect.top + top;
        const selectionBottom = selectionTop + height;
        const hitIds = (
          Array.from(
            content.querySelectorAll(
              ".timeline-video-clip[data-video-clip-id]",
            ),
          ) as HTMLElement[]
        )
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.right >= selectionLeft &&
              rect.left <= selectionRight &&
              rect.bottom >= selectionTop &&
              rect.top <= selectionBottom
            );
          })
          .map((element) => element.dataset.videoClipId)
          .filter((id): id is string => !!id);

        const nextIds = [...new Set([...drag.baseSelectedIds, ...hitIds])];
        onVideoClipSelectionChange?.(
          nextIds,
          selectedVideoClipId && nextIds.includes(selectedVideoClipId)
            ? selectedVideoClipId
            : (hitIds[hitIds.length - 1] ??
                nextIds[nextIds.length - 1] ??
                null),
        );
      };

      const handleMouseUp = () => {
        marqueeDragRef.current = null;
        setMarqueeRect(null);
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);

        window.setTimeout(() => {
          suppressRangeClickRef.current = false;
        }, 0);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const content = event.currentTarget;
    const anchorTime = timelineTimeFromClientX(event.clientX, content);

    // Range-selection capture owns empty-track clicks, so record a video paste
    // destination here before stopping propagation. Clip clicks are handled by
    // VideoTrack itself and therefore preserve the exact clicked time as well.
    const videoSurface = editableSurface.closest(
      ".video-track[data-video-track-id]",
    ) as HTMLElement | null;
    const pasteTrackId = videoSurface?.dataset.videoTrackId;
    if (pasteTrackId) {
      onPasteTargetChange?.(pasteTrackId, anchorTime);
    }

    rangeDragRef.current = {
      anchorTime,
      startClientX: event.clientX,
      moved: false,
    };
    suppressRangeClickRef.current = true;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const drag = rangeDragRef.current;

      if (!drag) {
        return;
      }

      if (!drag.moved && Math.abs(moveEvent.clientX - drag.startClientX) < 4) {
        return;
      }

      drag.moved = true;
      hideSkimmer();
      moveEvent.preventDefault();

      const current = timelineTimeFromClientX(moveEvent.clientX, content);
      setTimelineRange({
        start: Math.min(drag.anchorTime, current),
        end: Math.max(drag.anchorTime, current),
      });
    };

    const handleMouseUp = (upEvent: MouseEvent) => {
      const drag = rangeDragRef.current;

      if (drag) {
        if (drag.moved) {
          const current = timelineTimeFromClientX(upEvent.clientX, content);
          setTimelineRange({
            start: Math.min(drag.anchorTime, current),
            end: Math.max(drag.anchorTime, current),
          });
        } else {
          onSeek?.(drag.anchorTime);
        }
      }

      rangeDragRef.current = null;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);

      window.setTimeout(() => {
        suppressRangeClickRef.current = false;
      }, 0);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleRangeClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressRangeClickRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  };

  const hideSkimmer = () => {
    if (skimmerFrameRef.current !== null) {
      window.cancelAnimationFrame(skimmerFrameRef.current);
      skimmerFrameRef.current = null;
    }

    if (skimmerRef.current) {
      skimmerRef.current.hidden = true;
    }

    if (!skimmerActiveRef.current) return;
    skimmerActiveRef.current = false;
    onSkimPreviewChange?.(null);
  };

  const handleSkimmerPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (workspaceDuration <= 0) {
      hideSkimmer();
      return;
    }

    // Do not fight timeline edits while the primary pointer button is down.
    // Using a bit-mask rather than `buttons !== 0` is more reliable in
    // WKWebView/trackpad input and avoids disabling hover preview because of
    // auxiliary-button state.
    if ((event.buttons & 1) !== 0) {
      return;
    }

    const scroll = scrollRef.current;
    if (!scroll) {
      hideSkimmer();
      return;
    }

    const rect = scroll.getBoundingClientRect();

    // The fixed track-label column is outside the editable timeline surface.
    // Only skim when the pointer is horizontally inside the scroll viewport.
    if (event.clientX < rect.left || event.clientX > rect.right) {
      hideSkimmer();
      return;
    }

    const localContentX =
      event.clientX - rect.left + Math.max(0, scroll.scrollLeft);
    const ratio = Math.max(
      0,
      Math.min(1, localContentX / Math.max(1, timelineTrackWidthPx)),
    );
    const time = ratio * workspaceDuration;

    if (skimmerFrameRef.current !== null) {
      window.cancelAnimationFrame(skimmerFrameRef.current);
    }

    skimmerFrameRef.current = window.requestAnimationFrame(() => {
      skimmerFrameRef.current = null;

      const skimmer = skimmerRef.current;
      const label = skimmerTimeRef.current;

      if (!skimmer || !label) {
        return;
      }

      skimmer.hidden = false;
      skimmer.style.left = `${ratio * 100}%`;
      label.textContent = formatSkimmerTime(time);

      // Keep the time badge inside the visible timeline at the extreme edges.
      const visibleRatio =
        (event.clientX - rect.left) / Math.max(1, rect.width);
      if (visibleRatio < 0.045) {
        label.style.transform = "translateX(6px)";
      } else if (visibleRatio > 0.955) {
        label.style.transform = "translateX(calc(-100% - 6px))";
      } else {
        label.style.transform = "translateX(-50%)";
      }

      skimmerActiveRef.current = true;
      onSkimPreviewChange?.(time);
    });
  };

  useEffect(() => {
    return () => timelinePointerEditCleanupRef.current?.();
  }, []);

  useEffect(() => {
    return () => {
      if (skimmerFrameRef.current !== null) {
        window.cancelAnimationFrame(skimmerFrameRef.current);
      }
      if (skimmerActiveRef.current) {
        skimmerActiveRef.current = false;
        onSkimPreviewChange?.(null);
      }
    };
  }, [onSkimPreviewChange]);

  const selectCollapsedCompoundRegion = (
    compoundId: string,
    mode: "single" | "toggle" | "focus" = "single",
  ) => {
    const group = compoundDisplay.groups.get(compoundId);
    if (!group) return;
    onVideoClipSelect?.(group.anchorVideoId, mode);
  };

  const startCollapsedCompoundRegionMove = (compoundId: string) => {
    const group = compoundDisplay.groups.get(compoundId);
    if (!group) return false;
    return startVideoDragWithoutReveal(group.anchorVideoId);
  };

  const moveCollapsedCompoundRegion = (
    compoundId: string,
    newTimelineStart: number,
  ) => {
    const group = compoundDisplay.groups.get(compoundId);
    if (!group) return;
    onVideoClipMove?.(group.anchorVideoId, newTimelineStart);
  };

  const renderTimelineTrack = (track: TimelineTrackModel) => {
    switch (track.kind) {
      case "video":
        return (
          <VideoTrack
            key={track.id}
            duration={workspaceDuration}
            currentTime={currentTime}
            track={track}
            adjustmentLayers={adjustmentLayers.filter(
              (layer) => layer.trackId === track.id,
            )}
            selectedAdjustmentLayerId={selectedAdjustmentLayerId}
            onAdjustmentLayerSelect={onAdjustmentLayerSelect}
            onAdjustmentLayerOpen={onAdjustmentLayerOpen}
            onAdjustmentLayerEditStart={onAdjustmentLayerEditStart}
            onAdjustmentLayerEditEnd={onAdjustmentLayerEditEnd}
            onAdjustmentLayerMove={onAdjustmentLayerMove}
            onAdjustmentLayerResize={onAdjustmentLayerResize}
            selectedVideoClipId={selectedVideoClipId}
            selectedVideoClipIds={selectedVideoClipIds}
            framesByClipId={framesByClipId}
            showLabel={false}
            onSeek={onSeek}
            onSelect={onVideoClipSelect}
            onMoveStart={startVideoDragWithoutReveal}
            onMoveEnd={endVideoDragWithoutReveal}
            onMove={onVideoClipMove}
            onMoveToTrack={onVideoClipMoveToTrack}
            onResizeStart={startVideoResizeWithoutReveal}
            onResize={onVideoClipResize}
            onResizeEnd={endVideoResizeWithoutReveal}
            onToggleLock={onToggleTrackLock}
            onToggleHidden={onToggleTrackHidden}
            onTransitionChange={onVideoTransitionChange}
            onFadeChange={onVideoFadeChange}
            onFadeResizeStart={startFadeResizeWithoutReveal}
            onFadeResizeEnd={endFadeResizeWithoutReveal}
            onPasteTargetChange={onPasteTargetChange}
            snapTargets={videoMoveSnapTargets}
            onSnapGuideChange={setSnapGuideTime}
            onRevealClip={(clip) =>
              revealTarget({
                start: clip.timelineStart,
                end: clip.timelineEnd,
                trackId: clip.trackId,
              })
            }
            onRegenerateMissingSubtitles={onRegenerateMissingSubtitles}
            onOpenCompound={onOpenCompound}
            expandedCompoundId={expandedCompoundId}
          />
        );

      case "subtitle":
        return (
          <SubtitleTrack
            key={track.id}
            duration={workspaceDuration}
            pixelsPerSecond={pixelsPerSecond}
            track={track}
            subtitles={displaySubtitles.filter(
              (subtitle) => getSubtitleTrackId(subtitle) === track.id,
            )}
            selectedSubtitleId={selectedSubtitleId}
            selectedSubtitleIds={selectedSubtitleIds}
            markerTimes={markerTimes}
            playheadTime={currentTime}
            showLabel={false}
            onSubtitleSelect={onSubtitleSelect}
            onSubtitleMove={onSubtitleMove}
            onSubtitleMoveToTrack={onSubtitleMoveToTrack}
            onTrackActivate={onSubtitleTrackActivate}
            onSubtitleGroupMove={onSubtitleGroupMove}
            onSubtitleResize={onSubtitleResize}
            onSeek={onSeek}
            onToggleLock={onToggleTrackLock}
            onToggleHidden={onToggleTrackHidden}
            onRevealSubtitle={(subtitle) =>
              revealTarget({
                start: subtitle.startTime,
                end: subtitle.endTime,
                trackId: getSubtitleTrackId(subtitle),
              })
            }
          />
        );

      case "audio":
        return (
          <WaveformTrack
            key={track.id}
            duration={workspaceDuration}
            track={track}
            waveformsBySource={waveformsBySource}
            selectedVideoClipIds={selectedVideoClipIds}
            selectedAudioClipId={selectedAudioClipId}
            selectedAudioClipIds={selectedAudioClipIds}
            linkedTrackId={trackSettings[track.id]?.linkedTrackId}
            showLabel={false}
            onSeek={onSeek}
            onPasteTargetChange={onPasteTargetChange}
            onToggleMute={onToggleTrackMute}
            onSelect={onAudioClipSelect}
            onMoveStart={startAudioDragWithoutReveal}
            onMoveEnd={endAudioDragWithoutReveal}
            onMove={onAudioClipMove}
            onMoveToTrack={onAudioClipMoveToTrack}
            onResize={onAudioClipResize}
            onLinkedFadeChange={onAudioFadeChange}
            onLinkedVolumeChange={onAudioVolumeChange}
            onLinkedMuteChange={onAudioMuteChange}
            onStandaloneFadeChange={onStandaloneAudioFadeChange}
            onStandaloneVolumeChange={onStandaloneAudioVolumeChange}
            onStandaloneMuteChange={onStandaloneAudioMuteChange}
            onRevealClip={(clip) =>
              revealTarget({
                start: clip.timelineStart,
                end: clip.timelineEnd,
                trackId: track.id,
              })
            }
            compoundRegions={compoundTrackRegions.audio.filter(
              (region) => region.trackId === track.id,
            )}
            selectedCompoundIds={selectedCollapsedCompoundIds}
            onCompoundSelect={selectCollapsedCompoundRegion}
            onCompoundOpen={onOpenCompound}
            onCompoundMoveStart={startCollapsedCompoundRegionMove}
            onCompoundMove={moveCollapsedCompoundRegion}
            onCompoundMoveEnd={endVideoDragWithoutReveal}
            expandedCompoundId={expandedCompoundId}
          />
        );

      default:
        return null;
    }
  };

  useEffect(() => {
    const handleFitShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      const targetElement = target instanceof HTMLElement ? target : null;
      const activeElement =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const isTextEditingElement = (element: HTMLElement | null) =>
        !!element &&
        (element.isContentEditable ||
          !!element.closest(
            "input, textarea, select, [contenteditable='true']",
          ));

      // F is a timeline command only when the user is not typing/editing text.
      // Checking both the event target and activeElement keeps subtitle-list
      // editing safe even if WKWebView dispatches the key event from window.
      if (
        isTextEditingElement(targetElement) ||
        isTextEditingElement(activeElement) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "f"
      ) {
        return;
      }

      event.preventDefault();
      fitTimelineContent();
    };

    window.addEventListener("keydown", handleFitShortcut);
    return () => window.removeEventListener("keydown", handleFitShortcut);
  });

  useEffect(() => {
    if (!addTrackMenuOpen) return;

    const close = () => setAddTrackMenuOpen(false);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [addTrackMenuOpen]);

  const renderFixedTrackLabel = (track: TimelineTrackModel) => {
    const rowClass =
      track.kind === "video"
        ? "timeline-video-row"
        : track.kind === "subtitle"
          ? "timeline-subtitle-row"
          : "timeline-waveform-row";
    const linkedTrackId = trackSettings[track.id]?.linkedTrackId;
    const isLinkedAudioTrack = track.kind === "audio" && !!linkedTrackId;
    const canDeleteTrack =
      track.kind === "video" ||
      (track.kind === "subtitle" && track.index > 1) ||
      (track.kind === "audio" && !isLinkedAudioTrack);

    const isActiveSubtitleTrack =
      track.kind === "subtitle" && track.id === activeSubtitleTrackId;

    return (
      <div
        key={`label-${track.id}`}
        className={[
          "timeline-fixed-label-row",
          rowClass,
          isActiveSubtitleTrack ? "active-subtitle-track" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => {
          if (track.kind === "subtitle") {
            onSubtitleTrackActivate?.(track.id);
          }
        }}
      >
        <TimelineTrackLabel
          shortLabel={track.shortLabel}
          name={track.name}
          locked={track.locked}
          muted={track.muted}
          solo={track.solo}
          hidden={track.hidden}
          canMute={track.kind === "audio"}
          canSolo={track.kind === "audio"}
          canHide={track.kind !== "audio"}
          onToggleLock={
            track.kind !== "audio" || !isLinkedAudioTrack
              ? () => onToggleTrackLock?.(track.id)
              : undefined
          }
          onToggleMute={
            track.kind === "audio"
              ? () => onToggleTrackMute?.(track.id)
              : undefined
          }
          onToggleSolo={
            track.kind === "audio"
              ? () => onToggleTrackSolo?.(track.id)
              : undefined
          }
          onToggleHidden={
            track.kind !== "audio"
              ? () => onToggleTrackHidden?.(track.id)
              : undefined
          }
          onDelete={
            canDeleteTrack && onDeleteTrack
              ? () => onDeleteTrack(track.id)
              : undefined
          }
        />
      </div>
    );
  };

  const singleSelectedVideoClip =
    selectedVideoClipIds.length === 1
      ? (videoClips.find((clip) => clip.id === selectedVideoClipIds[0]) ?? null)
      : null;
  const selectedCompoundId = (() => {
    const compoundId = singleSelectedVideoClip?.compoundId;
    if (
      !compoundId ||
      compoundId === expandedCompoundId ||
      !singleSelectedVideoClip
    ) {
      return null;
    }
    return compoundDisplay.groups.get(compoundId)?.anchorVideoId ===
      singleSelectedVideoClip.id
      ? compoundId
      : null;
  })();
  const mixedSelectionCount =
    selectedVideoClipIds.length +
    selectedAudioClipIds.length +
    selectedSubtitleIds.length;
  const canCreateCompound =
    mixedSelectionCount >= 2 && selectedVideoClipIds.length > 0;

  const retimeLocked = !!singleSelectedVideoClip &&
    (trackSettings[singleSelectedVideoClip.trackId]?.locked ||
      singleSelectedVideoClip.freezeFrameSourceTime !== undefined);
  const toolsMenuItems: ToolbarMenuItem[] = [];
  if (timelineRange) {
    toolsMenuItems.push(
      { kind: "heading", id: "h-range", label: "Range" },
      { kind: "action", id: "range-delete", label: rippleMode ? "Delete range (ripple)" : "Delete range", onSelect: () => onDeleteRange?.() },
      { kind: "action", id: "range-lift", label: "Lift range", onSelect: () => onLiftRange?.() },
      { kind: "action", id: "range-extract", label: "Extract range", onSelect: () => onExtractRange?.() },
      { kind: "action", id: "range-export", label: "Export range", onSelect: () => onExportRange?.() },
      { kind: "separator", id: "s-range" },
    );
  }
  if (singleSelectedVideoClip && !selectedCompoundId) {
    const currentRate = videoPlaybackRate(singleSelectedVideoClip);
    toolsMenuItems.push({ kind: "heading", id: "h-speed", label: "Speed" });
    for (const rate of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]) {
      toolsMenuItems.push({ kind: "action", id: `speed-${rate}`, role: "radio", label: `${rate}x`, checked: Math.abs(currentRate - rate) < 0.001, disabled: retimeLocked, onSelect: () => onVideoPlaybackRateChange?.(singleSelectedVideoClip.id, rate) });
    }
    toolsMenuItems.push(
      { kind: "separator", id: "s-speed" },
      { kind: "action", id: "reverse", role: "checkbox", label: "Reverse", checked: singleSelectedVideoClip.playbackDirection === "reverse", disabled: retimeLocked, onSelect: () => onToggleVideoReverse?.(singleSelectedVideoClip.id) },
      { kind: "action", id: "freeze", label: "Freeze frame", disabled: retimeLocked, onSelect: () => onInsertFreezeFrame?.(singleSelectedVideoClip.id) },
      { kind: "separator", id: "s-retime" },
    );
  }
  if (!expandedCompoundId) {
    toolsMenuItems.push({ kind: "action", id: "adjustment", label: "Add adjustment layer", onSelect: () => onCreateAdjustmentLayer?.() });
    if (selectedAdjustmentLayerId) toolsMenuItems.push({ kind: "action", id: "adjustment-controls", label: "Adjustment controls", onSelect: () => onOpenAdjustmentControls?.() });
    toolsMenuItems.push({ kind: "action", id: "compound-create", label: "Create compound", disabled: !canCreateCompound, onSelect: () => onCreateCompound?.() });
    if (selectedCompoundId) toolsMenuItems.push(
      { kind: "action", id: "compound-open", label: "Open compound", onSelect: () => onOpenCompound?.(selectedCompoundId) },
      { kind: "action", id: "compound-break", label: "Break apart compound", onSelect: () => onBreakApartCompound?.(selectedCompoundId) },
    );
  } else {
    toolsMenuItems.push({ kind: "action", id: "compound-done", label: "Done editing compound", onSelect: () => onCloseCompound?.() });
  }
  toolsMenuItems.push(
    { kind: "separator", id: "s-edit" },
    { kind: "action", id: "copy", label: "Copy clips", disabled: selectedVideoClipIds.length === 0, onSelect: () => onCopyVideoClip?.() },
    { kind: "action", id: "fit", label: "Fit timeline", onSelect: () => fitTimelineContent() },
    { kind: "action", id: "frame", label: "Frame selection", disabled: !selectionRevealTarget, onSelect: () => frameSelection() },
  );

  return (
    <section className="timeline-panel">
      <div className="timeline-header">
        <div className="timeline-title-group">
          <div className="timeline-title-with-add">
            <h2>Timeline</h2>
            <div
              className="timeline-add-track-wrap"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="timeline-add-track-button"
                aria-label="Add timeline track"
                aria-haspopup="menu"
                aria-expanded={addTrackMenuOpen}
                title="Add track"
                onClick={() => setAddTrackMenuOpen((current) => !current)}
              >
                +
              </button>

              {addTrackMenuOpen && (
                <div className="timeline-add-track-menu" role="menu">
                  {[
                    [
                      "video-audio",
                      "Video + Audio",
                      "Linked picture and sound",
                      "V+A",
                    ],
                    ["video", "Video", "Visual-only track", "V"],
                    ["audio", "Audio", "Independent audio track", "A"],
                    ["subtitle", "Subtitle", "Text / caption track", "S"],
                  ].map(([kind, label, description, badge]) => (
                    <button
                      key={kind}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAddTrack?.(kind as TimelineTrackKind | "video-audio");
                        setAddTrackMenuOpen(false);
                      }}
                    >
                      <span className={`timeline-add-track-badge ${kind}`}>
                        {badge}
                      </span>
                      <span className="timeline-add-track-copy">
                        <strong>{label}</strong>
                        <small>{description}</small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <span className="timeline-help">
            Cmd/Ctrl-click clips across tracks to build a mixed selection ·
            Compound groups them · R toggles Ripple
          </span>
        </div>

        <div className="timeline-controls">
          {timelineRange && (
            <div
              className="timeline-range-summary"
              title="Selected timeline range"
            >
              <span>
                {formatSkimmerTime(timelineRange.start)}–
                {formatSkimmerTime(timelineRange.end)}
                <strong>
                  {(timelineRange.end - timelineRange.start).toFixed(2)}s
                </strong>
              </span>

              <div
                className="timeline-range-actions"
                aria-label="Range edit actions"
              >
                <button
                  type="button"
                  className="timeline-range-command"
                  onClick={onDeleteRange}
                  title={
                    rippleMode
                      ? "Ripple-delete range and close the gap (Delete / Backspace)"
                      : "Delete range and leave a gap (Delete / Backspace)"
                  }
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="timeline-range-command"
                  onClick={onLiftRange}
                  title="Lift range and leave a gap"
                >
                  Lift
                </button>
                <button
                  type="button"
                  className="timeline-range-command"
                  onClick={onExtractRange}
                  title="Extract range and ripple later content left"
                >
                  Extract
                </button>
                <button
                  type="button"
                  className="timeline-range-command timeline-range-export"
                  onClick={onExportRange}
                  title="Export only the selected range"
                >
                  Export
                </button>
                <button
                  type="button"
                  className="timeline-range-clear"
                  onClick={() => setTimelineRange(null)}
                  aria-label="Clear timeline range"
                  title="Clear range (Esc)"
                >
                  ×
                </button>
              </div>
            </div>
          )}

          <button
            type="button"
            className={`timeline-ripple-toggle ${rippleMode ? "active" : ""}`.trim()}
            aria-pressed={rippleMode}
            onClick={() => onRippleModeChange?.(!rippleMode)}
            title={
              rippleMode
                ? "Ripple mode is on: deletes close gaps and inserts push later clips (R)"
                : "Ripple mode is off: normal freeform timeline editing (R)"
            }
          >
            <span className="timeline-ripple-symbol" aria-hidden="true">
              ⇥
            </span>
            Ripple
          </button>

          <div className="timeline-tools-inline">
          {singleSelectedVideoClip && !selectedCompoundId && (
            <label
              className="timeline-speed-control"
              title={
                rippleMode
                  ? "Change clip speed; Ripple mode shifts later clips to match the new duration"
                  : "Change clip speed; slower speeds require free space after the clip"
              }
            >
              <span>Speed</span>
              <select
                value={videoPlaybackRate(singleSelectedVideoClip)}
                disabled={
                  trackSettings[singleSelectedVideoClip.trackId]?.locked ||
                  singleSelectedVideoClip.freezeFrameSourceTime !== undefined
                }
                onChange={(event) =>
                  onVideoPlaybackRateChange?.(
                    singleSelectedVideoClip.id,
                    Number(event.target.value),
                  )
                }
                aria-label="Selected video clip speed"
              >
                {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((rate) => (
                  <option key={rate} value={rate}>
                    {rate}×
                  </option>
                ))}
              </select>
            </label>
          )}

          {singleSelectedVideoClip && !selectedCompoundId && (
            <div
              className="timeline-retime-actions"
              aria-label="Retime clip actions"
            >
              <button
                type="button"
                className={`timeline-action-button ${singleSelectedVideoClip.playbackDirection === "reverse" ? "active" : ""}`.trim()}
                disabled={
                  trackSettings[singleSelectedVideoClip.trackId]?.locked ||
                  singleSelectedVideoClip.freezeFrameSourceTime !== undefined
                }
                onClick={() =>
                  onToggleVideoReverse?.(singleSelectedVideoClip.id)
                }
                title="Reverse the selected video clip"
              >
                Reverse
              </button>
              <button
                type="button"
                className="timeline-action-button"
                disabled={
                  trackSettings[singleSelectedVideoClip.trackId]?.locked ||
                  singleSelectedVideoClip.freezeFrameSourceTime !== undefined
                }
                onClick={() =>
                  onInsertFreezeFrame?.(singleSelectedVideoClip.id)
                }
                title="Insert a 2-second freeze frame at the playhead"
              >
                Freeze
              </button>
            </div>
          )}

          {!expandedCompoundId && (
            <div
              className="timeline-adjustment-actions"
              aria-label="Adjustment layer actions"
            >
              <button
                type="button"
                className="timeline-action-button adjustment"
                onClick={onCreateAdjustmentLayer}
                title="Create an adjustment layer at the playhead or selected range"
              >
                + Adjustment
              </button>
              {selectedAdjustmentLayerId && (
                <button
                  type="button"
                  className="timeline-action-button"
                  onClick={onOpenAdjustmentControls}
                  title="Open Adjustment Layer controls"
                >
                  Controls
                </button>
              )}
            </div>
          )}

          {expandedCompoundId && (
            <div
              className="timeline-compound-editing"
              title="Editing compound contents in place"
            >
              <span
                className="timeline-compound-editing-icon"
                aria-hidden="true"
              >
                <svg viewBox="0 0 20 20">
                  <path d="M4.5 7.2 10 4l5.5 3.2L10 10.4 4.5 7.2Z" />
                  <path d="m4.5 10.1 5.5 3.2 5.5-3.2" />
                  <path d="m4.5 13 5.5 3.2 5.5-3.2" />
                </svg>
              </span>
              <span className="timeline-compound-editing-copy">
                <strong>
                  {expandedCompoundGroup?.name ?? "Compound Clip"}
                </strong>
                <small>
                  {expandedCompoundGroup?.memberCount ?? 0} items · editing
                  contents
                </small>
              </span>
              <button
                type="button"
                className="timeline-action-button active"
                onClick={onCloseCompound}
              >
                Done
              </button>
            </div>
          )}

          {!expandedCompoundId && (
            <div
              className="timeline-compound-actions"
              aria-label="Compound clip actions"
            >
              <button
                type="button"
                className="timeline-action-button"
                onClick={onCreateCompound}
                disabled={!canCreateCompound}
                title="Collapse the mixed selection into a compound clip"
              >
                Compound
              </button>
              {selectedCompoundId && (
                <>
                  <button
                    type="button"
                    className="timeline-action-button"
                    onClick={() => onOpenCompound?.(selectedCompoundId)}
                    title="Open compound contents"
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    className="timeline-action-button"
                    onClick={() => onBreakApartCompound?.(selectedCompoundId)}
                    title="Return compound members to normal timeline clips"
                  >
                    Break Apart
                  </button>
                </>
              )}
            </div>
          )}

          <div
            className="timeline-edit-actions"
            aria-label="Video clip actions"
          >
            <button
              type="button"
              className="timeline-action-button"
              onClick={onCopyVideoClip}
              disabled={selectedVideoClipIds.length === 0}
              title="Copy selected video clip(s) (⌘C / Ctrl+C)"
            >
              Copy
            </button>
          </div>

          </div>
          <ToolbarMenu className="timeline-tools-menu" label="Tools" title="Clip, range and compound tools" items={toolsMenuItems} />

          <button
            type="button"
            className="timeline-zoom-button"
            onClick={zoomOut}
            disabled={zoom <= effectiveMinZoom + 0.0001}
            aria-label="Zoom timeline out"
          >
            −
          </button>

          <button
            type="button"
            className="timeline-fit-button"
            onClick={fitTimelineContent}
            disabled={Math.abs(zoom - fitContentZoom) < 0.0001}
            title="Fit edited timeline content in view"
            aria-label="Fit timeline content"
          >
            Fit
          </button>

          <button
            type="button"
            className="timeline-fit-button"
            onClick={frameSelection}
            disabled={!selectionRevealTarget}
            title="Frame selected clip(s) in the timeline"
            aria-label="Frame timeline selection"
          >
            Frame
          </button>

          <input
            className="timeline-zoom-slider"
            type="range"
            min={effectiveMinZoom}
            max={effectiveMaxZoom}
            step="any"
            value={zoom}
            onChange={(event) => setTimelineZoom(Number(event.target.value))}
            aria-label="Timeline zoom"
          />

          <button
            type="button"
            className="timeline-zoom-button"
            onClick={zoomIn}
            disabled={zoom >= effectiveMaxZoom - 0.0001}
            aria-label="Zoom timeline in"
          >
            +
          </button>

          <button
            type="button"
            className="timeline-zoom-label timeline-zoom-reset-button"
            onClick={() => setTimelineZoom(1)}
            disabled={Math.abs(zoom - 1) < 0.0001}
            title="Reset timeline zoom to 100%"
          >
            {Math.round(zoom * 100)}%
          </button>
        </div>
      </div>

      <div
        ref={bodyRef}
        className="timeline-body"
        onPointerMoveCapture={handleSkimmerPointerMove}
        onPointerLeave={hideSkimmer}
      >
        <div className="timeline-sticky-ruler" aria-label="Timeline time ruler">
          <div className="timeline-sticky-ruler-surface">
            <div
              className="timeline-sticky-ruler-label-spacer"
              aria-hidden="true"
            />
            <div className="timeline-sticky-ruler-viewport">
              <div
                className="timeline-sticky-ruler-track"
                style={{
                  width: `${timelineTrackWidthPx}px`,
                  transform: `translateX(-${timelineScrollLeft}px)`,
                }}
              >
                <TimelineRuler
                  duration={workspaceDuration}
                  zoom={zoom * workspaceWidthRatio}
                  currentTime={currentTime}
                  onSeek={onSeek}
                  showLabelSpacer={false}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="timeline-fixed-column" aria-label="Timeline tracks">
          <div className="timeline-fixed-ruler-spacer" />
          <div className="timeline-fixed-track-stack">
            {timelineTracks.map(renderFixedTrackLabel)}
          </div>
        </div>

        <div ref={scrollRef} className="timeline-scroll" onWheel={handleWheel}>
          <div
            className="timeline-content"
            data-workspace-duration={workspaceDuration}
            style={{
              width: `${timelineTrackWidthPx}px`,
            }}
            onMouseDownCapture={handleTimelineMouseDownCapture}
            onClickCapture={handleRangeClickCapture}
          >
            <TimelineRuler
              duration={workspaceDuration}
              zoom={zoom * workspaceWidthRatio}
              currentTime={currentTime}
              onSeek={onSeek}
              showLabelSpacer={false}
            />

            <div
              ref={skimmerRef}
              className="timeline-skimmer"
              hidden
              aria-hidden="true"
            >
              <span className="timeline-skimmer-cap" />
              <span ref={skimmerTimeRef} className="timeline-skimmer-time" />
            </div>

            {marqueeRect && (
              <div
                className="timeline-marquee-selection"
                style={{
                  left: `${marqueeRect.left}px`,
                  top: `${marqueeRect.top}px`,
                  width: `${marqueeRect.width}px`,
                  height: `${marqueeRect.height}px`,
                }}
                aria-hidden="true"
              />
            )}

            {timelineRange && workspaceDuration > 0 && (
              <div
                className="timeline-range-selection"
                style={{
                  left: `${(timelineRange.start / workspaceDuration) * 100}%`,
                  width: `${
                    ((timelineRange.end - timelineRange.start) /
                      workspaceDuration) *
                    100
                  }%`,
                }}
                aria-label={`Selected range ${timelineRange.start.toFixed(2)} to ${timelineRange.end.toFixed(2)} seconds`}
              >
                <button
                  type="button"
                  className="timeline-range-handle in"
                  onMouseDown={(event) => startRangeHandleDrag(event, "in")}
                  aria-label="Adjust range in point"
                />
                <span className="timeline-range-duration">
                  {(timelineRange.end - timelineRange.start).toFixed(2)}s
                </span>
                <button
                  type="button"
                  className="timeline-range-handle out"
                  onMouseDown={(event) => startRangeHandleDrag(event, "out")}
                  aria-label="Adjust range out point"
                />
              </div>
            )}

            <div
              className="timeline-track-stack"
              onDoubleClick={addMarkerAtEvent}
              onMouseDown={(event) => {
                const target = event.target as HTMLElement;

                if (
                  target.closest(".subtitle-clip") ||
                  target.closest(".timeline-user-marker") ||
                  target.closest("button") ||
                  target.closest("input")
                ) {
                  return;
                }

                onClearSubtitleSelection?.();
              }}
            >
              {timelineTracks.map(renderTimelineTrack)}

              <div className="timeline-marker-layer" aria-hidden="true">
                {markers.map((marker) => (
                  <button
                    key={marker.id}
                    type="button"
                    className="timeline-user-marker"
                    style={{
                      left: `${
                        workspaceDuration > 0
                          ? (marker.time / workspaceDuration) * 100
                          : 0
                      }%`,
                    }}
                    title={`Marker ${marker.time.toFixed(2)}s — click to remove`}
                    onClick={(event) => {
                      event.stopPropagation();
                      removeMarker(marker.id);
                    }}
                  >
                    <span className="timeline-user-marker-cap" />
                  </button>
                ))}
              </div>

              <div
                ref={snapGuideRef}
                className="timeline-video-snap-guide"
                hidden
                aria-hidden="true"
              >
                <span />
              </div>

              <div
                className="timeline-playhead"
                style={{
                  left: `${playheadPosition}%`,
                }}
                aria-hidden="true"
              >
                <span className="timeline-playhead-cap" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
});

export default Timeline;
