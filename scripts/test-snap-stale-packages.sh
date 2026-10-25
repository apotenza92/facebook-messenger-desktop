#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

manifest="$TMP_DIR/manifest.yaml"
cat >"$manifest" <<'YAML'
name: facebook-messenger-desktop
version: 1.3.1-beta.45
parts:
  messenger:
    stage-packages:
    - libnss3=2:3.98-1ubuntu0.1
primed-stage-packages:
- libnss3=2:3.98-1ubuntu0.2
- libasound2t64:amd64=1.2.11-1ubuntu0.1
- 'libgtk-3-0t64=3.24.41-4ubuntu1.3'
- libgone=1.0
YAML

candidates="$TMP_DIR/candidates.txt"
cat >"$candidates" <<'EOF2'
libnss3 2:3.98-1ubuntu0.3
libasound2t64 1.2.11-1ubuntu0.1
libgtk-3-0t64 3.24.41-4ubuntu1.3
libgone (none)
EOF2

output="$(SNAP_APT_CANDIDATES_FILE="$candidates" "$ROOT_DIR/scripts/snap-stale-packages.sh" "$manifest" 2>"$TMP_DIR/stderr")"
test "$output" = "libnss3 2:3.98-1ubuntu0.2 -> 2:3.98-1ubuntu0.3"
grep -F "Skipping libgone: no archive candidate" "$TMP_DIR/stderr"

printf 'libnss3 2:3.98-1ubuntu0.2\n' >"$candidates"
output="$(SNAP_APT_CANDIDATES_FILE="$candidates" "$ROOT_DIR/scripts/snap-stale-packages.sh" "$manifest" 2>/dev/null)"
test -z "$output"

# With dpkg (Ubuntu runners), an older archive candidate is not outdated.
if command -v dpkg >/dev/null; then
  printf 'libnss3 2:3.98-1ubuntu0.1\n' >"$candidates"
  output="$(SNAP_APT_CANDIDATES_FILE="$candidates" "$ROOT_DIR/scripts/snap-stale-packages.sh" "$manifest" 2>/dev/null)"
  test -z "$output"
  echo "dpkg version ordering checked"
fi

printf 'name: x\nversion: 1\n' >"$manifest"
if SNAP_APT_CANDIDATES_FILE="$candidates" "$ROOT_DIR/scripts/snap-stale-packages.sh" "$manifest" >/dev/null 2>&1; then
  echo "Expected a manifest without primed-stage-packages to fail" >&2
  exit 1
fi

echo "snap stale package tests passed"
