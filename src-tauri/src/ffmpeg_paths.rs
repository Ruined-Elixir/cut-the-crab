use std::{
    fs,
    path::PathBuf,
};

use tauri::Manager;

pub fn get_ffmpeg_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to determine app data directory: {error}"))?;

    let ffmpeg_dir = app_data.join("ffmpeg");

    fs::create_dir_all(&ffmpeg_dir)
        .map_err(|error| format!("Failed to create FFmpeg directory: {error}"))?;

    #[cfg(target_os = "windows")]
    let ffmpeg_path = ffmpeg_dir.join("ffmpeg.exe");

    #[cfg(not(target_os = "windows"))]
    let ffmpeg_path = ffmpeg_dir.join("ffmpeg");

    if !ffmpeg_path.exists() {
        #[cfg(target_os = "windows")]
        let bundled = app
            .path()
            .resolve(
                "resources/ffmpeg/ffmpeg.exe",
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|error| format!("Unable to resolve bundled FFmpeg: {error}"))?;

        #[cfg(not(target_os = "windows"))]
        let bundled = app
            .path()
            .resolve(
                "resources/ffmpeg/ffmpeg",
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|error| format!("Unable to resolve bundled FFmpeg: {error}"))?;

        fs::copy(&bundled, &ffmpeg_path)
            .map_err(|error| format!("Failed to install FFmpeg: {error}"))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = fs::metadata(&ffmpeg_path)
                .map_err(|error| format!("Failed to read FFmpeg permissions: {error}"))?
                .permissions();

            permissions.set_mode(0o755);

            fs::set_permissions(&ffmpeg_path, permissions)
                .map_err(|error| format!("Failed to set FFmpeg permissions: {error}"))?;
        }
    }

    Ok(ffmpeg_path)
}