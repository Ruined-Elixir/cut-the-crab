import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const WAVEFORM_POINTS = 1200;

type WaveformMap = Record<string, number[]>;

export function useWaveform() {
  const [waveformsBySource, setWaveformsBySource] = useState<WaveformMap>({});
  const [isGeneratingWaveform, setIsGeneratingWaveform] = useState(false);
  const [waveformError, setWaveformError] = useState<string | null>(null);

  const inFlightRef = useRef<Set<string>>(new Set());
  const cacheRef = useRef<WaveformMap>({});

  const generateWaveform = useCallback(async (videoPath: string) => {
    if (!videoPath) {
      return;
    }

    if (cacheRef.current[videoPath] || inFlightRef.current.has(videoPath)) {
      return;
    }

    inFlightRef.current.add(videoPath);
    setWaveformError(null);
    setIsGeneratingWaveform(true);

    try {
      const data = await invoke<number[]>("extract_waveform", {
        videoPath,
        points: WAVEFORM_POINTS,
      });

      cacheRef.current = {
        ...cacheRef.current,
        [videoPath]: data,
      };

      setWaveformsBySource(cacheRef.current);
    } catch (error) {
      const message =
        typeof error === "string" ? error : "Failed to extract waveform.";

      setWaveformError(message);
      console.error("Waveform extraction failed:", error);
    } finally {
      inFlightRef.current.delete(videoPath);
      setIsGeneratingWaveform(inFlightRef.current.size > 0);
    }
  }, []);

  return {
    waveformsBySource,
    isGeneratingWaveform,
    waveformError,
    generateWaveform,
  };
}
