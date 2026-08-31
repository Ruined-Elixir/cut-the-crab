import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

import type { Subtitle } from "../types/subtitle";
import { generateSrt, parseSrt } from "../utils/srt";

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

export async function exportSrtFile(
  subtitles: Subtitle[]
): Promise<boolean> {
  try {
    const filePath = await save({
      filters: [
        {
          name: "SubRip Subtitle",
          extensions: ["srt"],
        },
      ],
      defaultPath: "subtitles.srt",
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
