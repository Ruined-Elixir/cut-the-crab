import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

import type { Subtitle } from "../types/subtitle";
import { generateSrt, parseSrt } from "../utils/srt";

import { invoke } from "@tauri-apps/api/core";

export async function importSrtFile(): Promise<Subtitle[] | null> {
  try {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: "SubRip Subtitle",
          extensions: ["srt"],
        },
      ],
    });

    if (!selected || Array.isArray(selected)) {
      return null;
    }

    const content = await readTextFile(selected);

    return parseSrt(content);
  } catch (error) {
    console.error("Failed to import SRT:", error);

    return null;
  }
}

export async function loadMatchingSrtFile(
  videoPath: string,
): Promise<Subtitle[] | null> {
  try {
    const content = await invoke<string | null>("read_matching_srt", {
      videoPath,
    });

    if (!content) {
      return null;
    }

    return parseSrt(content);
  } catch (error) {
    console.error("Failed to load matching SRT:", error);

    return null;
  }
}

export async function exportSrtFile(
  subtitles: Subtitle[],
  videoPath?: string | null,
): Promise<boolean> {
  try {
    let defaultPath = "subtitles.srt";

    if (videoPath) {
      const videoFileName = videoPath.split(/[\\/]/).pop() ?? "";

      const baseName = videoFileName.replace(/\.[^/.\\]+$/, "");

      if (baseName) {
        defaultPath = `${baseName}.srt`;
      }
    }

    const filePath = await save({
      filters: [
        {
          name: "SubRip Subtitle",
          extensions: ["srt"],
        },
      ],
      defaultPath,
    });

    if (!filePath) {
      return false;
    }

    await writeTextFile(filePath, generateSrt(subtitles));

    return true;
  } catch (error) {
    console.error("Failed to export SRT:", error);

    return false;
  }
}
