import { useState } from "react";
import SubtitlesOctopus from "@biliblitz/libass-wasm";

import {
  ASS_HEIGHT,
  ASS_WIDTH,
  DEFAULT_ASS_FONT_FAMILY,
  DEFAULT_ASS_FONT_URL,
} from "../utils/assSubtitles";

/*
 * Phase 5 experiment, run 2: rounded subtitle backgrounds.
 * DEV ONLY. Delete this file after the experiment.
 *
 * Changes from run 1:
 *  - Cue text is raw text with "\n" for line breaks and is escaped for ASS the
 *    same way the app does it (braces and backslashes), so "{gjy}" is no longer
 *    swallowed as an override block.
 *  - Bold cases are measured two ways: with the browser's bold face and with
 *    the regular face (libass fakes bold on a font that has only Regular).
 *  - A small constant compensation (COMPENSATION) is added to the measured
 *    width, because run 1 showed the measured width was usually 0.2 to 4 px
 *    narrower than libass.
 *  - More bold cases.
 */

type Align = "left" | "center" | "right";

type LabCase = {
  id: string;
  text: string; // raw text, "\n" separates lines
  fontSize: number;
  bold?: boolean;
  italic?: boolean;
  align: Align;
};

type Bounds = { left: number; top: number; right: number; bottom: number };
type Size = { width: number; height: number };
type Edges = { left: number; top: number; right: number; bottom: number };

type CaseResult = {
  id: string;
  error?: string;
  truthSize?: Size;
  styledSize?: Size;
  regularSize?: Size;
  styledWidthErr?: number;
  regularWidthErr?: number;
  usedRegularWeight?: boolean;
  drawingEdgeErr?: Edges;
  drawingMaxEdgeErr?: number;
  drawingContainsInk?: boolean;
  verdict?: "PASS" | "MARGINAL" | "FAIL";
  truth?: Bounds;
  ink?: Bounds;
  drawing?: Bounds | null;
};

const PADDING = 8;
const RADIUS = 12;
const COMPENSATION = 1.5; // design pixels added to the measured width
const TOLERANCE = 2;
const HARD_LIMIT = 4;
const POS_Y = ASS_HEIGHT / 2;

const CASES: LabCase[] = [
  { id: "latin-1line-24", text: "Hello world", fontSize: 24, align: "center" },
  { id: "latin-1line-60", text: "Hello world", fontSize: 60, align: "center" },
  { id: "latin-2line-36", text: "First line\nSecond longer line", fontSize: 36, align: "center" },
  { id: "cjk-1line-36", text: "這是一個測試字幕", fontSize: 36, align: "center" },
  { id: "cjk-2line-36", text: "第一行文字\n第二行比較長的文字內容", fontSize: 36, align: "center" },
  { id: "mixed-36", text: "CTC 字幕 Test 123", fontSize: 36, align: "center" },
  { id: "italic-36", text: "Italic subtitle 斜體", fontSize: 36, italic: true, align: "center" },
  { id: "descenders-braces-36", text: "gypqj, ()[] {gjy} \\ end", fontSize: 36, align: "center" },
  { id: "left-2line-36", text: "Left aligned\n靠左對齊的兩行", fontSize: 36, align: "left" },
  { id: "right-2line-36", text: "Right aligned\n靠右對齊的兩行", fontSize: 36, align: "right" },
  { id: "long-1line-30", text: "A fairly long single line of subtitle text to check widths 這是一行比較長的字幕", fontSize: 30, align: "center" },
  { id: "bold-mixed-36", text: "Bold subtitle 粗體", fontSize: 36, bold: true, align: "center" },
  { id: "bold-latin-36", text: "Bold subtitle text only", fontSize: 36, bold: true, align: "center" },
  { id: "bold-cjk-36", text: "粗體中文字幕測試", fontSize: 36, bold: true, align: "center" },
  { id: "bold-italic-36", text: "Bold italic 粗斜體", fontSize: 36, bold: true, italic: true, align: "center" },
  { id: "bold-left-2line-36", text: "Bold left\n粗體靠左兩行", fontSize: 36, bold: true, align: "left" },
];

function alignmentFor(align: Align) {
  return align === "left" ? 4 : align === "right" ? 6 : 5;
}

function posXFor(align: Align) {
  if (align === "left") return 200;
  if (align === "right") return ASS_WIDTH - 200;
  return ASS_WIDTH / 2;
}

// Same escaping idea as assSubtitles.escapeAssText.
function toAssText(text: string) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\n/g, "\\N");
}

function styleLine(name: string, item: LabCase, borderStyle: number, outline: number) {
  return [
    `Style: ${name}`,
    DEFAULT_ASS_FONT_FAMILY,
    item.fontSize,
    "&H00FFFFFF",
    "&H00000000",
    "&H00FFFFFF",
    "&H00FFFFFF",
    item.bold ? -1 : 0,
    item.italic ? -1 : 0,
    0,
    0,
    100,
    100,
    0,
    0,
    borderStyle,
    outline,
    0,
    5,
    0,
    0,
    0,
    1,
  ].join(",");
}

function buildScript(styles: string[], events: string[]) {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${ASS_WIDTH}
PlayResY: ${ASS_HEIGHT}
LayoutResX: ${ASS_WIDTH}
LayoutResY: ${ASS_HEIGHT}
ScaledBorderAndShadow: yes
WrapStyle: 0
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
${styles.join("\n")}

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
${events.join("\n")}
`;
}

function textEvent(style: string, item: LabCase) {
  const an = alignmentFor(item.align);
  return `Dialogue: 1,0:00:00.00,0:00:10.00,${style},,0,0,0,,{\\an${an}\\pos(${posXFor(item.align)},${POS_Y})}${toAssText(item.text)}`;
}

function roundedRectPath(width: number, height: number, radius: number) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const k = 0.5522847498 * r;
  const n = (value: number) => Math.round(value);
  const w = n(width);
  const h = n(height);
  return [
    `m ${n(r)} 0`,
    `l ${n(w - r)} 0`,
    `b ${n(w - r + k)} 0 ${w} ${n(r - k)} ${w} ${n(r)}`,
    `l ${w} ${n(h - r)}`,
    `b ${w} ${n(h - r + k)} ${n(w - r + k)} ${h} ${n(w - r)} ${h}`,
    `l ${n(r)} ${h}`,
    `b ${n(r - k)} ${h} 0 ${n(h - r + k)} 0 ${n(h - r)}`,
    `l 0 ${n(r)}`,
    `b 0 ${n(r - k)} ${n(r - k)} 0 ${n(r)} 0`,
  ].join(" ");
}

function drawingEvent(item: LabCase, box: Size) {
  const an = alignmentFor(item.align);
  const x =
    item.align === "left"
      ? posXFor(item.align) - PADDING
      : item.align === "right"
        ? posXFor(item.align) + PADDING
        : posXFor(item.align);
  return `Dialogue: 0,0:00:00.00,0:00:10.00,D,,0,0,0,,{\\an${an}\\pos(${x},${POS_Y})\\p1}${roundedRectPath(box.width, box.height, RADIUS)}{\\p0}`;
}

function alphaBounds(image: ImageData, threshold = 128): Bounds | null {
  const { data, width, height } = image;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] >= threshold) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return right < 0 ? null : { left, top, right: right + 1, bottom: bottom + 1 };
}

type SyncedRenderer = SubtitlesOctopus & {
  setCurrentTime?: (time: number) => void;
  setIsPaused?: (paused: boolean, time: number) => void;
};

async function renderBounds(script: string): Promise<Bounds | null> {
  const canvas = document.createElement("canvas");
  canvas.width = ASS_WIDTH;
  canvas.height = ASS_HEIGHT;
  canvas.style.cssText = "position:fixed;left:-10000px;top:0;pointer-events:none;";
  document.body.appendChild(canvas);

  const clock = document.createElement("video");
  clock.preload = "none";
  clock.muted = true;
  clock.playsInline = true;

  const fontUrl = new URL(DEFAULT_ASS_FONT_URL, window.location.origin).href;
  const holder: { renderer: SubtitlesOctopus | null } = { renderer: null };
  let disposed = false;
  const dispose = () => {
    if (disposed || !holder.renderer) return;
    disposed = true;
    try {
      holder.renderer.dispose();
    } catch (error) {
      console.error("dispose failed", error);
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error("libass did not become ready in 15 s")),
        15000,
      );
      const options = {
        video: clock,
        timeOffset: 0,
        canvas,
        subContent: script,
        fonts: [fontUrl],
        fallbackFont: fontUrl,
        renderMode: "wasm-blend",
        targetFps: 24,
        libassMemoryLimit: 64,
        libassGlyphLimit: 32,
        prescaleHeightLimit: ASS_HEIGHT,
        maxRenderHeight: ASS_HEIGHT,
        onReady: () => {
          window.clearTimeout(timeout);
          resolve();
        },
        onError: (error: Error) => {
          window.clearTimeout(timeout);
          reject(error);
        },
      } as unknown as ConstructorParameters<typeof SubtitlesOctopus>[0];
      holder.renderer = new SubtitlesOctopus(options);
    });

    const synced = holder.renderer as SyncedRenderer | null;
    synced?.setIsPaused?.(true, 1);
    synced?.setCurrentTime?.(1);

    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D context on the libass canvas");

    const scale = canvas.width / ASS_WIDTH;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const bounds = alphaBounds(image);
      if (bounds) {
        return {
          left: bounds.left / scale,
          top: bounds.top / scale,
          right: bounds.right / scale,
          bottom: bounds.bottom / scale,
        };
      }
    }
    return null;
  } finally {
    dispose();
    canvas.remove();
  }
}

async function ensureFontLoaded() {
  const fontUrl = new URL(DEFAULT_ASS_FONT_URL, window.location.origin).href;
  const face = new FontFace(DEFAULT_ASS_FONT_FAMILY, `url(${fontUrl})`);
  await face.load();
  document.fonts.add(face);
}

/**
 * Box size in design pixels. ASS font size is the line height (ascent +
 * descent), not the CSS em size, so the em size is scaled by the font's own
 * ascent + descent. Measured twice: with the item's weight, and with the
 * regular weight (libass fakes bold when only Regular is bundled).
 */
function measureBoxes(item: LabCase) {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("No 2D context for measureText");

  const lines = item.text.split("\n");
  const italic = item.italic ? "italic " : "";

  context.font = `${italic}100px "${DEFAULT_ASS_FONT_FAMILY}"`;
  const probe = context.measureText("Hg");
  const ascent = probe.fontBoundingBoxAscent ?? probe.actualBoundingBoxAscent;
  const descent = probe.fontBoundingBoxDescent ?? probe.actualBoundingBoxDescent;
  const lineRatio = (ascent + descent) / 100;
  const emPx = item.fontSize / lineRatio;

  const widthWith = (weight: string) => {
    context.font = `${italic}${weight}${emPx}px "${DEFAULT_ASS_FONT_FAMILY}"`;
    return Math.max(...lines.map((line) => context.measureText(line).width));
  };

  const height = lines.length * item.fontSize + 2 * PADDING;
  const styled: Size = {
    width: widthWith(item.bold ? "bold " : "") + 2 * PADDING + COMPENSATION,
    height,
  };
  const regular: Size = {
    width: widthWith("") + 2 * PADDING + COMPENSATION,
    height,
  };
  return { styled, regular };
}

function sizeOf(bounds: Bounds): Size {
  return { width: bounds.right - bounds.left, height: bounds.bottom - bounds.top };
}

function edgeErrors(a: Bounds, b: Bounds): Edges {
  return {
    left: a.left - b.left,
    top: a.top - b.top,
    right: a.right - b.right,
    bottom: a.bottom - b.bottom,
  };
}

function maxAbs(values: number[]) {
  return Math.max(...values.map((value) => Math.abs(value)));
}

async function runCase(item: LabCase): Promise<CaseResult> {
  try {
    const truth = await renderBounds(
      buildScript([styleLine("T", item, 3, PADDING)], [textEvent("T", item)]),
    );
    const ink = await renderBounds(
      buildScript([styleLine("T", item, 1, 0)], [textEvent("T", item)]),
    );
    if (!truth || !ink) {
      return { id: item.id, error: "libass drew nothing for the truth or ink render" };
    }

    const { styled, regular } = measureBoxes(item);
    // Hypothesis: libass fake bold does not change advances, so bold text is
    // measured in the regular weight. The report shows both errors.
    const usedRegularWeight = Boolean(item.bold);
    const chosen = usedRegularWeight ? regular : styled;

    const drawing = await renderBounds(
      buildScript([styleLine("D", item, 1, 0)], [drawingEvent(item, chosen)]),
    );

    const truthSize = sizeOf(truth);
    const drawingEdgeErr = drawing ? edgeErrors(drawing, truth) : undefined;
    const drawingMaxEdgeErr = drawingEdgeErr
      ? maxAbs(Object.values(drawingEdgeErr))
      : undefined;
    const drawingContainsInk = drawing
      ? drawing.left <= ink.left + 0.5 &&
        drawing.top <= ink.top + 0.5 &&
        drawing.right >= ink.right - 0.5 &&
        drawing.bottom >= ink.bottom - 0.5
      : undefined;

    let verdict: CaseResult["verdict"] = "FAIL";
    if (drawingMaxEdgeErr !== undefined && drawingContainsInk) {
      if (drawingMaxEdgeErr <= TOLERANCE) verdict = "PASS";
      else if (drawingMaxEdgeErr <= HARD_LIMIT) verdict = "MARGINAL";
    }

    return {
      id: item.id,
      truth,
      ink,
      drawing,
      truthSize,
      styledSize: styled,
      regularSize: regular,
      styledWidthErr: styled.width - truthSize.width,
      regularWidthErr: regular.width - truthSize.width,
      usedRegularWeight,
      drawingEdgeErr,
      drawingMaxEdgeErr,
      drawingContainsInk,
      verdict,
    };
  } catch (error) {
    return {
      id: item.id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const fmt = (value: number | undefined) =>
  value === undefined ? "-" : value.toFixed(1);

const cell = { border: "1px solid #444", padding: "4px 8px" } as const;

export default function RoundedBackgroundLab() {
  const [rows, setRows] = useState<CaseResult[]>([]);
  const [status, setStatus] = useState("Idle");
  const [running, setRunning] = useState(false);
  const [json, setJson] = useState("");

  const run = async () => {
    setRunning(true);
    setRows([]);
    setJson("");
    const results: CaseResult[] = [];
    try {
      setStatus("Loading font...");
      await ensureFontLoaded();
      for (let index = 0; index < CASES.length; index += 1) {
        setStatus(`Running ${index + 1} of ${CASES.length}: ${CASES[index].id}`);
        results.push(await runCase(CASES[index]));
        setRows([...results]);
      }
      const text = JSON.stringify(
        {
          run: 2,
          userAgent: navigator.userAgent,
          devicePixelRatio: window.devicePixelRatio,
          padding: PADDING,
          radius: RADIUS,
          compensation: COMPENSATION,
          tolerance: TOLERANCE,
          hardLimit: HARD_LIMIT,
          results,
        },
        null,
        2,
      );
      setJson(text);
      console.log(text);
      setStatus("Done");
    } catch (error) {
      setStatus(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ padding: 16, fontFamily: "system-ui, sans-serif", color: "#eee", background: "#1b1b1d", minHeight: "100vh" }}>
      <h2 style={{ marginTop: 0 }}>Rounded background lab, run 2 (dev only)</h2>
      <button type="button" onClick={() => void run()} disabled={running}>
        {running ? "Running..." : "Run experiment"}
      </button>{" "}
      <span>{status}</span>

      <table style={{ marginTop: 12, borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            {["case", "libass box W x H", "width err (as styled)", "width err (regular weight)", "used", "drawing max edge err", "contains ink", "verdict"].map((title) => (
              <th key={title} style={{ ...cell, textAlign: "left" }}>{title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td style={cell}>{row.id}</td>
              {row.error ? (
                <td style={cell} colSpan={7}>{row.error}</td>
              ) : (
                <>
                  <td style={cell}>{fmt(row.truthSize?.width)} x {fmt(row.truthSize?.height)}</td>
                  <td style={cell}>{fmt(row.styledWidthErr)}</td>
                  <td style={cell}>{fmt(row.regularWidthErr)}</td>
                  <td style={cell}>{row.usedRegularWeight ? "regular" : "styled"}</td>
                  <td style={cell}>{fmt(row.drawingMaxEdgeErr)}</td>
                  <td style={cell}>{row.drawingContainsInk === undefined ? "-" : row.drawingContainsInk ? "yes" : "NO"}</td>
                  <td style={cell}>{row.verdict}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {json && (
        <>
          <p>Copy this report and send it back:</p>
          <button type="button" onClick={() => void navigator.clipboard.writeText(json)}>
            Copy JSON
          </button>
          <textarea readOnly value={json} style={{ display: "block", width: "100%", height: 220, marginTop: 8, fontFamily: "monospace", fontSize: 11 }} />
        </>
      )}
    </div>
  );
}
