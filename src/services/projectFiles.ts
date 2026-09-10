import { invoke } from "@tauri-apps/api/core";

import type { Subtitle, SubtitleTextAlign } from "../types/subtitle";
import type { TimelineMarker } from "../types/timeline";
import type { VideoTimelineClip } from "../types/timelineModel";
import type {
  ProjectLanguage,
  ProjectMediaAsset,
  ProjectMetadata,
} from "../types/project";

export const CURRENT_PROJECT_VERSION = 6;

export type SubtitleProject = {
  version: number;
  projectId: string;
  videoPath: string;
  title: string;
  languages: ProjectLanguage[];
  subtitles: Subtitle[];
  markers: TimelineMarker[];
  videoClips: VideoTimelineClip[];
  mediaAssets: ProjectMediaAsset[];
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

function normalizeVideoClip(
  value: unknown,
  index: number,
  fallbackVideoPath: string,
): VideoTimelineClip | null {
  if (!isRecord(value)) {
    return null;
  }

  const timelineStart = asNumber(
    value.timelineStart,
    0,
  );
  const timelineEnd = asNumber(
    value.timelineEnd,
    timelineStart,
  );
  const sourceIn = asNumber(value.sourceIn, 0);
  const sourceOut = asNumber(
    value.sourceOut,
    sourceIn +
      (timelineEnd - timelineStart),
  );

  if (
    timelineStart < 0 ||
    timelineEnd <= timelineStart ||
    sourceIn < 0 ||
    sourceOut <= sourceIn
  ) {
    return null;
  }

  const sourcePath =
    typeof value.sourcePath === "string" &&
    value.sourcePath.length > 0
      ? value.sourcePath
      : fallbackVideoPath;

  return {
    id:
      typeof value.id === "string" &&
      value.id.length > 0
        ? value.id
        : `video-clip-${index}-${crypto.randomUUID()}`,
    kind: "video",
    trackId:
      typeof value.trackId === "string"
        ? value.trackId
        : "video-1",
    sourceId:
      typeof value.sourceId === "string" &&
      value.sourceId.length > 0
        ? value.sourceId
        : sourcePath,
    sourcePath,
    sourceName:
      typeof value.sourceName === "string" &&
      value.sourceName.length > 0
        ? value.sourceName
        : defaultTitleFromVideoPath(sourcePath),
    sourceIn,
    sourceOut,
    sourceDuration: asOptionalNumber(value.sourceDuration),
    timelineStart,
    timelineEnd,
  };
}

function normalizeMediaAsset(
  value: unknown,
  index: number,
): ProjectMediaAsset | null {
  if (!isRecord(value)) {
    return null;
  }

  const path = typeof value.path === "string" ? value.path : "";

  if (!path) {
    return null;
  }

  return {
    id:
      typeof value.id === "string" && value.id.length > 0
        ? value.id
        : `media-${index}-${crypto.randomUUID()}`,
    kind: "video",
    path,
    name:
      typeof value.name === "string" && value.name.length > 0
        ? value.name
        : path.split(/[\\/]/).pop() ?? "Video",
    duration: Math.max(0, asNumber(value.duration, 0)),
  };
}

function normalizeProject(
  value: unknown,
  fallbackProjectId: string,
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

  const mediaAssets = Array.isArray(value.mediaAssets)
    ? value.mediaAssets
        .map((asset, index) => normalizeMediaAsset(asset, index))
        .filter((asset): asset is ProjectMediaAsset => asset !== null)
    : [];

  const videoClips = Array.isArray(value.videoClips)
    ? value.videoClips
        .map((clip, index) =>
          normalizeVideoClip(
            clip,
            index,
            videoPath,
          ),
        )
        .filter(
          (
            clip,
          ): clip is VideoTimelineClip =>
            clip !== null,
        )
        .sort(
          (a, b) =>
            a.timelineStart -
            b.timelineStart,
        )
    : [];

  return {
    version: CURRENT_PROJECT_VERSION,
    projectId:
      typeof value.projectId === "string" &&
      value.projectId.trim().length > 0
        ? value.projectId
        : fallbackProjectId,
    videoPath,
    title:
      typeof value.title === "string" && value.title.trim().length > 0
        ? value.title.trim()
        : defaultTitleFromVideoPath(videoPath),
    languages: parseLanguages(value.languages),
    subtitles,
    markers,
    videoClips,
    mediaAssets,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
  };
}

/*
 * Project persistence is managed by Rust inside the app-data directory.
 *
 * `videoPath` remains the lookup key at this API boundary so existing editor
 * code does not need to know where project files live. The backend also
 * migrates legacy sidecar projects automatically on first load.
 */
export async function loadMatchingProjectFile(
  projectId: string,
  videoPath: string,
): Promise<SubtitleProject | null> {
  try {
    const content = await invoke<string | null>("read_matching_project", {
      projectId,
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

    return normalizeProject(
      parsed,
      projectId,
      videoPath,
    );
  } catch (error) {
    console.error("Failed to load subtitle project:", error);
    return null;
  }
}

export async function saveProjectFile(
  projectId: string,
  videoPath: string,
  subtitles: Subtitle[],
  markers: TimelineMarker[],
  metadata?: ProjectMetadata,
  videoClips: VideoTimelineClip[] = [],
  mediaAssets: ProjectMediaAsset[] = [],
): Promise<void> {
  const project: SubtitleProject = {
    version: CURRENT_PROJECT_VERSION,
    projectId,
    videoPath,
    title: metadata?.title ?? defaultTitleFromVideoPath(videoPath),
    languages: metadata?.languages ?? [],
    subtitles,
    markers: [...markers].sort((a, b) => a.time - b.time),
    videoClips: [...videoClips].sort(
      (a, b) =>
        a.timelineStart - b.timelineStart,
    ),
    mediaAssets,
    updatedAt: new Date().toISOString(),
  };

  await invoke("save_subtitle_project", {
    projectId,
    projectJson: JSON.stringify(project, null, 2),
  });
}
