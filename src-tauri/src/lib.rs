use std::process::Command;
use crate::ffmpeg_paths::get_ffmpeg_path;
mod transcription;
mod whisper_paths;
mod model_manager;
mod ffmpeg_paths;
mod sensevoice_engine;
mod sensevoice_paths;

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
fn read_matching_srt(
    video_path: String
) -> Result<Option<String>, String> {
    use std::fs;
    use std::path::Path;

    let video_path = Path::new(&video_path);
    let srt_path = video_path.with_extension("srt");

    if !srt_path.exists() {
        return Ok(None);
    }

    fs::read_to_string(&srt_path)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            extract_waveform,
            transcription::transcribe_video,
            read_matching_srt
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
