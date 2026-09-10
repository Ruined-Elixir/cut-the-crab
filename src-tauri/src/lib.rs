use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    Emitter, Manager, PhysicalPosition, PhysicalSize,
};

use crate::ffmpeg_paths::get_ffmpeg_path;

mod ffmpeg_paths;
mod model_manager;
mod sensevoice_engine;
mod sensevoice_paths;
mod transcription;
mod whisper_paths;

const APP_MENU_COMMAND_EVENT: &str = "app-menu-command";

#[derive(Clone, Copy, Debug)]
struct WindowFrame {
    position: PhysicalPosition<i32>,
    outer_size: PhysicalSize<u32>,
}

fn main_window(app_handle: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app_handle.get_webview_window("main")
}

fn prepare_for_manual_layout(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    if window.is_fullscreen()? {
        window.set_fullscreen(false)?;
    }

    if window.is_maximized()? {
        window.unmaximize()?;
    }

    if window.is_minimized()? {
        window.unminimize()?;
    }

    Ok(())
}

fn set_outer_frame(
    window: &tauri::WebviewWindow,
    position: PhysicalPosition<i32>,
    outer_size: PhysicalSize<u32>,
) -> tauri::Result<()> {
    prepare_for_manual_layout(window)?;

    // Tauri's set_size() targets the inner/content size while macOS window
    // tiling is expressed in outer-frame coordinates. Compensate for the
    // title bar/border so the outer frame lands inside the monitor work area.
    let current_outer = window.outer_size()?;
    let current_inner = window.inner_size()?;

    let chrome_width = current_outer.width.saturating_sub(current_inner.width);
    let chrome_height = current_outer.height.saturating_sub(current_inner.height);

    let inner_width = outer_size.width.saturating_sub(chrome_width).max(1);
    let inner_height = outer_size.height.saturating_sub(chrome_height).max(1);

    window.set_position(position)?;
    window.set_size(PhysicalSize::new(inner_width, inner_height))?;
    window.set_focus()?;

    Ok(())
}

#[derive(Clone, Copy)]
enum WindowLayout {
    Fill,
    Left,
    Right,
    Top,
    Bottom,
}

fn layout_frame(
    work_position: PhysicalPosition<i32>,
    work_size: PhysicalSize<u32>,
    layout: WindowLayout,
) -> WindowFrame {
    let x = work_position.x;
    let y = work_position.y;
    let width = work_size.width;
    let height = work_size.height;

    let left_width = width / 2;
    let right_width = width - left_width;
    let top_height = height / 2;
    let bottom_height = height - top_height;

    match layout {
        WindowLayout::Fill => WindowFrame {
            position: PhysicalPosition::new(x, y),
            outer_size: PhysicalSize::new(width, height),
        },
        WindowLayout::Left => WindowFrame {
            position: PhysicalPosition::new(x, y),
            outer_size: PhysicalSize::new(left_width, height),
        },
        WindowLayout::Right => WindowFrame {
            position: PhysicalPosition::new(x + left_width as i32, y),
            outer_size: PhysicalSize::new(right_width, height),
        },
        WindowLayout::Top => WindowFrame {
            position: PhysicalPosition::new(x, y),
            outer_size: PhysicalSize::new(width, top_height),
        },
        WindowLayout::Bottom => WindowFrame {
            position: PhysicalPosition::new(x, y + top_height as i32),
            outer_size: PhysicalSize::new(width, bottom_height),
        },
    }
}

fn apply_window_layout(app_handle: &tauri::AppHandle, layout: WindowLayout) -> tauri::Result<()> {
    let Some(window) = main_window(app_handle) else {
        return Ok(());
    };

    let Some(monitor) = window.current_monitor()? else {
        return Ok(());
    };

    let work_area = monitor.work_area();
    let frame = layout_frame(work_area.position, work_area.size, layout);

    set_outer_frame(&window, frame.position, frame.outer_size)
}

fn center_main_window(app_handle: &tauri::AppHandle) -> tauri::Result<()> {
    let Some(window) = main_window(app_handle) else {
        return Ok(());
    };

    prepare_for_manual_layout(&window)?;
    window.center()?;
    window.set_focus()?;

    Ok(())
}


#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentProject {
    #[serde(default)]
    project_id: String,
    video_path: String,
    title: String,
    languages: Vec<String>,
    last_opened_at: String,
    duration: f64,
}

fn recent_projects_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to locate app data directory: {error}"))?;

    fs::create_dir_all(&app_data)
        .map_err(|error| format!("Failed to create app data directory: {error}"))?;

    Ok(app_data.join("projects.json"))
}

fn read_recent_projects_file(app: &tauri::AppHandle) -> Result<Vec<RecentProject>, String> {
    let path = recent_projects_path(app)?;

    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read recent projects: {error}"))?;

    let mut projects: Vec<RecentProject> = serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse recent projects: {error}"))?;

    for project in &mut projects {
        if project.project_id.trim().is_empty() {
            project.project_id =
                format!("legacy-{:016x}", stable_path_hash(&project.video_path));
        }
    }

    projects.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));

    Ok(projects)
}

fn write_recent_projects_file(
    app: &tauri::AppHandle,
    projects: &[RecentProject],
) -> Result<(), String> {
    let path = recent_projects_path(app)?;

    let content = serde_json::to_string_pretty(projects)
        .map_err(|error| format!("Failed to serialize recent projects: {error}"))?;

    fs::write(path, content)
        .map_err(|error| format!("Failed to save recent projects: {error}"))
}

#[tauri::command]
fn read_recent_projects(app: tauri::AppHandle) -> Result<Vec<RecentProject>, String> {
    read_recent_projects_file(&app)
}

#[tauri::command]
fn upsert_recent_project(
    app: tauri::AppHandle,
    project: RecentProject,
) -> Result<(), String> {
    let mut projects = read_recent_projects_file(&app)?;

    projects.retain(|existing| existing.project_id != project.project_id);
    projects.push(project);
    projects.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
    projects.truncate(50);

    write_recent_projects_file(&app, &projects)
}

#[tauri::command]
fn remove_recent_project(app: tauri::AppHandle, project_id: String) -> Result<(), String> {
    let mut projects = read_recent_projects_file(&app)?;

    projects.retain(|project| project.project_id != project_id);

    write_recent_projects_file(&app, &projects)
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

fn install_app_menu(app: &mut tauri::App) -> tauri::Result<()> {
    let new_project = MenuItemBuilder::with_id("file.new-project", "New Project…")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;

    let show_home = MenuItemBuilder::with_id("file.show-home", "Home").build(app)?;

    let open_video = MenuItemBuilder::with_id("file.open-video", "Open Video…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;

    let save_project = MenuItemBuilder::with_id("file.save-project", "Save Project")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;

    let import_srt = MenuItemBuilder::with_id("file.import-srt", "Import SRT…").build(app)?;
    let export_srt = MenuItemBuilder::with_id("file.export-srt", "Export SRT…").build(app)?;
    let export_video =
        MenuItemBuilder::with_id("file.export-video", "Export Styled Video…").build(app)?;

    let undo_editor = MenuItemBuilder::with_id("edit.undo", "Undo")
        .accelerator("CmdOrCtrl+Z")
        .build(app)?;

    let redo_editor = MenuItemBuilder::with_id("edit.redo", "Redo")
        .accelerator("CmdOrCtrl+Shift+Z")
        .build(app)?;

    let split_subtitle =
        MenuItemBuilder::with_id(
            "edit.split-subtitle",
            "Split Subtitle at Playhead",
        )
        .accelerator("CmdOrCtrl+B")
        .build(app)?;

    let select_all_subtitles =
        MenuItemBuilder::with_id(
            "edit.select-all-subtitles",
            "Select All Subtitles",
        )
        .build(app)?;

    let deselect_all_subtitles =
        MenuItemBuilder::with_id(
            "edit.deselect-all-subtitles",
            "Deselect All Subtitles",
        )
        .accelerator("CmdOrCtrl+Shift+A")
        .build(app)?;

    let add_subtitle =
        MenuItemBuilder::with_id("edit.add-subtitle", "Add Subtitle").build(app)?;
    let delete_subtitle =
        MenuItemBuilder::with_id("edit.delete-subtitle", "Delete Subtitle").build(app)?;

    let whisper_base = MenuItemBuilder::with_id(
        "transcription.whisper-base",
        "Generate with Whisper Base",
    )
    .build(app)?;

    let whisper_small = MenuItemBuilder::with_id(
        "transcription.whisper-small",
        "Generate with Whisper Small",
    )
    .build(app)?;

    let sensevoice = MenuItemBuilder::with_id(
        "transcription.sensevoice",
        "Generate with SenseVoice",
    )
    .build(app)?;

    let timeline_zoom_in = MenuItemBuilder::with_id("view.timeline-zoom-in", "Zoom In Timeline")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;

    let timeline_zoom_out =
        MenuItemBuilder::with_id("view.timeline-zoom-out", "Zoom Out Timeline")
            .accelerator("CmdOrCtrl+-")
            .build(app)?;

    let timeline_zoom_reset =
        MenuItemBuilder::with_id("view.timeline-zoom-reset", "Reset Timeline Zoom")
            .accelerator("CmdOrCtrl+0")
            .build(app)?;

    // -------------------------------------------------------------------------
    // Simplified macOS-style Window menu
    //
    // Tauri/muda does not expose the macOS Fn/Globe modifier in menu
    // accelerators, so these are registered as Control shortcuts. macOS users
    // can still hold Fn as well, but Fn cannot be required/displayed here.
    // -------------------------------------------------------------------------

    let window_fill = MenuItemBuilder::with_id("window.fill", "Fill")
        .accelerator("Ctrl+F")
        .build(app)?;

    let window_center = MenuItemBuilder::with_id("window.center", "Center")
        .accelerator("Ctrl+C")
        .build(app)?;

    let window_left = MenuItemBuilder::with_id("window.left", "Left")
        .accelerator("Ctrl+Left")
        .build(app)?;

    let window_right = MenuItemBuilder::with_id("window.right", "Right")
        .accelerator("Ctrl+Right")
        .build(app)?;

    let window_top = MenuItemBuilder::with_id("window.top", "Top")
        .accelerator("Ctrl+Up")
        .build(app)?;

    let window_bottom = MenuItemBuilder::with_id("window.bottom", "Bottom")
        .accelerator("Ctrl+Down")
        .build(app)?;

    let move_resize_menu = SubmenuBuilder::new(app, "Move & Resize")
        .item(&window_left)
        .item(&window_right)
        .item(&window_top)
        .item(&window_bottom)
        .build()?;

    let native_minimize = PredefinedMenuItem::minimize(app, Some("Minimize"))?;

    // On macOS the first submenu becomes the application menu.
    let app_menu = SubmenuBuilder::new(app, "Subtitle Editor")
        .about(None)
        .separator()
        .quit()
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_project)
        .item(&show_home)
        .separator()
        .item(&open_video)
        .separator()
        .item(&save_project)
        .separator()
        .item(&import_srt)
        .item(&export_srt)
        .separator()
        .item(&export_video)
        .separator()
        .close_window_with_text("Close Window")
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&undo_editor)
        .item(&redo_editor)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&select_all_subtitles)
        .item(&deselect_all_subtitles)
        .separator()
        .item(&split_subtitle)
        .separator()
        .item(&add_subtitle)
        .item(&delete_subtitle)
        .build()?;

    let transcription_menu = SubmenuBuilder::new(app, "Transcription")
        .item(&whisper_base)
        .item(&whisper_small)
        .separator()
        .item(&sensevoice)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&timeline_zoom_in)
        .item(&timeline_zoom_out)
        .separator()
        .item(&timeline_zoom_reset)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&window_fill)
        .item(&window_center)
        .item(&move_resize_menu)
        .separator()
        .item(&native_minimize)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &transcription_menu,
            &view_menu,
            &window_menu,
        ])
        .build()?;

    app.set_menu(menu)?;

    app.on_menu_event(|app_handle, event| {
        let id = event.id().0.as_str();

        let window_result = match id {
            "window.fill" => apply_window_layout(app_handle, WindowLayout::Fill),
            "window.center" => center_main_window(app_handle),
            "window.left" => apply_window_layout(app_handle, WindowLayout::Left),
            "window.right" => apply_window_layout(app_handle, WindowLayout::Right),
            "window.top" => apply_window_layout(app_handle, WindowLayout::Top),
            "window.bottom" => apply_window_layout(app_handle, WindowLayout::Bottom),
            _ => Ok(()),
        };

        if let Err(error) = window_result {
            eprintln!("Window menu action failed ({id}): {error}");
        }

        match id {
            "file.new-project"
            | "file.show-home"
            | "file.open-video"
            | "file.save-project"
            | "file.import-srt"
            | "file.export-srt"
            | "file.export-video"
            | "edit.undo"
            | "edit.redo"
            | "edit.split-subtitle"
            | "edit.select-all-subtitles"
            | "edit.deselect-all-subtitles"
            | "edit.add-subtitle"
            | "edit.delete-subtitle"
            | "transcription.whisper-base"
            | "transcription.whisper-small"
            | "transcription.sensevoice"
            | "view.timeline-zoom-in"
            | "view.timeline-zoom-out"
            | "view.timeline-zoom-reset" => {
                if let Err(error) = app_handle.emit(APP_MENU_COMMAND_EVENT, id.to_string()) {
                    eprintln!("Failed to emit app menu command: {error}");
                }
            }
            _ => {}
        }
    });

    Ok(())
}

#[tauri::command]
fn extract_waveform(
    app: tauri::AppHandle,
    video_path: String,
    points: usize,
) -> Result<Vec<f32>, String> {
    let ffmpeg_path = get_ffmpeg_path(&app)?;

    let output = Command::new(&ffmpeg_path)
        .args([
            "-i",
            &video_path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "8000",
            "-f",
            "s16le",
            "-",
        ])
        .output()
        .map_err(|error| error.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let bytes = output.stdout;

    if bytes.is_empty() {
        return Err("No audio samples were extracted.".to_string());
    }

    let samples: Vec<i16> = bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();

    if samples.is_empty() {
        return Err("No valid PCM samples were extracted.".to_string());
    }

    let point_count = points.max(1).min(samples.len());
    let samples_per_point = samples.len() / point_count;

    let mut waveform = Vec::with_capacity(point_count);

    for index in 0..point_count {
        let start = index * samples_per_point;

        let end = if index == point_count - 1 {
            samples.len()
        } else {
            (start + samples_per_point).min(samples.len())
        };

        let chunk = &samples[start..end];

        let sum_squares: f32 = chunk
            .iter()
            .map(|sample| {
                let normalized = *sample as f32 / i16::MAX as f32;
                normalized * normalized
            })
            .sum();

        let rms = (sum_squares / chunk.len() as f32).sqrt();
        waveform.push(rms);
    }

    let max_amplitude = waveform.iter().copied().fold(0.0_f32, f32::max);

    if max_amplitude > 0.0 {
        for value in &mut waveform {
            *value /= max_amplitude;
        }
    }

    Ok(waveform)
}

#[tauri::command]
fn read_matching_srt(video_path: String) -> Result<Option<String>, String> {
    let srt_path = Path::new(&video_path).with_extension("srt");

    if !srt_path.exists() {
        return Ok(None);
    }

    fs::read_to_string(&srt_path)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn escape_ffmpeg_filter_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:")
        .replace('\'', "\\'")
}

fn development_fonts_dir() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/fonts");

        if path.exists() {
            return Some(path);
        }
    }

    None
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoExportProgress {
    progress: f64,
    status: String,
}

fn emit_export_progress(
    app: &tauri::AppHandle,
    progress: f64,
    status: impl Into<String>,
) {
    let payload = VideoExportProgress {
        progress: progress.clamp(0.0, 100.0),
        status: status.into(),
    };

    if let Err(error) = app.emit("video-export-progress", payload) {
        eprintln!("Failed to emit export progress: {error}");
    }
}

#[tauri::command]
async fn export_styled_video(
    app: tauri::AppHandle,
    video_path: String,
    output_path: String,
    ass_content: String,
    video_duration: f64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::time::{SystemTime, UNIX_EPOCH};

        let ffmpeg_path = get_ffmpeg_path(&app)?;

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis();

        let ass_path =
            std::env::temp_dir().join(format!("subtitle-editor-export-{timestamp}.ass"));

        fs::write(&ass_path, ass_content)
            .map_err(|error| format!("Failed to create temporary ASS file: {error}"))?;

        let ass_path_string = escape_ffmpeg_filter_path(&ass_path);

        let video_filter = if let Some(fonts_dir) = development_fonts_dir() {
            let fonts_dir_string = escape_ffmpeg_filter_path(&fonts_dir);

            format!(
                "ass=filename='{}':fontsdir='{}'",
                ass_path_string, fonts_dir_string,
            )
        } else {
            format!("ass=filename='{}'", ass_path_string)
        };

        println!("Exporting with FFmpeg: {}", ffmpeg_path.display());
        println!("ASS filter: {}", video_filter);

        emit_export_progress(&app, 0.0, "Starting FFmpeg...");

        let mut child = Command::new(&ffmpeg_path)
            .args([
                "-y",
                "-i",
                &video_path,
                "-vf",
                &video_filter,
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "18",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
                "-progress",
                "pipe:1",
                "-nostats",
                &output_path,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("Failed to start FFmpeg: {error}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to read FFmpeg progress output.".to_string())?;

        let reader = BufReader::new(stdout);

        for line in reader.lines() {
            let line = line.map_err(|error| {
                format!("Failed to read FFmpeg progress output: {error}")
            })?;

            if let Some(value) = line.strip_prefix("out_time_us=") {
                if let Ok(microseconds) = value.parse::<f64>() {
                    if video_duration > 0.0 {
                        let seconds = microseconds / 1_000_000.0;
                        let percent = (seconds / video_duration) * 100.0;

                        emit_export_progress(
                            &app,
                            percent.min(99.0),
                            "Rendering subtitles and encoding video...",
                        );
                    }
                }
            }

            if line == "progress=end" {
                emit_export_progress(&app, 100.0, "Finishing export...");
            }
        }

        let status = child
            .wait()
            .map_err(|error| format!("Failed while waiting for FFmpeg: {error}"))?;

        let _ = fs::remove_file(&ass_path);

        if !status.success() {
            return Err(format!("FFmpeg export failed with status: {status}"));
        }

        emit_export_progress(&app, 100.0, "Export complete.");

        Ok(())
    })
    .await
    .map_err(|error| format!("Export task failed: {error}"))?
}

fn stable_path_hash(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;

    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }

    hash
}

fn project_thumbnails_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to locate app data directory: {error}"))?;

    let thumbnails = app_data.join("thumbnails");

    fs::create_dir_all(&thumbnails)
        .map_err(|error| format!("Failed to create thumbnail cache directory: {error}"))?;

    Ok(thumbnails)
}

#[tauri::command]
async fn get_project_thumbnail(
    app: tauri::AppHandle,
    video_path: String,
    duration: f64,
) -> Result<String, String> {
    let source = PathBuf::from(&video_path);

    if !source.exists() {
        return Err("The source video could not be found.".to_string());
    }

    let thumbnail_dir = project_thumbnails_dir(&app)?;
    let cache_key = stable_path_hash(&video_path);
    let thumbnail_path = thumbnail_dir.join(format!("{cache_key:016x}.jpg"));

    if thumbnail_path.exists() {
        return Ok(thumbnail_path.to_string_lossy().into_owned());
    }

    let ffmpeg_path = get_ffmpeg_path(&app)?;
    let output_path = thumbnail_path.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let seek_seconds = if duration.is_finite() && duration > 0.0 {
            (duration * 0.10).clamp(0.10, 5.0)
        } else {
            0.50
        };

        let status = Command::new(ffmpeg_path)
            .arg("-hide_banner")
            .arg("-loglevel")
            .arg("error")
            .arg("-ss")
            .arg(format!("{seek_seconds:.3}"))
            .arg("-i")
            .arg(&source)
            .arg("-frames:v")
            .arg("1")
            .arg("-vf")
            .arg(
                "scale=640:360:force_original_aspect_ratio=increase,crop=640:360",
            )
            .arg("-q:v")
            .arg("3")
            .arg("-y")
            .arg(&output_path)
            .status()
            .map_err(|error| format!("Failed to start FFmpeg for thumbnail: {error}"))?;

        if !status.success() {
            let _ = fs::remove_file(&output_path);

            return Err(format!(
                "FFmpeg thumbnail generation failed with status: {status}"
            ));
        }

        Ok(output_path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("Thumbnail task failed: {error}"))?
}

fn legacy_matching_project_path(video_path: &Path) -> PathBuf {
    video_path.with_extension("subtitle-project.json")
}

fn managed_projects_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to locate app data directory: {error}"))?;

    let projects_dir = app_data.join("projects");

    fs::create_dir_all(&projects_dir)
        .map_err(|error| format!("Failed to create managed projects directory: {error}"))?;

    Ok(projects_dir)
}

fn managed_project_path_for_id(
    app: &tauri::AppHandle,
    project_id: &str,
) -> Result<PathBuf, String> {
    let projects_dir = managed_projects_dir(app)?;
    let cache_key = stable_path_hash(project_id);

    Ok(projects_dir.join(format!("{cache_key:016x}.subtitle-project.json")))
}

fn legacy_managed_project_path_for_video(
    app: &tauri::AppHandle,
    video_path: &str,
) -> Result<PathBuf, String> {
    let projects_dir = managed_projects_dir(app)?;
    let cache_key = stable_path_hash(video_path);

    Ok(projects_dir.join(format!("{cache_key:016x}.subtitle-project.json")))
}

fn write_managed_project(
    app: &tauri::AppHandle,
    project_id: &str,
    project_json: &str,
) -> Result<(), String> {
    let project_path = managed_project_path_for_id(app, project_id)?;
    let temporary_path = project_path.with_extension("json.tmp");

    fs::write(&temporary_path, project_json)
        .map_err(|error| format!("Failed to write temporary project file: {error}"))?;

    if project_path.exists() {
        fs::remove_file(&project_path)
            .map_err(|error| format!("Failed to replace existing project file: {error}"))?;
    }

    fs::rename(&temporary_path, &project_path)
        .map_err(|error| format!("Failed to finalize project save: {error}"))
}

#[tauri::command]
fn read_matching_project(
    app: tauri::AppHandle,
    project_id: String,
    video_path: String,
) -> Result<Option<String>, String> {
    let managed_path = managed_project_path_for_id(&app, &project_id)?;

    if managed_path.exists() {
        return fs::read_to_string(&managed_path)
            .map(Some)
            .map_err(|error| format!("Failed to read managed subtitle project: {error}"));
    }

    /*
     * Backward compatibility:
     *
     * Existing installs used the source video path as the project identity.
     * Only deterministic `legacy-*` project IDs are allowed to fall back to
     * that old location. New UUID-backed projects never do this, which is what
     * allows multiple independent projects to use the same source video.
     */
    if project_id.starts_with("legacy-") {
        let legacy_managed_path =
            legacy_managed_project_path_for_video(&app, &video_path)?;

        if legacy_managed_path.exists() {
            let content = fs::read_to_string(&legacy_managed_path)
                .map_err(|error| {
                    format!("Failed to read legacy managed subtitle project: {error}")
                })?;

            write_managed_project(&app, &project_id, &content)?;

            return Ok(Some(content));
        }

        /*
         * Older builds stored `*.subtitle-project.json` beside the source video.
         * If one exists, read it and copy it into project-ID managed storage.
         * The legacy sidecar remains untouched.
         */
        let legacy_path = legacy_matching_project_path(Path::new(&video_path));

        if legacy_path.exists() {
            let content = fs::read_to_string(&legacy_path)
                .map_err(|error| format!("Failed to read legacy subtitle project: {error}"))?;

            write_managed_project(&app, &project_id, &content)?;

            return Ok(Some(content));
        }
    }

    Ok(None)
}

#[tauri::command]
fn save_subtitle_project(
    app: tauri::AppHandle,
    project_id: String,
    project_json: String,
) -> Result<(), String> {
    write_managed_project(&app, &project_id, &project_json)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            install_app_menu(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            extract_waveform,
            transcription::transcribe_video,
            read_matching_srt,
            read_matching_project,
            save_subtitle_project,
            read_recent_projects,
            upsert_recent_project,
            remove_recent_project,
            path_exists,
            get_project_thumbnail,
            export_styled_video
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
