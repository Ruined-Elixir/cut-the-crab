import { useEffect, useRef } from "react";

import { listen } from "@tauri-apps/api/event";

export const APP_MENU_COMMAND_EVENT = "app-menu-command";

export type AppMenuCommand =
  | "file.new-project"
  | "file.show-home"
  | "file.open-video"
  | "file.save-project"
  | "file.import-srt"
  | "file.export-srt"
  | "file.export-video"
  | "edit.undo"
  | "edit.redo"
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
