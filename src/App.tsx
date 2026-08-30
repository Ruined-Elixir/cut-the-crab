import { useState } from "react";
import VideoPlayer from "./components/VideoPlayer";
import Timeline from "./components/Timeline";
import "./App.css";
import { invoke } from "@tauri-apps/api/core";

function App() {
  const [videoDuration, setVideoDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [seekTo, setSeekTo] = useState<number | undefined>(undefined);
  const [videoName, setVideoName] = useState<string | null>(null);

  // Wave Form
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [waveform, setWaveform] = useState<number[]>([]);
  const [timelineZoom, setTimelineZoom] = useState(1);

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
          <h2>Subtitles</h2>
          <p>No subtitles yet.</p>
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
        onSeek={setSeekTo}
      />
      </section>
    </main>
  );
}

export default App;