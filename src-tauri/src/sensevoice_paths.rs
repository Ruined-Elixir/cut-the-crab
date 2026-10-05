use std::fs;
use std::path::PathBuf;

use tauri::Manager;

pub struct SenseVoicePaths {
    pub binary: PathBuf,
    pub model: PathBuf,
    pub vad_model: PathBuf,
}

fn bundled_sensevoice_binary(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve(
            "resources/sensevoice/llama-funasr-sensevoice",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("Unable to resolve bundled SenseVoice binary: {e}"))
}

pub fn get_sensevoice_paths(app: &tauri::AppHandle) -> Result<SenseVoicePaths, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Unable to determine app data directory: {e}"))?;

    let sensevoice_dir = app_data.join("sensevoice");
    let models_dir = sensevoice_dir.join("models");

    fs::create_dir_all(&models_dir)
        .map_err(|e| format!("Failed to create SenseVoice directories: {e}"))?;

    // Execute SenseVoice directly from the application resource bundle.
    // Its dependent dylibs live beside it and are resolved through @loader_path.
    let binary = bundled_sensevoice_binary(app)?;

    if !binary.exists() {
        return Err(format!(
            "Bundled SenseVoice binary was not found at {}",
            binary.display()
        ));
    }

    let model = models_dir.join("sensevoice-small.gguf");
    let vad_model = models_dir.join("fsmn-vad.gguf");

    Ok(SenseVoicePaths {
        binary,
        model,
        vad_model,
    })
}
