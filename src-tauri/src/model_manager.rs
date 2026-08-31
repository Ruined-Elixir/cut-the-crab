use std::{
    fs,
    fs::File,
    io::Write,
    path::{Path, PathBuf},
};

use tauri::Emitter;

const BASE_MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";

const VAD_MODEL_URL: &str =
    "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin";

const SMALL_MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";

pub async fn ensure_whisper_model(
    app: &tauri::AppHandle,
    model_name: &str,
    model_path: &Path,
) -> Result<(), String> {
    if model_path.exists() {
        return Ok(());
    }

    if let Some(parent) = model_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create model directory: {error}"))?;
    }

    let model_url = match model_name {
        "base" => BASE_MODEL_URL,
        "small" => SMALL_MODEL_URL,
        _ => return Err(format!("Unsupported Whisper model: {model_name}")),
    };

    let _ = app.emit("transcription-progress", "Downloading model...");
    let _ = app.emit("model-download-percent", 0u32);

    let mut response = reqwest::get(model_url)
        .await
        .map_err(|error| format!("Failed to download Whisper model: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Whisper model download failed with HTTP status {}",
            response.status()
        ));
    }

    let total_size = response.content_length();
    let temp_path = partial_path(model_path);

    let mut file = File::create(&temp_path)
        .map_err(|error| format!("Failed to create model file: {error}"))?;

    let mut downloaded: u64 = 0;
    let mut last_percent: u32 = 0;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Failed while downloading Whisper model: {error}"))?
    {
        file.write_all(&chunk)
            .map_err(|error| format!("Failed to write Whisper model: {error}"))?;

        downloaded += chunk.len() as u64;

        if let Some(total) = total_size {
            if total > 0 {
                let percent =
                    ((downloaded as f64 / total as f64) * 100.0).round() as u32;

                let percent = percent.min(100);

                if percent != last_percent {
                    last_percent = percent;
                    let _ = app.emit("model-download-percent", percent);
                }
            }
        }
    }

    file.flush()
        .map_err(|error| format!("Failed to finish writing model: {error}"))?;

    fs::rename(&temp_path, model_path)
        .map_err(|error| format!("Failed to install Whisper model: {error}"))?;

    let _ = app.emit("model-download-percent", 100u32);

    Ok(())
}

pub async fn ensure_vad_model(model_path: &Path) -> Result<(), String> {
    if model_path.exists() {
        return Ok(());
    }

    if let Some(parent) = model_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create model directory: {error}"))?;
    }

    let response = reqwest::get(VAD_MODEL_URL)
        .await
        .map_err(|error| format!("Failed to download VAD model: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "VAD model download failed with HTTP status {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read VAD model download: {error}"))?;

    fs::write(model_path, bytes)
        .map_err(|error| format!("Failed to save VAD model: {error}"))?;

    Ok(())
}

fn partial_path(model_path: &Path) -> PathBuf {
    let mut path = model_path.as_os_str().to_os_string();
    path.push(".part");

    PathBuf::from(path)
}