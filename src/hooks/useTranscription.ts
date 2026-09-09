import { useEffect, useState } from "react";

import { listen } from "@tauri-apps/api/event";

import {
  transcribeVideo,
  type TranscriptionEngine,
  type WhisperModel,
} from "../services/transcriptionService";

type UseTranscriptionOptions = {
  onGenerated: (
    segments: {
      startTime: number;
      endTime: number;
      text: string;
    }[],
  ) => void;
};

export type GenerateSubtitlesOptions = {
  engine?: TranscriptionEngine;
  model?: WhisperModel;
};

export function useTranscription({ onGenerated }: UseTranscriptionOptions) {
  const [isGenerating, setIsGenerating] = useState(false);

  const [generationStatus, setGenerationStatus] = useState("");

  const [generationPercent, setGenerationPercent] = useState(0);

  const [modelDownloadPercent, setModelDownloadPercent] = useState(0);

  const [generationError, setGenerationError] = useState("");

  const [whisperModel, setWhisperModel] = useState<WhisperModel>("base");

  const [transcriptionEngine, setTranscriptionEngine] =
    useState<TranscriptionEngine>("whisper");

  const generateSubtitles = async (
    videoPath: string | null,
    options: GenerateSubtitlesOptions = {},
  ) => {
    if (!videoPath) {
      setGenerationError("Please choose a video first.");

      return;
    }

    if (isGenerating) {
      return;
    }

    const engine = options.engine ?? transcriptionEngine;
    const model = options.model ?? whisperModel;

    setTranscriptionEngine(engine);

    if (engine === "whisper") {
      setWhisperModel(model);
    }

    setIsGenerating(true);
    setGenerationError("");
    setGenerationStatus("Checking models...");
    setGenerationPercent(0);
    setModelDownloadPercent(0);

    try {
      const result = await transcribeVideo(videoPath, engine, model);

      onGenerated(result.segments);

      setGenerationStatus("Finished");
      setGenerationPercent(100);
    } catch (error) {
      console.error("Failed to generate subtitles:", error);

      setGenerationStatus("Failed");

      setGenerationError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    const unlistenStatusPromise = listen<string>(
      "transcription-progress",
      (event) => {
        setGenerationStatus(event.payload);
      },
    );

    const unlistenPercentPromise = listen<number>(
      "transcription-percent",
      (event) => {
        setGenerationPercent(event.payload);
      },
    );

    const unlistenModelDownloadPromise = listen<number>(
      "model-download-percent",
      (event) => {
        setModelDownloadPercent(event.payload);
      },
    );

    return () => {
      void unlistenStatusPromise.then((unlisten) => unlisten());

      void unlistenPercentPromise.then((unlisten) => unlisten());

      void unlistenModelDownloadPromise.then((unlisten) => unlisten());
    };
  }, []);

  const clearGenerationError = () => {
    setGenerationError("");
    setGenerationStatus("");
  };

  return {
    isGenerating,
    generationStatus,
    generationPercent,
    modelDownloadPercent,
    generationError,
    clearGenerationError,

    whisperModel,
    setWhisperModel,

    transcriptionEngine,
    setTranscriptionEngine,

    generateSubtitles,
  };
}
