import { useEffect, useMemo, useState } from "react";

import {
  PROJECT_LANGUAGE_LABELS,
  type ProjectLanguage,
  type RecentProject,
} from "../../types/project";

import "./HomeScreen.css";

type HomeScreenProps = {
  projects: RecentProject[];
  pendingVideoPath: string | null;
  errorMessage: string;

  onChooseNewVideo: () => void | Promise<void>;
  onCancelNewProject: () => void;
  onCreateProject: (language: ProjectLanguage) => void | Promise<void>;

  onOpenProject: (project: RecentProject) => void | Promise<void>;
  onRemoveProject: (project: RecentProject) => void | Promise<void>;
};

const LANGUAGE_OPTIONS: ProjectLanguage[] = [
  "english",
  "cantonese",
  "mandarin",
  "french",
  "mixed",
];

function getFileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function formatLastOpened(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Recently opened";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDuration(duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return "";
  }

  const totalSeconds = Math.floor(duration);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function HomeScreen({
  projects,
  pendingVideoPath,
  errorMessage,
  onChooseNewVideo,
  onCancelNewProject,
  onCreateProject,
  onOpenProject,
  onRemoveProject,
}: HomeScreenProps) {
  const [selectedLanguage, setSelectedLanguage] =
    useState<ProjectLanguage>("english");

  useEffect(() => {
    if (pendingVideoPath) {
      setSelectedLanguage("english");
    }
  }, [pendingVideoPath]);

  const pendingVideoName = useMemo(
    () => (pendingVideoPath ? getFileName(pendingVideoPath) : ""),
    [pendingVideoPath],
  );

  return (
    <main className="home-screen">
      <div className="home-shell">
        <header className="home-header">
          <div>
            <div className="home-eyebrow">LOCAL SUBTITLE WORKSPACE</div>
            <h1>Subtitle Editor</h1>
            <p>
              Open a recent project or create a new transcription workspace.
            </p>
          </div>

          <button
            type="button"
            className="home-new-project-button"
            onClick={() => void onChooseNewVideo()}
          >
            <span aria-hidden="true">＋</span>
            New Project
          </button>
        </header>

        {errorMessage && (
          <div className="home-error" role="alert">
            {errorMessage}
          </div>
        )}

        <section className="home-recents">
          <div className="home-section-heading">
            <h2>Recent Projects</h2>
            <span>{projects.length}</span>
          </div>

          {projects.length > 0 ? (
            <div className="project-grid">
              {projects.map((project) => {
                const duration = formatDuration(project.duration);

                return (
                  <article
                    key={project.videoPath}
                    className="project-card"
                    onDoubleClick={() => void onOpenProject(project)}
                  >
                    <button
                      type="button"
                      className="project-card-main"
                      onClick={() => void onOpenProject(project)}
                    >
                      <div className="project-thumbnail-placeholder">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <rect x="3" y="5" width="18" height="14" rx="2" />
                          <path d="m10 9 5 3-5 3Z" />
                        </svg>

                        {duration && (
                          <span className="project-duration">{duration}</span>
                        )}
                      </div>

                      <div className="project-card-content">
                        <strong title={project.title}>{project.title}</strong>

                        <span
                          className="project-video-name"
                          title={project.videoPath}
                        >
                          {getFileName(project.videoPath)}
                        </span>

                        <div className="project-language-badges">
                          {project.languages.length > 0 ? (
                            project.languages.map((language) => (
                              <span key={language}>
                                {PROJECT_LANGUAGE_LABELS[language]}
                              </span>
                            ))
                          ) : (
                            <span>Language not set</span>
                          )}
                        </div>

                        <time dateTime={project.lastOpenedAt}>
                          {formatLastOpened(project.lastOpenedAt)}
                        </time>
                      </div>
                    </button>

                    <button
                      type="button"
                      className="project-remove-button"
                      onClick={() => void onRemoveProject(project)}
                      aria-label={`Remove ${project.title} from recent projects`}
                      title="Remove from Recent Projects"
                    >
                      ×
                    </button>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="home-empty-state">
              <div className="home-empty-icon" aria-hidden="true">
                ▶
              </div>
              <h3>No recent projects yet</h3>
              <p>Choose a video to create your first subtitle project.</p>
              <button
                type="button"
                onClick={() => void onChooseNewVideo()}
              >
                Choose Video
              </button>
            </div>
          )}
        </section>
      </div>

      {pendingVideoPath && (
        <div className="new-project-backdrop">
          <section
            className="new-project-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-project-title"
          >
            <div className="new-project-dialog-header">
              <div>
                <span>NEW PROJECT</span>
                <h2 id="new-project-title">{pendingVideoName}</h2>
              </div>

              <button
                type="button"
                className="new-project-close"
                onClick={onCancelNewProject}
                aria-label="Cancel new project"
              >
                ×
              </button>
            </div>

            <p className="new-project-help">
              Choose the main spoken language. The project opens immediately,
              and subtitle generation runs inside the editor.
            </p>

            <div className="language-grid" role="radiogroup">
              {LANGUAGE_OPTIONS.map((language) => (
                <button
                  type="button"
                  key={language}
                  className={
                    selectedLanguage === language
                      ? "language-option selected"
                      : "language-option"
                  }
                  onClick={() => setSelectedLanguage(language)}
                  role="radio"
                  aria-checked={selectedLanguage === language}
                >
                  <span className="language-radio" />
                  <span>{PROJECT_LANGUAGE_LABELS[language]}</span>
                </button>
              ))}
            </div>

            <div className="new-project-actions">
              <button
                type="button"
                className="new-project-secondary"
                onClick={onCancelNewProject}
              >
                Cancel
              </button>

              <button
                type="button"
                className="new-project-primary"
                onClick={() => void onCreateProject(selectedLanguage)}
              >
                Create & Generate Subtitles
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

export default HomeScreen;
