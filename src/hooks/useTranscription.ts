import { useEffect, useState } from "react";

import { listen } from "@tauri-apps/api/event";

import {
  transcribeVideo,
  type TranscriptionEngine,
  type TranscriptionSegment,
  type WhisperModel,
} from "../services/transcriptionService";

type UseTranscriptionOptions = {
  onGenerated: (
    segments: {
      startTime: number;
      endTime: number;
      text: string;
    }[],
    videoPath: string,
  ) => void;
};

export type GenerateSubtitlesOptions = {
  engine?: TranscriptionEngine;
  model?: WhisperModel;
  commitResult?: boolean;
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
  ): Promise<TranscriptionSegment[] | null> => {
    if (!videoPath) {
      setGenerationError("Please choose a video first.");

      return null;
    }

    if (isGenerating) {
      return null;
    }

    const engine = options.engine ?? transcriptionEngine;
    const model = options.model ?? whisperModel;
    const commitResult = options.commitResult ?? true;

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

      if (commitResult) {
        onGenerated(result.segments, videoPath);
      }

      setGenerationStatus("Finished");
      setGenerationPercent(100);

      return result.segments;
    } catch (error) {
      console.error("Failed to generate subtitles:", error);

      setGenerationStatus("Failed");

      setGenerationError(
        error instanceof Error ? error.message : String(error),
      );

      return null;
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
