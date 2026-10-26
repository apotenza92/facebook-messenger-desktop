#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

info="$TMP_DIR/info.json"
channel() {
  printf '{"channel":{"track":"latest","risk":"%s","architecture":"%s"},"revision":%s,"version":"%s"}' "$1" "$2" "$3" "$4"
}
wait_for() {
  SNAP_INFO_FILE="$info" WAIT_ATTEMPTS=2 WAIT_SECONDS=0 \
    "$ROOT_DIR/scripts/wait-snap-refreshed-revisions.sh" facebook-messenger-desktop "$@" 2>"$TMP_DIR/stderr"
}

# Other channels come first so a missing channel filter is caught.
printf '{"channel-map":[%s,%s,%s,%s]}' \
  "$(channel stable amd64 459 1.4.2)" "$(channel stable arm64 456 1.4.2)" \
  "$(channel candidate amd64 470 1.4.2)" "$(channel candidate arm64 471 1.4.2)" >"$info"
test "$(wait_for candidate 1.4.2 459 456 | tr '\n' ' ')" = "amd64_revision=470 arm64_revision=471 "

# Revisions at or below the floor are the pre-rebuild ones: keep waiting.
if wait_for candidate 1.4.2 470 456 >/dev/null; then
  echo "Expected an unrefreshed amd64 revision to time out" >&2
  exit 1
fi
grep -F "Timed out waiting for refreshed candidate 1.4.2" "$TMP_DIR/stderr"

# A different version in the channel never counts.
if wait_for candidate 1.4.3 0 0 >/dev/null; then
  echo "Expected a version mismatch to time out" >&2
  exit 1
fi

# Store outages and malformed responses are retried, not fatal.
printf 'not json' >"$info"
if wait_for candidate 1.4.2 0 0 >/dev/null; then
  echo "Expected a malformed store response to time out" >&2
  exit 1
fi
: >"$info"
if wait_for candidate 1.4.2 0 0 >/dev/null; then
  echo "Expected an empty store response to time out" >&2
  exit 1
fi
grep -F "Attempt 2/2: candidate amd64=rmissing, arm64=rmissing" "$TMP_DIR/stderr"

echo "wait snap refreshed revisions tests passed"
