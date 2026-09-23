use std::path::PathBuf;

#[cfg(not(debug_assertions))]
use tauri::Manager;

pub fn get_ffmpeg_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;

        if let Some(path) = find_system_ffmpeg() {
            println!("Using system FFmpeg for development: {}", path.display());

            return Ok(path);
        }

        return Err("FFmpeg was not found on this computer. \
             Install FFmpeg before running the app in development."
            .to_string());
    }

    #[cfg(not(debug_assertions))]
    {
        get_bundled_ffmpeg_path(app)
    }
}

#[cfg(debug_assertions)]
fn find_system_ffmpeg() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let candidates = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];

        for candidate in candidates {
            let path = PathBuf::from(candidate);

            if path.exists() {
                return Some(path);
            }
        }

        if let Some(path) = find_ffmpeg_in_path("which", "ffmpeg") {
            return Some(path);
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(path) = find_ffmpeg_in_path("where", "ffmpeg.exe") {
            return Some(path);
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(path) = find_ffmpeg_in_path("which", "ffmpeg") {
            return Some(path);
        }
    }

    None
}

#[cfg(all(
    debug_assertions,
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
fn find_ffmpeg_in_path(command: &str, ffmpeg_name: &str) -> Option<PathBuf> {
    use std::process::Command;

    let output = Command::new(command).arg(ffmpeg_name).output().ok()?;

    if !output.status.success() {
        return None;
    }

    let result = String::from_utf8_lossy(&output.stdout);

    let first_line = result.lines().next()?.trim();

    if first_line.is_empty() {
        return None;
    }

    let path = PathBuf::from(first_line);

    if path.exists() {
        Some(path)
    } else {
        None
    }
}

#[cfg(not(debug_assertions))]
fn get_bundled_ffmpeg_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Failed to locate application resources: {}", error))?;

    // Tauri preserves the configured resource path. Because tauri.conf.json
    // bundles "resources/ffmpeg/ffmpeg", release builds place the binary at
    // $RESOURCE/resources/ffmpeg/ffmpeg. Keep this lookup aligned with the
    // Whisper and SenseVoice resource layout.
    #[cfg(target_os = "windows")]
    let ffmpeg_path = resource_dir
        .join("resources")
        .join("ffmpeg")
        .join("ffmpeg.exe");

    #[cfg(not(target_os = "windows"))]
    let ffmpeg_path = resource_dir
        .join("resources")
        .join("ffmpeg")
        .join("ffmpeg");

    if !ffmpeg_path.exists() {
        return Err(format!(
            "Bundled FFmpeg was not found at {}",
            ffmpeg_path.display()
        ));
    }

    Ok(ffmpeg_path)
}
