import { invoke } from "@tauri-apps/api/core";

export type MediaStreams = {
  path: string;
  hasVideo: boolean;
  hasAudio: boolean;
};

export async function probeMediaStreams(
  paths: string[],
): Promise<Map<string, MediaStreams>> {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  if (uniquePaths.length === 0) return new Map();

  // Probe at export time rather than caching by path for the whole app
  // session. Editors commonly replace/relink media in place; a path-only
  // cache can otherwise retain stale audio/video stream topology.
  const results = await invoke<MediaStreams[]>("probe_media_streams", {
    paths: uniquePaths,
  });
  const byPath = new Map(results.map((item) => [item.path, item]));

  return new Map(
    uniquePaths.map((path) => [
      path,
      byPath.get(path) ?? { path, hasVideo: false, hasAudio: false },
    ]),
  );
}
