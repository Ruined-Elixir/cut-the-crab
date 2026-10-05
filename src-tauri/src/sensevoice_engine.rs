use crate::ffmpeg_paths::get_ffmpeg_path;
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
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

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn unique_temp_wav(temp_dir: &Path) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    Ok(temp_dir.join(format!(
        "sensevoice-{}-{timestamp}.wav",
        std::process::id()
    )))
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

    let wav_path = unique_temp_wav(&temp_dir)?;
    let _wav_cleanup = TempFileGuard(wav_path.clone());
    let ffmpeg_path = get_ffmpeg_path(app)?;

    let ffmpeg_output = Command::new(ffmpeg_path)
        .args(["-nostdin", "-y", "-i", video_path, "-vn", "-ac", "1", "-ar", "16000"])
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
    let mut detected_language: Option<String> = detect_sensevoice_language(&stdout);
    let parsed = parse_srt_output(&stdout)?;

    let mut cleaned_segments = Vec::with_capacity(parsed.len());
    for mut segment in parsed {
        if detected_language.is_none() {
            detected_language = detect_sensevoice_language(&segment.text);
        }
        segment.text = clean_subtitle_punctuation(&strip_sensevoice_tags(&segment.text));
        if !segment.text.trim().is_empty() {
            cleaned_segments.push(segment);
        }
    }

    let segments = cleaned_segments
        .into_iter()
        .flat_map(split_sensevoice_segment)
        .collect();

    // Do not claim Cantonese for every SenseVoice run. The runtime can emit
    // language tags; when it does not, return "auto" rather than applying an
    // incorrect Chinese conversion to English/Japanese/Mandarin text.
    Ok(SenseVoiceResult {
        language: detected_language.unwrap_or_else(|| "auto".to_string()),
        segments,
    })
}

fn detect_sensevoice_language(text: &str) -> Option<String> {
    const TAGS: [(&str, &str); 10] = [
        ("<|yue|>", "yue"),
        ("<|zh|>", "zh"),
        ("<|en|>", "en"),
        ("<|ja|>", "ja"),
        ("<|ko|>", "ko"),
        ("<|粤语|>", "yue"),
        ("<|中文|>", "zh"),
        ("<|英语|>", "en"),
        ("<|日语|>", "ja"),
        ("<|韩语|>", "ko"),
    ];

    TAGS
        .iter()
        .find_map(|(tag, language)| text.contains(tag).then(|| (*language).to_string()))
}

fn strip_sensevoice_tags(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;

    while index < chars.len() {
        if index + 1 < chars.len() && chars[index] == '<' && chars[index + 1] == '|' {
            let start = index;
            index += 2;
            let mut closed = false;
            while index + 1 < chars.len() {
                if chars[index] == '|' && chars[index + 1] == '>' {
                    index += 2;
                    closed = true;
                    break;
                }
                index += 1;
            }
            if closed {
                continue;
            }
            index = start;
        }

        result.push(chars[index]);
        index += 1;
    }

    result
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

    let weights: Vec<f64> = chunks.iter().map(|chunk| chunk_timing_weight(chunk)).collect();
    let total_weight: f64 = weights.iter().sum();
    if total_weight <= 0.0 {
        return vec![segment];
    }

    let mut result = Vec::new();
    let mut current_time = segment.start_time;
    let supported_min_duration =
        duration >= chunks.len() as f64 * MIN_DURATION;
    let min_chunk_duration = if supported_min_duration {
        MIN_DURATION
    } else {
        0.0
    };

    for (index, chunk) in chunks.iter().enumerate() {
        let proportional_duration = duration * (weights[index] / total_weight);
        let remaining_chunks = chunks.len() - index - 1;
        let latest_end =
            segment.end_time - remaining_chunks as f64 * min_chunk_duration;
        let end_time = if index == chunks.len() - 1 {
            segment.end_time
        } else {
            (current_time + proportional_duration)
                .max(current_time + min_chunk_duration)
                .min(latest_end)
                .max(current_time)
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
    let normalized = input.replace("\r\n", "\n");
    let mut segments = Vec::new();

    for block in normalized.split("\n\n") {
        let lines: Vec<&str> = block.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
        let Some(timing_index) = lines.iter().position(|line| line.contains(" --> ")) else {
            continue;
        };
        let timing_line = lines[timing_index];
        let Some((start, end)) = timing_line.split_once(" --> ") else {
            continue;
        };
        let text = lines
            .iter()
            .skip(timing_index + 1)
            .copied()
            .collect::<Vec<_>>()
            .join(" ")
            .trim()
            .to_string();
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
    let parts: Vec<&str> = value.trim().split([':', ',']).collect();
    if parts.len() != 4 {
        return Err(format!("Invalid SRT timestamp: {value}"));
    }

    let hours: f64 = parts[0].parse().map_err(|_| format!("Invalid hours in timestamp: {value}"))?;
    let minutes: f64 = parts[1].parse().map_err(|_| format!("Invalid minutes in timestamp: {value}"))?;
    let seconds: f64 = parts[2].parse().map_err(|_| format!("Invalid seconds in timestamp: {value}"))?;
    let milliseconds: f64 = parts[3].parse().map_err(|_| format!("Invalid milliseconds in timestamp: {value}"))?;
    Ok(hours * 3600.0 + minutes * 60.0 + seconds + milliseconds / 1000.0)
}

fn clean_subtitle_punctuation(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut cleaned = String::with_capacity(text.len());

    for (index, ch) in chars.iter().copied().enumerate() {
        let previous_is_digit = index > 0 && chars[index - 1].is_ascii_digit();
        let next_is_digit = index + 1 < chars.len() && chars[index + 1].is_ascii_digit();
        let numeric_separator = matches!(ch, '.' | ':' | ',') && previous_is_digit && next_is_digit;

        if numeric_separator {
            cleaned.push(ch);
        } else if matches!(
            ch,
            '。' | '，' | '、' | '；' | '：' | '！' | '？' | '.' | ',' | ';' | ':' | '!' | '?'
        ) {
            cleaned.push(' ');
        } else {
            cleaned.push(ch);
        }
    }

    cleaned.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_ignores_log_lines_before_srt_entries() {
        let input = "loading model...\n\n1\n00:00:01,000 --> 00:00:02,000\nHello\n";
        let parsed = parse_srt_output(input).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].text, "Hello");
    }

    #[test]
    fn punctuation_preserves_numeric_separators() {
        assert_eq!(clean_subtitle_punctuation("3.5 at 10:30!"), "3.5 at 10:30");
    }

    #[test]
    fn short_dense_segment_never_produces_reverse_timestamps() {
        let segment = SenseVoiceSegment {
            start_time: 10.0,
            end_time: 11.0,
            text: "abcdefghijklmnopqrstuvwx yz0123456789".to_string(),
        };
        let chunks = split_sensevoice_segment(segment);
        assert!(!chunks.is_empty());
        assert!(chunks.iter().all(|chunk| chunk.end_time >= chunk.start_time));
        assert!(chunks.windows(2).all(|pair| pair[1].start_time >= pair[0].end_time));
        assert!((chunks.last().unwrap().end_time - 11.0).abs() < 0.000_001);
    }
}
