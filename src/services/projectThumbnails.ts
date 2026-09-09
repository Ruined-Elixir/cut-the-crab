import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export async function getProjectThumbnailUrl(
  videoPath: string,
  duration = 0,
): Promise<string> {
  const thumbnailPath = await invoke<string>("get_project_thumbnail", {
    videoPath,
    duration,
  });

  return convertFileSrc(thumbnailPath);
}
