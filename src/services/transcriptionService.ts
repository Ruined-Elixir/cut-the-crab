import { invoke } from "@tauri-apps/api/core";

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
  model: WhisperModel
): Promise<TranscriptionResult> {
  return invoke<TranscriptionResult>("transcribe_video", {
    videoPath,
    model,
  });
}