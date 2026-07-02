#!/usr/bin/env bash
set -euo pipefail

SNAP_NAME="${1:?Usage: verify-snap-channel-version.sh <snap-name> <channel> <version>}"
CHANNEL="${2:?Usage: verify-snap-channel-version.sh <snap-name> <channel> <version>}"
EXPECTED_VERSION="${3:?Usage: verify-snap-channel-version.sh <snap-name> <channel> <version>}"

if [ -n "${SNAP_STATUS_FILE:-}" ]; then
  STATUS_OUTPUT="$(<"$SNAP_STATUS_FILE")"
else
  STATUS_OUTPUT="$(snapcraft status "$SNAP_NAME")"
fi

missing_arches=()

for arch in amd64 arm64; do
  version="$(awk -v arch="$arch" -v channel="$CHANNEL" 'NR > 1 && $2 == arch && $3 == channel {print $4; exit}' <<<"$STATUS_OUTPUT")"

  if [ "$version" != "$EXPECTED_VERSION" ]; then
    missing_arches+=("$arch=${version:-missing}")
  fi
done

if [ "${#missing_arches[@]}" -ne 0 ]; then
  echo "Expected $SNAP_NAME $CHANNEL to point at $EXPECTED_VERSION for amd64 and arm64." >&2
  echo "Mismatched architectures: ${missing_arches[*]}" >&2
  echo "$STATUS_OUTPUT" >&2
  exit 1
fi

echo "$SNAP_NAME $CHANNEL points at $EXPECTED_VERSION for amd64 and arm64."
