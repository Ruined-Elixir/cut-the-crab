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

import type { Subtitle, SubtitleStyle } from "../../types/subtitle";

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

import "./VideoSubtitleOverlay.css";

type VideoSubtitleOverlayProps = {
  subtitles: Subtitle[];
  currentTime: number;

  selectedSubtitleId?: string | null;
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
  positionX: number;
  positionY: number;
};

const RENDERER_REFRESH_DELAY_MS = 60;

function VideoSubtitleOverlay({
  subtitles,
  currentTime,
  selectedSubtitleId,
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

  const [isDragging, setIsDragging] = useState(false);
  const [draftPosition, setDraftPosition] = useState<DraftPosition | null>(null);
  const [draftStyle, setDraftStyle] = useState<SubtitleStyle>({});
  const [waitingForLibass, setWaitingForLibass] = useState(false);

  const styleScopeRef = useRef<SubtitleStyleScope>("current");
  const interactionButtonRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<SubtitlesOctopus | null>(null);

  const draftPositionRef = useRef<DraftPosition | null>(null);

  /*
   * Every local visual change increments this revision. A renderer that
   * finishes later is only allowed to clear the CSS draft if it represents
   * the newest revision.
   */
  const visualRevisionRef = useRef(0);

  const activeSubtitle = useMemo(
    () =>
      subtitles.find(
        (subtitle) =>
          currentTime >= subtitle.startTime &&
          currentTime <= subtitle.endTime,
      ),
    [subtitles, currentTime],
  );

  const displaySubtitle = useMemo(() => {
    if (!activeSubtitle) {
      return null;
    }

    const position =
      draftPosition?.subtitleId === activeSubtitle.id
        ? {
            positionX: draftPosition.positionX,
            positionY: draftPosition.positionY,
          }
        : {};

    return {
      ...activeSubtitle,
      ...draftStyle,
      ...position,
    };
  }, [activeSubtitle, draftPosition, draftStyle]);

  const isEditing =
    !!activeSubtitle && editingSubtitleId === activeSubtitle.id;

  /*
   * While the user is dragging or waiting for a freshly rendered ASS frame,
   * show an immediate CSS draft and hide the old libass frame. Once libass
   * reports ready, the CSS draft disappears and the exact ASS rendering takes
   * over again.
   */
  const showImmediateDraft = isDragging || waitingForLibass;

  const previewScale =
    (renderedVideoRect?.height ?? ASS_HEIGHT) / ASS_HEIGHT;

  const positionStyle = displaySubtitle
    ? {
        left: renderedVideoRect
          ? `${
              renderedVideoRect.left +
              renderedVideoRect.width *
                ((displaySubtitle.positionX ?? 50) / 100)
            }px`
          : `${displaySubtitle.positionX ?? 50}%`,

        top: renderedVideoRect
          ? `${
              renderedVideoRect.top +
              renderedVideoRect.height *
                ((displaySubtitle.positionY ?? 80) / 100)
            }px`
          : `${displaySubtitle.positionY ?? 80}%`,
      }
    : undefined;

  const interactionStyle =
    displaySubtitle && positionStyle
      ? ({
          ...positionStyle,

          maxWidth: renderedVideoRect
            ? `${renderedVideoRect.width * 0.8}px`
            : "80%",

          fontSize: `${(displaySubtitle.fontSize ?? 24) * previewScale}px`,

          fontFamily:
            displaySubtitle.fontFamily ?? DEFAULT_ASS_FONT_FAMILY,

          fontWeight: displaySubtitle.isBold ? 700 : 400,

          lineHeight: 1.35,

          padding: `${8 * previewScale}px`,

          textAlign: displaySubtitle.textAlign ?? "center",

          /*
           * Normally the interaction button is invisible. It becomes the
           * instant visual draft only while libass catches up.
           */
          color: showImmediateDraft
            ? (displaySubtitle.color ?? "#ffffff")
            : "transparent",

          backgroundColor: showImmediateDraft
            ? (displaySubtitle.backgroundColor ?? "transparent")
            : "transparent",

          textDecoration:
            showImmediateDraft && displaySubtitle.isUnderlined
              ? "underline"
              : "none",

          textShadow: showImmediateDraft
            ? `
              ${-2 * previewScale}px ${-2 * previewScale}px 0 rgba(0, 0, 0, 0.9),
              ${2 * previewScale}px ${-2 * previewScale}px 0 rgba(0, 0, 0, 0.9),
              ${-2 * previewScale}px ${2 * previewScale}px 0 rgba(0, 0, 0, 0.9),
              ${2 * previewScale}px ${2 * previewScale}px 0 rgba(0, 0, 0, 0.9)
            `
            : "none",
        } as CSSProperties)
      : undefined;

  const editingStyle =
    displaySubtitle && positionStyle
      ? ({
          ...positionStyle,

          maxWidth: renderedVideoRect
            ? `${renderedVideoRect.width * 0.8}px`
            : "80%",

          fontSize: `${(displaySubtitle.fontSize ?? 24) * previewScale}px`,
          fontFamily:
            displaySubtitle.fontFamily ?? DEFAULT_ASS_FONT_FAMILY,
          fontWeight: displaySubtitle.isBold ? 700 : 400,
          lineHeight: 1.35,
          padding: `${8 * previewScale}px`,
          textAlign: displaySubtitle.textAlign ?? "center",

          color: displaySubtitle.color ?? "#ffffff",
          backgroundColor:
            displaySubtitle.backgroundColor ?? "transparent",
          textDecoration: displaySubtitle.isUnderlined
            ? "underline"
            : "none",

          textShadow: `
            ${-2 * previewScale}px ${-2 * previewScale}px 0 rgba(0, 0, 0, 0.9),
            ${2 * previewScale}px ${-2 * previewScale}px 0 rgba(0, 0, 0, 0.9),
            ${-2 * previewScale}px ${2 * previewScale}px 0 rgba(0, 0, 0, 0.9),
            ${2 * previewScale}px ${2 * previewScale}px 0 rgba(0, 0, 0, 0.9)
          `,
        } as CSSProperties)
      : undefined;

  const canvasStyle = renderedVideoRect
    ? {
        left: `${renderedVideoRect.left}px`,
        top: `${renderedVideoRect.top}px`,
        width: `${renderedVideoRect.width}px`,
        height: `${renderedVideoRect.height}px`,
        opacity: isEditing || showImmediateDraft ? 0 : 1,
      }
    : {
        left: "0px",
        top: "0px",
        width: "100%",
        height: "100%",
        opacity: isEditing || showImmediateDraft ? 0 : 1,
      };

  const markVisualUpdatePending = () => {
    visualRevisionRef.current += 1;
    setWaitingForLibass(true);
  };

  useEffect(() => {
    if (editingSubtitleId && !activeSubtitle) {
      setEditingSubtitleId(null);
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
      markVisualUpdatePending();
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
    if (event.button !== 0 || !shellRef.current || !activeSubtitle) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    setStyleMenu(null);
    onSubtitleSelect?.(activeSubtitle.id);

    const subtitleId = activeSubtitle.id;
    const shell = shellRef.current;

    const initialDraft: DraftPosition = {
      subtitleId,
      positionX: activeSubtitle.positionX ?? 50,
      positionY: activeSubtitle.positionY ?? 80,
    };

    draftPositionRef.current = initialDraft;
    setDraftPosition(initialDraft);
    setIsDragging(true);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const video = shell.querySelector<HTMLVideoElement>("video");

      if (!video) {
        return;
      }

      const shellRect = shell.getBoundingClientRect();
      const videoRect = getRenderedVideoRect(video, shell);

      if (!videoRect) {
        return;
      }

      const proxyRect = interactionButtonRef.current?.getBoundingClientRect();

      const videoLeft = shellRect.left + videoRect.left;
      const videoTop = shellRect.top + videoRect.top;

      let x = ((moveEvent.clientX - videoLeft) / videoRect.width) * 100;
      let y = ((moveEvent.clientY - videoTop) / videoRect.height) * 100;

      if (proxyRect) {
        const halfWidthPercent = (proxyRect.width / videoRect.width) * 50;
        const halfHeightPercent = (proxyRect.height / videoRect.height) * 50;

        x = Math.max(halfWidthPercent, Math.min(100 - halfWidthPercent, x));
        y = Math.max(halfHeightPercent, Math.min(100 - halfHeightPercent, y));
      } else {
        x = Math.max(0, Math.min(100, x));
        y = Math.max(0, Math.min(100, y));
      }

      const nextDraft: DraftPosition = {
        subtitleId,
        positionX: x,
        positionY: y,
      };

      draftPositionRef.current = nextDraft;
      setDraftPosition(nextDraft);
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);

      const finalDraft = draftPositionRef.current;

      setIsDragging(false);

      if (
        finalDraft &&
        (finalDraft.positionX !== (activeSubtitle.positionX ?? 50) ||
          finalDraft.positionY !== (activeSubtitle.positionY ?? 80))
      ) {
        markVisualUpdatePending();

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

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
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
        setDraftStyle((current) => ({
          ...current,
          ...currentStyle,
        }));

        markVisualUpdatePending();
        onAllSubtitleStylesChange?.(currentStyle);
      }
    }
  };

  const handleStyleChange = (style: SubtitleStyle) => {
    if (!styleMenu || !activeSubtitle) {
      return;
    }

    /*
     * Update the DOM draft immediately. The exact libass rendering will
     * replace it once the rebuilt ASS track is ready.
     */
    setDraftStyle((current) => ({
      ...current,
      ...style,
    }));

    markVisualUpdatePending();

    if (styleScopeRef.current === "all") {
      onAllSubtitleStylesChange?.(style);
      return;
    }

    onSubtitleStyleChange?.(activeSubtitle.id, style);
  };

  /*
   * Keep the libass canvas aligned with the actual rendered video picture,
   * excluding letterbox/pillarbox space.
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
  }, [shellRef]);

  /*
   * Browser preview and FFmpeg export both consume the same complete ASS
   * track. This package version has no setTrack(), so changes are rebuilt
   * after a short debounce.
   */
  useEffect(() => {
    const shell = shellRef.current;
    const canvas = canvasRef.current;

    if (!shell || !canvas) {
      return;
    }

    const video = shell.querySelector<HTMLVideoElement>("video");

    if (!video) {
      return;
    }

    const revisionAtScheduleTime = visualRevisionRef.current;

    const timeoutId = window.setTimeout(() => {
      const assContent = buildAssTrack(subtitles);

      const fontUrl = new URL(
        DEFAULT_ASS_FONT_URL,
        window.location.origin,
      ).href;

      rendererRef.current?.dispose();

      const renderer = new SubtitlesOctopus({
        video,
        canvas,
        subContent: assContent,

        fonts: [fontUrl],
        fallbackFont: fontUrl,

        renderMode: "wasm-blend",

        prescaleHeightLimit: ASS_HEIGHT,
        maxRenderHeight: ASS_HEIGHT,

        onReady: () => {
          /*
           * Only the newest renderer is allowed to hand control back from
           * the instant CSS draft to libass.
           */
          if (revisionAtScheduleTime === visualRevisionRef.current) {
            setWaitingForLibass(false);
            setDraftStyle({});
            setDraftPosition(null);
            draftPositionRef.current = null;
          }
        },

        onError: (error: Error) => {
          console.error("libass preview renderer failed:", error);

          if (revisionAtScheduleTime === visualRevisionRef.current) {
            setWaitingForLibass(false);
          }
        },
      });

      rendererRef.current = renderer;
    }, RENDERER_REFRESH_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [subtitles, shellRef]);

  /*
   * Dispose the active worker only when the overlay itself unmounts.
   */
  useEffect(() => {
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, []);

  return (
    <>
      <div className="video-subtitle-layer">
        <canvas
          ref={canvasRef}
          className="ass-subtitle-canvas"
          width={ASS_WIDTH}
          height={ASS_HEIGHT}
          style={canvasStyle}
        />

        {activeSubtitle &&
          displaySubtitle &&
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
              {displaySubtitle.text}
            </button>
          ) : null)}
      </div>

      {styleMenu && activeSubtitle && (
        <SubtitleStyleContextMenu
          x={styleMenu.x}
          y={styleMenu.y}
          fontSize={displaySubtitle?.fontSize ?? activeSubtitle.fontSize ?? 24}
          fontFamily={
            displaySubtitle?.fontFamily ??
            activeSubtitle.fontFamily ??
            DEFAULT_ASS_FONT_FAMILY
          }
          color={
            displaySubtitle?.color ?? activeSubtitle.color ?? "#ffffff"
          }
          backgroundColor={
            displaySubtitle?.backgroundColor ??
            activeSubtitle.backgroundColor ??
            "transparent"
          }
          isBold={
            displaySubtitle?.isBold ?? activeSubtitle.isBold ?? false
          }
          isUnderlined={
            displaySubtitle?.isUnderlined ??
            activeSubtitle.isUnderlined ??
            false
          }
          textAlign={
            displaySubtitle?.textAlign ??
            activeSubtitle.textAlign ??
            "center"
          }
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
