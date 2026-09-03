import { invoke } from "@tauri-apps/api/core";

import type { Subtitle, SubtitleTextAlign } from "../types/subtitle";
import type { TimelineMarker } from "../types/timeline";
import type {
  ProjectLanguage,
  ProjectMetadata,
} from "../types/project";

export const CURRENT_PROJECT_VERSION = 3;

export type SubtitleProject = {
  version: number;
  videoPath: string;
  title: string;
  languages: ProjectLanguage[];
  subtitles: Subtitle[];
  markers: TimelineMarker[];
  updatedAt: string;
};

type UnknownRecord = Record<string, unknown>;

const PROJECT_LANGUAGES = new Set<ProjectLanguage>([
  "english",
  "cantonese",
  "mandarin",
  "french",
  "mixed",
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseTextAlign(value: unknown): SubtitleTextAlign | undefined {
  if (value === "left" || value === "center" || value === "right") {
    return value;
  }

  return undefined;
}

function parseLanguages(value: unknown): ProjectLanguage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (language): language is ProjectLanguage =>
      typeof language === "string" &&
      PROJECT_LANGUAGES.has(language as ProjectLanguage),
  );
}

function defaultTitleFromVideoPath(videoPath: string) {
  const fileName = videoPath.split(/[\\/]/).pop() ?? "Untitled Project";

  return fileName.replace(/\.[^/.\\]+$/, "") || "Untitled Project";
}

function normalizeSubtitle(value: unknown, index: number): Subtitle | null {
  if (!isRecord(value)) {
    return null;
  }

  const startTime = asNumber(value.startTime, 0);
  const endTime = asNumber(value.endTime, startTime + 2);
  const text = typeof value.text === "string" ? value.text : "";

  if (startTime < 0 || endTime < startTime) {
    return null;
  }

  return {
    id:
      typeof value.id === "string" && value.id.length > 0
        ? value.id
        : `recovered-${index}-${crypto.randomUUID()}`,
    startTime,
    endTime,
    text,
    positionX: asOptionalNumber(value.positionX),
    positionY: asOptionalNumber(value.positionY),
    fontSize: asOptionalNumber(value.fontSize),
    fontFamily: asOptionalString(value.fontFamily),
    color: asOptionalString(value.color),
    backgroundColor: asOptionalString(value.backgroundColor),
    isBold: asOptionalBoolean(value.isBold),
    isUnderlined: asOptionalBoolean(value.isUnderlined),
    textAlign: parseTextAlign(value.textAlign),
  };
}

function normalizeMarker(value: unknown, index: number): TimelineMarker | null {
  if (!isRecord(value)) {
    return null;
  }

  const time = asNumber(value.time, -1);

  if (time < 0) {
    return null;
  }

  return {
    id:
      typeof value.id === "string" && value.id.length > 0
        ? value.id
        : `marker-${index}-${crypto.randomUUID()}`,
    time,
  };
}

function normalizeProject(
  value: unknown,
  fallbackVideoPath: string,
): SubtitleProject {
  if (!isRecord(value)) {
    throw new Error("Project file does not contain a valid object.");
  }

  const version = typeof value.version === "number" ? value.version : 1;

  if (version > CURRENT_PROJECT_VERSION) {
    throw new Error(
      `This project was created with a newer project format (version ${version}). ` +
        `This app currently supports version ${CURRENT_PROJECT_VERSION}.`,
    );
  }

  if (!Array.isArray(value.subtitles)) {
    throw new Error("Project file does not contain a valid subtitles array.");
  }

  const videoPath =
    typeof value.videoPath === "string" ? value.videoPath : fallbackVideoPath;

  const subtitles = value.subtitles
    .map((subtitle, index) => normalizeSubtitle(subtitle, index))
    .filter((subtitle): subtitle is Subtitle => subtitle !== null)
    .sort((a, b) => a.startTime - b.startTime);

  const markers = Array.isArray(value.markers)
    ? value.markers
        .map((marker, index) => normalizeMarker(marker, index))
        .filter((marker): marker is TimelineMarker => marker !== null)
        .sort((a, b) => a.time - b.time)
    : [];

  return {
    version: CURRENT_PROJECT_VERSION,
    videoPath,
    title:
      typeof value.title === "string" && value.title.trim().length > 0
        ? value.title.trim()
        : defaultTitleFromVideoPath(videoPath),
    languages: parseLanguages(value.languages),
    subtitles,
    markers,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
  };
}

export async function loadMatchingProjectFile(
  videoPath: string,
): Promise<SubtitleProject | null> {
  try {
    const content = await invoke<string | null>("read_matching_project", {
      videoPath,
    });

    if (!content) {
      return null;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("Project file contains invalid JSON.");
    }

    return normalizeProject(parsed, videoPath);
  } catch (error) {
    console.error("Failed to load subtitle project:", error);
    return null;
  }
}

export async function saveProjectFile(
  videoPath: string,
  subtitles: Subtitle[],
  markers: TimelineMarker[],
  metadata?: ProjectMetadata,
): Promise<void> {
  const project: SubtitleProject = {
    version: CURRENT_PROJECT_VERSION,
    videoPath,
    title: metadata?.title ?? defaultTitleFromVideoPath(videoPath),
    languages: metadata?.languages ?? [],
    subtitles,
    markers: [...markers].sort((a, b) => a.time - b.time),
    updatedAt: new Date().toISOString(),
  };

  await invoke("save_subtitle_project", {
    videoPath,
    projectJson: JSON.stringify(project, null, 2),
  });
}
