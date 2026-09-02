import { invoke } from "@tauri-apps/api/core";

import { save } from "@tauri-apps/plugin-dialog";

import type { Subtitle } from "../types/subtitle";

import { buildAssTrack } from "../utils/assSubtitles";

export async function exportStyledVideo(
  videoPath: string,
  subtitles: Subtitle[],
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

  /*
   * This is the exact same ASS content used by the browser libass preview.
   * Rust does not rebuild or reinterpret subtitle styles.
   */
  const assContent = buildAssTrack(subtitles);

  await invoke("export_styled_video", {
    videoPath,
    outputPath,
    assContent,
  });

  return outputPath;
}
