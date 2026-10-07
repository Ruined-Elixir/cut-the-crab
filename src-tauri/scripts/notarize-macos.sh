#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS notarization must run on macOS." >&2
  exit 1
fi

TARGET="${1:?Usage: scripts/notarize-macos.sh <path-to-Cut-The-Crab.app-or.dmg>}"
if [[ ! -e "$TARGET" ]]; then
  echo "Notarization target not found: $TARGET" >&2
  exit 1
fi

for tool in xcrun ditto mktemp; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "Missing required notarization tool: $tool" >&2
    exit 1
  }
done

UPLOAD="$TARGET"
TEMP_DIR=""
if [[ -d "$TARGET" && "$TARGET" == *.app ]]; then
  TEMP_DIR="$(mktemp -d -t cut-the-crab-notary)"
  UPLOAD="$TEMP_DIR/Cut-The-Crab.zip"
  echo "Creating notarization archive: $UPLOAD"
  ditto -c -k --keepParent "$TARGET" "$UPLOAD"
fi

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

submit_args=(submit "$UPLOAD" --wait)
if [[ -n "${APPLE_NOTARY_KEYCHAIN_PROFILE:-}" ]]; then
  submit_args+=(--keychain-profile "$APPLE_NOTARY_KEYCHAIN_PROFILE")
else
  : "${APPLE_ID:?Set APPLE_NOTARY_KEYCHAIN_PROFILE, or APPLE_ID for notarization}"
  : "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID for notarization}"
  : "${APPLE_APP_SPECIFIC_PASSWORD:?Set APPLE_APP_SPECIFIC_PASSWORD for notarization}"
  submit_args+=(
    --apple-id "$APPLE_ID"
    --team-id "$APPLE_TEAM_ID"
    --password "$APPLE_APP_SPECIFIC_PASSWORD"
  )
fi

echo "Submitting to Apple notarization service..."
xcrun notarytool "${submit_args[@]}"

echo "Stapling notarization ticket..."
xcrun stapler staple "$TARGET"
xcrun stapler validate "$TARGET"

echo "Notarization complete: $TARGET"
