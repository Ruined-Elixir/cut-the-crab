import { invoke } from "@tauri-apps/api/core";
import { traceCut } from "../utils/cutTrace";

export type TranscriptionEngine = "whisper" | "sensevoice";

export type WhisperModel = "base" | "small";

export type TranscriptionSegment = {
  startTime: number;
  endTime: number;
  text: string;
};

export type TranscriptionResult = {
  language: string;
  segments: TranscriptionSegment[];
};

export async function transcribeVideo(
  videoPath: string,
  engine: TranscriptionEngine,
  model: WhisperModel,
): Promise<TranscriptionResult> {
  traceCut("transcription-task-start", { videoPath, engine, model });
  return invoke<TranscriptionResult>("transcribe_video", {
    videoPath,
    engine,
    model,
  });
}
