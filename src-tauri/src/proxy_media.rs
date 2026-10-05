use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::UNIX_EPOCH,
};

use tauri::Manager;

use crate::ffmpeg_paths::get_ffmpeg_path;

const PROXY_CACHE_MAX_BYTES: u64 = 12 * 1024 * 1024 * 1024;
const PROXY_CACHE_TARGET_BYTES: u64 = 10 * 1024 * 1024 * 1024;

#[derive(Clone)]
struct ActiveProxyJob {
    child: Arc<Mutex<Option<Child>>>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct ProxyRegistry {
    active: Mutex<HashMap<String, ActiveProxyJob>>,
}

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
    let version_identity = format!(
        "ctc-edit-proxy-v3-cfr30|{}|{}|{}",
        source_string,
        metadata.len(),
        modified_ns
    );
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

    for entry in entries.flatten() {
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

fn prune_proxy_cache(cache_dir: &Path, keep: Option<&Path>) -> Result<(), String> {
    let mut entries = Vec::new();
    let mut total = 0u64;

    for entry in fs::read_dir(cache_dir)
        .map_err(|error| format!("Failed to inspect proxy cache: {error}"))?
        .flatten()
    {
        let path = entry.path();
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();

        // Active proxy jobs write to *.tmp.<pid>.mp4. Never include those in
        // LRU eviction: another concurrent proxy job may still have the file
        // open. Only remove abandoned temp files after they have been untouched
        // for a full day.
        if file_name.contains(".tmp.") {
            if let Ok(metadata) = entry.metadata() {
                let stale = metadata
                    .modified()
                    .ok()
                    .and_then(|modified| modified.elapsed().ok())
                    .map(|age| age.as_secs() >= 24 * 60 * 60)
                    .unwrap_or(false);
                if stale {
                    let _ = fs::remove_file(&path);
                }
            }
            continue;
        }

        if path.extension().and_then(|value| value.to_str()) != Some("mp4") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else { continue };
        let len = metadata.len();
        total = total.saturating_add(len);
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        entries.push((modified, len, path));
    }

    if total <= PROXY_CACHE_MAX_BYTES {
        return Ok(());
    }

    entries.sort_by_key(|(modified, _, _)| *modified);
    for (_, len, path) in entries {
        if total <= PROXY_CACHE_TARGET_BYTES {
            break;
        }
        if keep.is_some_and(|keep| keep == path.as_path()) {
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
    Ok(())
}

fn remove_registry_job(app: &tauri::AppHandle, source_path: &str) {
    let registry = app.state::<ProxyRegistry>();
    if let Ok(mut active) = registry.active.lock() {
        active.remove(source_path);
    };
}

#[tauri::command]
pub fn cancel_video_proxy(app: tauri::AppHandle, source_path: String) -> Result<(), String> {
    let job = {
        let registry = app.state::<ProxyRegistry>();
        let active = registry
            .active
            .lock()
            .map_err(|_| "Proxy registry is unavailable.".to_string())?;
        active.get(&source_path).cloned()
    };

    let Some(job) = job else {
        return Ok(());
    };

    job.cancelled.store(true, Ordering::SeqCst);
    if let Ok(mut slot) = job.child.lock() {
        if let Some(child) = slot.as_mut() {
            let _ = child.kill();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ensure_video_proxy(
    app: tauri::AppHandle,
    source_path: String,
) -> Result<String, String> {
    let app_for_task = app.clone();
    let source_key_for_registry = source_path.clone();

    let task = tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(&source_path);
        if !source.exists() {
            return Err("The source video could not be found.".to_string());
        }

        let cache_dir = proxy_cache_dir(&app_for_task)?;
        let (source_key, version_key) = proxy_cache_identity(&source)?;
        let proxy_path = cache_dir.join(format!("{source_key:016x}-{version_key:016x}.mp4"));

        if proxy_path.metadata().map(|metadata| metadata.len() > 0).unwrap_or(false) {
            remove_stale_proxy_versions(&cache_dir, source_key, &proxy_path)?;
            prune_proxy_cache(&cache_dir, Some(&proxy_path))?;
            return Ok(proxy_path.to_string_lossy().into_owned());
        }

        prune_proxy_cache(&cache_dir, None)?;
        let temporary_path = cache_dir.join(format!(
            "{source_key:016x}-{version_key:016x}.tmp.{}.mp4",
            std::process::id()
        ));
        let _ = fs::remove_file(&temporary_path);

        let child_slot = Arc::new(Mutex::new(None));
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let registry = app_for_task.state::<ProxyRegistry>();
            let mut active = registry
                .active
                .lock()
                .map_err(|_| "Proxy registry is unavailable.".to_string())?;
            if active.contains_key(&source_path) {
                return Err("A proxy for this source is already being generated.".to_string());
            }
            active.insert(
                source_path.clone(),
                ActiveProxyJob {
                    child: Arc::clone(&child_slot),
                    cancelled: Arc::clone(&cancelled),
                },
            );
        }

        let result = (|| -> Result<String, String> {
            if cancelled.load(Ordering::SeqCst) {
                return Err("PROXY_CANCELLED".to_string());
            }

            let ffmpeg_path = get_ffmpeg_path(&app_for_task)?;
            let scale_filter = "fps=30,scale='if(gt(a,16/9),min(1280,iw),-2)':'if(gt(a,16/9),-2,min(720,ih))'";
            let mut command = Command::new(ffmpeg_path);
            command
                .arg("-nostdin")
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
                .arg("-fps_mode")
                .arg("cfr")
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
                .arg("1")
                .arg("-keyint_min")
                .arg("1")
                .arg("-bf")
                .arg("0")
                .arg("-sc_threshold")
                .arg("0")
                .arg("-tune")
                .arg("zerolatency")
                .arg("-threads")
                .arg("2")
                .arg("-filter_threads")
                .arg("1")
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
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());

            let child = command
                .spawn()
                .map_err(|error| format!("Failed to start FFmpeg proxy generation: {error}"))?;
            {
                let mut slot = child_slot
                    .lock()
                    .map_err(|_| "Proxy process handle is unavailable.".to_string())?;
                *slot = Some(child);
            }

            if cancelled.load(Ordering::SeqCst) {
                if let Ok(mut slot) = child_slot.lock() {
                    if let Some(child) = slot.as_mut() {
                        let _ = child.kill();
                    }
                }
            }

            let status = loop {
                if cancelled.load(Ordering::SeqCst) {
                    if let Ok(mut slot) = child_slot.lock() {
                        if let Some(child) = slot.as_mut() {
                            let _ = child.kill();
                        }
                    }
                }

                let maybe_status = {
                    let mut slot = child_slot
                        .lock()
                        .map_err(|_| "Proxy process handle is unavailable.".to_string())?;
                    let child = slot
                        .as_mut()
                        .ok_or_else(|| "Proxy FFmpeg process disappeared.".to_string())?;
                    child
                        .try_wait()
                        .map_err(|error| format!("Failed while waiting for proxy FFmpeg: {error}"))?
                };

                if let Some(status) = maybe_status {
                    break status;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            };

            if cancelled.load(Ordering::SeqCst) {
                let _ = fs::remove_file(&temporary_path);
                return Err("PROXY_CANCELLED".to_string());
            }
            if !status.success() {
                let _ = fs::remove_file(&temporary_path);
                return Err(format!("FFmpeg proxy generation failed with status: {status}"));
            }

            if temporary_path.metadata().map(|metadata| metadata.len() > 0).unwrap_or(false) == false {
                let _ = fs::remove_file(&temporary_path);
                return Err("Proxy generation produced an empty file.".to_string());
            }

            if proxy_path.exists() {
                fs::remove_file(&proxy_path)
                    .map_err(|error| format!("Failed to replace cached proxy: {error}"))?;
            }
            fs::rename(&temporary_path, &proxy_path)
                .map_err(|error| format!("Failed to finalize proxy file: {error}"))?;
            remove_stale_proxy_versions(&cache_dir, source_key, &proxy_path)?;
            prune_proxy_cache(&cache_dir, Some(&proxy_path))?;
            Ok(proxy_path.to_string_lossy().into_owned())
        })();

        remove_registry_job(&app_for_task, &source_path);
        if result.is_err() {
            let _ = fs::remove_file(&temporary_path);
        }
        result
    })
    .await;

    if task.is_err() {
        remove_registry_job(&app, &source_key_for_registry);
    }

    match task {
        Ok(result) => result,
        Err(error) => Err(format!("Proxy generation task failed: {error}")),
    }
}
