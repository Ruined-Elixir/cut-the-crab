import { useEffect, useRef, useState } from "react";
import VideoPlayer from "./components/VideoPlayer";
import Timeline from "./components/Timeline";
import "./App.css";
import { invoke } from "@tauri-apps/api/core";
import type { Subtitle } from "./types/subtitle";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { generateSrt, parseSrt } from "./utils/srt";


function App() {
  const [videoDuration, setVideoDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [seekTo, setSeekTo] = useState<number | undefined>(undefined);
  const [videoName, setVideoName] = useState<string | null>(null);

  // Wave Form
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [waveform, setWaveform] = useState<number[]>([]);
  const [timelineZoom, setTimelineZoom] = useState(1);

  // Subtitles
  const [selectedSubtitleId, setSelectedSubtitleId] = useState<string | null>(null);
  const [subtitleSearch, setSubtitleSearch] = useState("");
  const subtitleListRef = useRef<HTMLDivElement | null>(null);

  const testFfmpeg = async () => {
    try {
      const version = await invoke<string>("get_ffmpeg_version");
      console.log(version);
    } catch (error) {
      console.error("FFmpeg test failed:", error);
    }
  };

  const generateWaveform = async (path: string) => {
    try {
      const data = await invoke<number[]>("extract_waveform", {
        videoPath: path,
        points: 1200,
      });

      setWaveform(data);
      console.log("Waveform points:", data.length);
    } catch (error) {
      console.error("Waveform extraction failed:", error);
    }
  };

  // Subtitles
  const [subtitles, setSubtitles] = useState<Subtitle[]>([    {
      id: "1",
      startTime: 1.2,
      endTime: 3.8,
      text: "Hello everyone",
    },
    {
      id: "2",
      startTime: 4.5,
      endTime: 7.1,
      text: "This is a subtitle test",
    },
  ]);

  const updateSubtitleText = (id: string, text: string) => {
    setSubtitles((currentSubtitles) =>
      currentSubtitles.map((subtitle) =>
        subtitle.id === id
          ? { ...subtitle, text }
          : subtitle
      )
    );
  };

  const updateSubtitleTiming = (
    id: string,
    field: "startTime" | "endTime",
    value: number
  ) => {
    setSubtitles((currentSubtitles) =>
      currentSubtitles.map((subtitle) => {
        if (subtitle.id !== id) return subtitle;

        if (field === "startTime") {
          return {
            ...subtitle,
            startTime: Math.max(0, Math.min(value, subtitle.endTime)),
          };
        }

        return {
          ...subtitle,
          endTime: Math.max(subtitle.startTime, value),
        };
      })
    );
  };

  const formatSubtitleTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);

    return `${minutes
      .toString()
      .padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
  };

  const filteredSubtitles = subtitles.filter((subtitle) =>
    subtitle.text
      .toLowerCase()
      .includes(subtitleSearch.toLowerCase())
  );

  const activeSubtitle = subtitles.find(
    (subtitle) =>
      currentTime >= subtitle.startTime &&
      currentTime <= subtitle.endTime
  );

  useEffect(() => {
    if (!activeSubtitle || !subtitleListRef.current) return;

    const element = subtitleListRef.current.querySelector(
      `[data-subtitle-id="${activeSubtitle.id}"]`
    );

    if (element instanceof HTMLElement) {
      element.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [activeSubtitle?.id]);

  const moveSubtitle = (
    id: string,
    newStartTime: number
  ) => {
    setSubtitles((currentSubtitles) =>
      currentSubtitles.map((subtitle) => {
        if (subtitle.id !== id) return subtitle;

        const duration =
          subtitle.endTime - subtitle.startTime;

        return {
          ...subtitle,
          startTime: newStartTime,
          endTime: newStartTime + duration,
        };
      })
    );
  };

  const resizeSubtitle = (
    id: string,
    newStartTime: number,
    newEndTime: number
  ) => {
    setSubtitles((currentSubtitles) =>
      currentSubtitles.map((subtitle) =>
        subtitle.id === id
          ? {
              ...subtitle,
              startTime: newStartTime,
              endTime: newEndTime,
            }
          : subtitle
      )
    );
  };

  const addSubtitle = () => {
    const startTime = currentTime;
    const endTime = Math.min(
      videoDuration,
      currentTime + 2
    );

    const newSubtitle: Subtitle = {
      id: crypto.randomUUID(),
      startTime,
      endTime,
      text: "New subtitle",
    };

    setSubtitles((currentSubtitles) => [
      ...currentSubtitles,
      newSubtitle,
    ]);

    setSelectedSubtitleId(newSubtitle.id);
  };

  const deleteSubtitle = (id: string) => {
    setSubtitles((currentSubtitles) =>
      currentSubtitles.filter((subtitle) => subtitle.id !== id)
    );

    if (selectedSubtitleId === id) {
      setSelectedSubtitleId(null);
    }
  };

  useEffect(() => {
    const handleDeleteKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;

      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedSubtitleId
      ) {
        deleteSubtitle(selectedSubtitleId);
      }
    };

    window.addEventListener("keydown", handleDeleteKey);

    return () => {
      window.removeEventListener("keydown", handleDeleteKey);
    };
  }, [selectedSubtitleId]);

  // SRT
  const importSrt = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "SubRip Subtitle",
            extensions: ["srt"],
          },
        ],
      });

      if (!selected || Array.isArray(selected)) {
        return;
      }

      const content = await readTextFile(selected);
      const importedSubtitles = parseSrt(content);

      setSubtitles(importedSubtitles);
      setSelectedSubtitleId(null);
    } catch (error) {
      console.error("Failed to import SRT:", error);
    }
  };

  const exportSrt = async () => {
    try {
      const filePath = await save({
        filters: [
          {
            name: "SubRip Subtitle",
            extensions: ["srt"],
          },
        ],
        defaultPath: "subtitles.srt",
      });

      if (!filePath) {
        return;
      }

      const content = generateSrt(subtitles);

      await writeTextFile(filePath, content);
    } catch (error) {
      console.error("Failed to export SRT:", error);
    }
  };

  return (
    <main className="app">
      <header className="topbar">
        <h1>Subtitle Editor</h1>
      </header>

      <button onClick={testFfmpeg}>
        Test FFmpeg
      </button>

      <div className="workspace">
        <section className="preview-panel">
          <VideoPlayer
            onDurationChange={setVideoDuration}
            onTimeChange={setCurrentTime}
            onVideoNameChange={setVideoName}
            onVideoPathChange={(path) => {
              setVideoPath(path);
              generateWaveform(path);
            }}
            seekTo={seekTo}
          />
        </section>

        <aside className="subtitle-panel">
          <div className="subtitle-panel-header">
            <h2>Subtitles</h2>

            <button onClick={addSubtitle}>
              Add Subtitle
            </button>

            <button onClick={importSrt}>
              Import SRT
            </button>

            <button onClick={exportSrt}>
              Export SRT
            </button>

            <input
              type="text"
              placeholder="Search subtitles"
              className="subtitle-search"
              value={subtitleSearch}
              onChange={(event) => setSubtitleSearch(event.target.value)}
            />
          </div>

          <div 
            className="subtitle-list"
            ref={subtitleListRef}
          >
            {subtitles.length === 0 ? (
              <p className="subtitle-empty">No subtitles yet.</p>
            ) : (
              filteredSubtitles.map((subtitle) => {
                const isSelected = selectedSubtitleId === subtitle.id;
                const isActive = activeSubtitle?.id === subtitle.id;

                return (
                  <div
                    key={subtitle.id}
                    date-subtitle-id={subtitle.id}
                    className={`subtitle-row
                      ${isSelected ? "selected" : ""}
                      ${isActive ? "active" : ""}
                    `}
                    onClick={() => {
                      setSelectedSubtitleId(subtitle.id);
                      setSeekTo(subtitle.startTime);
                    }}
                  >
                    <span className="subtitle-row-time">
                      {formatSubtitleTime(subtitle.startTime)}
                    </span>

                    <input
                      className="subtitle-row-text"
                      value={subtitle.text}
                      onClick={(event) => event.stopPropagation()}
                      onFocus={() =>
                        setSelectedSubtitleId(subtitle.id)
                      }
                      onChange={(event) =>
                        updateSubtitleText(
                          subtitle.id,
                          event.target.value
                        )
                      }
                    />

                    <button
                      className="subtitle-delete"
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteSubtitle(subtitle.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </aside>
      </div>

      <section className="timeline-panel">
        <h2>Timeline</h2>
        <div className="timeline-controls">
          <button
            onClick={() =>
              setTimelineZoom((zoom) => Math.max(1, zoom - 0.5))
            }
          >
            -
          </button>

          <span>{Math.round(timelineZoom * 100)}%</span>

          <button
            onClick={() =>
              setTimelineZoom((zoom) => Math.min(8, zoom + 0.5))
            }
          >
            +
          </button>
        </div>

        <Timeline
        duration={videoDuration}
        currentTime={currentTime}
        videoName={videoName}
        waveform={waveform}
        zoom={timelineZoom}
        subtitles={subtitles}
        selectedSubtitleId={selectedSubtitleId}
        onSubtitleSelect={setSelectedSubtitleId}
        onSubtitleMove={moveSubtitle}
        onSubtitleResize={resizeSubtitle}
        onSeek={setSeekTo}
      />
      </section>
    </main>
  );
}

export default App;