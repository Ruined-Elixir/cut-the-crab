use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::UNIX_EPOCH,
};

use tauri::Manager;

use crate::ffmpeg_paths::get_ffmpeg_path;

fn stable_hash(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;

    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }

    hash
}

fn proxy_cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to locate app data directory: {error}"))?;
    let proxy_dir = app_data.join("video-proxies");

    fs::create_dir_all(&proxy_dir)
        .map_err(|error| format!("Failed to create proxy cache directory: {error}"))?;

    Ok(proxy_dir)
}

fn proxy_cache_identity(source: &Path) -> Result<(u64, u64), String> {
    let metadata = fs::metadata(source)
        .map_err(|error| format!("Failed to read source media metadata: {error}"))?;
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let source_string = source.to_string_lossy();
    let source_key = stable_hash(&source_string);
    let version_identity = format!("{}|{}|{}", source_string, metadata.len(), modified_ns);

    Ok((source_key, stable_hash(&version_identity)))
}

fn remove_stale_proxy_versions(
    cache_dir: &Path,
    source_key: u64,
    current_proxy: &Path,
) -> Result<(), String> {
    let prefix = format!("{source_key:016x}-");
    let entries = fs::read_dir(cache_dir)
        .map_err(|error| format!("Failed to inspect proxy cache directory: {error}"))?;

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();

        if path == current_proxy {
            continue;
        }

        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };

        if file_name.starts_with(&prefix) {
            let _ = fs::remove_file(path);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn ensure_video_proxy(
    app: tauri::AppHandle,
    source_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(&source_path);

        if !source.exists() {
            return Err("The source video could not be found.".to_string());
        }

        let cache_dir = proxy_cache_dir(&app)?;
        let (source_key, version_key) = proxy_cache_identity(&source)?;
        let proxy_path = cache_dir.join(format!(
            "{source_key:016x}-{version_key:016x}.mp4"
        ));

        if proxy_path
            .metadata()
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false)
        {
            remove_stale_proxy_versions(&cache_dir, source_key, &proxy_path)?;
            return Ok(proxy_path.to_string_lossy().into_owned());
        }

        let temporary_path = cache_dir.join(format!(
            "{source_key:016x}-{version_key:016x}.tmp.mp4"
        ));
        let _ = fs::remove_file(&temporary_path);

        let ffmpeg_path = get_ffmpeg_path(&app)?;
        let scale_filter =
            "scale='if(gt(a,16/9),min(1280,iw),-2)':'if(gt(a,16/9),-2,min(720,ih))'";

        let status = Command::new(ffmpeg_path)
            .arg("-hide_banner")
            .arg("-loglevel")
            .arg("error")
            .arg("-y")
            .arg("-fflags")
            .arg("+genpts")
            .arg("-i")
            .arg(&source)
            .arg("-map")
            .arg("0:v:0")
            .arg("-map")
            .arg("0:a:0?")
            .arg("-vf")
            .arg(scale_filter)
            .arg("-c:v")
            .arg("libx264")
            .arg("-preset")
            .arg("veryfast")
            .arg("-crf")
            .arg("24")
            .arg("-profile:v")
            .arg("main")
            .arg("-pix_fmt")
            .arg("yuv420p")
            .arg("-g")
            .arg("30")
            .arg("-keyint_min")
            .arg("30")
            .arg("-sc_threshold")
            .arg("0")
            .arg("-c:a")
            .arg("aac")
            .arg("-b:a")
            .arg("128k")
            .arg("-ac")
            .arg("2")
            .arg("-sn")
            .arg("-dn")
            .arg("-map_metadata")
            .arg("-1")
            .arg("-avoid_negative_ts")
            .arg("make_zero")
            .arg("-movflags")
            .arg("+faststart")
            .arg(&temporary_path)
            .status()
            .map_err(|error| format!("Failed to start FFmpeg proxy generation: {error}"))?;

        if !status.success() {
            let _ = fs::remove_file(&temporary_path);
            return Err(format!(
                "FFmpeg proxy generation failed with status: {status}"
            ));
        }

        if proxy_path.exists() {
            fs::remove_file(&proxy_path)
                .map_err(|error| format!("Failed to replace cached proxy: {error}"))?;
        }

        fs::rename(&temporary_path, &proxy_path)
            .map_err(|error| format!("Failed to finalize proxy file: {error}"))?;
        remove_stale_proxy_versions(&cache_dir, source_key, &proxy_path)?;

        Ok(proxy_path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("Proxy generation task failed: {error}"))?
}
