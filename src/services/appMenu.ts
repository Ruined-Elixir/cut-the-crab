import { useEffect, useRef } from "react";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const APP_MENU_COMMAND_EVENT = "app-menu-command";

export type TranscriptionPreset =
  | "whisper-base"
  | "whisper-small"
  | "sensevoice";

export type TranscriptionMenuTarget = {
  clipId: string;
  label: string;
};

type StaticAppMenuCommand =
  | "file.new-project"
  | "file.show-home"
  | "file.open-video"
  | "file.save-project"
  | "file.import-srt"
  | "file.export-srt"
  | "file.export-video"
  | "file.export-range"
  | "edit.undo"
  | "edit.redo"
  | "edit.cut"
  | "edit.copy"
  | "edit.paste"
  | "edit.duplicate"
  | "edit.select-all"
  | "edit.delete-range"
  | "edit.lift-range"
  | "edit.extract-range"
  | "edit.split-subtitle"
  | "edit.select-all-subtitles"
  | "edit.deselect-all-subtitles"
  | "edit.add-subtitle"
  | "edit.delete-subtitle"
  | "transcription.whisper-base"
  | "transcription.whisper-small"
  | "transcription.sensevoice"
  | "view.timeline-zoom-in"
  | "view.timeline-zoom-out"
  | "view.timeline-zoom-reset";

export type ClipTranscriptionMenuCommand =
  `transcription.clip:${TranscriptionPreset}:${string}`;

export type AppMenuCommand =
  | StaticAppMenuCommand
  | ClipTranscriptionMenuCommand;

export function parseClipTranscriptionCommand(command: AppMenuCommand) {
  if (!command.startsWith("transcription.clip:")) {
    return null;
  }

  const [, preset, ...clipParts] = command.split(":");
  const clipId = clipParts.join(":");

  if (
    !clipId ||
    (preset !== "whisper-base" &&
      preset !== "whisper-small" &&
      preset !== "sensevoice")
  ) {
    return null;
  }

  return {
    preset: preset as TranscriptionPreset,
    clipId,
  };
}

export async function updateTranscriptionMenuTargets(
  targets: TranscriptionMenuTarget[],
) {
  await invoke("update_transcription_menu_targets", {
    targets,
  });
}

export function useAppMenuCommands(
  onCommand: (command: AppMenuCommand) => void | Promise<void>,
) {
  const onCommandRef = useRef(onCommand);

  useEffect(() => {
    onCommandRef.current = onCommand;
  }, [onCommand]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listen<AppMenuCommand>(APP_MENU_COMMAND_EVENT, (event) => {
      void onCommandRef.current(event.payload);
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
        return;
      }

      unlisten = cleanup;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
