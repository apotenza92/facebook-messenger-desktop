#!/usr/bin/env bash
set -euo pipefail

# Waits until a channel carries a version on both architectures at revisions
# above the given floors (the revisions held before the rebuild), then writes
# amd64_revision and arm64_revision to $GITHUB_OUTPUT (or stdout).
#
# Test inputs: SNAP_INFO_FILE replaces the store, WAIT_ATTEMPTS and
# WAIT_SECONDS shorten the wait.

USAGE="Usage: wait-snap-refreshed-revisions.sh <snap-name> <channel> <version> <amd64-floor> <arm64-floor>"
SNAP_NAME="${1:?$USAGE}"
CHANNEL="${2:?$USAGE}"
EXPECTED_VERSION="${3:?$USAGE}"
AMD64_FLOOR="${4:?$USAGE}"
ARM64_FLOOR="${5:?$USAGE}"
ATTEMPTS="${WAIT_ATTEMPTS:-60}"

for attempt in $(seq 1 "$ATTEMPTS"); do
  if [ -n "${SNAP_INFO_FILE:-}" ]; then
    info="$(<"$SNAP_INFO_FILE")"
  else
    info="$(curl -fsSL \
      -H "Snap-Device-Series: 16" \
      -H "User-Agent: snapd/2.63" \
      "https://api.snapcraft.io/v2/snaps/info/${SNAP_NAME}" || true)"
  fi
  if [ -z "$info" ]; then
    info='{"channel-map":[]}'
  fi

  revision() {
    jq -r --arg risk "$CHANNEL" --arg arch "$1" --arg version "$EXPECTED_VERSION" \
      '[."channel-map"[] | select(.channel.track == "latest" and .channel.risk == $risk and .channel.architecture == $arch and .version == $version) | .revision] | first // empty' \
      <<<"$info" 2>/dev/null || true
  }
  amd64_revision="$(revision amd64)"
  arm64_revision="$(revision arm64)"

  echo "Attempt $attempt/$ATTEMPTS: $CHANNEL amd64=r${amd64_revision:-missing}, arm64=r${arm64_revision:-missing}" >&2

  if [[ "$amd64_revision" =~ ^[0-9]+$ ]] &&
    [[ "$arm64_revision" =~ ^[0-9]+$ ]] &&
    [ "$amd64_revision" -gt "$AMD64_FLOOR" ] &&
    [ "$arm64_revision" -gt "$ARM64_FLOOR" ]; then
    {
      echo "amd64_revision=$amd64_revision"
      echo "arm64_revision=$arm64_revision"
    } >>"${GITHUB_OUTPUT:-/dev/stdout}"
    exit 0
  fi

  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep "${WAIT_SECONDS:-15}"
  fi
done

echo "Timed out waiting for refreshed $CHANNEL $EXPECTED_VERSION revisions on both architectures." >&2
exit 1
