#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

status_file="$TMP_DIR/status.txt"
cat >"$status_file" <<'EOF'
Track    Arch    Channel    Version        Revision    Progress
latest   amd64   stable     1.3.0          266         -
latest   amd64   candidate  -              -           -
latest   amd64   beta       1.3.1-beta.30  348         -
latest   amd64   edge       1.3.1-beta.30  348         -
latest   arm64   stable     1.3.0          267         -
latest   arm64   candidate  -              -           -
latest   arm64   beta       1.3.1-beta.30  349         -
latest   arm64   edge       1.3.1-beta.30  349         -
EOF

SNAP_STATUS_FILE="$status_file" "$ROOT_DIR/scripts/verify-snap-channel-version.sh" facebook-messenger-desktop beta 1.3.1-beta.30

failure_output="$TMP_DIR/verify-snap-channel-version.out"
if SNAP_STATUS_FILE="$status_file" "$ROOT_DIR/scripts/verify-snap-channel-version.sh" facebook-messenger-desktop stable 1.3.1-beta.30 >"$failure_output" 2>&1; then
  echo "Expected mismatched stable channel verification to fail" >&2
  exit 1
fi

grep -F "Mismatched architectures: amd64=1.3.0 arm64=1.3.0" "$failure_output"

echo "snap channel verification tests passed"
