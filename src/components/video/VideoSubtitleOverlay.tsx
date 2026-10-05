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
  videoSourceKey?: string;
  clockVideo?: HTMLVideoElement | null;
  videoTimeOffset?: number;

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

function setRendererTimeOffset(
  renderer: SubtitlesOctopus | null,
  timeOffset: number,
) {
  const timelineRenderer = renderer as
    | (SubtitlesOctopus & {
        timeOffset?: number;
      })
    | null;

  if (timelineRenderer) {
    timelineRenderer.timeOffset = timeOffset;
  }
}

function VideoSubtitleOverlay({
  subtitles,
  currentTime,
  videoSourceKey = "",
  clockVideo = null,
  videoTimeOffset = 0,
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
  const videoTimeOffsetRef = useRef(videoTimeOffset);

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

  useEffect(() => {
    videoTimeOffsetRef.current = videoTimeOffset;
    setRendererTimeOffset(renderer0Ref.current, videoTimeOffset);
    setRendererTimeOffset(renderer1Ref.current, videoTimeOffset);
  }, [videoTimeOffset]);

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

  /*
   * Double-buffered libass refresh.
   *
   * The currently visible renderer is never disposed before the replacement
   * renderer is ready. This is what prevents style-change flicker.
   */
  useEffect(() => {
    if (!clockVideo) {
      return;
    }

    const backIndex: 0 | 1 = frontCanvasIndexRef.current === 0 ? 1 : 0;

    const canvas = backIndex === 0 ? canvas0Ref.current : canvas1Ref.current;

    if (!canvas) {
      return;
    }

    renderRevisionRef.current += 1;
    const revision = renderRevisionRef.current;

    const assContent = buildAssTrack(subtitles);

    const fontUrl = new URL(DEFAULT_ASS_FONT_URL, window.location.origin).href;

    /*
     * Dispose only the renderer already attached to the BACK canvas.
     * The visible/front renderer stays alive.
     */
    if (backIndex === 0) {
      disposeRendererOnce(renderer0Ref.current);
      renderer0Ref.current = null;
    } else {
      disposeRendererOnce(renderer1Ref.current);
      renderer1Ref.current = null;
    }

    let renderer: SubtitlesOctopus | null = null;

    /*
     * @biliblitz/libass-wasm is the video-attached fork used by CTC. Keep
     * exactly one renderer clock: the HTMLVideoElement's native media clock.
     * CTC updates only timeOffset so source-media time maps into canonical
     * timeline time for moved/trimmed/retimed clips. Do not also call
     * setCurrentTime() while a video is attached; that reintroduces the
     * two-clock flicker/early-cue regression.
     */
    const rendererOptions = {
      video: clockVideo,
      canvas,
      subContent: assContent,

      fonts: [fontUrl],
      fallbackFont: fontUrl,

      renderMode: "wasm-blend",

      prescaleHeightLimit: ASS_HEIGHT,
      maxRenderHeight: ASS_HEIGHT,
      timeOffset: videoTimeOffsetRef.current,

      onReady: () => {
        setRendererTimeOffset(renderer, videoTimeOffsetRef.current);

        /*
         * onReady means the new worker/libass instance is initialized, but it
         * does NOT necessarily mean the new subtitle frame has already been
         * painted into the back canvas.
         *
         * Swapping canvases immediately here can therefore expose a blank
         * back canvas for a moment, which looks like a flash.
         *
         * Give the new renderer a couple of browser frames plus a short paint
         * grace period before making it visible. The old front canvas remains
         * visible and translated at the dropped position during this time.
         */
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            window.setTimeout(() => {
              /*
               * Ignore stale workers if another subtitle change happened
               * while this renderer was starting/painting.
               */
              if (revision !== renderRevisionRef.current) {
                // Another effect run may have already superseded and
                // disposed THIS SAME renderer object (it's reachable via
                // renderer0Ref/renderer1Ref, not just this closure). The
                // guard makes that safe either way.
                disposeRendererOnce(renderer);
                return;
              }

              const oldFrontIndex = frontCanvasIndexRef.current;

              frontCanvasIndexRef.current = backIndex;
              setFrontCanvasIndex(backIndex);

              /*
               * The replacement ASS renderer now contains the committed drag
               * position, so the temporary translation is no longer needed.
               */
              setDraftPosition(null);
              draftPositionRef.current = null;

              /*
               * Wait one more frame before disposing the old renderer so the
               * newly visible canvas has definitely been composited.
               */
              window.requestAnimationFrame(() => {
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
      /*
       * A synchronous libass constructor failure must never take down the
       * entire React editor. Keep the project open and surface the real
       * renderer error in DevTools instead of producing a grey screen.
       */
      console.error("Failed to initialize libass preview renderer:", error);
      return;
    }

    if (backIndex === 0) {
      renderer0Ref.current = renderer;
    } else {
      renderer1Ref.current = renderer;
    }
  }, [clockVideo, subtitles, videoSourceKey]);

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
