import { invoke } from "@tauri-apps/api/core";

export async function ensureVideoProxy(sourcePath: string): Promise<string> {
  return invoke<string>("ensure_video_proxy", {
    sourcePath,
  });
}
