import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { traceCut } from "../utils/cutTrace";

const WAVEFORM_POINTS = 1200;
const WAVEFORM_START_DELAY_MS = 350;
const WAVEFORM_RETRY_BACKOFF_MS = [500, 1200, 2500];

type WaveformMap = Record<string, number[]>;

export type WaveformLoadStatus = "queued" | "generating" | "ready" | "error";
export type WaveformLoadStates = Record<string, WaveformLoadStatus>;

export function useWaveform() {
  const [waveformsBySource, setWaveformsBySource] = useState<WaveformMap>({});
  const [isGeneratingWaveform, setIsGeneratingWaveform] = useState(false);
  const [waveformError, setWaveformError] = useState<string | null>(null);
  const [waveformStatesBySource, setWaveformStatesBySource] =
    useState<WaveformLoadStates>({});

  const inFlightRef = useRef<Set<string>>(new Set());
  const queuedRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<string[]>([]);
  const processingRef = useRef(false);
  const cacheRef = useRef<WaveformMap>({});

  const generateWaveform = useCallback(async (videoPath: string) => {
    if (!videoPath) return;
    if (
      cacheRef.current[videoPath] ||
      inFlightRef.current.has(videoPath) ||
      queuedRef.current.has(videoPath)
    ) {
      return;
    }

    queuedRef.current.add(videoPath);
    queueRef.current.push(videoPath);
    setWaveformStatesBySource((current) => ({
      ...current,
      [videoPath]: "queued",
    }));

    if (processingRef.current) return;
    processingRef.current = true;
    setWaveformError(null);
    setIsGeneratingWaveform(true);

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, WAVEFORM_START_DELAY_MS);
    });

    try {
      while (queueRef.current.length > 0) {
        const nextPath = queueRef.current.shift();
        if (!nextPath) continue;
        queuedRef.current.delete(nextPath);

        if (cacheRef.current[nextPath]) continue;

        inFlightRef.current.add(nextPath);
        setWaveformStatesBySource((current) => ({
          ...current,
          [nextPath]: "generating",
        }));

        try {
          for (
            let attempt = 0;
            attempt <= WAVEFORM_RETRY_BACKOFF_MS.length;
            attempt += 1
          ) {
            try {
              traceCut("waveform-task-start", {
                sourcePath: nextPath,
                attempt: attempt + 1,
              });
              const data = await invoke<number[]>("extract_waveform", {
                videoPath: nextPath,
                points: WAVEFORM_POINTS,
              });

              cacheRef.current = {
                ...cacheRef.current,
                [nextPath]: data,
              };
              setWaveformsBySource(cacheRef.current);
              setWaveformStatesBySource((current) => ({
                ...current,
                [nextPath]: "ready",
              }));
              break;
            } catch (error) {
              const retryDelay = WAVEFORM_RETRY_BACKOFF_MS[attempt];
              if (retryDelay !== undefined) {
                setWaveformStatesBySource((current) => ({
                  ...current,
                  [nextPath]: "queued",
                }));
                await new Promise<void>((resolve) => {
                  window.setTimeout(resolve, retryDelay);
                });
                setWaveformStatesBySource((current) => ({
                  ...current,
                  [nextPath]: "generating",
                }));
                continue;
              }

              const message =
                typeof error === "string"
                  ? error
                  : "Failed to extract waveform.";
              setWaveformError(message);
              setWaveformStatesBySource((current) => ({
                ...current,
                [nextPath]: "error",
              }));
              console.error(
                `Waveform extraction failed after ${attempt + 1} attempts:`,
                error,
              );
            }
          }
        } finally {
          inFlightRef.current.delete(nextPath);
        }
      }
    } finally {
      processingRef.current = false;
      setIsGeneratingWaveform(false);
    }
  }, []);

  return {
    waveformsBySource,
    waveformStatesBySource,
    isGeneratingWaveform,
    waveformError,
    generateWaveform,
  };
}
