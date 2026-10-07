use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    Emitter, Manager, PhysicalPosition, PhysicalSize,
};

use crate::ffmpeg_paths::get_ffmpeg_path;

mod ffmpeg_paths;
mod model_manager;
mod proxy_media;
mod sensevoice_engine;
mod sensevoice_paths;
mod transcription;
mod whisper_paths;

const APP_MENU_COMMAND_EVENT: &str = "app-menu-command";


fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn sibling_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    path.with_file_name(format!("{file_name}{suffix}"))
}

fn sync_parent_directory(path: &Path) {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        if let Ok(directory) = fs::File::open(parent) {
            let _ = directory.sync_all();
        }
    }
}

fn atomic_write_file(path: &Path, contents: &[u8], keep_backup: bool) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create parent directory: {error}"))?;
    }

    let temporary = sibling_with_suffix(path, &format!(".tmp-{}-{}", std::process::id(), timestamp_ms()));
    let mut file = fs::File::create(&temporary)
        .map_err(|error| format!("Failed to create temporary file: {error}"))?;
    file.write_all(contents)
        .map_err(|error| format!("Failed to write temporary file: {error}"))?;
    file.flush()
        .map_err(|error| format!("Failed to flush temporary file: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Failed to sync temporary file: {error}"))?;
    drop(file);

    let backup = sibling_with_suffix(path, ".bak");
    if path.exists() && keep_backup {
        fs::copy(path, &backup)
            .map_err(|error| format!("Failed to create backup file: {error}"))?;
        if let Ok(file) = fs::File::open(&backup) {
            let _ = file.sync_all();
        }
    }

    match fs::rename(&temporary, path) {
        Ok(()) => {
            sync_parent_directory(path);
            Ok(())
        }
        Err(first_error) if path.exists() => {
            // Windows does not replace an existing destination with rename().
            // A synced .bak exists before this fallback, so the previous file
            // remains recoverable even if the second rename fails.
            fs::remove_file(path)
                .map_err(|error| format!("Failed to prepare atomic replacement: {error}"))?;
            if let Err(error) = fs::rename(&temporary, path) {
                if keep_backup && backup.exists() {
                    let _ = fs::copy(&backup, path);
                }
                return Err(format!(
                    "Failed to finalize atomic replacement ({first_error}; retry: {error})"
                ));
            }
            sync_parent_directory(path);
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            Err(format!("Failed to finalize atomic write: {error}"))
        }
    }
}

fn backup_corrupt_file(path: &Path) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let backup = sibling_with_suffix(path, &format!(".corrupt-{}", timestamp_ms()));
    fs::copy(path, &backup)
        .map_err(|error| format!("Failed to back up corrupt file: {error}"))?;
    if let Ok(file) = fs::File::open(&backup) {
        let _ = file.sync_all();
    }
    Ok(Some(backup))
}

struct RemoveFileOnDrop(PathBuf);
impl Drop for RemoveFileOnDrop {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptionMenuTarget {
    clip_id: String,
    label: String,
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
    let mut projects: Vec<RecentProject> = match serde_json::from_str(&content) {
        Ok(projects) => projects,
        Err(error) => {
            let backup = backup_corrupt_file(&path)?;
            eprintln!(
                "Recent project registry was corrupt ({error}); backup: {:?}",
                backup
            );
            atomic_write_file(&path, b"[]", false)?;
            Vec::new()
        }
    };

    for project in &mut projects {
        if project.project_id.trim().is_empty() {
            project.project_id = format!("legacy-{:016x}", stable_path_hash(&project.video_path));
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
    let content = serde_json::to_vec_pretty(projects)
        .map_err(|error| format!("Failed to serialize recent projects: {error}"))?;
    atomic_write_file(&path, &content, true)
}

#[tauri::command]
fn read_recent_projects(app: tauri::AppHandle) -> Result<Vec<RecentProject>, String> {
    read_recent_projects_file(&app)
}

#[tauri::command]
async fn upsert_recent_project(app: tauri::AppHandle, project: RecentProject) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut projects = read_recent_projects_file(&app)?;

        projects.retain(|existing| existing.project_id != project.project_id);
        projects.push(project);
        projects.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
        projects.truncate(50);

        write_recent_projects_file(&app, &projects)
    })
    .await
    .map_err(|error| format!("Recent-project update task failed: {error}"))?
}

#[tauri::command]
async fn remove_recent_project(app: tauri::AppHandle, project_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut projects = read_recent_projects_file(&app)?;
        projects.retain(|project| project.project_id != project_id);
        write_recent_projects_file(&app, &projects)
    })
    .await
    .map_err(|error| format!("Recent-project removal task failed: {error}"))?
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
    let export_range =
        MenuItemBuilder::with_id("file.export-range", "Export Selected Range…").build(app)?;

    let undo_editor = MenuItemBuilder::with_id("edit.undo", "Undo")
        .accelerator("CmdOrCtrl+Z")
        .build(app)?;

    let redo_editor = MenuItemBuilder::with_id("edit.redo", "Redo")
        .accelerator("CmdOrCtrl+Shift+Z")
        .build(app)?;

    // App-owned editing commands. These intentionally use custom menu items
    // instead of Tauri's predefined Cut/Copy/Paste/Select All items so the
    // frontend can route the same command to either timeline editing or the
    // currently focused text field.
    let cut_editor = MenuItemBuilder::with_id("edit.cut", "Cut")
        .accelerator("CmdOrCtrl+X")
        .build(app)?;

    let copy_editor = MenuItemBuilder::with_id("edit.copy", "Copy")
        .accelerator("CmdOrCtrl+C")
        .build(app)?;

    let paste_editor = MenuItemBuilder::with_id("edit.paste", "Paste")
        .accelerator("CmdOrCtrl+V")
        .build(app)?;

    let duplicate_editor = MenuItemBuilder::with_id("edit.duplicate", "Duplicate")
        .accelerator("CmdOrCtrl+D")
        .build(app)?;

    let select_all_editor = MenuItemBuilder::with_id("edit.select-all", "Select All")
        .accelerator("CmdOrCtrl+A")
        .build(app)?;

    let delete_range =
        MenuItemBuilder::with_id("edit.delete-range", "Delete Range").build(app)?;
    let lift_range = MenuItemBuilder::with_id("edit.lift-range", "Lift Range").build(app)?;
    let extract_range =
        MenuItemBuilder::with_id("edit.extract-range", "Extract Range").build(app)?;

    let split_subtitle =
        MenuItemBuilder::with_id("edit.split-subtitle", "Split at Playhead")
            .accelerator("CmdOrCtrl+B")
            .build(app)?;

    let select_all_subtitles =
        MenuItemBuilder::with_id("edit.select-all-subtitles", "Select All Subtitles").build(app)?;

    let deselect_all_subtitles =
        MenuItemBuilder::with_id("edit.deselect-all-subtitles", "Deselect All Subtitles")
            .accelerator("CmdOrCtrl+Shift+A")
            .build(app)?;

    let add_subtitle = MenuItemBuilder::with_id("edit.add-subtitle", "Add Subtitle").build(app)?;
    let delete_subtitle =
        MenuItemBuilder::with_id("edit.delete-subtitle", "Delete Subtitle").build(app)?;

    let whisper_base = SubmenuBuilder::new(app, "Generate with Whisper Base")
        .id("transcription.whisper-base-menu")
        .build()?;

    let whisper_small = SubmenuBuilder::new(app, "Generate with Whisper Small")
        .id("transcription.whisper-small-menu")
        .build()?;

    let sensevoice = SubmenuBuilder::new(app, "Generate with SenseVoice")
        .id("transcription.sensevoice-menu")
        .build()?;

    let timeline_zoom_in = MenuItemBuilder::with_id("view.timeline-zoom-in", "Zoom In Timeline")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;

    let timeline_zoom_out = MenuItemBuilder::with_id("view.timeline-zoom-out", "Zoom Out Timeline")
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
        .accelerator("Ctrl+Alt+F")
        .build(app)?;

    let window_center = MenuItemBuilder::with_id("window.center", "Center")
        .accelerator("Ctrl+Alt+C")
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
    let app_menu = SubmenuBuilder::new(app, "Cut The Crab")
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
        .item(&export_range)
        .separator()
        .close_window_with_text("Close Window")
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&undo_editor)
        .item(&redo_editor)
        .separator()
        .item(&cut_editor)
        .item(&copy_editor)
        .item(&paste_editor)
        .item(&duplicate_editor)
        .item(&select_all_editor)
        .separator()
        .item(&delete_range)
        .item(&lift_range)
        .item(&extract_range)
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
        .id("transcription-menu")
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

        if id.starts_with("transcription.clip:") {
            if let Err(error) = app_handle.emit(APP_MENU_COMMAND_EVENT, id.to_string()) {
                eprintln!("Failed to emit app menu command: {error}");
            }
            return;
        }

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
            | "file.export-range"
            | "edit.undo"
            | "edit.redo"
            | "edit.cut"
            | "edit.copy"
            | "edit.paste"
            | "edit.duplicate"
            | "edit.select-all"
            | "edit.delete-range"
            | "edit.lift-range"
            | "edit.extract-range"
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

fn refill_transcription_target_menu(
    app: &tauri::AppHandle,
    submenu_id: &str,
    preset: &str,
    targets: &[TranscriptionMenuTarget],
) -> Result<(), String> {
    let menu = app
        .menu()
        .ok_or_else(|| "Application menu is not available.".to_string())?;

    let transcription_item = menu
        .get("transcription-menu")
        .ok_or_else(|| "Transcription menu is not available.".to_string())?;

    let transcription_menu = transcription_item
        .as_submenu()
        .ok_or_else(|| "Transcription menu has an unexpected type.".to_string())?;

    let model_item = transcription_menu
        .get(submenu_id)
        .ok_or_else(|| format!("Transcription submenu {submenu_id} is not available."))?;

    let model_menu = model_item
        .as_submenu()
        .ok_or_else(|| format!("Transcription submenu {submenu_id} has an unexpected type."))?;

    while !model_menu
        .items()
        .map_err(|error| format!("Failed to read transcription menu items: {error}"))?
        .is_empty()
    {
        model_menu
            .remove_at(0)
            .map_err(|error| format!("Failed to clear transcription menu: {error}"))?;
    }

    for target in targets {
        let item = MenuItemBuilder::with_id(
            format!("transcription.clip:{preset}:{}", target.clip_id),
            &target.label,
        )
        .build(app)
        .map_err(|error| format!("Failed to build transcription target item: {error}"))?;

        model_menu
            .append(&item)
            .map_err(|error| format!("Failed to append transcription target item: {error}"))?;
    }

    model_menu
        .set_enabled(!targets.is_empty())
        .map_err(|error| format!("Failed to update transcription menu state: {error}"))?;

    Ok(())
}

#[tauri::command]
fn update_transcription_menu_targets(
    app: tauri::AppHandle,
    targets: Vec<TranscriptionMenuTarget>,
) -> Result<(), String> {
    refill_transcription_target_menu(
        &app,
        "transcription.whisper-base-menu",
        "whisper-base",
        &targets,
    )?;
    refill_transcription_target_menu(
        &app,
        "transcription.whisper-small-menu",
        "whisper-small",
        &targets,
    )?;
    refill_transcription_target_menu(
        &app,
        "transcription.sensevoice-menu",
        "sensevoice",
        &targets,
    )?;

    Ok(())
}

#[tauri::command]
async fn extract_waveform(
    app: tauri::AppHandle,
    video_path: String,
    points: usize,
) -> Result<Vec<f32>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ffmpeg_path = get_ffmpeg_path(&app)?;
        let output = Command::new(&ffmpeg_path)
            .arg("-nostdin")
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
            waveform.push((sum_squares / chunk.len() as f32).sqrt());
        }
        let max_amplitude = waveform.iter().copied().fold(0.0_f32, f32::max);
        if max_amplitude > 0.0 {
            for value in &mut waveform {
                *value /= max_amplitude;
            }
        }
        Ok(waveform)
    })
    .await
    .map_err(|error| format!("Waveform task failed: {error}"))?
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaStreams {
    path: String,
    has_video: bool,
    has_audio: bool,
}

const MEDIA_PROBE_TIMEOUT: Duration = Duration::from_secs(15);

fn probe_media_stream(ffmpeg: &Path, path: String) -> Result<MediaStreams, String> {
    let stderr_path = std::env::temp_dir().join(format!(
        "cut-the-crab-probe-{}-{}-{:016x}.log",
        std::process::id(),
        timestamp_ms(),
        stable_path_hash(&path),
    ));
    let _stderr_cleanup = RemoveFileOnDrop(stderr_path.clone());
    let stderr_file = fs::File::create(&stderr_path)
        .map_err(|error| format!("Failed to create probe log for {path}: {error}"))?;

    // `ffmpeg -i file` exits non-zero when no output is requested, but its
    // stderr still contains the authoritative stream list. Write stderr to a
    // file instead of a pipe so a verbose/corrupt input cannot fill a pipe and
    // deadlock the child while we enforce the timeout below.
    let mut child = Command::new(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-i", &path])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .map_err(|error| format!("Failed to probe {path}: {error}"))?;

    let started = Instant::now();
    loop {
        match child
            .try_wait()
            .map_err(|error| format!("Failed while probing {path}: {error}"))?
        {
            Some(_) => break,
            None if started.elapsed() >= MEDIA_PROBE_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "Timed out probing {path} after {} seconds.",
                    MEDIA_PROBE_TIMEOUT.as_secs()
                ));
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    }

    let text = fs::read_to_string(&stderr_path)
        .map_err(|error| format!("Failed to read probe result for {path}: {error}"))?;

    Ok(MediaStreams {
        path,
        has_video: text.contains(": Video:"),
        has_audio: text.contains(": Audio:"),
    })
}

#[tauri::command]
async fn probe_media_streams(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<Vec<MediaStreams>, String> {
    let ffmpeg = get_ffmpeg_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| probe_media_stream(&ffmpeg, path))
            .collect()
    })
    .await
    .map_err(|error| format!("Probe task failed: {error}"))?
}

fn escape_ffmpeg_filter_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:")
        .replace('\'', "\\'")
}

fn export_fonts_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("fonts"));
        candidates.push(resource_dir.join("public").join("fonts"));
        candidates.push(resource_dir.join("_up_").join("public").join("fonts"));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/fonts"));
    candidates.into_iter().find(|path| path.is_dir())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoExportProgress {
    progress: f64,
    status: String,
}

#[derive(Clone)]
struct ActiveVideoExport {
    child: Option<Arc<Mutex<Child>>>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
struct VideoExportRegistry {
    active: Mutex<HashMap<String, ActiveVideoExport>>,
}

fn emit_export_progress(app: &tauri::AppHandle, progress: f64, status: impl Into<String>) {
    let payload = VideoExportProgress {
        progress: progress.clamp(0.0, 100.0),
        status: status.into(),
    };
    if let Err(error) = app.emit("video-export-progress", payload) {
        eprintln!("Failed to emit export progress: {error}");
    }
}

fn ffmpeg_error_detail(stderr: &str) -> String {
    const MAX_LINES: usize = 40;
    const MAX_CHARS: usize = 12_000;
    let lines = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return "FFmpeg did not provide an error message.".to_string();
    }
    let start = lines.len().saturating_sub(MAX_LINES);
    let detail = lines[start..].join("\n");
    if detail.chars().count() <= MAX_CHARS {
        return detail;
    }

    detail
        .chars()
        .rev()
        .take(MAX_CHARS)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn register_export_job(
    app: &tauri::AppHandle,
    export_job_id: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<(), String> {
    let registry = app.state::<VideoExportRegistry>();
    let mut active = registry
        .active
        .lock()
        .map_err(|_| "Export process registry is unavailable.".to_string())?;
    if active.contains_key(export_job_id) {
        return Err("An export with this job ID is already active.".to_string());
    }
    active.insert(
        export_job_id.to_string(),
        ActiveVideoExport {
            child: None,
            cancelled,
        },
    );
    Ok(())
}

fn attach_export_child(
    app: &tauri::AppHandle,
    export_job_id: &str,
    child: Arc<Mutex<Child>>,
) -> Result<bool, String> {
    let registry = app.state::<VideoExportRegistry>();
    let mut active = registry
        .active
        .lock()
        .map_err(|_| "Export process registry is unavailable.".to_string())?;
    let job = active
        .get_mut(export_job_id)
        .ok_or_else(|| "Export job disappeared before FFmpeg started.".to_string())?;
    job.child = Some(child);
    Ok(job.cancelled.load(Ordering::SeqCst))
}

fn unregister_export_job(app: &tauri::AppHandle, export_job_id: &str) {
    let registry = app.state::<VideoExportRegistry>();
    if let Ok(mut active) = registry.active.lock() {
        active.remove(export_job_id);
    };
}

#[tauri::command]
fn cancel_video_export(app: tauri::AppHandle, export_job_id: String) -> Result<(), String> {
    let child = {
        let registry = app.state::<VideoExportRegistry>();
        let mut active = registry
            .active
            .lock()
            .map_err(|_| "Export process registry is unavailable.".to_string())?;
        let Some(job) = active.get_mut(&export_job_id) else {
            return Ok(());
        };
        job.cancelled.store(true, Ordering::SeqCst);
        job.child.clone()
    };

    if let Some(child) = child {
        let mut child = child
            .lock()
            .map_err(|_| "The active FFmpeg process is unavailable.".to_string())?;
        if child
            .try_wait()
            .map_err(|error| format!("Failed to inspect FFmpeg process: {error}"))?
            .is_none()
        {
            let _ = child.kill();
        }
    }
    Ok(())
}

fn temporary_export_path(output: &Path, job_id: &str) -> PathBuf {
    let parent = output.parent().unwrap_or_else(|| Path::new("."));
    let stem = output.file_stem().and_then(|value| value.to_str()).unwrap_or("export");
    let extension = output.extension().and_then(|value| value.to_str()).unwrap_or("mp4");
    let safe_job = job_id
        .chars()
        .map(|character| if character.is_ascii_alphanumeric() { character } else { '-' })
        .collect::<String>();
    parent.join(format!(".{stem}.ctc-{safe_job}-{}.tmp.{extension}", timestamp_ms()))
}

fn commit_export_output(temp_output: &Path, final_output: &Path) -> Result<(), String> {
    let backup = sibling_with_suffix(final_output, ".pre-export.bak");
    let had_existing = final_output.exists();
    if had_existing {
        fs::copy(final_output, &backup)
            .map_err(|error| format!("Failed to protect the existing export: {error}"))?;
        if let Ok(file) = fs::File::open(&backup) {
            let _ = file.sync_all();
        }
    }

    let replace = match fs::rename(temp_output, final_output) {
        Ok(()) => Ok(()),
        Err(first_error) if had_existing => {
            fs::remove_file(final_output)
                .map_err(|error| format!("Failed to prepare export replacement: {error}"))?;
            if let Err(error) = fs::rename(temp_output, final_output) {
                let _ = fs::copy(&backup, final_output);
                Err(format!(
                    "Failed to finalize export ({first_error}; retry: {error}). The previous file was restored."
                ))
            } else {
                Ok(())
            }
        }
        Err(error) => Err(format!("Failed to finalize export: {error}")),
    };

    if replace.is_ok() {
        sync_parent_directory(final_output);
        if had_existing {
            let _ = fs::remove_file(&backup);
        }
    }
    replace
}

#[tauri::command]
async fn export_styled_video(
    app: tauri::AppHandle,
    video_path: String,
    output_path: String,
    ass_content: String,
    video_duration: f64,
    input_paths: Option<Vec<String>>,
    filter_complex: Option<String>,
    export_job_id: String,
) -> Result<(), String> {
    if export_job_id.trim().is_empty() {
        return Err("Export job ID is missing.".to_string());
    }

    let cancelled = Arc::new(AtomicBool::new(false));
    register_export_job(&app, &export_job_id, Arc::clone(&cancelled))?;
    let task_app = app.clone();
    let task_job_id = export_job_id.clone();

    let task = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if cancelled.load(Ordering::SeqCst) {
            return Err("EXPORT_CANCELLED".to_string());
        }

        let ffmpeg_path = get_ffmpeg_path(&task_app)?;
        let ass_path = std::env::temp_dir().join(format!(
            "cut-the-crab-export-{}-{}.ass",
            task_job_id
                .chars()
                .map(|character| if character.is_ascii_alphanumeric() { character } else { '-' })
                .collect::<String>(),
            timestamp_ms()
        ));
        fs::write(&ass_path, ass_content)
            .map_err(|error| format!("Failed to create temporary ASS file: {error}"))?;
        let _ass_cleanup = RemoveFileOnDrop(ass_path.clone());

        let requested_output = PathBuf::from(&output_path);
        let temp_output = temporary_export_path(&requested_output, &task_job_id);
        let _output_cleanup = RemoveFileOnDrop(temp_output.clone());
        let ass_path_string = escape_ffmpeg_filter_path(&ass_path);
        let ass_filter = if let Some(fonts_dir) = export_fonts_dir(&task_app) {
            format!(
                "ass=filename='{}':fontsdir='{}'",
                ass_path_string,
                escape_ffmpeg_filter_path(&fonts_dir)
            )
        } else {
            format!("ass=filename='{}'", ass_path_string)
        };

        emit_export_progress(&task_app, 0.0, "Starting FFmpeg...");
        let timeline_mode = filter_complex.is_some()
            && input_paths.as_ref().map(|paths| !paths.is_empty()).unwrap_or(false);
        let mut command = Command::new(&ffmpeg_path);
        command
            .arg("-nostdin")
            .arg("-hide_banner")
            .arg("-loglevel")
            .arg("error")
            .arg("-y");

        if timeline_mode {
            for input_path in input_paths.unwrap_or_default() {
                command.arg("-i").arg(input_path);
            }
            let base_filter = filter_complex.unwrap_or_default();
            let full_filter = format!("{};[vcomp]{},format=yuv420p[vout]", base_filter, ass_filter);
            command
                .arg("-filter_complex")
                .arg(full_filter)
                .arg("-map")
                .arg("[vout]")
                .arg("-map")
                .arg("[aout]");
        } else {
            command.arg("-i").arg(&video_path).arg("-vf").arg(&ass_filter);
        }

        command
            .arg("-c:v")
            .arg("libx264")
            .arg("-preset")
            .arg("medium")
            .arg("-crf")
            .arg("18")
            .arg("-pix_fmt")
            .arg("yuv420p")
            .arg("-c:a")
            .arg("aac")
            .arg("-b:a")
            .arg("192k")
            .arg("-movflags")
            .arg("+faststart")
            .arg("-progress")
            .arg("pipe:1")
            .arg("-nostats")
            .arg(&temp_output)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut spawned = command
            .spawn()
            .map_err(|error| format!("Failed to start FFmpeg: {error}"))?;
        let stdout = spawned
            .stdout
            .take()
            .ok_or_else(|| "Failed to read FFmpeg progress output.".to_string())?;
        let stderr = spawned.stderr.take();
        let child = Arc::new(Mutex::new(spawned));
        if attach_export_child(&task_app, &task_job_id, Arc::clone(&child))? {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
            }
        }

        let stderr_thread = stderr.map(|stderr| {
            thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut output = String::new();
                match reader.read_to_string(&mut output) {
                    Ok(_) => output,
                    Err(error) => format!("Failed while reading FFmpeg error output: {error}"),
                }
            })
        });

        let mut progress_error = None;
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    progress_error = Some(format!("Failed to read FFmpeg progress output: {error}"));
                    break;
                }
            };
            if let Some(value) = line.strip_prefix("out_time_us=") {
                if let Ok(microseconds) = value.parse::<f64>() {
                    if video_duration > 0.0 {
                        let percent = (microseconds / 1_000_000.0 / video_duration) * 100.0;
                        emit_export_progress(
                            &task_app,
                            percent.min(99.0),
                            if timeline_mode {
                                "Rendering edited timeline..."
                            } else {
                                "Rendering subtitles and encoding video..."
                            },
                        );
                    }
                }
            }
        }

        let status = child
            .lock()
            .map_err(|_| "The active FFmpeg process is unavailable.".to_string())?
            .wait()
            .map_err(|error| format!("Failed while waiting for FFmpeg: {error}"))?;
        let stderr_output = stderr_thread
            .map(|handle| handle.join().unwrap_or_else(|_| "FFmpeg error reader thread failed.".to_string()))
            .unwrap_or_default();

        if cancelled.load(Ordering::SeqCst) {
            return Err("EXPORT_CANCELLED".to_string());
        }
        if let Some(error) = progress_error {
            return Err(error);
        }
        if !status.success() {
            return Err(format!(
                "FFmpeg export failed with status: {status}\n{}",
                ffmpeg_error_detail(&stderr_output)
            ));
        }

        commit_export_output(&temp_output, &requested_output)?;
        emit_export_progress(&task_app, 100.0, "Export complete.");
        Ok(())
    })
    .await;

    unregister_export_job(&app, &export_job_id);

    match task {
        Ok(result) => result,
        Err(error) => Err(format!("Export task failed: {error}")),
    }
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
            .arg("scale=640:360:force_original_aspect_ratio=increase,crop=640:360")
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

// Security boundary for restoring asset-protocol access after a project reload.
// Keep this list in sync with media formats exposed by the frontend import/relink
// dialogs whenever support for a new container is added. Do not replace it with
// a blanket path grant: saved projects should only re-authorize media files.
const ALLOWED_MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "m4v", "webm", "mkv", "avi", "mp3", "wav", "m4a", "aac", "flac",
    "ogg", "opus",
];

fn collect_media_paths(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                if matches!(key.as_str(), "sourcePath" | "videoPath" | "path") {
                    if let Some(text) = child.as_str() {
                        out.push(text.to_string());
                    }
                }
                collect_media_paths(child, out);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_media_paths(item, out);
            }
        }
        _ => {}
    }
}

/// Re-authorize only media files referenced by a project that was loaded from
/// managed storage. Runtime dialog grants disappear after restart, so this
/// restores exactly the files the saved project already knows about instead of
/// exposing the user's whole home directory to the asset protocol.
fn allow_project_media(app: &tauri::AppHandle, project_json: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(project_json) else {
        return;
    };

    let mut paths = Vec::new();
    collect_media_paths(&value, &mut paths);
    paths.sort();
    paths.dedup();

    let scope = app.asset_protocol_scope();

    for text in paths {
        let path = PathBuf::from(&text);
        let extension_ok = path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| {
                let extension = extension.to_ascii_lowercase();
                ALLOWED_MEDIA_EXTENSIONS.contains(&extension.as_str())
            })
            .unwrap_or(false);

        if path.is_absolute() && extension_ok && path.is_file() {
            if let Err(error) = scope.allow_file(&path) {
                eprintln!("Could not allow media {}: {error}", path.display());
            }
        }
    }
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
    atomic_write_file(&project_path, project_json.as_bytes(), true)
}

fn read_matching_project_inner(
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
        let legacy_managed_path = legacy_managed_project_path_for_video(&app, &video_path)?;

        if legacy_managed_path.exists() {
            let content = fs::read_to_string(&legacy_managed_path).map_err(|error| {
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
fn read_matching_project(
    app: tauri::AppHandle,
    project_id: String,
    video_path: String,
) -> Result<Option<String>, String> {
    let content = read_matching_project_inner(app.clone(), project_id, video_path)?;
    if let Some(text) = &content {
        allow_project_media(&app, text);
    }
    Ok(content)
}

#[tauri::command]
async fn save_subtitle_project(
    app: tauri::AppHandle,
    project_id: String,
    project_json: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        write_managed_project(&app, &project_id, &project_json)
    })
    .await
    .map_err(|error| format!("Project save task failed: {error}"))?
}

#[tauri::command]
fn backup_corrupt_project(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<Option<String>, String> {
    let path = managed_project_path_for_id(&app, &project_id)?;
    backup_corrupt_file(&path).map(|backup| backup.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn quarantine_project(app: tauri::AppHandle, project_id: String) -> Result<String, String> {
    let path = managed_project_path_for_id(&app, &project_id)?;

    if !path.exists() {
        return Err("There is no project file to back up.".to_string());
    }

    backup_corrupt_file(&path)?
        .map(|copy| copy.to_string_lossy().into_owned())
        .ok_or_else(|| "There is no project file to back up.".to_string())
}

#[tauri::command]
fn read_project_backup(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<Option<String>, String> {
    let project_path = managed_project_path_for_id(&app, &project_id)?;
    let backup_path = sibling_with_suffix(&project_path, ".bak");

    if !backup_path.exists() {
        return Ok(None);
    }

    let text = fs::read_to_string(&backup_path)
        .map_err(|error| format!("Failed to read project backup: {error}"))?;
    allow_project_media(&app, &text);
    Ok(Some(text))
}

const LEGACY_BUNDLE_IDENTIFIER: &str = "com.ruinedelixir.subtitle-editor";

fn migrate_legacy_app_data_if_needed(app: &tauri::AppHandle) {
    let Ok(current_dir) = app.path().app_data_dir() else {
        return;
    };
    let Some(parent) = current_dir.parent() else {
        return;
    };
    let legacy_dir = parent.join(LEGACY_BUNDLE_IDENTIFIER);

    if legacy_dir == current_dir || !legacy_dir.is_dir() {
        return;
    }

    if let Err(error) = fs::create_dir_all(&current_dir) {
        eprintln!(
            "Could not prepare Cut The Crab app-data migration destination {}: {error}",
            current_dir.display()
        );
        return;
    }

    let Ok(entries) = fs::read_dir(&legacy_dir) else {
        return;
    };
    let mut moved_any = false;

    for entry in entries.flatten() {
        let source = entry.path();
        let destination = current_dir.join(entry.file_name());
        if destination.exists() {
            continue;
        }
        match fs::rename(&source, &destination) {
            Ok(()) => moved_any = true,
            Err(error) => eprintln!(
                "Could not migrate pre-release app-data entry {}: {error}",
                source.display()
            ),
        }
    }

    let _ = fs::remove_dir(&legacy_dir);
    if moved_any {
        eprintln!(
            "Migrated pre-release Cut The Crab app data from {} to {}",
            legacy_dir.display(),
            current_dir.display()
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(VideoExportRegistry::default())
        .manage(proxy_media::ProxyRegistry::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            migrate_legacy_app_data_if_needed(app.handle());
            install_app_menu(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            extract_waveform,
            update_transcription_menu_targets,
            transcription::transcribe_video,
            read_matching_srt,
            probe_media_streams,
            read_matching_project,
            save_subtitle_project,
            backup_corrupt_project,
            quarantine_project,
            read_project_backup,
            read_recent_projects,
            upsert_recent_project,
            remove_recent_project,
            path_exists,
            get_project_thumbnail,
            proxy_media::ensure_video_proxy,
            proxy_media::cancel_video_proxy,
            export_styled_video,
            cancel_video_export
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
