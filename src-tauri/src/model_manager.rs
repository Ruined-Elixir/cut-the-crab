use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::Emitter;

// Pin every model URL to a concrete repository revision. Downloads are also
// verified by SHA-256 before the .part file is promoted into the model cache.
const WHISPER_REVISION: &str = "c521a4b02f422512d734391fdf08bb08c0862f68";
const WHISPER_VAD_REVISION: &str = "c5c26827b67dfd053856f92e824e14fdcc123daf";
const SENSEVOICE_REVISION: &str = "669f1de748f932a95ee3c7023b4393808a9a071f";
const SENSEVOICE_VAD_REVISION: &str = "5644b91e991622131f287c034f2a0424ba5be928";

const BASE_MODEL_SHA256: &str = "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe";
const SMALL_MODEL_SHA256: &str = "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b";
const WHISPER_VAD_SHA256: &str = "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987";
const SENSEVOICE_MODEL_SHA256: &str = "62bbbd6bc97bdb55a53957c768f9e7f38e6b818fb720ba46d6ff52d4cc200ff0";
const SENSEVOICE_VAD_SHA256: &str = "1270f2559c495f4e7b6e739541151027d360761a3fda43fc147034f5719f5479";

const BASE_MODEL_MIN_BYTES: u64 = 140_000_000;
const SMALL_MODEL_MIN_BYTES: u64 = 470_000_000;
const WHISPER_VAD_MIN_BYTES: u64 = 800_000;
const SENSEVOICE_MODEL_MIN_BYTES: u64 = 900_000_000;
const SENSEVOICE_VAD_MIN_BYTES: u64 = 1_500_000;

static ACTIVE_DOWNLOADS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

struct DownloadGuard {
    path: PathBuf,
}

impl Drop for DownloadGuard {
    fn drop(&mut self) {
        if let Some(active) = ACTIVE_DOWNLOADS.get() {
            if let Ok(mut active) = active.lock() {
                active.remove(&self.path);
            }
        }
    }
}

fn begin_download(path: &Path) -> Result<DownloadGuard, String> {
    let active = ACTIVE_DOWNLOADS.get_or_init(|| Mutex::new(HashSet::new()));
    let mut active = active
        .lock()
        .map_err(|_| "Model download registry is unavailable.".to_string())?;

    if !active.insert(path.to_path_buf()) {
        return Err("That model is already being downloaded. Please wait for the active download to finish.".to_string());
    }

    Ok(DownloadGuard {
        path: path.to_path_buf(),
    })
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Failed to open model for verification: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];

    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to verify model file: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}


fn verification_marker_path(model_path: &Path) -> PathBuf {
    let mut path = model_path.as_os_str().to_os_string();
    path.push(".verified");
    PathBuf::from(path)
}

fn write_verification_marker(model_path: &Path, expected_sha256: &str, size: u64) {
    let marker = verification_marker_path(model_path);
    let _ = fs::write(marker, format!("{expected_sha256}:{size}"));
}

fn valid_model(path: &Path, expected_sha256: &str, min_bytes: u64) -> Result<bool, String> {
    let metadata = match path.metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Failed to inspect model file: {error}")),
    };

    if metadata.len() < min_bytes {
        let _ = fs::remove_file(verification_marker_path(path));
        return Ok(false);
    }

    let marker_path = verification_marker_path(path);
    let expected_marker = format!("{expected_sha256}:{}", metadata.len());
    if fs::read_to_string(&marker_path)
        .map(|value| value.trim() == expected_marker)
        .unwrap_or(false)
    {
        return Ok(true);
    }

    let valid = sha256_file(path)?.eq_ignore_ascii_case(expected_sha256);
    if valid {
        write_verification_marker(path, expected_sha256, metadata.len());
    } else {
        let _ = fs::remove_file(marker_path);
    }
    Ok(valid)
}

fn partial_path(model_path: &Path) -> PathBuf {
    let mut path = model_path.as_os_str().to_os_string();
    path.push(".part");
    PathBuf::from(path)
}

fn download_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(60 * 30))
        .user_agent("Cut-The-Crab/1.0")
        .build()
        .map_err(|error| format!("Failed to create model download client: {error}"))
}

async fn download_verified_file(
    app: Option<&tauri::AppHandle>,
    url: &str,
    destination: &Path,
    status: &str,
    expected_sha256: &str,
    min_bytes: u64,
) -> Result<(), String> {
    if valid_model(destination, expected_sha256, min_bytes)? {
        return Ok(());
    }

    if destination.exists() {
        fs::remove_file(destination)
            .map_err(|error| format!("Failed to remove an invalid cached model: {error}"))?;
        let _ = fs::remove_file(verification_marker_path(destination));
    }

    let _guard = begin_download(destination)?;

    // Another request could have finished immediately before we acquired the
    // guard; verify again before doing network work.
    if valid_model(destination, expected_sha256, min_bytes)? {
        return Ok(());
    }

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create model directory: {error}"))?;
    }

    if let Some(app) = app {
        let _ = app.emit("transcription-progress", status);
        let _ = app.emit("model-download-percent", 0u32);
    }

    let client = download_client()?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Failed to download model: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Model download failed with HTTP status {}",
            response.status()
        ));
    }

    let total_size = response.content_length();
    if let Some(total) = total_size {
        if total < min_bytes {
            return Err(format!(
                "Model download is unexpectedly small ({total} bytes). Refusing to cache it."
            ));
        }
    }

    let part_path = partial_path(destination);
    let _ = fs::remove_file(&part_path);
    let mut file = File::create(&part_path)
        .map_err(|error| format!("Failed to create temporary model file: {error}"))?;

    let mut downloaded = 0u64;
    let mut last_percent = 0u32;

    let download_result: Result<(), String> = async {
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("Failed while downloading model: {error}"))?
        {
            file.write_all(&chunk)
                .map_err(|error| format!("Failed to write model data: {error}"))?;
            downloaded += chunk.len() as u64;

            if let (Some(app), Some(total)) = (app, total_size) {
                if total > 0 {
                    let percent = (((downloaded as f64 / total as f64) * 100.0).round() as u32)
                        .min(100);
                    if percent != last_percent {
                        last_percent = percent;
                        let _ = app.emit("model-download-percent", percent);
                    }
                }
            }
        }

        file.flush()
            .map_err(|error| format!("Failed to flush model file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Failed to sync model file: {error}"))?;
        drop(file);

        let part_metadata = part_path
            .metadata()
            .map_err(|error| format!("Failed to inspect downloaded model: {error}"))?;
        if part_metadata.len() < min_bytes {
            return Err(format!(
                "Downloaded model is incomplete ({} bytes).",
                part_metadata.len()
            ));
        }

        let actual_hash = sha256_file(&part_path)?;
        if !actual_hash.eq_ignore_ascii_case(expected_sha256) {
            return Err(format!(
                "Downloaded model failed SHA-256 verification. Expected {expected_sha256}, got {actual_hash}."
            ));
        }

        if destination.exists() {
            fs::remove_file(destination)
                .map_err(|error| format!("Failed to replace cached model: {error}"))?;
        }
        fs::rename(&part_path, destination)
            .map_err(|error| format!("Failed to finalize model download: {error}"))?;
        let installed_size = destination.metadata().map(|metadata| metadata.len()).unwrap_or(downloaded);
        write_verification_marker(destination, expected_sha256, installed_size);

        if let Some(app) = app {
            let _ = app.emit("model-download-percent", 100u32);
        }
        Ok(())
    }
    .await;

    if download_result.is_err() {
        let _ = fs::remove_file(&part_path);
    }

    download_result
}

pub async fn ensure_whisper_model(
    app: &tauri::AppHandle,
    model_name: &str,
    model_path: &Path,
) -> Result<(), String> {
    let (file_name, hash, min_bytes) = match model_name {
        "base" => ("ggml-base.bin", BASE_MODEL_SHA256, BASE_MODEL_MIN_BYTES),
        "small" => ("ggml-small.bin", SMALL_MODEL_SHA256, SMALL_MODEL_MIN_BYTES),
        _ => return Err(format!("Unsupported Whisper model: {model_name}")),
    };
    let url = format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/{WHISPER_REVISION}/{file_name}"
    );
    download_verified_file(
        Some(app),
        &url,
        model_path,
        "Downloading Whisper model...",
        hash,
        min_bytes,
    )
    .await
}

pub async fn ensure_vad_model(model_path: &Path) -> Result<(), String> {
    let url = format!(
        "https://huggingface.co/ggml-org/whisper-vad/resolve/{WHISPER_VAD_REVISION}/ggml-silero-v6.2.0.bin"
    );
    download_verified_file(
        None,
        &url,
        model_path,
        "Downloading Whisper VAD...",
        WHISPER_VAD_SHA256,
        WHISPER_VAD_MIN_BYTES,
    )
    .await
}

pub async fn ensure_sensevoice_model(
    app: &tauri::AppHandle,
    model_path: &Path,
) -> Result<(), String> {
    let url = format!(
        "https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF/resolve/{SENSEVOICE_REVISION}/sensevoice-small.gguf"
    );
    download_verified_file(
        Some(app),
        &url,
        model_path,
        "Downloading SenseVoice model...",
        SENSEVOICE_MODEL_SHA256,
        SENSEVOICE_MODEL_MIN_BYTES,
    )
    .await
}

pub async fn ensure_sensevoice_vad(
    app: &tauri::AppHandle,
    vad_path: &Path,
) -> Result<(), String> {
    let url = format!(
        "https://huggingface.co/FunAudioLLM/fsmn-vad-GGUF/resolve/{SENSEVOICE_VAD_REVISION}/fsmn-vad.gguf"
    );
    download_verified_file(
        Some(app),
        &url,
        vad_path,
        "Downloading SenseVoice VAD...",
        SENSEVOICE_VAD_SHA256,
        SENSEVOICE_VAD_MIN_BYTES,
    )
    .await
}
