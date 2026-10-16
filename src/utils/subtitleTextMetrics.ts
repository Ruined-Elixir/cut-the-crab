import type { LineMeasurer } from "./subtitleBackground";

/*
 * Browser text measurement for rounded subtitle backgrounds.
 *
 * measureText only matches libass when it uses the same physical font file, so
 * the font is loaded into the page once (the libass worker loads its own copy).
 * Until it is ready, callers fall back to the square background.
 */

let loadPromise: Promise<boolean> | null = null;
let ready = false;
let lineRatio = 0;
let family = "";
let context: CanvasRenderingContext2D | null = null;

export function ensureSubtitleFontLoaded(
  fontFamily: string,
  fontUrl: string,
): Promise<boolean> {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const url = new URL(fontUrl, window.location.origin).href;
      const face = new FontFace(fontFamily, `url(${url})`);
      await face.load();
      document.fonts.add(face);

      const canvasContext = document.createElement("canvas").getContext("2d");
      if (!canvasContext) throw new Error("No 2D canvas context");

      // The ASS font size is (ascent + descent), so the CSS em size is the ASS
      // size divided by this ratio. Needs real font metrics, not glyph bounds.
      canvasContext.font = `100px "${fontFamily}"`;
      const probe = canvasContext.measureText("Hg");
      if (
        typeof probe.fontBoundingBoxAscent !== "number" ||
        typeof probe.fontBoundingBoxDescent !== "number"
      ) {
        throw new Error("fontBoundingBox metrics are not supported");
      }

      const ratio = (probe.fontBoundingBoxAscent + probe.fontBoundingBoxDescent) / 100;
      if (!Number.isFinite(ratio) || ratio < 0.5) {
        throw new Error(`Unexpected font line ratio ${ratio}`);
      }

      family = fontFamily;
      context = canvasContext;
      lineRatio = ratio;
      ready = true;
    } catch (error) {
      console.error("Subtitle font measurement is unavailable:", error);
      ready = false;
    }
    return ready;
  })();

  return loadPromise;
}

export function isSubtitleFontReady(): boolean {
  return ready;
}

export function getSubtitleLineRatio(): number {
  return lineRatio;
}

/** Width in px of one line, regular weight, at the given CSS em size. */
export const measureSubtitleLine: LineMeasurer = (line, emPx, italic) => {
  if (!context) return 0;
  context.font = `${italic ? "italic " : ""}${emPx}px "${family}"`;
  return context.measureText(line).width;
};
