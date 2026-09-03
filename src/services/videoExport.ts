import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";

import type { Subtitle } from "../types/subtitle";

import { buildAssTrack } from "../utils/assSubtitles";

export type VideoExportProgress = {
  progress: number;
  status: string;
};

type ExportStyledVideoOptions = {
  videoDuration: number;
  onStart?: () => void;
  onProgress?: (progress: VideoExportProgress) => void;
};

export async function exportStyledVideo(
  videoPath: string,
  subtitles: Subtitle[],
  options: ExportStyledVideoOptions,
): Promise<string | null> {
  const outputPath = await save({
    title: "Export Styled Video",

    filters: [
      {
        name: "MP4 Video",
        extensions: ["mp4"],
      },
    ],

    defaultPath: "subtitled-video.mp4",
  });

  if (!outputPath) {
    return null;
  }

  const assContent = buildAssTrack(subtitles);

  const unlisten = await listen<VideoExportProgress>(
    "video-export-progress",
    (event) => {
      options.onProgress?.(event.payload);
    },
  );

  options.onStart?.();

  /*
   * Give React/WebView one frame to actually paint the blocking export modal
   * before starting the backend export command.
   */
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });

  try {
    await invoke("export_styled_video", {
      videoPath,
      outputPath,
      assContent,
      videoDuration: options.videoDuration,
    });
  } finally {
    unlisten();
  }

  return outputPath;
}
