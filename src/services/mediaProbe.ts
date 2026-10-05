import { invoke } from "@tauri-apps/api/core";

export type MediaStreams = {
  path: string;
  hasVideo: boolean;
  hasAudio: boolean;
};

const cache = new Map<string, MediaStreams>();

export async function probeMediaStreams(
  paths: string[],
): Promise<Map<string, MediaStreams>> {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  const missing = uniquePaths.filter((path) => !cache.has(path));

  if (missing.length > 0) {
    const results = await invoke<MediaStreams[]>("probe_media_streams", {
      paths: missing,
    });

    for (const item of results) {
      cache.set(item.path, item);
    }
  }

  return new Map(
    uniquePaths.map((path) => [
      path,
      cache.get(path) ?? { path, hasVideo: false, hasAudio: false },
    ]),
  );
}
