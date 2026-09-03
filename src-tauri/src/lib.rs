use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use serde::Serialize;
use tauri::Emitter;

use crate::ffmpeg_paths::get_ffmpeg_path;

mod ffmpeg_paths;
mod model_manager;
mod sensevoice_engine;
mod sensevoice_paths;
mod transcription;
mod whisper_paths;

#[tauri::command]
fn extract_waveform(
    app: tauri::AppHandle,
    video_path: String,
    points: usize,
) -> Result<Vec<f32>, String> {
    let ffmpeg_path = get_ffmpeg_path(&app)?;

    let output = Command::new(&ffmpeg_path)
        .args([
            "-i",
            &video_path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "8000",
            "-f",
            "s16le",
            "-",
        ])
        .output()
        .map_err(|error| error.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let bytes = output.stdout;

    if bytes.is_empty() {
        return Err("No audio samples were extracted.".to_string());
    }

    let samples: Vec<i16> = bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();

    if samples.is_empty() {
        return Err("No valid PCM samples were extracted.".to_string());
    }

    let point_count = points.max(1).min(samples.len());
    let samples_per_point = samples.len() / point_count;

    let mut waveform = Vec::with_capacity(point_count);

    for index in 0..point_count {
        let start = index * samples_per_point;

        let end = if index == point_count - 1 {
            samples.len()
        } else {
            (start + samples_per_point).min(samples.len())
        };

        let chunk = &samples[start..end];

        let sum_squares: f32 = chunk
            .iter()
            .map(|sample| {
                let normalized = *sample as f32 / i16::MAX as f32;
                normalized * normalized
            })
            .sum();

        let rms = (sum_squares / chunk.len() as f32).sqrt();
        waveform.push(rms);
    }

    let max_amplitude = waveform.iter().copied().fold(0.0_f32, f32::max);

    if max_amplitude > 0.0 {
        for value in &mut waveform {
            *value /= max_amplitude;
        }
    }

    Ok(waveform)
}

#[tauri::command]
fn read_matching_srt(video_path: String) -> Result<Option<String>, String> {
    let srt_path = Path::new(&video_path).with_extension("srt");

    if !srt_path.exists() {
        return Ok(None);
    }

    fs::read_to_string(&srt_path)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn escape_ffmpeg_filter_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:")
        .replace('\'', "\\'")
}

fn development_fonts_dir() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/fonts");

        if path.exists() {
            return Some(path);
        }
    }

    None
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoExportProgress {
    progress: f64,
    status: String,
}

fn emit_export_progress(
    app: &tauri::AppHandle,
    progress: f64,
    status: impl Into<String>,
) {
    let payload = VideoExportProgress {
        progress: progress.clamp(0.0, 100.0),
        status: status.into(),
    };

    if let Err(error) = app.emit("video-export-progress", payload) {
        eprintln!("Failed to emit export progress: {error}");
    }
}

#[tauri::command]
async fn export_styled_video(
    app: tauri::AppHandle,
    video_path: String,
    output_path: String,
    ass_content: String,
    video_duration: f64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::time::{SystemTime, UNIX_EPOCH};

        let ffmpeg_path = get_ffmpeg_path(&app)?;

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis();

        let ass_path =
            std::env::temp_dir().join(format!("subtitle-editor-export-{timestamp}.ass"));

        fs::write(&ass_path, ass_content)
            .map_err(|error| format!("Failed to create temporary ASS file: {error}"))?;

        let ass_path_string = escape_ffmpeg_filter_path(&ass_path);

        let video_filter = if let Some(fonts_dir) = development_fonts_dir() {
            let fonts_dir_string = escape_ffmpeg_filter_path(&fonts_dir);

            format!(
                "ass=filename='{}':fontsdir='{}'",
                ass_path_string, fonts_dir_string,
            )
        } else {
            format!("ass=filename='{}'", ass_path_string)
        };

        println!("Exporting with FFmpeg: {}", ffmpeg_path.display());
        println!("ASS filter: {}", video_filter);

        emit_export_progress(&app, 0.0, "Starting FFmpeg...");

        let mut child = Command::new(&ffmpeg_path)
            .args([
                "-y",
                "-i",
                &video_path,
                "-vf",
                &video_filter,
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "18",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
                "-progress",
                "pipe:1",
                "-nostats",
                &output_path,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("Failed to start FFmpeg: {error}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to read FFmpeg progress output.".to_string())?;

        let reader = BufReader::new(stdout);

        for line in reader.lines() {
            let line = line.map_err(|error| {
                format!("Failed to read FFmpeg progress output: {error}")
            })?;

            if let Some(value) = line.strip_prefix("out_time_us=") {
                if let Ok(microseconds) = value.parse::<f64>() {
                    if video_duration > 0.0 {
                        let seconds = microseconds / 1_000_000.0;
                        let percent = (seconds / video_duration) * 100.0;

                        emit_export_progress(
                            &app,
                            percent.min(99.0),
                            "Rendering subtitles and encoding video...",
                        );
                    }
                }
            }

            if line == "progress=end" {
                emit_export_progress(&app, 100.0, "Finishing export...");
            }
        }

        let status = child
            .wait()
            .map_err(|error| format!("Failed while waiting for FFmpeg: {error}"))?;

        let _ = fs::remove_file(&ass_path);

        if !status.success() {
            return Err(format!("FFmpeg export failed with status: {status}"));
        }

        emit_export_progress(&app, 100.0, "Export complete.");

        Ok(())
    })
    .await
    .map_err(|error| format!("Export task failed: {error}"))?
}

fn matching_project_path(video_path: &Path) -> PathBuf {
    video_path.with_extension("subtitle-project.json")
}

#[tauri::command]
fn read_matching_project(video_path: String) -> Result<Option<String>, String> {
    let project_path = matching_project_path(Path::new(&video_path));

    if !project_path.exists() {
        return Ok(None);
    }

    fs::read_to_string(&project_path)
        .map(Some)
        .map_err(|error| format!("Failed to read subtitle project: {}", error))
}

#[tauri::command]
fn save_subtitle_project(video_path: String, project_json: String) -> Result<(), String> {
    let project_path = matching_project_path(Path::new(&video_path));

    fs::write(&project_path, project_json)
        .map_err(|error| format!("Failed to save subtitle project: {}", error))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            extract_waveform,
            transcription::transcribe_video,
            read_matching_srt,
            read_matching_project,
            save_subtitle_project,
            export_styled_video
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
