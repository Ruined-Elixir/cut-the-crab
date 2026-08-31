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

const SENSEVOICE_MODEL_URL: &str =
    "https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF/resolve/main/sensevoice-small.gguf";

const SENSEVOICE_VAD_URL: &str =
    "https://huggingface.co/FunAudioLLM/fsmn-vad-GGUF/resolve/main/fsmn-vad.gguf";

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

async fn download_model_file(
    app: &tauri::AppHandle,
    url: &str,
    destination: &Path,
    status: &str,
) -> Result<(), String> {
    use std::fs::File;
    use std::io::Write;
    use tauri::Emitter;

    if destination.exists() {
        return Ok(());
    }

    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create model directory: {e}"))?;
    }

    app.emit("transcription-progress", status)
        .map_err(|e| format!("Failed to emit download status: {e}"))?;

    app.emit("model-download-percent", 0u32)
        .map_err(|e| format!("Failed to emit download progress: {e}"))?;

    let response = reqwest::get(url)
        .await
        .map_err(|e| format!("Failed to download model: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Model download failed with HTTP status {}",
            response.status()
        ));
    }

    let total_size = response.content_length();

    let part_path = destination.with_extension("part");

    let mut file = File::create(&part_path)
        .map_err(|e| format!("Failed to create temporary model file: {e}"))?;

    let mut response = response;
    let mut downloaded: u64 = 0;
    let mut last_percent = 0;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Failed while downloading model: {e}"))?
    {
        file.write_all(&chunk)
            .map_err(|e| format!("Failed to write model data: {e}"))?;

        downloaded += chunk.len() as u64;

        if let Some(total) = total_size {
            let percent = ((downloaded as f64 / total as f64) * 100.0)
                .round() as u32;

            if percent != last_percent {
                last_percent = percent;

                app.emit("model-download-percent", percent)
                    .map_err(|e| {
                        format!("Failed to emit download progress: {e}")
                    })?;
            }
        }
    }

    file.flush()
        .map_err(|e| format!("Failed to flush model file: {e}"))?;

    std::fs::rename(&part_path, destination)
        .map_err(|e| format!("Failed to finalize model download: {e}"))?;

    app.emit("model-download-percent", 100u32)
        .map_err(|e| format!("Failed to emit download progress: {e}"))?;

    Ok(())
}

pub async fn ensure_sensevoice_model(
    app: &tauri::AppHandle,
    model_path: &Path,
) -> Result<(), String> {
    download_model_file(
        app,
        SENSEVOICE_MODEL_URL,
        model_path,
        "Downloading SenseVoice model...",
    )
    .await
}

pub async fn ensure_sensevoice_vad(
    app: &tauri::AppHandle,
    vad_path: &Path,
) -> Result<(), String> {
    download_model_file(
        app,
        SENSEVOICE_VAD_URL,
        vad_path,
        "Downloading SenseVoice VAD...",
    )
    .await
}