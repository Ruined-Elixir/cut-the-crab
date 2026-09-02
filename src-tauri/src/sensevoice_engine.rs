use crate::ffmpeg_paths::get_ffmpeg_path;
use opencc_rs::{Config, OpenCC};
use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SenseVoiceSegment {
    pub start_time: f64,
    pub end_time: f64,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SenseVoiceResult {
    pub language: String,
    pub segments: Vec<SenseVoiceSegment>,
}

pub fn transcribe_with_sensevoice(
    app: &AppHandle,
    video_path: &str,
    binary_path: PathBuf,
    model_path: PathBuf,
    vad_path: PathBuf,
) -> Result<SenseVoiceResult, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Unable to determine app data directory: {e}"))?;

    let temp_dir = app_data.join("temp");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp directory: {e}"))?;

    let wav_path = temp_dir.join("sensevoice_input.wav");

    let ffmpeg_path = get_ffmpeg_path(app)?;

    let ffmpeg_output = Command::new(ffmpeg_path)
        .args(["-y", "-i", video_path, "-vn", "-ac", "1", "-ar", "16000"])
        .arg(&wav_path)
        .output()
        .map_err(|e| format!("Failed to start FFmpeg: {e}"))?;

    if !ffmpeg_output.status.success() {
        return Err(format!(
            "FFmpeg failed: {}",
            String::from_utf8_lossy(&ffmpeg_output.stderr)
        ));
    }

    let output = Command::new(binary_path)
        .arg("-m")
        .arg(model_path)
        .arg("-a")
        .arg(&wav_path)
        .arg("--vad")
        .arg(vad_path)
        .arg("--srt")
        .output()
        .map_err(|e| format!("Failed to run SenseVoice: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "SenseVoice failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    let converter =
        OpenCC::new([Config::S2HK]).map_err(|e| format!("Failed to initialize OpenCC: {e}"))?;

    let converted_segments = parse_srt_output(&stdout)?
        .into_iter()
        .map(|mut segment| {
            let converted = converter
                .convert(&segment.text)
                .map_err(|e| format!("Failed to convert SenseVoice text: {e}"))?;

            segment.text = clean_subtitle_punctuation(&converted);

            Ok(segment)
        })
        .collect::<Result<Vec<_>, String>>()?;

    let segments = converted_segments
        .into_iter()
        .flat_map(split_sensevoice_segment)
        .collect();

    Ok(SenseVoiceResult {
        language: "yue".to_string(),
        segments,
    })
}

fn split_sensevoice_segment(segment: SenseVoiceSegment) -> Vec<SenseVoiceSegment> {
    const TARGET_CHARS: usize = 14;
    const MAX_DURATION: f64 = 6.0;
    const MIN_DURATION: f64 = 0.8;

    let duration = segment.end_time - segment.start_time;
    let total_chars = segment.text.chars().count();

    if total_chars <= TARGET_CHARS && duration <= MAX_DURATION {
        return vec![segment];
    }

    let chunks = split_text_into_chunks(&segment.text, TARGET_CHARS);

    if chunks.len() <= 1 {
        return vec![segment];
    }

    let weights: Vec<f64> = chunks
        .iter()
        .map(|chunk| chunk_timing_weight(chunk))
        .collect();

    let total_weight: f64 = weights.iter().sum();

    if total_weight <= 0.0 {
        return vec![segment];
    }

    let mut result = Vec::new();
    let mut current_time = segment.start_time;

    for (index, chunk) in chunks.iter().enumerate() {
        let proportional_duration = duration * (weights[index] / total_weight);

        let remaining_chunks = chunks.len() - index - 1;

        let latest_end = segment.end_time - remaining_chunks as f64 * MIN_DURATION;

        let end_time = if index == chunks.len() - 1 {
            segment.end_time
        } else {
            (current_time + proportional_duration)
                .max(current_time + MIN_DURATION)
                .min(latest_end)
        };

        result.push(SenseVoiceSegment {
            start_time: current_time,
            end_time,
            text: chunk.trim().to_string(),
        });

        current_time = end_time;
    }

    result
}

fn chunk_timing_weight(text: &str) -> f64 {
    let mut weight: f64 = 0.0;

    for ch in text.chars() {
        weight += match ch {
            '。' | '！' | '？' | '!' | '?' => 1.8,
            '，' | ',' | '；' | ';' | '：' | ':' => 1.4,
            ' ' => 0.3,
            _ => 1.0,
        };
    }

    weight.max(1.0)
}

fn split_text_into_chunks(text: &str, target_chars: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();

    for ch in text.chars() {
        current.push(ch);

        let char_count = current.chars().count();

        let is_strong_boundary = matches!(ch, '。' | '！' | '？' | '!' | '?');

        let is_soft_boundary = matches!(ch, '，' | ',' | '；' | ';');

        if is_strong_boundary
            || (is_soft_boundary && char_count >= target_chars / 2)
            || char_count >= target_chars
        {
            let trimmed = current.trim();

            if !trimmed.is_empty() {
                chunks.push(trimmed.to_string());
            }

            current.clear();
        }
    }

    let remaining = current.trim();

    if !remaining.is_empty() {
        chunks.push(remaining.to_string());
    }

    chunks
}

fn parse_srt_output(input: &str) -> Result<Vec<SenseVoiceSegment>, String> {
    let mut segments = Vec::new();

    let blocks = input.split("\n\n");

    for block in blocks {
        let lines: Vec<&str> = block.lines().collect();

        if lines.len() < 3 {
            continue;
        }

        let timing_line = lines[1];

        let Some((start, end)) = timing_line.split_once(" --> ") else {
            continue;
        };

        let text = lines[2..].join(" ").trim().to_string();

        if text.is_empty() {
            continue;
        }

        segments.push(SenseVoiceSegment {
            start_time: parse_srt_time(start)?,
            end_time: parse_srt_time(end)?,
            text,
        });
    }

    Ok(segments)
}

fn parse_srt_time(value: &str) -> Result<f64, String> {
    let parts: Vec<&str> = value.split([':', ',']).collect();

    if parts.len() != 4 {
        return Err(format!("Invalid SRT timestamp: {value}"));
    }

    let hours: f64 = parts[0]
        .parse()
        .map_err(|_| format!("Invalid hours in timestamp: {value}"))?;

    let minutes: f64 = parts[1]
        .parse()
        .map_err(|_| format!("Invalid minutes in timestamp: {value}"))?;

    let seconds: f64 = parts[2]
        .parse()
        .map_err(|_| format!("Invalid seconds in timestamp: {value}"))?;

    let milliseconds: f64 = parts[3]
        .parse()
        .map_err(|_| format!("Invalid milliseconds in timestamp: {value}"))?;

    Ok(hours * 3600.0 + minutes * 60.0 + seconds + milliseconds / 1000.0)
}

fn clean_subtitle_punctuation(text: &str) -> String {
    let cleaned = text
        .chars()
        .map(|ch| {
            if matches!(
                ch,
                '。' | '，' | '、' | '；' | '：' | '！' | '？' | '.' | ',' | ';' | ':' | '!' | '?'
            ) {
                ' '
            } else {
                ch
            }
        })
        .collect::<String>();

    cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}
