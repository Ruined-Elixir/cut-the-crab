import { useEffect, useMemo, useState } from "react";

import CtcLogo from "../brand/CtcLogo";

import {
  PROJECT_LANGUAGE_LABELS,
  type ProjectLanguage,
  type RecentProject,
} from "../../types/project";

import { getProjectThumbnailUrl } from "../../services/projectThumbnails";
import { videoPathExists } from "../../services/projectRegistry";
import {
  MAX_PROJECT_TITLE_LENGTH,
  normalizeProjectTitle,
  projectTitleExists,
} from "../../utils/projectIdentity";

import "./HomeScreen.css";

type HomeScreenProps = {
  projects: RecentProject[];
  pendingVideoPath: string | null;
  pendingProjectTitle: string | null;
  newProjectRequestId: number;
  errorMessage: string;

  onChooseNewVideo: (projectTitle: string) => Promise<boolean>;
  onCancelNewProject: () => void;
  onCreateProject: (language: ProjectLanguage) => void | Promise<void>;

  onOpenProject: (project: RecentProject) => void | Promise<void>;
  onRenameProject: (
    project: RecentProject,
    title: string,
  ) => void | Promise<void>;
  onRelinkProject: (project: RecentProject) => void | Promise<void>;
  onRemoveProject: (project: RecentProject) => void | Promise<void>;
};

type ProjectContextMenuState = {
  project: RecentProject;
  x: number;
  y: number;
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
  pendingProjectTitle,
  newProjectRequestId,
  errorMessage,
  onChooseNewVideo,
  onCancelNewProject,
  onCreateProject,
  onOpenProject,
  onRenameProject,
  onRelinkProject,
  onRemoveProject,
}: HomeScreenProps) {
  const [selectedLanguage, setSelectedLanguage] =
    useState<ProjectLanguage>("english");
  const [projectNameDialogOpen, setProjectNameDialogOpen] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [projectNameError, setProjectNameError] = useState("");
  const [isChoosingNewProjectVideo, setIsChoosingNewProjectVideo] =
    useState(false);

  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>(
    {},
  );

  const [projectAvailability, setProjectAvailability] = useState<
    Record<string, boolean>
  >({});

  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(
    null,
  );
  const [renameDraft, setRenameDraft] = useState("");

  const [projectContextMenu, setProjectContextMenu] =
    useState<ProjectContextMenuState | null>(null);

  useEffect(() => {
    if (pendingVideoPath) {
      setSelectedLanguage("english");
      setProjectNameDialogOpen(false);
      setProjectNameError("");
    }
  }, [pendingVideoPath]);

  useEffect(() => {
    if (newProjectRequestId <= 0) return;
    setProjectNameDraft("");
    setProjectNameError("");
    setProjectNameDialogOpen(true);
  }, [newProjectRequestId]);

  useEffect(() => {
    if (!projectContextMenu) {
      return;
    }

    const dismiss = () => {
      setProjectContextMenu(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProjectContextMenu(null);

        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      }
    };

    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);

    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [projectContextMenu]);

  useEffect(() => {
    let cancelled = false;

    const inspectProjects = async () => {
      for (const project of projects) {
        if (cancelled) {
          return;
        }

        try {
          const exists = await videoPathExists(project.videoPath);

          if (cancelled) {
            return;
          }

          setProjectAvailability((current) => ({
            ...current,
            [project.videoPath]: exists,
          }));

          if (!exists) {
            continue;
          }

          const thumbnailUrl = await getProjectThumbnailUrl(
            project.videoPath,
            project.duration,
          );

          if (!cancelled) {
            setThumbnailUrls((current) => ({
              ...current,
              [project.videoPath]: thumbnailUrl,
            }));
          }
        } catch (error) {
          console.warn(
            `Unable to inspect recent project ${project.videoPath}:`,
            error,
          );
        }
      }
    };

    void inspectProjects();

    return () => {
      cancelled = true;
    };
  }, [projects]);

  const openProjectContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    project: RecentProject,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const menuWidth = 220;
    const menuHeight = 176;
    const edgeInset = 10;

    const x = Math.min(
      event.clientX,
      window.innerWidth - menuWidth - edgeInset,
    );
    const y = Math.min(
      event.clientY,
      window.innerHeight - menuHeight - edgeInset,
    );

    setProjectContextMenu({
      project,
      x: Math.max(edgeInset, x),
      y: Math.max(edgeInset, y),
    });
  };

  const dismissProjectContextMenu = () => {
    setProjectContextMenu(null);
  };

  const beginRename = (project: RecentProject) => {
    setRenamingProjectId(project.projectId);
    setRenameDraft(project.title);
  };

  const cancelRename = () => {
    setRenamingProjectId(null);
    setRenameDraft("");
  };

  const commitRename = async (project: RecentProject) => {
    const title = renameDraft.trim();

    if (!title) {
      cancelRename();
      return;
    }

    await onRenameProject(project, title);
    cancelRename();
  };

  const beginNewProject = () => {
    setProjectNameDraft("");
    setProjectNameError("");
    setProjectNameDialogOpen(true);
  };

  const cancelProjectNameDialog = () => {
    if (isChoosingNewProjectVideo) return;
    setProjectNameDialogOpen(false);
    setProjectNameDraft("");
    setProjectNameError("");
  };

  const continueNewProject = async () => {
    if (isChoosingNewProjectVideo) return;

    const title = normalizeProjectTitle(projectNameDraft);
    if (!title) {
      setProjectNameError("Enter a project name.");
      return;
    }
    if (title.length > MAX_PROJECT_TITLE_LENGTH) {
      setProjectNameError(
        `Project names can be up to ${MAX_PROJECT_TITLE_LENGTH} characters.`,
      );
      return;
    }
    if (projectTitleExists(projects, title)) {
      setProjectNameError("That project name is already in use. Choose a unique name.");
      return;
    }

    setProjectNameError("");
    setIsChoosingNewProjectVideo(true);
    try {
      const selected = await onChooseNewVideo(title);
      if (selected) {
        setProjectNameDraft(title);
        setProjectNameDialogOpen(false);
      }
    } finally {
      setIsChoosingNewProjectVideo(false);
    }
  };

  const pendingVideoName = useMemo(
    () => (pendingVideoPath ? getFileName(pendingVideoPath) : ""),
    [pendingVideoPath],
  );

  return (
    <main className="home-screen">
      <div className="home-shell">
        <header className="home-header">
          <div className="home-brand">
            <CtcLogo className="home-brand-logo" alt="Cut The Crab" />

            <div className="home-brand-copy">
              <div className="home-eyebrow">LOCAL SUBTITLE WORKSPACE</div>
              <h1>CUT THE CRAB</h1>
              <p>
                Open a recent project or create a new transcription workspace.
              </p>
            </div>
          </div>

          <button
            type="button"
            className="home-new-project-button"
            onClick={beginNewProject}
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
                const isMissing =
                  projectAvailability[project.videoPath] === false;

                return (
                  <article
                    key={project.projectId}
                    className={[
                      "project-card",
                      isMissing ? "missing-media" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onContextMenu={(event) =>
                      openProjectContextMenu(event, project)
                    }
                  >
                    <div
                      className="project-card-main"
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        if (renamingProjectId !== project.projectId) {
                          void onOpenProject(project);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (
                          renamingProjectId !== project.projectId &&
                          (event.key === "Enter" || event.key === " ")
                        ) {
                          event.preventDefault();
                          void onOpenProject(project);
                        }
                      }}
                    >
                      <div className="project-thumbnail">
                        {thumbnailUrls[project.videoPath] ? (
                          <img
                            src={thumbnailUrls[project.videoPath]}
                            alt=""
                            aria-hidden="true"
                            draggable={false}
                          />
                        ) : (
                          <div
                            className="project-thumbnail-placeholder"
                            aria-hidden="true"
                          >
                            <svg viewBox="0 0 24 24">
                              <rect x="3" y="5" width="18" height="14" rx="2" />
                              <path d="m10 9 5 3-5 3Z" />
                            </svg>
                          </div>
                        )}

                        <div
                          className="project-thumbnail-shade"
                          aria-hidden="true"
                        />

                        {isMissing && (
                          <div className="project-missing-media-overlay">
                            <span
                              className="project-missing-media-icon"
                              aria-hidden="true"
                            >
                              !
                            </span>

                            <div>
                              <strong>Missing Media</strong>
                              <span>Click to relink</span>
                            </div>
                          </div>
                        )}

                        {duration && (
                          <span className="project-duration">{duration}</span>
                        )}
                      </div>

                      <div className="project-card-content">
                        {renamingProjectId === project.projectId ? (
                          <input
                            className="project-title-input"
                            value={renameDraft}
                            autoFocus
                            aria-label={`Rename ${project.title}`}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) =>
                              setRenameDraft(event.target.value)
                            }
                            onKeyDown={(event) => {
                              event.stopPropagation();

                              if (event.key === "Enter") {
                                event.preventDefault();
                                void commitRename(project);
                              }

                              if (event.key === "Escape") {
                                event.preventDefault();
                                cancelRename();
                              }
                            }}
                            onBlur={() => void commitRename(project)}
                          />
                        ) : (
                          <strong
                            className="project-title"
                            title={project.title}
                            onDoubleClick={(event) => {
                              event.stopPropagation();
                              beginRename(project);
                            }}
                          >
                            {project.title}
                          </strong>
                        )}

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
                    </div>

                    <button
                      type="button"
                      className="project-rename-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        beginRename(project);
                      }}
                      aria-label={`Rename ${project.title}`}
                      title="Rename Project"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4 20h4l10.5-10.5a2.8 2.8 0 0 0-4-4L4 16v4Z" />
                        <path d="m13.5 6.5 4 4" />
                      </svg>
                    </button>

                    {isMissing && (
                      <button
                        type="button"
                        className="project-relink-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void onRelinkProject(project);
                        }}
                        title="Relink Media"
                      >
                        Relink
                      </button>
                    )}

                    <button
                      type="button"
                      className="project-remove-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void onRemoveProject(project);
                      }}
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
              <p>Name your project, then choose its source video and language.</p>
              <button type="button" onClick={beginNewProject}>
                New Project
              </button>
            </div>
          )}
        </section>
      </div>

      {projectContextMenu && (
        <div
          className="project-context-menu"
          role="menu"
          aria-label={`Project actions for ${projectContextMenu.project.title}`}
          style={{
            left: projectContextMenu.x,
            top: projectContextMenu.y,
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            className="project-context-menu-item"
            onClick={() => {
              const project = projectContextMenu.project;
              dismissProjectContextMenu();
              void onOpenProject(project);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 4.5h5l2 2H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z" />
            </svg>
            <span>Open</span>
          </button>

          <button
            type="button"
            role="menuitem"
            className="project-context-menu-item"
            onClick={() => {
              const project = projectContextMenu.project;
              dismissProjectContextMenu();
              beginRename(project);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 20h4l10.5-10.5a2.8 2.8 0 0 0-4-4L4 16v4Z" />
              <path d="m13.5 6.5 4 4" />
            </svg>
            <span>Rename</span>
          </button>

          <button
            type="button"
            role="menuitem"
            className="project-context-menu-item"
            onClick={() => {
              const project = projectContextMenu.project;
              dismissProjectContextMenu();
              void onRelinkProject(project);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8.5 15.5 15.5 8.5" />
              <path d="M7 8.5H5.5a3.5 3.5 0 0 0 0 7H9" />
              <path d="M15 8.5h3.5a3.5 3.5 0 0 1 0 7H15" />
            </svg>
            <span>Relink Media…</span>
          </button>

          <div className="project-context-menu-separator" role="separator" />

          <button
            type="button"
            role="menuitem"
            className="project-context-menu-item destructive"
            onClick={() => {
              const project = projectContextMenu.project;
              dismissProjectContextMenu();
              void onRemoveProject(project);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16" />
              <path d="M9 7V4h6v3" />
              <path d="m6.5 7 1 13h9l1-13" />
              <path d="M10 11v5M14 11v5" />
            </svg>
            <span>Remove from Recents</span>
          </button>
        </div>
      )}

      {projectNameDialogOpen && !pendingVideoPath && (
        <div className="new-project-backdrop">
          <section
            className="new-project-dialog project-name-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-name-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                cancelProjectNameDialog();
              }
            }}
          >
            <div className="new-project-dialog-header">
              <div>
                <span>NEW PROJECT</span>
                <h2 id="project-name-title">Name your project</h2>
              </div>

              <button
                type="button"
                className="new-project-close"
                onClick={cancelProjectNameDialog}
                aria-label="Cancel new project"
                disabled={isChoosingNewProjectVideo}
              >
                ×
              </button>
            </div>

            <p className="new-project-help">
              The project name identifies this edit independently from its source video.
              Two projects can use the same video without sharing subtitles or timeline state.
            </p>

            <label className="project-name-field">
              <span>Project Name</span>
              <input
                autoFocus
                type="text"
                value={projectNameDraft}
                maxLength={MAX_PROJECT_TITLE_LENGTH}
                placeholder="My Project"
                disabled={isChoosingNewProjectVideo}
                onChange={(event) => {
                  setProjectNameDraft(event.target.value);
                  if (projectNameError) setProjectNameError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void continueNewProject();
                  }
                }}
              />
            </label>

            <div className="project-name-meta">
              <span className={projectNameError ? "project-name-error visible" : "project-name-error"}>
                {projectNameError || "Project names must be unique."}
              </span>
              <span>{normalizeProjectTitle(projectNameDraft).length}/{MAX_PROJECT_TITLE_LENGTH}</span>
            </div>

            <div className="new-project-actions">
              <button
                type="button"
                className="new-project-secondary"
                onClick={cancelProjectNameDialog}
                disabled={isChoosingNewProjectVideo}
              >
                Cancel
              </button>

              <button
                type="button"
                className="new-project-primary"
                onClick={() => void continueNewProject()}
                disabled={isChoosingNewProjectVideo}
              >
                {isChoosingNewProjectVideo ? "Choosing…" : "Choose Video…"}
              </button>
            </div>
          </section>
        </div>
      )}

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
                <h2 id="new-project-title">{pendingProjectTitle ?? "New Project"}</h2>
                <div className="new-project-source" title={pendingVideoPath}>
                  {pendingVideoName}
                </div>
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
              Choose the main spoken language. This project has its own unique
              save identity even if another project uses the same source video.
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
