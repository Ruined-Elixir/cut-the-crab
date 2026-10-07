import type {
  AudioTimelineClip,
  VideoTimelineClip,
} from "../types/timelineModel";
import type { ProjectMediaAsset } from "../types/project";
import type { Subtitle } from "../types/subtitle";
import { videoPathExists } from "./projectRegistry";

export type MissingMediaKind = "video" | "audio";

export type MissingMediaIssue = {
  path: string;
  name: string;
  kind: MissingMediaKind;
  requiredDuration: number;
  referenceCount: number;
  isPrimary: boolean;
};

type ProjectMediaState = {
  primaryVideoPath: string;
  videoClips: VideoTimelineClip[];
  audioClips: AudioTimelineClip[];
  mediaAssets: ProjectMediaAsset[];
};



type RemoveProjectMediaState = ProjectMediaState & {
  subtitles: Subtitle[];
  removedPath: string;
};

type RelinkProjectMediaState = ProjectMediaState & {
  replacementPath: string;
  replacementName: string;
  replacementDuration: number;
  missingPath: string;
};

const MISSING_MEDIA_CHECK_CONCURRENCY = 6;
const RELINK_DURATION_TOLERANCE_SECONDS = 0.05;

const AUDIO_MEDIA_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "opus",
]);

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function inferredKind(path: string): MissingMediaKind {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_MEDIA_EXTENSIONS.has(extension) ? "audio" : "video";
}

function preferredKind(
  path: string,
  primaryVideoPath: string,
  videoPaths: Set<string>,
  assetKindByPath: Map<string, MissingMediaKind>,
) {
  if (path === primaryVideoPath || videoPaths.has(path)) return "video";
  return assetKindByPath.get(path) ?? inferredKind(path);
}

export function collectProjectMediaReferences({
  primaryVideoPath,
  videoClips,
  audioClips,
  mediaAssets,
}: ProjectMediaState): MissingMediaIssue[] {
  const assetKindByPath = new Map<string, MissingMediaKind>();
  const assetNameByPath = new Map<string, string>();
  const videoPaths = new Set(videoClips.map((clip) => clip.sourcePath));

  for (const asset of mediaAssets) {
    assetKindByPath.set(asset.path, asset.kind);
    assetNameByPath.set(asset.path, asset.name);
  }

  const byPath = new Map<string, MissingMediaIssue>();

  const addReference = (
    path: string,
    name: string,
    requiredDuration: number,
    incrementReference = true,
  ) => {
    const trimmed = path.trim();
    if (!trimmed) return;

    const existing = byPath.get(trimmed);
    const nextDuration = Math.max(
      existing?.requiredDuration ?? 0,
      Number.isFinite(requiredDuration) ? requiredDuration : 0,
    );

    byPath.set(trimmed, {
      path: trimmed,
      name:
        existing?.name ??
        assetNameByPath.get(trimmed) ??
        name ??
        fileName(trimmed),
      kind: preferredKind(
        trimmed,
        primaryVideoPath,
        videoPaths,
        assetKindByPath,
      ),
      requiredDuration: nextDuration,
      referenceCount:
        (existing?.referenceCount ?? 0) + (incrementReference ? 1 : 0),
      isPrimary: trimmed === primaryVideoPath,
    });
  };

  addReference(primaryVideoPath, fileName(primaryVideoPath), 0, false);

  for (const asset of mediaAssets) {
    // An unused Browser asset does not require its full original duration.
    // Timeline sourceOut values below define the minimum compatible duration.
    addReference(asset.path, asset.name, 0);
  }

  for (const clip of videoClips) {
    addReference(clip.sourcePath, clip.sourceName, clip.sourceOut);
  }

  for (const clip of audioClips) {
    addReference(clip.sourcePath, clip.sourceName, clip.sourceOut);
  }

  return [...byPath.values()].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function findMissingProjectMedia(
  state: ProjectMediaState,
): Promise<MissingMediaIssue[]> {
  const references = collectProjectMediaReferences(state);
  if (references.length === 0) return [];

  const availability = new Array<boolean>(references.length).fill(false);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= references.length) return;
      availability[index] = await videoPathExists(references[index].path);
    }
  };

  const workerCount = Math.min(
    MISSING_MEDIA_CHECK_CONCURRENCY,
    references.length,
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return references.filter((_, index) => !availability[index]);
}

export function relinkProjectMediaPath({
  primaryVideoPath,
  videoClips,
  audioClips,
  mediaAssets,
  replacementPath,
  replacementName,
  replacementDuration,
  missingPath,
}: RelinkProjectMediaState) {
  const requiredDuration = Math.max(
    0,
    ...videoClips
      .filter((clip) => clip.sourcePath === missingPath)
      .map((clip) =>
        Math.max(clip.sourceOut, clip.freezeFrameSourceTime ?? 0),
      ),
    ...audioClips
      .filter((clip) => clip.sourcePath === missingPath)
      .map((clip) => clip.sourceOut),
  );

  if (
    requiredDuration > 0 &&
    (!Number.isFinite(replacementDuration) || replacementDuration <= 0)
  ) {
    throw new Error(
      `Could not determine the duration of ${replacementName}; the existing project uses ` +
        `source ranges up to ${requiredDuration.toFixed(2)} s.`,
    );
  }

  if (
    replacementDuration > 0 &&
    replacementDuration + RELINK_DURATION_TOLERANCE_SECONDS < requiredDuration
  ) {
    throw new Error(
      `${replacementName} is too short for the source ranges used by this project. ` +
        `The replacement is ${replacementDuration.toFixed(2)} s, but at least ` +
        `${requiredDuration.toFixed(2)} s is required.`,
    );
  }

  const updateSourceId = (sourceId: string) =>
    sourceId === missingPath ? replacementPath : sourceId;
  const sourceDuration =
    Number.isFinite(replacementDuration) && replacementDuration > 0
      ? replacementDuration
      : undefined;

  return {
    primaryVideoPath:
      primaryVideoPath === missingPath ? replacementPath : primaryVideoPath,
    videoClips: videoClips.map((clip) =>
      clip.sourcePath === missingPath
        ? {
            ...clip,
            sourceId: updateSourceId(clip.sourceId),
            sourcePath: replacementPath,
            sourceName: replacementName,
            ...(sourceDuration !== undefined ? { sourceDuration } : {}),
          }
        : clip,
    ),
    audioClips: audioClips.map((clip) =>
      clip.sourcePath === missingPath
        ? {
            ...clip,
            sourceId: updateSourceId(clip.sourceId),
            sourcePath: replacementPath,
            sourceName: replacementName,
            ...(sourceDuration !== undefined ? { sourceDuration } : {}),
          }
        : clip,
    ),
    mediaAssets: mediaAssets.map((asset) =>
      asset.path === missingPath
        ? {
            ...asset,
            path: replacementPath,
            name: replacementName,
            ...(sourceDuration !== undefined
              ? { duration: replacementDuration }
              : {}),
          }
        : asset,
    ),
  };
}

function clearVideoCompoundMembership(clip: VideoTimelineClip): VideoTimelineClip {
  const next = { ...clip };
  delete next.compoundId;
  delete next.compoundName;
  delete next.compoundAnchor;
  delete next.compoundDisplay;
  delete next.compoundMemberCount;
  return next;
}

/**
 * Removes every project reference to a media source without touching the
 * original file on disk. If a removed clip belonged to a Compound Clip, the
 * remaining members are broken apart so no orphaned/collapsed compound state
 * survives. Primary-source promotion is intentionally handled by App.tsx.
 */
export function removeProjectMediaPath({
  primaryVideoPath,
  videoClips,
  audioClips,
  mediaAssets,
  subtitles,
  removedPath,
}: RemoveProjectMediaState) {
  const affectedCompoundIds = new Set<string>();
  const removedVideoClipIds = new Set(
    videoClips
      .filter((clip) => clip.sourcePath === removedPath)
      .map((clip) => clip.id),
  );

  for (const clip of videoClips) {
    if (clip.sourcePath === removedPath && clip.compoundId) {
      affectedCompoundIds.add(clip.compoundId);
    }
  }

  for (const clip of audioClips) {
    if (clip.sourcePath === removedPath && clip.compoundId) {
      affectedCompoundIds.add(clip.compoundId);
    }
  }

  return {
    primaryVideoPath,
    videoClips: videoClips
      .filter((clip) => clip.sourcePath !== removedPath)
      .map((clip) =>
        clip.compoundId && affectedCompoundIds.has(clip.compoundId)
          ? clearVideoCompoundMembership(clip)
          : clip,
      ),
    audioClips: audioClips
      .filter((clip) => clip.sourcePath !== removedPath)
      .map((clip) =>
        clip.compoundId && affectedCompoundIds.has(clip.compoundId)
          ? { ...clip, compoundId: undefined }
          : clip,
      ),
    subtitles: subtitles
      .filter(
        (subtitle) =>
          !subtitle.linkedVideoClipId ||
          !removedVideoClipIds.has(subtitle.linkedVideoClipId),
      )
      .map((subtitle) =>
        subtitle.compoundId && affectedCompoundIds.has(subtitle.compoundId)
          ? { ...subtitle, compoundId: undefined }
          : subtitle,
      ),
    mediaAssets: mediaAssets.filter((asset) => asset.path !== removedPath),
    affectedCompoundIds: [...affectedCompoundIds],
  };
}

