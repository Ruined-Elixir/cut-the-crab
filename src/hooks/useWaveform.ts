import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export function useWaveform() {
  const [waveform, setWaveform] = useState<number[]>([]);
  const [isGeneratingWaveform, setIsGeneratingWaveform] = useState(false);
  const [waveformError, setWaveformError] = useState<string | null>(null);

  const generateWaveform = async (videoPath: string) => {
    setWaveform([]);
    setWaveformError(null);
    setIsGeneratingWaveform(true);

    try {
      const data = await invoke<number[]>("extract_waveform", {
        videoPath,
        points: 1200,
      });

      setWaveform(data);
    } catch (error) {
      const message =
        typeof error === "string" ? error : "Failed to extract waveform.";

      setWaveformError(message);
      console.error("Waveform extraction failed:", error);
    } finally {
      setIsGeneratingWaveform(false);
    }
  };

  return {
    waveform,
    isGeneratingWaveform,
    waveformError,
    generateWaveform,
  };
}
