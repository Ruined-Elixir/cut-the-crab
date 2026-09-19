import { invoke } from "@tauri-apps/api/core";

import {
  DEFAULT_SUBTITLE_TRACK_ID,
  getSubtitleTrackId,
  type Subtitle,
  type SubtitleTextAlign,
} from "../types/subtitle";
import type { TimelineMarker } from "../types/timeline";
import { DEFAULT_TIMELINE_TRACK_SETTINGS } from "../types/timelineModel";
import type {
  AdjustmentLayerClip,
  AdjustmentLayerKeyframes,
  AudioTimelineClip,
  TimelineTrackSettings,
  VideoEffectInstance,
  VideoTimelineClip,
  VideoTransformKeyframeProperty,
  VideoTransformKeyframes,
} from "../types/timelineModel";
import { normalizeVideoTransformKeyframes } from "../utils/videoTransformKeyframes";
import {
  ADJUSTMENT_LAYER_PROPERTIES,
  normalizeAdjustmentKeyframes,
} from "../utils/adjustmentLayers";
import { normalizeVideoPlaybackRate } from "../utils/videoRetime";
import { normalizeVideoEffects } from "../utils/videoEffects";
import type {
  ProjectLanguage,
  ProjectMediaAsset,
  ProjectMetadata,
} from "../types/project";

export const CURRENT_PROJECT_VERSION = 23;

export type SubtitleProject = {
  version: number;
  projectId: string;
  videoPath: string;
  title: string;
  languages: ProjectLanguage[];
  subtitles: Subtitle[];
  markers: TimelineMarker[];
  videoClips: VideoTimelineClip[];
  audioClips: AudioTimelineClip[];
  adjustmentLayers: AdjustmentLayerClip[];
  mediaAssets: ProjectMediaAsset[];
  trackSettings: TimelineTrackSettings;
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

const VIDEO_KEYFRAME_PROPERTIES: VideoTransformKeyframeProperty[] = [
  "positionX",
  "positionY",
  "scale",
  "rotation",
  "opacity",
];

function parseVideoTransformKeyframes(
  value: unknown,
  clipDuration: number,
): VideoTransformKeyframes | undefined {
  if (!isRecord(value)) return undefined;
  const parsed: VideoTransformKeyframes = {};

  for (const property of VIDEO_KEYFRAME_PROPERTIES) {
    const rawChannel = value[property];
    if (!Array.isArray(rawChannel)) continue;
    const channel = rawChannel
      .filter(isRecord)
      .map((item) => ({
        time: asNumber(item.time, Number.NaN),
        value: asNumber(item.value, Number.NaN),
      }))
      .filter((item) => Number.isFinite(item.time) && Number.isFinite(item.value));
    if (channel.length > 0) parsed[property] = channel;
  }

  return normalizeVideoTransformKeyframes(parsed, clipDuration);
}


function parseAdjustmentKeyframes(
  value: unknown,
  duration: number,
): AdjustmentLayerKeyframes | undefined {
  if (!isRecord(value)) return undefined;
  const parsed: AdjustmentLayerKeyframes = {};

  for (const property of ADJUSTMENT_LAYER_PROPERTIES) {
    const rawChannel = value[property];
    if (!Array.isArray(rawChannel)) continue;
    const channel = rawChannel
      .filter(isRecord)
      .map((item) => ({
        time: asNumber(item.time, Number.NaN),
        value: asNumber(item.value, Number.NaN),
      }))
      .filter((item) => Number.isFinite(item.time) && Number.isFinite(item.value));
    if (channel.length > 0) parsed[property] = channel;
  }

  return normalizeAdjustmentKeyframes(parsed, duration);
}

function parseVideoEffects(value: unknown): VideoEffectInstance[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const parsed: VideoEffectInstance[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === "string" && raw.id.length > 0
      ? raw.id
      : `effect-${index}-${crypto.randomUUID()}`;
    const enabled = asOptionalBoolean(raw.enabled) ?? true;

    if (raw.kind === "gaussian-blur") {
      parsed.push({
        id,
        kind: "gaussian-blur",
        enabled,
        radius: asNumber(raw.radius, 8),
      });
      continue;
    }

    if (raw.kind === "sharpen") {
      parsed.push({
        id,
        kind: "sharpen",
        enabled,
        amount: asNumber(raw.amount, 35),
      });
      continue;
    }

    if (raw.kind === "vignette") {
      parsed.push({
        id,
        kind: "vignette",
        enabled,
        amount: asNumber(raw.amount, 45),
        softness: asNumber(raw.softness, 60),
      });
    }
  }

  return normalizeVideoEffects(parsed);
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


function normalizeTrackSettings(value: unknown): TimelineTrackSettings {
  const normalized: TimelineTrackSettings = {
    ...DEFAULT_TIMELINE_TRACK_SETTINGS,
  };

  if (!isRecord(value)) {
    return normalized;
  }

  for (const [trackId, trackValue] of Object.entries(value)) {
    if (!isRecord(trackValue)) {
      continue;
    }

    normalized[trackId] = {
      locked:
        typeof trackValue.locked === "boolean"
          ? trackValue.locked
          : normalized[trackId]?.locked ?? false,
      muted:
        typeof trackValue.muted === "boolean"
          ? trackValue.muted
          : normalized[trackId]?.muted,
      solo:
        typeof trackValue.solo === "boolean"
          ? trackValue.solo
          : normalized[trackId]?.solo,
      hidden:
        typeof trackValue.hidden === "boolean"
          ? trackValue.hidden
          : normalized[trackId]?.hidden,
      deleted:
        typeof trackValue.deleted === "boolean"
          ? trackValue.deleted
          : normalized[trackId]?.deleted,
      linkedTrackId:
        trackValue.linkedTrackId === null
          ? null
          : typeof trackValue.linkedTrackId === "string"
            ? trackValue.linkedTrackId
            : normalized[trackId]?.linkedTrackId,
    };
  }

  return normalized;
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
    trackId:
      typeof value.trackId === "string" && /^subtitle-\d+$/.test(value.trackId)
        ? value.trackId
        : DEFAULT_SUBTITLE_TRACK_ID,
    startTime,
    endTime,
    text,
    positionX: asOptionalNumber(value.positionX),
    positionY: asOptionalNumber(value.positionY),
    compoundId: asOptionalString(value.compoundId),
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
    playbackRate: normalizeVideoPlaybackRate(asOptionalNumber(value.playbackRate)),
    playbackDirection: value.playbackDirection === "reverse" ? "reverse" : "forward",
    freezeFrameSourceTime: asOptionalNumber(value.freezeFrameSourceTime),
    positionX: asOptionalNumber(value.positionX) ?? 0,
    positionY: asOptionalNumber(value.positionY) ?? 0,
    scale: Math.max(10, Math.min(400, asNumber(value.scale, 100))),
    rotation: Math.max(-180, Math.min(180, asNumber(value.rotation, 0))),
    opacity: Math.max(0, Math.min(100, asNumber(value.opacity, 100))),
    transformKeyframes: parseVideoTransformKeyframes(
      value.transformKeyframes,
      timelineEnd - timelineStart,
    ),
    effects: parseVideoEffects(value.effects),
    cropTop: Math.max(0, Math.min(49, asNumber(value.cropTop, 0))),
    cropRight: Math.max(0, Math.min(49, asNumber(value.cropRight, 0))),
    cropBottom: Math.max(0, Math.min(49, asNumber(value.cropBottom, 0))),
    cropLeft: Math.max(0, Math.min(49, asNumber(value.cropLeft, 0))),
    transitionInType:
      value.transitionInType === "cross-dissolve" || value.transitionInType === "fade-black"
        ? value.transitionInType
        : "none",
    transitionInDuration: Math.max(0.1, Math.min(5, asNumber(value.transitionInDuration, 0.5))),
    transitionOutType:
      value.transitionOutType === "cross-dissolve" || value.transitionOutType === "fade-black"
        ? value.transitionOutType
        : "none",
    transitionOutDuration: Math.max(0.1, Math.min(5, asNumber(value.transitionOutDuration, 0.5))),
    videoFadeInDuration: Math.max(
      0,
      Math.min(timelineEnd - timelineStart, asNumber(value.videoFadeInDuration, 0)),
    ),
    videoFadeOutDuration: Math.max(
      0,
      Math.min(timelineEnd - timelineStart, asNumber(value.videoFadeOutDuration, 0)),
    ),
    audioVolume: Math.max(0, Math.min(100, asNumber(value.audioVolume, 100))),
    audioMuted: value.audioMuted === true,
    audioFadeInDuration: Math.max(
      0,
      Math.min(timelineEnd - timelineStart, asNumber(value.audioFadeInDuration, 0)),
    ),
    audioFadeOutDuration: Math.max(
      0,
      Math.min(timelineEnd - timelineStart, asNumber(value.audioFadeOutDuration, 0)),
    ),
    rippleAutoHealInBoundaryId: asOptionalString(value.rippleAutoHealInBoundaryId),
    rippleAutoHealOutBoundaryId: asOptionalString(value.rippleAutoHealOutBoundaryId),
    compoundId: asOptionalString(value.compoundId),
    compoundName: asOptionalString(value.compoundName),
    compoundAnchor: asOptionalBoolean(value.compoundAnchor),
    timelineStart,
    timelineEnd,
  };
}

function normalizeAudioClip(
  value: unknown,
  index: number,
): AudioTimelineClip | null {
  if (!isRecord(value)) return null;

  const timelineStart = asNumber(value.timelineStart, 0);
  const timelineEnd = asNumber(value.timelineEnd, timelineStart);
  const sourceIn = asNumber(value.sourceIn, 0);
  const sourceOut = asNumber(value.sourceOut, sourceIn + (timelineEnd - timelineStart));
  const sourcePath = typeof value.sourcePath === "string" ? value.sourcePath : "";

  if (!sourcePath || timelineStart < 0 || timelineEnd <= timelineStart || sourceIn < 0 || sourceOut <= sourceIn) {
    return null;
  }

  const duration = timelineEnd - timelineStart;
  return {
    id: typeof value.id === "string" && value.id ? value.id : `audio-clip-${index}-${crypto.randomUUID()}`,
    kind: "audio",
    trackId: typeof value.trackId === "string" ? value.trackId : "audio-1",
    sourceId: typeof value.sourceId === "string" && value.sourceId ? value.sourceId : sourcePath,
    sourcePath,
    sourceName: typeof value.sourceName === "string" && value.sourceName ? value.sourceName : (sourcePath.split(/[\\/]/).pop() ?? "Audio"),
    sourceIn,
    sourceOut,
    sourceDuration: asOptionalNumber(value.sourceDuration),
    volume: Math.max(0, Math.min(100, asNumber(value.volume, 100))),
    muted: value.muted === true,
    fadeInDuration: Math.max(0, Math.min(duration, asNumber(value.fadeInDuration, 0))),
    fadeOutDuration: Math.max(0, Math.min(duration, asNumber(value.fadeOutDuration, 0))),
    compoundId: asOptionalString(value.compoundId),
    timelineStart,
    timelineEnd,
  };
}

function normalizeAdjustmentLayer(
  value: unknown,
  index: number,
): AdjustmentLayerClip | null {
  if (!isRecord(value)) return null;

  const timelineStart = Math.max(0, asNumber(value.timelineStart, 0));
  const timelineEnd = asNumber(value.timelineEnd, timelineStart + 5);
  const trackId = typeof value.trackId === "string" && /^video-\d+$/.test(value.trackId)
    ? value.trackId
    : "video-1";

  if (timelineEnd - timelineStart < 0.1) return null;

  const duration = timelineEnd - timelineStart;

  return {
    id: typeof value.id === "string" && value.id ? value.id : `adjustment-${index}-${crypto.randomUUID()}`,
    kind: "adjustment",
    trackId,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : `Adjustment Layer ${index + 1}`,
    timelineStart,
    timelineEnd,
    enabled: asOptionalBoolean(value.enabled) ?? true,
    opacity: Math.max(0, Math.min(100, asNumber(value.opacity, 100))),
    exposure: Math.max(-3, Math.min(3, asNumber(value.exposure, 0))),
    contrast: Math.max(-100, Math.min(100, asNumber(value.contrast, 0))),
    saturation: Math.max(0, Math.min(200, asNumber(value.saturation, 100))),
    temperature: Math.max(-100, Math.min(100, asNumber(value.temperature, 0))),
    tint: Math.max(-100, Math.min(100, asNumber(value.tint, 0))),
    highlights: Math.max(-100, Math.min(100, asNumber(value.highlights, 0))),
    shadows: Math.max(-100, Math.min(100, asNumber(value.shadows, 0))),
    whites: Math.max(-100, Math.min(100, asNumber(value.whites, 0))),
    blacks: Math.max(-100, Math.min(100, asNumber(value.blacks, 0))),
    keyframes: parseAdjustmentKeyframes(value.keyframes, duration),
    effects: parseVideoEffects(value.effects),
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
    kind: value.kind === "audio" ? "audio" : "video",
    path,
    name:
      typeof value.name === "string" && value.name.length > 0
        ? value.name
        : path.split(/[\\/]/).pop() ?? (value.kind === "audio" ? "Audio" : "Video"),
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
    .map((subtitle) => ({ ...subtitle, trackId: getSubtitleTrackId(subtitle) }))
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

  const audioClips = Array.isArray(value.audioClips)
    ? value.audioClips
        .map((clip, index) => normalizeAudioClip(clip, index))
        .filter((clip): clip is AudioTimelineClip => clip !== null)
        .sort((a, b) => a.timelineStart - b.timelineStart)
    : [];

  const adjustmentLayers = Array.isArray(value.adjustmentLayers)
    ? value.adjustmentLayers
        .map((layer, index) => normalizeAdjustmentLayer(layer, index))
        .filter((layer): layer is AdjustmentLayerClip => layer !== null)
        .sort((a, b) => a.timelineStart - b.timelineStart)
    : [];

  const normalizedTrackSettings = normalizeTrackSettings(value.trackSettings);

  for (const layer of adjustmentLayers) {
    if (!normalizedTrackSettings[layer.trackId]) {
      normalizedTrackSettings[layer.trackId] = { locked: false, hidden: false, linkedTrackId: null };
    }
  }

  // v16 persists subtitle ownership on each subtitle. Ensure every subtitle
  // track referenced by project data has a corresponding control state even
  // if the saved settings object was incomplete.
  for (const subtitle of subtitles) {
    const trackId = getSubtitleTrackId(subtitle);
    if (!normalizedTrackSettings[trackId]) {
      normalizedTrackSettings[trackId] = { locked: false, hidden: false };
    }
  }

  // v14 and older implicitly paired Vn with An. Preserve that behavior by
  // turning it into explicit links during migration. v15+ stores the links.
  if (version < 15) {
    const videoTrackIds = new Set<string>([
      ...Object.keys(normalizedTrackSettings).filter((id) => /^video-\d+$/.test(id) && normalizedTrackSettings[id]?.deleted !== true),
      ...videoClips.map((clip) => clip.trackId),
    ]);

    for (const videoTrackId of videoTrackIds) {
      const match = /^video-(\d+)$/.exec(videoTrackId);
      if (!match) continue;
      const audioTrackId = `audio-${match[1]}`;
      if (normalizedTrackSettings[audioTrackId]?.deleted === true) continue;
      normalizedTrackSettings[videoTrackId] = {
        ...(normalizedTrackSettings[videoTrackId] ?? { locked: false, hidden: false }),
        linkedTrackId: audioTrackId,
      };
      normalizedTrackSettings[audioTrackId] = {
        ...(normalizedTrackSettings[audioTrackId] ?? { locked: true, muted: false }),
        locked: true,
        linkedTrackId: videoTrackId,
      };
    }
  }

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
    audioClips,
    adjustmentLayers,
    mediaAssets,
    trackSettings: normalizedTrackSettings,
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
  audioClips: AudioTimelineClip[] = [],
  adjustmentLayers: AdjustmentLayerClip[] = [],
  mediaAssets: ProjectMediaAsset[] = [],
  trackSettings: TimelineTrackSettings = DEFAULT_TIMELINE_TRACK_SETTINGS,
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
      (a, b) => a.timelineStart - b.timelineStart,
    ),
    audioClips: [...audioClips].sort(
      (a, b) => a.timelineStart - b.timelineStart,
    ),
    adjustmentLayers: [...adjustmentLayers].sort(
      (a, b) => a.timelineStart - b.timelineStart,
    ),
    mediaAssets,
    trackSettings,
    updatedAt: new Date().toISOString(),
  };

  await invoke("save_subtitle_project", {
    projectId,
    projectJson: JSON.stringify(project, null, 2),
  });
}
