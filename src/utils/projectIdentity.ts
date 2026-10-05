import type { RecentProject } from "../types/project";

export const MAX_PROJECT_TITLE_LENGTH = 80;

export function normalizeProjectTitle(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export function projectTitleKey(value: string) {
  return normalizeProjectTitle(value).toLocaleLowerCase();
}

export function projectTitleExists(
  projects: RecentProject[],
  title: string,
  excludingProjectId?: string,
) {
  const key = projectTitleKey(title);
  if (!key) return false;

  return projects.some(
    (project) =>
      project.projectId !== excludingProjectId &&
      projectTitleKey(project.title) === key,
  );
}
