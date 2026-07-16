#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

info_file="$TMP_DIR/info.json"
cat >"$info_file" <<'EOF'
{
  "channel-map": [
    {"channel":{"track":"latest","risk":"beta","architecture":"amd64"},"version":"1.3.1-beta.40","revision":370},
    {"channel":{"track":"latest","risk":"beta","architecture":"arm64"},"version":"1.3.1-beta.40","revision":371}
  ]
}
EOF

SNAP_INFO_FILE="$info_file" \
  "$ROOT_DIR/scripts/verify-snap-channel-revisions.sh" \
  facebook-messenger-desktop beta 1.3.1-beta.40 370 371

failure_output="$TMP_DIR/failure.out"
if SNAP_INFO_FILE="$info_file" \
  "$ROOT_DIR/scripts/verify-snap-channel-revisions.sh" \
  facebook-messenger-desktop beta 1.3.1-beta.40 368 369 >"$failure_output" 2>&1; then
  echo "Expected stale revision verification to fail" >&2
  exit 1
fi

grep -F "Mismatched architectures: amd64=1.3.1-beta.40/r370 arm64=1.3.1-beta.40/r371" "$failure_output"
echo "snap channel revision verification tests passed"
