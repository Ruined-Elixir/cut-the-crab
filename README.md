<div align="center">

# Cut The Crab

### A local-first video editor with built-in AI subtitles.

**Cut, caption, and export on your own machine. No uploads. No account. No internet required.**

[Download](https://github.com/Ruined-Elixir/cut-the-crab/releases) · [Quick start](#quick-start) · [Features](#features) · [Local transcription](#local-transcription) · [FAQ](#faq) · [Build from source](#build-from-source)

[![Release](https://img.shields.io/github/v/release/Ruined-Elixir/cut-the-crab?style=flat-square)](https://github.com/Ruined-Elixir/cut-the-crab/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-lightgrey?style=flat-square)](#platform-support)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB?style=flat-square)](https://tauri.app)

<img src="src/assets/demo_Menu.jpg" alt="Cut The Crab main interface" width="860" />

</div>

> [!IMPORTANT]
> Get Cut The Crab only from this repository's [Releases page](https://github.com/Ruined-Elixir/cut-the-crab/releases). A similarly named repository or a re-uploaded build is not an official download.

Cut The Crab is a nonlinear editor where subtitles are part of the timeline, not an afterthought. Generate captions with Whisper or SenseVoice, then move, trim, split, ripple or reverse the video. The captions follow every edit. Preview and export share the same rendering logic, so what you see is what FFmpeg produces.

Everything runs on-device: transcription, rendering, proxies, waveforms and project storage.

## Quick start

1. Download the latest `.dmg` from [Releases](https://github.com/Ruined-Elixir/cut-the-crab/releases) and drag **Cut The Crab** into Applications.
2. Open the app and create a named project.
3. Import a video onto the timeline.
4. Click **Transcribe** to generate subtitles locally.
5. Edit the video and subtitles. They stay in sync.
6. Export the full timeline or a selected range.

`Import → Edit → Transcribe → Subtitle → Preview → Export`

macOS may block the first launch because the app is not notarized yet. See [First launch on macOS](#first-launch-on-macos).

## How it works

Your video is decoded and edited locally. Transcription runs through bundled whisper.cpp and SenseVoice engines, and each caption is linked to the source clip it came from. When you change that clip, the app remaps, shortens, splits or removes the linked captions. Export builds one FFmpeg graph from the same timeline, transforms, layers and subtitle data the Program Monitor uses.

## Features

| Area | What you get |
|---|---|
| Nonlinear editing | Multi-track timeline, blade, ripple, freeze-frame, reverse, speed changes |
| Program Monitor | Real-time layered preview with drag, resize and snapping guides |
| Subtitle editing | Multiple tracks, full styling, ASS/libass rendering that matches export |
| Linked subtitles | Captions update automatically when the source video is edited |
| Local transcription | Whisper and SenseVoice, no cloud upload |
| Audio | Waveforms, volume, mute, multi-track mixing |
| Formats | 16:9, vertical short-form, or custom resolutions |
| Projects | Autosave, recent projects, missing-media relink, crash recovery |
| Export | FFmpeg-based, full timeline or selected range, progress and cancel |

### Linked subtitles

Generated subtitles stay structurally linked to their source video.

| Video edit | Subtitle behavior |
|---|---|
| Move, ripple, trim | Captions shift and resize with the clip |
| Split | Captions crossing the cut are split |
| Delete | Captions outside the remaining range are removed |
| Freeze-frame, speed change, reverse | Captions are remapped to the new timing |
| Timeline healing | Captions close the gap with the video |

Deleted a caption by accident? **Restore Missing Subtitles** retranscribes the original source, compares the result with your existing captions, and restores only the missing ones. Restored captions are mapped into the edited timeline and keep nearby styling where possible.

### Editing and performance

- **Timeline:** drag across tracks, trim, blade at the playhead, cut/copy/paste/duplicate, frame-accurate scrubbing, filmstrip thumbnails and edge scrolling.
- **Structural edits:** ripple inserts split surrounding clips and heal the gap on removal. Linked audio and subtitles stay synchronized. Undo reverses a structural edit as one operation.
- **Effects:** fade in/out, dissolve, freeze/hold, reverse, speed changes, adjustment layers.
- **Caching:** waveforms, filmstrips and editing proxies are generated in the background, with stale-proxy cleanup. Proxies speed up editing only. Export always uses the original media.
- **Playback:** upcoming-clip prewarming, decoded-frame readiness checks, clip-specific decoders, a media recovery watchdog, and playback kept in sync with linked audio.
- **Projects:** atomic autosave, persistent project IDs, missing-media relinking with duration validation, and grouped undo/redo across video, audio and subtitles.

## Local transcription

| Engine | Models | Best for |
|---|---|---|
| Whisper (whisper.cpp) | Base, Small | General-purpose speech recognition |
| SenseVoice | Default | Multilingual speech, including Cantonese |

The app handles model download, verification and local storage, then audio extraction, language detection, recognition, and subtitle placement on the timeline. Models are verified before they are stored.

## Platform support

| Platform | Status |
|---|---|
| macOS, Apple Silicon (M1 or newer) | Supported in v1.0 |
| Windows | Planned |
| Linux | Planned |

The app bundles the native tools it needs, including FFmpeg, Whisper and SenseVoice.

## First launch on macOS

Cut The Crab is ad-hoc signed and not yet notarized by Apple, so macOS may block the first launch.

1. Try to open **Cut The Crab** once.
2. Open **System Settings → Privacy & Security**.
3. In the **Security** section, find the message that Cut The Crab was blocked.
4. Click **Open Anyway**, then confirm with **Open**.

You only need to do this once.

> [!NOTE]
> Use the per-app **Open Anyway** option. Don't disable Gatekeeper or change system-wide security settings.

## FAQ

**Is my video uploaded anywhere?**
No. Transcription, rendering, proxies and project storage all run locally.

**Does it work offline?**
Yes for editing, transcription and export. Speech models are downloaded and verified the first time you use them, so fetch the ones you need while online.

**Does the preview match the export?**
Yes. The Program Monitor and the FFmpeg export share the same timeline, transform, layering and subtitle logic. Proxies are used only for editing speed, never for export.

**Why does macOS say the developer can't be verified?**
The app isn't notarized yet. See [First launch on macOS](#first-launch-on-macos).

**Is Windows or Linux supported?**
Not yet. Both are on the roadmap.

**What if I hit a bug?**
Update to the latest release first. If it persists, [open an issue](https://github.com/Ruined-Elixir/cut-the-crab/issues) with your app version, macOS version, steps to reproduce and any error output.

## Build from source

**Prerequisites:** [Node.js](https://nodejs.org), [Rust](https://rustup.rs), and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for macOS.

```bash
git clone [https://github.com/Ruined-Elixir/cut-the-crab.git](https://github.com/Ruined-Elixir/cut-the-crab.git)
cd cut-the-crab
npm install
npm run tauri dev     # development
npm run tauri build   # production build
```

### Tech stack

| Layer | Technology |
|---|---|
| App shell | [Tauri 2](https://tauri.app) |
| UI | React + TypeScript |
| Backend | Rust |
| Media | FFmpeg |
| Transcription | whisper.cpp, SenseVoice |
| Subtitle rendering | libass (WebAssembly) |

## Design principles

- **Editing feels immediate.** Timeline interactions, playback, scrubbing and trimming stay responsive.
- **Subtitles are part of the video.** Move, trim, split or ripple a clip and its captions follow.
- **Preview equals export.** One shared model drives both.

## Roadmap

**v1.0** delivers a complete workflow from import to export.

- [x] Multi-track timeline and ripple editing
- [x] Local transcription (Whisper, SenseVoice)
- [x] Video-linked subtitles
- [x] FFmpeg export
- [x] Project system with media relinking
- [ ] Windows support
- [ ] Linux support
- [ ] Additional editing and workflow improvements

## Contributing

Bug reports, feature requests and pull requests are welcome. Start with the [issues page](https://github.com/Ruined-Elixir/cut-the-crab/issues).

1. Fork the repository and create a branch: `git checkout -b feature/your-feature`
2. Commit your changes and push the branch.
3. Open a pull request describing what changed and why.

## License

<!-- Replace with your actual license, e.g. MIT -->
See [LICENSE](LICENSE). Third-party components (FFmpeg, whisper.cpp, SenseVoice, libass, Tauri) keep their own licenses.

## Acknowledgments

[FFmpeg](https://ffmpeg.org) · [whisper.cpp](https://github.com/ggerganov/whisper.cpp) · [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) · [libass](https://github.com/libass/libass) · [Tauri](https://tauri.app)

<div align="center">

Made with 🦀 and a lot of cuts.

</div>