#!/usr/bin/env bash
set -euo pipefail

SNAP_NAME="${1:?Usage: verify-snap-channel-revisions.sh <snap-name> <channel> <version> <amd64-revision> <arm64-revision>}"
CHANNEL="${2:?Usage: verify-snap-channel-revisions.sh <snap-name> <channel> <version> <amd64-revision> <arm64-revision>}"
EXPECTED_VERSION="${3:?Usage: verify-snap-channel-revisions.sh <snap-name> <channel> <version> <amd64-revision> <arm64-revision>}"
EXPECTED_AMD64_REVISION="${4:?Usage: verify-snap-channel-revisions.sh <snap-name> <channel> <version> <amd64-revision> <arm64-revision>}"
EXPECTED_ARM64_REVISION="${5:?Usage: verify-snap-channel-revisions.sh <snap-name> <channel> <version> <amd64-revision> <arm64-revision>}"

if [ -n "${SNAP_INFO_FILE:-}" ]; then
  INFO="$(<"$SNAP_INFO_FILE")"
else
  snap_info_url="https://api.snapcraft.io/v2/snaps/info/${SNAP_NAME}"
  INFO=""
  for attempt in 1 2 3 4; do
    if INFO="$(curl -fsSL \
      -H "Snap-Device-Series: 16" \
      -H "User-Agent: snapd/2.63" \
      "$snap_info_url")"; then
      break
    fi
    sleep $((attempt * 15))
  done
fi

test -n "$INFO"

failures=()
for arch in amd64 arm64; do
  expected_revision="$EXPECTED_AMD64_REVISION"
  if [ "$arch" = "arm64" ]; then
    expected_revision="$EXPECTED_ARM64_REVISION"
  fi

  row="$(jq -r --arg channel "$CHANNEL" --arg arch "$arch" \
    '."channel-map"[] | select(.channel.track == "latest" and .channel.risk == $channel and .channel.architecture == $arch) | [.version, (.revision | tostring)] | @tsv' \
    <<<"$INFO")"
  actual_version="${row%%$'\t'*}"
  actual_revision="${row#*$'\t'}"

  if [ "$actual_version" != "$EXPECTED_VERSION" ] || [ "$actual_revision" != "$expected_revision" ]; then
    failures+=("$arch=${actual_version:-missing}/r${actual_revision:-missing}")
  fi
done

if [ "${#failures[@]}" -ne 0 ]; then
  echo "Expected $SNAP_NAME $CHANNEL to point at $EXPECTED_VERSION amd64 r$EXPECTED_AMD64_REVISION and arm64 r$EXPECTED_ARM64_REVISION." >&2
  echo "Mismatched architectures: ${failures[*]}" >&2
  exit 1
fi

echo "$SNAP_NAME $CHANNEL points at $EXPECTED_VERSION amd64 r$EXPECTED_AMD64_REVISION and arm64 r$EXPECTED_ARM64_REVISION."
