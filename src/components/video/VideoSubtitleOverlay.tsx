import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

import SubtitlesOctopus from "@biliblitz/libass-wasm";

import {
  getSubtitleTrackId,
  type Subtitle,
} from "../../types/subtitle";

import {
  ASS_HEIGHT,
  ASS_WIDTH,
  buildAssTrack,
  DEFAULT_ASS_FONT_FAMILY,
  DEFAULT_ASS_FONT_URL,
} from "../../utils/assSubtitles";

import {
  getRenderedVideoRect,
  type RenderedVideoRect,
} from "../../utils/videoGeometry";
import {
  PROGRAM_FRAME_SNAP_THRESHOLD_PX,
  programFrameSnapLines,
  programLayoutSnapLines,
  snapProgramBoundsToLines,
  snapProgramPointToLines,
  type ProgramBounds,
  type ProgramSnapGuide,
} from "../../utils/programSnapping";

import ProgramSnapOverlay from "./ProgramSnapOverlay";

import "./VideoSubtitleOverlay.css";

type VideoSubtitleOverlayProps = {
  subtitles: Subtitle[];
  currentTime: number;
  isPlaying: boolean;
  videoSourceKey?: string;
  clockVideo?: HTMLVideoElement | null;

  selectedSubtitleId?: string | null;
  interactiveSubtitleIds?: string[];
  shellRef: React.RefObject<HTMLDivElement | null>;

  onSubtitleSelect?: (id: string) => void;

  onSubtitlePositionChange?: (
    id: string,
    positionX: number,
    positionY: number,
  ) => void;
};

type DraftPosition = {
  subtitleId: string;

  // Position baked into the currently visible/front libass canvas.
  originX: number;
  originY: number;

  // Live/current drag destination.
  positionX: number;
  positionY: number;
};

type PlaybackSyncedRenderer = SubtitlesOctopus & {
  setCurrentTime?: (time: number) => void;
  setIsPaused?: (paused: boolean, time: number) => void;
  setRate?: (rate: number) => void;
};

function syncRendererToTimelineState(
  renderer: SubtitlesOctopus | null,
  timelineTime: number,
  isPlaying: boolean,
  hardSync = false,
) {
  if (!renderer || !Number.isFinite(timelineTime)) return;

  const syncedRenderer = renderer as PlaybackSyncedRenderer;

  try {
    if (hardSync) {
      // Force an immediate paint at discontinuities (clip handoff / seek).
      // The renderer is canvas-driven, so this does not create a second media
      // clock: timelineTime already comes from the presented Program frame.
      syncedRenderer.setIsPaused?.(true, timelineTime);
      syncedRenderer.setCurrentTime?.(timelineTime);
      if (isPlaying) {
        syncedRenderer.setIsPaused?.(false, timelineTime);
      }
      return;
    }

    syncedRenderer.setCurrentTime?.(timelineTime);
  } catch (error) {
    console.error("Failed to synchronize libass timeline clock:", error);
  }
}

function clearSubtitleCanvas(canvas: HTMLCanvasElement | null) {
  const context = canvas?.getContext("2d");
  if (canvas && context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function VideoSubtitleOverlay({
  subtitles,
  currentTime,
  isPlaying,
  videoSourceKey = "",
  clockVideo = null,
  selectedSubtitleId,
  interactiveSubtitleIds,
  shellRef,
  onSubtitleSelect,
  onSubtitlePositionChange,
}: VideoSubtitleOverlayProps) {
  const [renderedVideoRect, setRenderedVideoRect] =
    useState<RenderedVideoRect | null>(null);

  /*
   * Two canvases are used as a front/back buffer:
   * - front canvas stays visible with the current exact libass frame
   * - back canvas renders the next ASS track invisibly
   * - when the back renderer is ready, the canvases swap atomically
   *
   * This removes the blank/glitchy transition during style changes.
   */
  const [frontCanvasIndex, setFrontCanvasIndex] = useState<0 | 1>(0);

  /*
   * During drag we DO NOT replace libass with CSS text.
   * We keep the exact libass canvas visible and temporarily translate it.
   * That avoids the font-size jump caused by CSS and libass having different
   * font metrics.
   */
  const [draftPosition, setDraftPosition] = useState<DraftPosition | null>(
    null,
  );
  const [subtitleSnapGuides, setSubtitleSnapGuides] = useState<
    ProgramSnapGuide[]
  >([]);
  const [subtitleMoveSnappingActive, setSubtitleMoveSnappingActive] =
    useState(false);

  const interactionButtonRef = useRef<HTMLButtonElement | null>(null);

  const canvas0Ref = useRef<HTMLCanvasElement | null>(null);
  const canvas1Ref = useRef<HTMLCanvasElement | null>(null);

  const renderer0Ref = useRef<SubtitlesOctopus | null>(null);
  const renderer1Ref = useRef<SubtitlesOctopus | null>(null);

  // @biliblitz/libass-wasm documents canvas-only mode, but its current fork
  // unconditionally calls the internal onSeeked() once at construction time.
  // That callback dereferences self.video.currentTime even when no video was
  // supplied, so a true canvas-only constructor throws before the worker can
  // become usable. Give libass a stable, detached HTMLVideoElement purely as a
  // constructor/event host. CTC still owns the subtitle clock below through
  // setCurrentTime/setIsPaused; this dummy element never plays and therefore
  // cannot compete with the Program Monitor media clock.
  const libassClockVideoRef = useRef<HTMLVideoElement | null>(null);
  if (!libassClockVideoRef.current) {
    const clock = document.createElement("video");
    clock.preload = "none";
    clock.muted = true;
    clock.playsInline = true;
    libassClockVideoRef.current = clock;
  }

  const currentTimeRef = useRef(currentTime);
  const isPlayingRef = useRef(isPlaying);
  const lastTimelineObservationRef = useRef(currentTime);
  const lastWorkerSyncAtRef = useRef(0);
  const lastVideoSourceKeyRef = useRef(videoSourceKey);
  const lastActiveSubtitleIdRef = useRef<string | null>(null);

  const frontCanvasIndexRef = useRef<0 | 1>(0);
  const renderRevisionRef = useRef(0);
  // subtitles-octopus's dispose() is not safe to call twice: once its worker
  // is torn down, a second dispose() reaches for `self.worker.postMessage`
  // on a null worker and throws. Two independent code paths can end up
  // holding a reference to the same renderer (the effect that supersedes a
  // back-buffer renderer, and that renderer's own delayed onReady callback),
  // so dispose is routed through this guard everywhere instead of being
  // called directly.
  const disposedRenderersRef = useRef(new WeakSet<SubtitlesOctopus>());
  const disposeRendererOnce = (renderer: SubtitlesOctopus | null | undefined) => {
    if (!renderer || disposedRenderersRef.current.has(renderer)) return;
    disposedRenderersRef.current.add(renderer);
    try {
      renderer.dispose();
    } catch (error) {
      console.error("Failed to dispose libass renderer:", error);
    }
  };

  const draftPositionRef = useRef<DraftPosition | null>(null);

  const interactiveSubtitleIdSet = useMemo(
    () => (interactiveSubtitleIds ? new Set(interactiveSubtitleIds) : null),
    [interactiveSubtitleIds],
  );

  currentTimeRef.current = currentTime;
  isPlayingRef.current = isPlaying;

  const syncLiveRenderers = (hardSync = false) => {
    syncRendererToTimelineState(
      renderer0Ref.current,
      currentTimeRef.current,
      isPlayingRef.current,
      hardSync,
    );
    syncRendererToTimelineState(
      renderer1Ref.current,
      currentTimeRef.current,
      isPlayingRef.current,
      hardSync,
    );
  };

  // CTC manually drives SubtitlesOctopus from canonical timeline time. Pushing
  // setCurrentTime on every Program frame can outpace its worker and grow a
  // large render queue. Keep the worker running between sparse corrections and
  // reserve immediate hard syncs for real discontinuities.
  useEffect(() => {
    const sourceChanged = lastVideoSourceKeyRef.current !== videoSourceKey;
    const jumped =
      Math.abs(currentTime - lastTimelineObservationRef.current) > 0.2;
    const hardSync = sourceChanged || jumped;
    const now = performance.now();

    currentTimeRef.current = currentTime;
    isPlayingRef.current = isPlaying;

    if (hardSync) {
      clearSubtitleCanvas(canvas0Ref.current);
      clearSubtitleCanvas(canvas1Ref.current);
    }

    // While playing, SubtitlesOctopus advances from setIsPaused(false, time).
    // Four corrections per second are enough to keep it aligned without
    // flooding the worker. Paused/seeking states still synchronize immediately.
    if (
      hardSync ||
      !isPlaying ||
      now - lastWorkerSyncAtRef.current >= 250
    ) {
      syncLiveRenderers(hardSync);
      lastWorkerSyncAtRef.current = now;
    }

    lastTimelineObservationRef.current = currentTime;
    lastVideoSourceKeyRef.current = videoSourceKey;
  }, [currentTime, isPlaying, videoSourceKey]);

  // setIsPaused controls libass's internal render-ahead behavior. Keep it in
  // lockstep with the editor transport, then seed the exact current frame.
  useEffect(() => {
    const applyTransportState = (renderer: SubtitlesOctopus | null) => {
      if (!renderer) return;
      const syncedRenderer = renderer as PlaybackSyncedRenderer;
      try {
        syncedRenderer.setRate?.(1);
        syncedRenderer.setIsPaused?.(!isPlaying, currentTimeRef.current);
        syncedRenderer.setCurrentTime?.(currentTimeRef.current);
      } catch (error) {
        console.error("Failed to update libass transport state:", error);
      }
    };

    applyTransportState(renderer0Ref.current);
    applyTransportState(renderer1Ref.current);
  }, [isPlaying]);

  const activeSubtitle = useMemo(() => {
    const active = subtitles.filter(
      (subtitle) =>
        currentTime >= subtitle.startTime &&
        currentTime < subtitle.endTime &&
        (!interactiveSubtitleIdSet ||
          interactiveSubtitleIdSet.has(subtitle.id)),
    );

    const selectedActive = selectedSubtitleId
      ? active.find((subtitle) => subtitle.id === selectedSubtitleId)
      : undefined;

    if (selectedActive) {
      return selectedActive;
    }

    return active.sort((a, b) => {
      const aIndex = Number(getSubtitleTrackId(a).split("-")[1] ?? 1);
      const bIndex = Number(getSubtitleTrackId(b).split("-")[1] ?? 1);
      return bIndex - aIndex;
    })[0];
  }, [currentTime, interactiveSubtitleIdSet, selectedSubtitleId, subtitles]);

  useEffect(() => {
    const activeId = activeSubtitle?.id ?? null;
    if (activeId === lastActiveSubtitleIdRef.current) return;

    lastActiveSubtitleIdRef.current = activeId;

    if (!activeId) {
      // wasm-blend can retain the last painted bitmap when the requested frame
      // contains no dialogue. Explicitly clear both buffers so a subtitle can
      // never remain over a no-subtitle section.
      clearSubtitleCanvas(canvas0Ref.current);
      clearSubtitleCanvas(canvas1Ref.current);
      return;
    }

    // Entering a new cue is a semantic boundary even if the media source did
    // not change. Force exactly one immediate frame so a following clip/cue
    // does not wait for a later pause/play event to become visible.
    syncLiveRenderers(true);
    lastWorkerSyncAtRef.current = performance.now();
  }, [activeSubtitle?.id]);

  const previewScale = (renderedVideoRect?.height ?? ASS_HEIGHT) / ASS_HEIGHT;

  const effectivePosition =
    activeSubtitle && draftPosition?.subtitleId === activeSubtitle.id
      ? {
          positionX: draftPosition.positionX,
          positionY: draftPosition.positionY,
        }
      : activeSubtitle
        ? {
            positionX: activeSubtitle.positionX ?? 50,
            positionY: activeSubtitle.positionY ?? 80,
          }
        : null;

  const positionStyle =
    activeSubtitle && effectivePosition
      ? {
          left: renderedVideoRect
            ? `${
                renderedVideoRect.left +
                renderedVideoRect.width * (effectivePosition.positionX / 100)
              }px`
            : `${effectivePosition.positionX}%`,

          top: renderedVideoRect
            ? `${
                renderedVideoRect.top +
                renderedVideoRect.height * (effectivePosition.positionY / 100)
              }px`
            : `${effectivePosition.positionY}%`,
        }
      : undefined;

  /*
   * Transparent DOM proxy used only as the subtitle move handle.
   *
   * The box mirrors the canonical libass background geometry:
   * - background subtitles get the same 8-design-pixel box padding
   * - transparent subtitles have no synthetic padding
   *
   * The proxy itself stays transparent so the libass canvas remains the only
   * visible subtitle renderer.
   */
  const interactionStyle =
    activeSubtitle && positionStyle
      ? ({
          ...positionStyle,

          maxWidth: renderedVideoRect
            ? `${renderedVideoRect.width * 0.92}px`
            : "92%",

          fontSize: `${(activeSubtitle.fontSize ?? 24) * previewScale}px`,
          fontFamily: activeSubtitle.fontFamily ?? DEFAULT_ASS_FONT_FAMILY,
          fontWeight: activeSubtitle.isBold ? 700 : 400,
          fontStyle: activeSubtitle.isItalic ? "italic" : "normal",
          lineHeight: 1,
          padding:
            activeSubtitle.backgroundColor &&
            activeSubtitle.backgroundColor !== "transparent"
              ? `${8 * previewScale}px`
              : "0px",
          textAlign: activeSubtitle.textAlign ?? "center",

          color: "transparent",
          backgroundColor: "transparent",
          textDecoration: activeSubtitle.isUnderlined ? "underline" : "none",
          textShadow: "none",
        } as CSSProperties)
      : undefined;

  /*
   * Translate the exact libass canvas during drag instead of showing CSS text.
   * Translation stays active after pointer-up until the rebuilt ASS renderer
   * is ready, preventing a snap back to the old position.
   */
  const dragCanvasTransform = useMemo(() => {
    if (
      !activeSubtitle ||
      !draftPosition ||
      draftPosition.subtitleId !== activeSubtitle.id ||
      !renderedVideoRect
    ) {
      return "translate(0px, 0px)";
    }

    /*
     * The parent commits the new position immediately on pointer-up.
     * activeSubtitle.positionX/Y therefore changes before the replacement
     * libass renderer is ready, while the visible front canvas still contains
     * the OLD position.
     *
     * Use the position baked into the front canvas as the transform origin.
     * This keeps the translated front canvas at the dropped position until
     * the back-buffer swaps in.
     */
    const deltaX =
      ((draftPosition.positionX - draftPosition.originX) / 100) *
      renderedVideoRect.width;

    const deltaY =
      ((draftPosition.positionY - draftPosition.originY) / 100) *
      renderedVideoRect.height;

    return `translate(${deltaX}px, ${deltaY}px)`;
  }, [activeSubtitle, draftPosition, renderedVideoRect]);

  const subtitleFrameStyle: CSSProperties = renderedVideoRect
    ? {
        left: `${renderedVideoRect.left}px`,
        top: `${renderedVideoRect.top}px`,
        width: `${renderedVideoRect.width}px`,
        height: `${renderedVideoRect.height}px`,
      }
    : {
        left: "0px",
        top: "0px",
        width: "100%",
        height: "100%",
      };

  /*
   * Keep the libass canvases inside a dedicated frame wrapper. SubtitlesOctopus
   * may resize/reposition its canvas against the full <video> element; the
   * wrapper + CSS constraints make the visible result use the same geometry as
   * the interaction proxy and the exported ASS coordinate space.
   */
  const canvas0Style: CSSProperties = {
    opacity: frontCanvasIndex === 0 ? 1 : 0,
    transform:
      frontCanvasIndex === 0 ? dragCanvasTransform : "translate(0px, 0px)",
  };

  const canvas1Style: CSSProperties = {
    opacity: frontCanvasIndex === 1 ? 1 : 0,
    transform:
      frontCanvasIndex === 1 ? dragCanvasTransform : "translate(0px, 0px)",
  };

  useEffect(() => {
    frontCanvasIndexRef.current = frontCanvasIndex;
  }, [frontCanvasIndex]);

  useEffect(() => {
    if (!activeSubtitle) {
      setDraftPosition(null);
      draftPositionRef.current = null;
      setSubtitleSnapGuides([]);
    }
  }, [activeSubtitle]);

  const handleSubtitlePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0) {
      // The Program Monitor subtitle is move-only. Suppress WebKit/browser
      // selection/context behavior for auxiliary buttons.
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (!shellRef.current || !activeSubtitle || !renderedVideoRect) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    setSubtitleSnapGuides([]);
    setSubtitleMoveSnappingActive(true);
    onSubtitleSelect?.(activeSubtitle.id);

    const subtitleId = activeSubtitle.id;
    const shell = shellRef.current;
    const frameRect = renderedVideoRect;
    const pointerId = event.pointerId;
    const dragTarget = event.currentTarget;

    const initialX = activeSubtitle.positionX ?? 50;
    const initialY = activeSubtitle.positionY ?? 80;

    /*
     * Preserve where inside the subtitle box the user grabbed it. Without this,
     * the first pointermove jumps the subtitle centre underneath the cursor.
     */
    const shellRectAtStart = shell.getBoundingClientRect();
    const initialCenterClientX =
      shellRectAtStart.left +
      frameRect.left +
      frameRect.width * (initialX / 100);
    const initialCenterClientY =
      shellRectAtStart.top +
      frameRect.top +
      frameRect.height * (initialY / 100);
    const grabOffsetX = event.clientX - initialCenterClientX;
    const grabOffsetY = event.clientY - initialCenterClientY;

    const initialProxyRect =
      interactionButtonRef.current?.getBoundingClientRect() ?? null;
    const proxyWidth = initialProxyRect?.width ?? 0;
    const proxyHeight = initialProxyRect?.height ?? 0;

    const initialDraft: DraftPosition = {
      subtitleId,
      originX: initialX,
      originY: initialY,
      positionX: initialX,
      positionY: initialY,
    };

    draftPositionRef.current = initialDraft;
    setDraftPosition(initialDraft);

    try {
      dragTarget.setPointerCapture(pointerId);
    } catch {
      // Window-level listeners below remain the fallback.
    }

    let finished = false;

    const finishDrag = () => {
      if (finished) {
        return;
      }
      finished = true;

      setSubtitleSnapGuides([]);
      setSubtitleMoveSnappingActive(false);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);

      try {
        if (dragTarget.hasPointerCapture(pointerId)) {
          dragTarget.releasePointerCapture(pointerId);
        }
      } catch {
        // The browser may already have released capture.
      }

      const finalDraft = draftPositionRef.current;

      if (
        finalDraft &&
        (Math.abs(finalDraft.positionX - (activeSubtitle.positionX ?? 50)) >
          0.0001 ||
          Math.abs(finalDraft.positionY - (activeSubtitle.positionY ?? 80)) >
            0.0001)
      ) {
        /*
         * Keep draftPosition until the new libass back-buffer finishes. This
         * keeps the exact old canvas translated at the dropped position.
         */
        onSubtitlePositionChange?.(
          finalDraft.subtitleId,
          finalDraft.positionX,
          finalDraft.positionY,
        );
      } else {
        setDraftPosition(null);
        draftPositionRef.current = null;
      }
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }

      const shellRect = shell.getBoundingClientRect();

      const centerX = moveEvent.clientX - shellRect.left - grabOffsetX;
      const centerY = moveEvent.clientY - shellRect.top - grabOffsetY;

      let x = ((centerX - frameRect.left) / frameRect.width) * 100;
      let y = ((centerY - frameRect.top) / frameRect.height) * 100;

      // Snapping v2 intentionally does not clamp subtitles to the frame. The
      // player edge is magnetic, not a wall: drag through it to continue out.
      const halfWidth = proxyWidth / 2;
      const halfHeight = proxyHeight / 2;

      const movingBounds: ProgramBounds = {
        left: centerX - halfWidth,
        right: centerX + halfWidth,
        top: centerY - halfHeight,
        bottom: centerY + halfHeight,
        centerX,
        centerY,
      };

      const frameSnapX = snapProgramBoundsToLines(
        movingBounds,
        programFrameSnapLines(shellRect.width, shellRect.height, "x"),
        shellRect.width,
        "x",
        PROGRAM_FRAME_SNAP_THRESHOLD_PX,
      );
      const frameSnapY = snapProgramBoundsToLines(
        movingBounds,
        programFrameSnapLines(shellRect.width, shellRect.height, "y"),
        shellRect.height,
        "y",
        PROGRAM_FRAME_SNAP_THRESHOLD_PX,
      );

      // Preserve the existing subtitle layout snapping, expressed in shell
      // pixels so the shared ProgramSnapOverlay can visualize the target.
      const layoutSnapX = snapProgramPointToLines(
        movingBounds.centerX,
        programLayoutSnapLines(frameRect.left, frameRect.width),
        shellRect.width,
        "x",
      );
      const layoutSnapY = snapProgramPointToLines(
        movingBounds.centerY,
        programLayoutSnapLines(frameRect.top, frameRect.height),
        shellRect.height,
        "y",
      );

      const chosenSnapX = frameSnapX.guide ? frameSnapX : layoutSnapX;
      const chosenSnapY = frameSnapY.guide ? frameSnapY : layoutSnapY;

      x += (chosenSnapX.deltaPx / frameRect.width) * 100;
      y += (chosenSnapY.deltaPx / frameRect.height) * 100;

      setSubtitleSnapGuides(
        [chosenSnapX.guide, chosenSnapY.guide].filter(
          (guide): guide is ProgramSnapGuide => guide !== null,
        ),
      );

      const currentDraft = draftPositionRef.current;
      const nextDraft: DraftPosition = {
        subtitleId,
        originX: currentDraft?.originX ?? activeSubtitle.positionX ?? 50,
        originY: currentDraft?.originY ?? activeSubtitle.positionY ?? 80,
        positionX: x,
        positionY: y,
      };

      draftPositionRef.current = nextDraft;
      setDraftPosition(nextDraft);
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) {
        return;
      }
      finishDrag();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  /*
   * Keep canvases aligned to the actual displayed video image rather than the
   * whole shell (which may contain letterbox/pillarbox space).
   */
  useEffect(() => {
    const shell = shellRef.current;

    if (!shell) {
      return;
    }

    const video =
      clockVideo ?? shell.querySelector<HTMLVideoElement>("video.video-track-layer");

    if (!video) {
      return;
    }

    const updateVideoRect = () => {
      const rect = getRenderedVideoRect(video, shell);

      if (rect) {
        setRenderedVideoRect(rect);
      }
    };

    updateVideoRect();

    const observer = new ResizeObserver(updateVideoRect);

    observer.observe(shell);
    observer.observe(video);

    video.addEventListener("loadedmetadata", updateVideoRect);

    return () => {
      observer.disconnect();
      video.removeEventListener("loadedmetadata", updateVideoRect);
    };
  }, [clockVideo, shellRef, videoSourceKey]);

  const assContent = useMemo(() => buildAssTrack(subtitles), [subtitles]);

  /*
   * Double-buffered libass refresh.
   *
   * The subtitle list can change many times per second while Ripple/Freeze or
   * other timeline gestures are previewing. Creating a fresh WASM worker for
   * every transient array would retain large heaps until WebKit/GC catches up.
   * Coalesce those transient updates and keep the visible renderer alive until
   * one replacement is genuinely ready.
   */
  useEffect(() => {
    renderRevisionRef.current += 1;
    const revision = renderRevisionRef.current;

    let cancelled = false;
    let startTimer: number | null = null;
    let firstPaintFrame: number | null = null;
    let secondPaintFrame: number | null = null;
    let swapTimer: number | null = null;
    let disposeFrame: number | null = null;
    let renderer: SubtitlesOctopus | null = null;
    let backIndex: 0 | 1 | null = null;
    let promoted = false;

    const startRenderer = () => {
      if (cancelled || revision !== renderRevisionRef.current) return;

      backIndex = frontCanvasIndexRef.current === 0 ? 1 : 0;
      const canvas = backIndex === 0 ? canvas0Ref.current : canvas1Ref.current;
      if (!canvas) return;

      const fontUrl = new URL(DEFAULT_ASS_FONT_URL, window.location.origin).href;

      // Only the non-visible buffer is replaceable. Never tear down the current
      // front renderer until the replacement has rendered and been promoted.
      if (backIndex === 0) {
        disposeRendererOnce(renderer0Ref.current);
        renderer0Ref.current = null;
      } else {
        disposeRendererOnce(renderer1Ref.current);
        renderer1Ref.current = null;
      }

      const libassClockVideo = libassClockVideoRef.current;
      if (!libassClockVideo) return;

      const rendererOptions = {
        // The biliblitz fork currently invokes onSeeked() unconditionally at
        // the end of its constructor. A detached real <video> keeps that path
        // valid while all actual subtitle timing remains manually driven from
        // CTC's presented-frame timeline clock.
        video: libassClockVideo,
        timeOffset: currentTimeRef.current,
        canvas,
        subContent: assContent,
        fonts: [fontUrl],
        fallbackFont: fontUrl,
        renderMode: "wasm-blend",
        targetFps: 24,
        // The library defaults both libass caches to unlimited. CTC subtitles
        // are ordinary dialogue tracks, so bounded caches prevent a pathological
        // subtitle/animation from consuming gigabytes of WASM memory.
        libassMemoryLimit: 64,
        libassGlyphLimit: 32,
        prescaleHeightLimit: ASS_HEIGHT,
        maxRenderHeight: ASS_HEIGHT,

        onReady: () => {
          if (
            cancelled ||
            revision !== renderRevisionRef.current ||
            backIndex === null
          ) {
            disposeRendererOnce(renderer);
            return;
          }

          syncRendererToTimelineState(
            renderer,
            currentTimeRef.current,
            isPlayingRef.current,
            true,
          );

          firstPaintFrame = window.requestAnimationFrame(() => {
            secondPaintFrame = window.requestAnimationFrame(() => {
              swapTimer = window.setTimeout(() => {
                if (
                  cancelled ||
                  revision !== renderRevisionRef.current ||
                  backIndex === null
                ) {
                  disposeRendererOnce(renderer);
                  return;
                }

                const oldFrontIndex = frontCanvasIndexRef.current;
                frontCanvasIndexRef.current = backIndex;
                promoted = true;
                setFrontCanvasIndex(backIndex);
                setDraftPosition(null);
                draftPositionRef.current = null;

                disposeFrame = window.requestAnimationFrame(() => {
                  if (oldFrontIndex === backIndex) return;
                  if (oldFrontIndex === 0) {
                    disposeRendererOnce(renderer0Ref.current);
                    renderer0Ref.current = null;
                  } else {
                    disposeRendererOnce(renderer1Ref.current);
                    renderer1Ref.current = null;
                  }
                });
              }, 50);
            });
          });
        },

        onError: (error: Error) => {
          console.error("libass preview renderer failed:", error);
        },
      } as unknown as ConstructorParameters<typeof SubtitlesOctopus>[0];

      try {
        renderer = new SubtitlesOctopus(rendererOptions);
      } catch (error) {
        console.error("Failed to initialize libass preview renderer:", error);
        return;
      }

      if (backIndex === 0) renderer0Ref.current = renderer;
      else renderer1Ref.current = renderer;
    };

    // Initial mount should render immediately. Once a renderer exists, briefly
    // debounce full ASS-track rebuilds so a drag generates one replacement
    // worker rather than dozens of short-lived workers.
    const hasLiveRenderer = !!renderer0Ref.current || !!renderer1Ref.current;
    if (hasLiveRenderer) startTimer = window.setTimeout(startRenderer, 80);
    else startRenderer();

    return () => {
      cancelled = true;
      if (startTimer !== null) window.clearTimeout(startTimer);
      if (firstPaintFrame !== null) window.cancelAnimationFrame(firstPaintFrame);
      if (secondPaintFrame !== null) window.cancelAnimationFrame(secondPaintFrame);
      if (swapTimer !== null) window.clearTimeout(swapTimer);
      if (disposeFrame !== null) window.cancelAnimationFrame(disposeFrame);

      // A renderer that never became the visible front buffer is safe to tear
      // down immediately. This closes the last worker-leak path during rapid
      // subtitle topology changes.
      if (renderer && !promoted) {
        if (renderer0Ref.current === renderer) renderer0Ref.current = null;
        if (renderer1Ref.current === renderer) renderer1Ref.current = null;
        disposeRendererOnce(renderer);
      }
    };
  }, [assContent]);

  useEffect(() => {
    return () => {
      disposeRendererOnce(renderer0Ref.current);
      disposeRendererOnce(renderer1Ref.current);

      renderer0Ref.current = null;
      renderer1Ref.current = null;
    };
  }, []);

  return (
    <>
      <div className="video-subtitle-layer">
        <ProgramSnapOverlay
          width={shellRef.current?.clientWidth ?? 0}
          height={shellRef.current?.clientHeight ?? 0}
          activeGuides={subtitleSnapGuides}
          show={subtitleMoveSnappingActive}
        />

        <div className="ass-subtitle-frame" style={subtitleFrameStyle}>
          <canvas
            ref={canvas0Ref}
            className="ass-subtitle-canvas"
            width={ASS_WIDTH}
            height={ASS_HEIGHT}
            style={canvas0Style}
          />

          <canvas
            ref={canvas1Ref}
            className="ass-subtitle-canvas"
            width={ASS_WIDTH}
            height={ASS_HEIGHT}
            style={canvas1Style}
          />
        </div>

        {activeSubtitle && interactionStyle ? (
          <button
            ref={interactionButtonRef}
            className={[
              "video-subtitle-interaction",
              selectedSubtitleId === activeSubtitle.id ? "selected" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={interactionStyle}
            onPointerDown={handleSubtitlePointerDown}
            onMouseDown={(event) => {
              if (event.button !== 0) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            onAuxClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onDragStart={(event) => event.preventDefault()}
            type="button"
            aria-label={`Move subtitle: ${activeSubtitle.text}`}
            title="Drag to move subtitle"
          >
            {activeSubtitle.text}
          </button>
        ) : null}
      </div>

    </>
  );
}

export default VideoSubtitleOverlay;
