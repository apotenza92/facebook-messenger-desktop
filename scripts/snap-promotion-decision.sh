#!/usr/bin/env bash
set -euo pipefail

SNAP_NAME="${SNAP_NAME:-facebook-messenger-desktop}"

if [ -n "${SNAP_STATUS_FILE:-}" ]; then
  STATUS_OUTPUT="$(<"$SNAP_STATUS_FILE")"
else
  STATUS_OUTPUT="$(snapcraft status "$SNAP_NAME")"
fi

is_prerelease() {
  [[ "$1" == *"alpha"* ]] || [[ "$1" == *"beta"* ]] || [[ "$1" == *"rc"* ]]
}

has_tag() {
  local version="$1"

  if [ -n "${SNAP_PROMOTION_TEST_TAGS:-}" ]; then
    [[ " ${SNAP_PROMOTION_TEST_TAGS} " == *" v${version} "* ]]
    return
  fi

  git rev-parse "v${version}" >/dev/null 2>&1
}

channel_rows() {
  local channel="$1"
  awk -v channel="$channel" 'NR > 1 && $3 == channel {print $2 "\t" $4 "\t" $5}' <<<"$STATUS_OUTPUT"
}

channel_versions() {
  local channel="$1"
  channel_rows "$channel" | awk '$2 != "-" && $2 != "↑" {print $2}' | sort -u
}

channel_arch_versions() {
  local channel="$1"
  channel_rows "$channel" | awk '$2 != "-" && $2 != "↑" {print $1 "=" $2}' | paste -sd "," -
}

single_channel_version() {
  local channel="$1"
  local versions count

  versions="$(channel_versions "$channel")"
  count="$(wc -l <<<"$versions" | tr -d ' ')"

  if [ -z "$versions" ] || [ "$count" -ne 1 ]; then
    return 1
  fi

  printf '%s\n' "$versions"
}

all_channel_arches_match_version() {
  local channel="$1"
  local version="$2"

  [ -n "$(channel_rows "$channel")" ] &&
    ! channel_rows "$channel" | awk -v version="$version" '$2 != version {found = 1} END {exit found ? 0 : 1}'
}

PROMOTE_BETA=false
PROMOTE_STABLE=false
PROMOTE_STABLE_FROM_BETA=false
BETA_VERSION=""

EDGE_VERSION="$(single_channel_version edge || true)"
BETA_VERSION="$(single_channel_version beta || true)"
STABLE_VERSION="$(single_channel_version stable || true)"

echo "Detected architecture versions:"
echo "  Edge:   $(channel_arch_versions edge)"
echo "  Beta:   $(channel_arch_versions beta)"
echo "  Stable: $(channel_arch_versions stable)"

if [ -n "$EDGE_VERSION" ] && has_tag "$EDGE_VERSION"; then
  echo "Edge version $EDGE_VERSION is consistent across architectures and has a git tag"

  if is_prerelease "$EDGE_VERSION"; then
    if ! all_channel_arches_match_version beta "$EDGE_VERSION"; then
      PROMOTE_BETA=true
      echo "Will promote $EDGE_VERSION from edge to beta (prerelease)"
    fi
  else
    if ! all_channel_arches_match_version beta "$EDGE_VERSION"; then
      PROMOTE_BETA=true
      echo "Will promote $EDGE_VERSION from edge to beta (stable release)"
    fi
    if ! all_channel_arches_match_version stable "$EDGE_VERSION"; then
      PROMOTE_STABLE=true
      echo "Will promote $EDGE_VERSION from edge to stable"
    fi
  fi
else
  echo "Edge channel is empty, mixed, or missing a git tag; skipping edge promotions"
fi

if [ "$PROMOTE_STABLE" = false ] && [ -n "$BETA_VERSION" ] && has_tag "$BETA_VERSION" && ! is_prerelease "$BETA_VERSION"; then
  if ! all_channel_arches_match_version stable "$BETA_VERSION"; then
    PROMOTE_STABLE_FROM_BETA=true
    echo "Will promote $BETA_VERSION from beta to stable (stable release in beta channel)"
  fi
fi

{
  echo "promote_beta=$PROMOTE_BETA"
  echo "promote_stable=$PROMOTE_STABLE"
  echo "promote_stable_from_beta=$PROMOTE_STABLE_FROM_BETA"
  echo "edge_version=$EDGE_VERSION"
  echo "beta_version=$BETA_VERSION"
  echo "stable_version=$STABLE_VERSION"
} >>"${GITHUB_OUTPUT:-/dev/stdout}"

if [ "$PROMOTE_BETA" = false ] && [ "$PROMOTE_STABLE" = false ] && [ "$PROMOTE_STABLE_FROM_BETA" = false ]; then
  echo "All safe promotions are up to date or waiting for matching architecture builds."
fi
