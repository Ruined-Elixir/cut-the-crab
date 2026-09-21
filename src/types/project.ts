export type ProjectLanguage =
  "english" | "cantonese" | "mandarin" | "french" | "mixed";

export type ProjectMetadata = {
  title: string;
  languages: ProjectLanguage[];
};

export type ProjectMediaAsset = {
  id: string;
  kind: "video" | "audio";
  path: string;
  name: string;
  duration: number;
};

export type RecentProject = ProjectMetadata & {
  projectId: string;
  videoPath: string;
  lastOpenedAt: string;
  duration: number;
};

export const PROJECT_LANGUAGE_LABELS: Record<ProjectLanguage, string> = {
  english: "English",
  cantonese: "Cantonese",
  mandarin: "Mandarin",
  french: "French",
  mixed: "Mixed / Auto",
};
