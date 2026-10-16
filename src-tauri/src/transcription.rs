use crate::ffmpeg_paths::get_ffmpeg_path;
use crate::sensevoice_engine::transcribe_with_sensevoice;
use crate::sensevoice_paths::get_sensevoice_paths;
use crate::whisper_paths::get_whisper_paths;
use serde::Deserialize;
use std::{
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;

use crate::model_manager::{
    ensure_sensevoice_model, ensure_sensevoice_vad, ensure_vad_model, ensure_whisper_model,
};

#[derive(Debug, Deserialize)]
struct WhisperOutput {
    result: WhisperResult,
    transcription: Vec<WhisperSegment>,
}

#[derive(Debug, Deserialize)]
struct WhisperResult {
    language: String,
}

#[derive(Debug, Deserialize)]
struct WhisperSegment {
    offsets: WhisperOffsets,
    text: String,
}

#[derive(Debug, Deserialize)]
struct WhisperOffsets {
    from: u64,
    to: u64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionSegment {
    pub start_time: f64,
    pub end_time: f64,
    pub text: String,
}

#[derive(Debug, serde::Serialize)]
pub struct TranscriptionResult {
    pub language: String,
    pub segments: Vec<TranscriptionSegment>,
}

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn parse_whisper_progress(line: &str) -> Option<u32> {
    let marker = "progress =";
    let start = line.find(marker)?;
    let remaining = &line[start + marker.len()..];
    let percent_text = remaining.trim().trim_end_matches('%').trim();
    percent_text.parse::<u32>().ok()
}

fn unique_transcription_id() -> Result<String, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    Ok(format!("{}-{timestamp}", std::process::id()))
}

#[tauri::command]
pub async fn transcribe_video(
    app: tauri::AppHandle,
    video_path: String,
    engine: String,
    model: String,
) -> Result<TranscriptionResult, String> {
    if engine == "sensevoice" {
        let sensevoice_paths = get_sensevoice_paths(&app)?;
        ensure_sensevoice_model(&app, &sensevoice_paths.model).await?;
        ensure_sensevoice_vad(&app, &sensevoice_paths.vad_model).await?;

        let binary_path = sensevoice_paths.binary;
        let model_path = sensevoice_paths.model;
        let vad_path = sensevoice_paths.vad_model;

        let result = tauri::async_runtime::spawn_blocking({
            let app = app.clone();
            let video_path = video_path.clone();
            move || transcribe_with_sensevoice(&app, &video_path, binary_path, model_path, vad_path)
        })
        .await
        .map_err(|error| format!("SenseVoice task failed: {error}"))??;

        return Ok(TranscriptionResult {
            language: result.language,
            segments: result
                .segments
                .into_iter()
                .map(|segment| TranscriptionSegment {
                    start_time: segment.start_time,
                    end_time: segment.end_time,
                    text: segment.text,
                })
                .collect(),
        });
    }

    if engine != "whisper" {
        return Err(format!("Unsupported transcription engine: {engine}"));
    }

    let whisper_paths = get_whisper_paths(&app)?;
    let ffmpeg_path = get_ffmpeg_path(&app)?;
    let whisper_binary = whisper_paths.binary;
    let vad_model = whisper_paths.vad_model;
    let model_dir = whisper_paths
        .model
        .parent()
        .ok_or("Unable to determine Whisper model directory")?;

    let whisper_model = match model.as_str() {
        "base" => model_dir.join("ggml-base.bin"),
        "small" => model_dir.join("ggml-small.bin"),
        _ => return Err(format!("Unsupported Whisper model: {model}")),
    };

    let _ = app.emit("transcription-progress", "Checking models...");
    ensure_whisper_model(&app, &model, &whisper_model).await?;
    ensure_vad_model(&vad_model).await?;

    let run_id = unique_transcription_id()?;
    let temp_dir = std::env::temp_dir();
    let audio_path = temp_dir.join(format!("cut-the-crab-audio-{run_id}.wav"));
    let output_base = temp_dir.join(format!("cut-the-crab-whisper-{run_id}"));
    let json_path = output_base.with_extension("json");
    let _audio_cleanup = TempFileGuard(audio_path.clone());
    let _json_cleanup = TempFileGuard(json_path.clone());

    let _ = app.emit("transcription-progress", "Preparing audio...");
    let ffmpeg_binary_path = ffmpeg_path.clone();
    let ffmpeg_video_path = video_path.clone();
    let ffmpeg_audio_path = audio_path.clone();

    let ffmpeg_status = tauri::async_runtime::spawn_blocking(move || {
        Command::new(&ffmpeg_binary_path)
            .arg("-nostdin")
            .arg("-y")
            .arg("-i")
            .arg(&ffmpeg_video_path)
            .arg("-vn")
            .arg("-ac")
            .arg("1")
            .arg("-ar")
            .arg("16000")
            .arg(&ffmpeg_audio_path)
            .status()
    })
    .await
    .map_err(|error| format!("FFmpeg task failed: {error}"))?
    .map_err(|error| format!("Failed to start FFmpeg: {error}"))?;

    if !ffmpeg_status.success() {
        return Err(format!("FFmpeg exited with status: {ffmpeg_status}"));
    }

    let _ = app.emit("transcription-progress", "Transcribing...");
    let whisper_binary_path = whisper_binary.clone();
    let whisper_model_path = whisper_model.clone();
    let vad_model_path = vad_model.clone();
    let whisper_audio_path = audio_path.clone();
    let whisper_output_base = output_base.clone();
    let whisper_app = app.clone();

    let whisper_status = tauri::async_runtime::spawn_blocking(move || {
        let mut child = Command::new(&whisper_binary_path)
            .arg("-m")
            .arg(&whisper_model_path)
            .arg("-f")
            .arg(&whisper_audio_path)
            .arg("-l")
            .arg("auto")
            .arg("--vad")
            .arg("-vm")
            .arg(&vad_model_path)
            .arg("-oj")
            .arg("-np")
            .arg("--print-progress")
            .arg("-of")
            .arg(&whisper_output_base)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Failed to start Whisper: {error}"))?;

        if let Some(stderr) = child.stderr.take() {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let line = line.map_err(|error| format!("Failed reading Whisper output: {error}"))?;
                if let Some(progress) = parse_whisper_progress(&line) {
                    let _ = whisper_app.emit("transcription-percent", progress);
                } else {
                    eprintln!("[Whisper] {line}");
                }
            }
        }

        child
            .wait()
            .map_err(|error| format!("Failed waiting for Whisper: {error}"))
    })
    .await
    .map_err(|error| format!("Whisper task failed: {error}"))??;

    if !whisper_status.success() {
        return Err(format!("Whisper exited with status: {whisper_status}"));
    }

    let _ = app.emit("transcription-progress", "Finishing...");
    let json = fs::read_to_string(&json_path)
        .map_err(|error| format!("Failed to read Whisper output: {error}"))?;
    let output: WhisperOutput = serde_json::from_str(&json)
        .map_err(|error| format!("Failed to parse Whisper output: {error}"))?;

    let segments = output
        .transcription
        .into_iter()
        .filter_map(|segment| {
            let text = segment.text.trim().to_string();
            if text.is_empty() {
                return None;
            }
            Some(TranscriptionSegment {
                start_time: segment.offsets.from as f64 / 1000.0,
                end_time: segment.offsets.to as f64 / 1000.0,
                text,
            })
        })
        .collect();

    Ok(TranscriptionResult {
        language: output.result.language,
        segments,
    })
}
