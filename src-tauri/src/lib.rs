use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use serde::Serialize;
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

fn install_app_menu(app: &mut tauri::App) -> tauri::Result<()> {
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

    let view_placeholder =
        MenuItemBuilder::with_id("view.timeline-placeholder", "Timeline controls coming next")
            .enabled(false)
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
        .item(&open_video)
        .separator()
        .item(&save_project)
        .separator()
        .item(&import_srt)
        .item(&export_srt)
        .separator()
        .item(&export_video)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
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
        .item(&view_placeholder)
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
            "file.open-video"
            | "file.save-project"
            | "file.import-srt"
            | "file.export-srt"
            | "file.export-video"
            | "edit.add-subtitle"
            | "edit.delete-subtitle"
            | "transcription.whisper-base"
            | "transcription.whisper-small"
            | "transcription.sensevoice" => {
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

fn matching_project_path(video_path: &Path) -> PathBuf {
    video_path.with_extension("subtitle-project.json")
}

#[tauri::command]
fn read_matching_project(video_path: String) -> Result<Option<String>, String> {
    let project_path = matching_project_path(Path::new(&video_path));

    if !project_path.exists() {
        return Ok(None);
    }

    fs::read_to_string(&project_path)
        .map(Some)
        .map_err(|error| format!("Failed to read subtitle project: {}", error))
}

#[tauri::command]
fn save_subtitle_project(video_path: String, project_json: String) -> Result<(), String> {
    let project_path = matching_project_path(Path::new(&video_path));

    fs::write(&project_path, project_json)
        .map_err(|error| format!("Failed to save subtitle project: {}", error))
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
            export_styled_video
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
