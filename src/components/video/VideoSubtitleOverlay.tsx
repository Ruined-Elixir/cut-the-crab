import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import SubtitlesOctopus from "@biliblitz/libass-wasm";

import {
  getSubtitleTrackId,
  type Subtitle,
  type SubtitleStyle,
} from "../../types/subtitle";

import SubtitleStyleContextMenu, {
  type SubtitleStyleScope,
} from "../subtitles/SubtitleStyleContextMenu";

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
  videoTimeOffset?: number;
  videoSourceKey?: string;

  selectedSubtitleId?: string | null;
  interactiveSubtitleIds?: string[];
  shellRef: React.RefObject<HTMLDivElement | null>;

  onSubtitleSelect?: (id: string) => void;

  onSubtitlePositionChange?: (
    id: string,
    positionX: number,
    positionY: number,
  ) => void;

  onSubtitleTextChange?: (id: string, text: string) => void;

  onSubtitleStyleChange?: (id: string, style: SubtitleStyle) => void;

  onAllSubtitleStylesChange?: (style: SubtitleStyle) => void;
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

function setRendererCurrentTime(
  renderer: SubtitlesOctopus | null,
  time: number,
) {
  const timelineRenderer = renderer as
    | (SubtitlesOctopus & {
        setCurrentTime?: (currentTime: number) => void;
      })
    | null;

  timelineRenderer?.setCurrentTime?.(time);
}

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
  videoTimeOffset = 0,
  videoSourceKey = "",
  selectedSubtitleId,
  interactiveSubtitleIds,
  shellRef,
  onSubtitleSelect,
  onSubtitlePositionChange,
  onSubtitleTextChange,
  onSubtitleStyleChange,
  onAllSubtitleStylesChange,
}: VideoSubtitleOverlayProps) {
  const [editingSubtitleId, setEditingSubtitleId] = useState<string | null>(
    null,
  );
  const [editingText, setEditingText] = useState("");

  const [styleMenu, setStyleMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [styleScope, setStyleScope] = useState<SubtitleStyleScope>("current");

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

  const styleScopeRef = useRef<SubtitleStyleScope>("current");

  const interactionButtonRef = useRef<HTMLButtonElement | null>(null);

  const canvas0Ref = useRef<HTMLCanvasElement | null>(null);
  const canvas1Ref = useRef<HTMLCanvasElement | null>(null);

  const renderer0Ref = useRef<SubtitlesOctopus | null>(null);
  const renderer1Ref = useRef<SubtitlesOctopus | null>(null);
  const currentTimeRef = useRef(currentTime);
  const videoTimeOffsetRef = useRef(videoTimeOffset);

  const frontCanvasIndexRef = useRef<0 | 1>(0);
  const renderRevisionRef = useRef(0);

  const draftPositionRef = useRef<DraftPosition | null>(null);

  const interactiveSubtitleIdSet = useMemo(
    () => (interactiveSubtitleIds ? new Set(interactiveSubtitleIds) : null),
    [interactiveSubtitleIds],
  );

  useEffect(() => {
    currentTimeRef.current = currentTime;
    videoTimeOffsetRef.current = videoTimeOffset;

    setRendererTimeOffset(renderer0Ref.current, videoTimeOffset);
    setRendererTimeOffset(renderer1Ref.current, videoTimeOffset);

    // App.currentTime is canonical timeline time. Drive libass explicitly so
    // subtitle timing stays correct even when native video time represents a
    // trimmed or moved source clip.
    setRendererCurrentTime(renderer0Ref.current, currentTime);
    setRendererCurrentTime(renderer1Ref.current, currentTime);
  }, [currentTime, videoTimeOffset]);

  const activeSubtitle = useMemo(() => {
    const active = subtitles.filter(
      (subtitle) =>
        currentTime >= subtitle.startTime &&
        currentTime <= subtitle.endTime &&
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

  const isEditing = !!activeSubtitle && editingSubtitleId === activeSubtitle.id;

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
   * This transparent DOM button is interaction-only.
   * Its text is never used as a visual substitute for libass.
   */
  const interactionStyle =
    activeSubtitle && positionStyle
      ? ({
          ...positionStyle,

          maxWidth: renderedVideoRect
            ? `${renderedVideoRect.width * 0.8}px`
            : "80%",

          fontSize: `${(activeSubtitle.fontSize ?? 24) * previewScale}px`,
          fontFamily: activeSubtitle.fontFamily ?? DEFAULT_ASS_FONT_FAMILY,
          fontWeight: activeSubtitle.isBold ? 700 : 400,
          lineHeight: 1.35,
          padding: `${8 * previewScale}px`,
          textAlign: activeSubtitle.textAlign ?? "center",

          color: "transparent",
          backgroundColor: "transparent",
          textDecoration: "none",
          textShadow: "none",
        } as CSSProperties)
      : undefined;

  /*
   * Text editing still needs a real DOM textarea.
   * This is only shown while actively typing.
   */
  const editingStyle =
    activeSubtitle && positionStyle
      ? ({
          ...positionStyle,

          maxWidth: renderedVideoRect
            ? `${renderedVideoRect.width * 0.8}px`
            : "80%",

          fontSize: `${(activeSubtitle.fontSize ?? 24) * previewScale}px`,
          fontFamily: activeSubtitle.fontFamily ?? DEFAULT_ASS_FONT_FAMILY,
          fontWeight: activeSubtitle.isBold ? 700 : 400,
          lineHeight: 1.35,
          padding: `${8 * previewScale}px`,
          textAlign: activeSubtitle.textAlign ?? "center",

          color: activeSubtitle.color ?? "#ffffff",
          backgroundColor: activeSubtitle.backgroundColor ?? "transparent",

          textDecoration: activeSubtitle.isUnderlined ? "underline" : "none",

          textShadow: `
            ${-2 * previewScale}px ${-2 * previewScale}px 0 rgba(0, 0, 0, 0.9),
            ${2 * previewScale}px ${-2 * previewScale}px 0 rgba(0, 0, 0, 0.9),
            ${-2 * previewScale}px ${2 * previewScale}px 0 rgba(0, 0, 0, 0.9),
            ${2 * previewScale}px ${2 * previewScale}px 0 rgba(0, 0, 0, 0.9)
          `,
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
    opacity: frontCanvasIndex === 0 && !isEditing ? 1 : 0,
    transform:
      frontCanvasIndex === 0 ? dragCanvasTransform : "translate(0px, 0px)",
  };

  const canvas1Style: CSSProperties = {
    opacity: frontCanvasIndex === 1 && !isEditing ? 1 : 0,
    transform:
      frontCanvasIndex === 1 ? dragCanvasTransform : "translate(0px, 0px)",
  };

  useEffect(() => {
    frontCanvasIndexRef.current = frontCanvasIndex;
  }, [frontCanvasIndex]);

  useEffect(() => {
    if (editingSubtitleId && !activeSubtitle) {
      setEditingSubtitleId(null);
    }

    if (!activeSubtitle) {
      setStyleMenu(null);
      setDraftPosition(null);
      draftPositionRef.current = null;
      setSubtitleSnapGuides([]);
    }
  }, [activeSubtitle, editingSubtitleId]);

  const startEditingSubtitle = () => {
    if (!activeSubtitle) {
      return;
    }

    onSubtitleSelect?.(activeSubtitle.id);
    setStyleMenu(null);
    setEditingSubtitleId(activeSubtitle.id);
    setEditingText(activeSubtitle.text);
  };

  const finishEditingSubtitle = () => {
    if (!activeSubtitle) {
      setEditingSubtitleId(null);
      return;
    }

    if (editingText !== activeSubtitle.text) {
      onSubtitleTextChange?.(activeSubtitle.id, editingText);
    }

    setEditingSubtitleId(null);
  };

  const cancelEditingSubtitle = () => {
    if (activeSubtitle) {
      setEditingText(activeSubtitle.text);
    }

    setEditingSubtitleId(null);
  };

  const handleSubtitlePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (
      event.button !== 0 ||
      !shellRef.current ||
      !activeSubtitle ||
      !renderedVideoRect
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    setStyleMenu(null);
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

      // If a native interaction swallowed pointerup, never leave the subtitle
      // attached to the cursor.
      if ((moveEvent.buttons & 1) === 0) {
        finishDrag();
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

  const openStyleMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!activeSubtitle) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    onSubtitleSelect?.(activeSubtitle.id);

    setStyleMenu({
      x: event.clientX,
      y: event.clientY,
    });
  };

  const getCurrentSubtitleStyle = (): SubtitleStyle | null => {
    if (!activeSubtitle) {
      return null;
    }

    return {
      fontSize: activeSubtitle.fontSize ?? 24,
      fontFamily: activeSubtitle.fontFamily ?? DEFAULT_ASS_FONT_FAMILY,
      color: activeSubtitle.color ?? "#ffffff",
      backgroundColor: activeSubtitle.backgroundColor ?? "transparent",
      isBold: activeSubtitle.isBold ?? false,
      isUnderlined: activeSubtitle.isUnderlined ?? false,
      textAlign: activeSubtitle.textAlign ?? "center",
    };
  };

  const handleStyleScopeChange = (scope: SubtitleStyleScope) => {
    styleScopeRef.current = scope;
    setStyleScope(scope);

    if (scope === "all") {
      const currentStyle = getCurrentSubtitleStyle();

      if (currentStyle) {
        onAllSubtitleStylesChange?.(currentStyle);
      }
    }
  };

  const handleStyleChange = (style: SubtitleStyle) => {
    if (!styleMenu || !activeSubtitle) {
      return;
    }

    if (styleScopeRef.current === "all") {
      onAllSubtitleStylesChange?.(style);
      return;
    }

    onSubtitleStyleChange?.(activeSubtitle.id, style);
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

    const video = shell.querySelector<HTMLVideoElement>("video");

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
  }, [shellRef, videoSourceKey]);

  /*
   * Double-buffered libass refresh.
   *
   * The currently visible renderer is never disposed before the replacement
   * renderer is ready. This is what prevents style-change flicker.
   */
  useEffect(() => {
    const shell = shellRef.current;

    if (!shell) {
      return;
    }

    const video = shell.querySelector<HTMLVideoElement>("video");

    if (!video) {
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
      renderer0Ref.current?.dispose();
      renderer0Ref.current = null;
    } else {
      renderer1Ref.current?.dispose();
      renderer1Ref.current = null;
    }

    let renderer: SubtitlesOctopus | null = null;

    /*
     * Keep libass attached to the real video element for geometry/resizing.
     * The renderer's clock is still driven explicitly from App.currentTime,
     * while timeOffset keeps native video events aligned to timeline time for
     * trimmed/moved clips.
     */
    const rendererOptions = {
      video,
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
        setRendererCurrentTime(renderer, currentTimeRef.current);

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
                renderer?.dispose();
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
                  renderer0Ref.current?.dispose();
                  renderer0Ref.current = null;
                } else {
                  renderer1Ref.current?.dispose();
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
  }, [subtitles, shellRef, videoSourceKey]);

  useEffect(() => {
    return () => {
      renderer0Ref.current?.dispose();
      renderer1Ref.current?.dispose();

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

        {activeSubtitle &&
          (isEditing && editingStyle ? (
            <textarea
              className="video-subtitle-editing"
              style={editingStyle}
              value={editingText}
              autoFocus
              onChange={(event) => setEditingText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  finishEditingSubtitle();
                }

                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelEditingSubtitle();
                }
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            />
          ) : interactionStyle ? (
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
              onContextMenu={openStyleMenu}
              onDoubleClick={(event) => {
                event.stopPropagation();
                startEditingSubtitle();
              }}
              type="button"
              aria-label={`Edit subtitle: ${activeSubtitle.text}`}
            >
              {activeSubtitle.text}
            </button>
          ) : null)}
      </div>

      {styleMenu && activeSubtitle && (
        <SubtitleStyleContextMenu
          x={styleMenu.x}
          y={styleMenu.y}
          fontSize={activeSubtitle.fontSize ?? 24}
          fontFamily={activeSubtitle.fontFamily ?? DEFAULT_ASS_FONT_FAMILY}
          color={activeSubtitle.color ?? "#ffffff"}
          backgroundColor={activeSubtitle.backgroundColor ?? "transparent"}
          isBold={activeSubtitle.isBold ?? false}
          isUnderlined={activeSubtitle.isUnderlined ?? false}
          textAlign={activeSubtitle.textAlign ?? "center"}
          scope={styleScope}
          onScopeChange={handleStyleScopeChange}
          onStyleChange={handleStyleChange}
          onClose={() => setStyleMenu(null)}
        />
      )}
    </>
  );
}

export default VideoSubtitleOverlay;
