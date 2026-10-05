#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Skipping bundled-tool signing: not running on macOS."
  exit 0
fi

IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  echo "APPLE_SIGNING_IDENTITY must be set to a Developer ID Application identity before a distributable macOS build." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESOURCES="$ROOT/resources"
BINARIES="$ROOT/binaries"

if [[ ! -d "$RESOURCES" ]]; then
  echo "Bundled native resources were not found at $RESOURCES" >&2
  exit 1
fi

sign_one() {
  local target="$1"
  local args=(--force --timestamp --options runtime --sign "$IDENTITY")
  if [[ -n "${APPLE_TOOL_ENTITLEMENTS:-}" ]]; then
    args+=(--entitlements "$APPLE_TOOL_ENTITLEMENTS")
  fi
  codesign "${args[@]}" "$target"
}

is_macho() {
  file "$1" | grep -q "Mach-O"
}

is_library_macho() {
  file "$1" | grep -Eq "Mach-O .*dynamically linked shared library|Mach-O .*bundle"
}

# Sign inside-out. First sign every nested Mach-O library/helper library, then
# executables. Do not use --deep; each code object gets its own hardened-runtime
# signature and timestamp before Tauri signs the outer .app bundle.
while IFS= read -r -d '' target; do
  if is_macho "$target" && is_library_macho "$target"; then
    echo "Signing library: $target"
    sign_one "$target"
  fi
done < <(find "$RESOURCES" -depth -type f -print0)

while IFS= read -r -d '' target; do
  if is_macho "$target" && ! is_library_macho "$target"; then
    echo "Signing executable/helper: $target"
    sign_one "$target"
  fi
done < <(find "$RESOURCES" -depth -type f -print0)

# If a future notarization fallback moves a single-file tool to externalBin,
# sign those target-triple binaries before Tauri copies them beside the app.
if [[ -d "$BINARIES" ]]; then
  while IFS= read -r -d '' target; do
    if is_macho "$target"; then
      echo "Signing externalBin candidate: $target"
      sign_one "$target"
    fi
  done < <(find "$BINARIES" -depth -type f -print0)
fi

echo "Bundled FFmpeg/Whisper/SenseVoice Mach-O files signed. Tauri will sign the outer app bundle during tauri build."
