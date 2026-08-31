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

pub fn get_sensevoice_paths(
    app: &tauri::AppHandle,
) -> Result<SenseVoicePaths, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Unable to determine app data directory: {e}"))?;

    let sensevoice_dir = app_data.join("sensevoice");
    let models_dir = sensevoice_dir.join("models");

    fs::create_dir_all(&models_dir)
        .map_err(|e| format!("Failed to create SenseVoice directories: {e}"))?;

    #[cfg(target_os = "windows")]
    let binary = sensevoice_dir.join("llama-funasr-sensevoice.exe");

    #[cfg(not(target_os = "windows"))]
    let binary = sensevoice_dir.join("llama-funasr-sensevoice");

    let model = models_dir.join("sensevoice-small.gguf");
    let vad_model = models_dir.join("fsmn-vad.gguf");

    if !binary.exists() {
        let bundled_binary = bundled_sensevoice_binary(app)?;

        fs::copy(&bundled_binary, &binary)
            .map_err(|e| format!("Failed to install SenseVoice binary: {e}"))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = fs::metadata(&binary)
                .map_err(|e| {
                    format!("Failed to read SenseVoice binary permissions: {e}")
                })?
                .permissions();

            permissions.set_mode(0o755);

            fs::set_permissions(&binary, permissions)
                .map_err(|e| {
                    format!("Failed to set SenseVoice binary permissions: {e}")
                })?;
        }
    }

    Ok(SenseVoicePaths {
        binary,
        model,
        vad_model,
    })
}