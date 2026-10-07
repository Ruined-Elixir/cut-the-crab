#!/usr/bin/env bash
# Usage: scripts/verify-release.sh "src-tauri/target/release/bundle/macos/Cut The Crab.app"
set -u

APP="${1:?path to .app}"
fail=0

if [[ ! -d "$APP" ]]; then
  echo "App bundle not found: $APP" >&2
  exit 1
fi

for tool in codesign spctl file find otool awk grep sed; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "Missing required verification tool: $tool" >&2
    exit 1
  }
done

echo "== Mach-O files that are not signed with a hardened runtime + timestamp =="
while IFS= read -r -d '' f; do
  if file "$f" | grep -q "Mach-O"; then
    info="$(codesign -dv --verbose=4 "$f" 2>&1)"
    echo "$info" | grep -q "flags=.*runtime" || { echo "NO RUNTIME FLAG: $f"; fail=1; }
    echo "$info" | grep -q "Timestamp="       || { echo "NO TIMESTAMP:    $f"; fail=1; }
  fi
done < <(find "$APP" -type f -print0)

echo "== codesign strict verification =="
codesign --verify --deep --strict --verbose=2 "$APP" || fail=1

echo "== Gatekeeper assessment =="
spctl -a -t exec -vv "$APP" || fail=1

echo "== linked libraries that are not inside the app or the system =="
while IFS= read -r -d '' f; do
  if file "$f" | grep -q "Mach-O"; then
    while IFS= read -r lib; do
      [[ -z "$lib" ]] && continue
      if [[ ! "$lib" =~ ^(/usr/lib|/System|@rpath|@executable_path|@loader_path) ]]; then
        echo "EXTERNAL LIB in $f: $lib"
        fail=1
      fi
    done < <(otool -L "$f" | tail -n +2 | awk '{print $1}')
  fi
done < <(find "$APP" -type f -print0)

[[ "$fail" -eq 0 ]] && echo "OK" || { echo "FAILED"; exit 1; }

