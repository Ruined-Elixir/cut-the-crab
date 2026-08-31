use std::path::PathBuf;

use tauri::Manager;

use std::fs;

pub struct WhisperPaths {
    pub binary: PathBuf,
    pub model: PathBuf,
    pub vad_model: PathBuf,
}

fn bundled_whisper_binary(
    app: &tauri::AppHandle,
) -> Result<PathBuf, String> {
    app.path()
        .resolve(
            "resources/whisper/whisper-cli",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|error| {
            format!("Unable to resolve bundled Whisper binary: {error}")
        })
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

    #[cfg(target_os = "windows")]
    let binary = whisper_dir.join("whisper-cli.exe");

    #[cfg(not(target_os = "windows"))]
    let binary = whisper_dir.join("whisper-cli");

    let model = models_dir.join("ggml-base.bin");
    let vad_model = models_dir.join("ggml-silero-v6.2.0.bin");

    if !binary.exists() {
        let bundled_binary = bundled_whisper_binary(app)?;

        fs::copy(&bundled_binary, &binary)
            .map_err(|error| format!("Failed to install Whisper binary: {error}"))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = fs::metadata(&binary)
                .map_err(|error| format!("Failed to read Whisper binary permissions: {error}"))?
                .permissions();

            permissions.set_mode(0o755);

            fs::set_permissions(&binary, permissions)
                .map_err(|error| format!("Failed to set Whisper binary permissions: {error}"))?;
        }
    }

    Ok(WhisperPaths {
        binary,
        model,
        vad_model,
    })
}