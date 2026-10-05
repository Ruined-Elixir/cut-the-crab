import { invoke } from "@tauri-apps/api/core";
import { traceCut } from "../utils/cutTrace";

export async function ensureVideoProxy(sourcePath: string): Promise<string> {
  traceCut("proxy-task-start", { sourcePath });
  return invoke<string>("ensure_video_proxy", {
    sourcePath,
  });
}

export async function cancelVideoProxy(sourcePath: string): Promise<void> {
  await invoke("cancel_video_proxy", { sourcePath });
}
