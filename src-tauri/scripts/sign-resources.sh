#!/usr/bin/env bash
set -euo pipefail
exec "$(dirname "$0")/../src-tauri/scripts/sign-macos-tools.sh" "$@"

