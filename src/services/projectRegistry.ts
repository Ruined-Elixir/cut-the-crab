import { invoke } from "@tauri-apps/api/core";

import type { RecentProject } from "../types/project";

export async function loadRecentProjects(): Promise<RecentProject[]> {
  try {
    return await invoke<RecentProject[]>("read_recent_projects");
  } catch (error) {
    console.error("Failed to read recent projects:", error);
    return [];
  }
}

export async function upsertRecentProject(
  project: RecentProject,
): Promise<void> {
  await invoke("upsert_recent_project", {
    project,
  });
}

export async function removeRecentProject(projectId: string): Promise<void> {
  await invoke("remove_recent_project", {
    projectId,
  });
}

export async function videoPathExists(videoPath: string): Promise<boolean> {
  return invoke<boolean>("path_exists", {
    path: videoPath,
  });
}
