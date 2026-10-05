use std::fs;
use std::path::PathBuf;

use tauri::Manager;

pub struct WhisperPaths {
    pub binary: PathBuf,
    pub model: PathBuf,
    pub vad_model: PathBuf,
}

fn bundled_whisper_binary(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve(
            "resources/whisper/whisper-cli",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|error| format!("Unable to resolve bundled Whisper binary: {error}"))
}

pub fn get_whisper_paths(app: &tauri::AppHandle) -> Result<WhisperPaths, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to determine app data directory: {error}"))?;

    let whisper_dir = app_data.join("whisper");
    let models_dir = whisper_dir.join("models");

    fs::create_dir_all(&models_dir)
        .map_err(|error| format!("Failed to create Whisper directories: {error}"))?;

    // Execute Whisper directly from the application resource bundle.
    // Its dependent dylibs live beside it and are resolved through @loader_path.
    let binary = bundled_whisper_binary(app)?;

    if !binary.exists() {
        return Err(format!(
            "Bundled Whisper binary was not found at {}",
            binary.display()
        ));
    }

    let model = models_dir.join("ggml-base.bin");
    let vad_model = models_dir.join("ggml-silero-v6.2.0.bin");

    Ok(WhisperPaths {
        binary,
        model,
        vad_model,
    })
}
