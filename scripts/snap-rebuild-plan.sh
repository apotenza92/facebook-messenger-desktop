#!/usr/bin/env bash
set -euo pipefail

# Decides which published release lines need a Snap security rebuild.
#
# - prerelease: highest beta tag above the highest stable tag; rebuilt to
#   edge, then released to beta.
# - stable: highest stable tag; rebuilt to candidate. When no higher beta
#   exists it is also released to beta and edge so those channels are not left
#   on a stale prerelease. When the stable channel already carries this exact
#   version on both architectures (an approved promotion), the rebuild is also
#   released to stable (`refresh_stable`). A new version never reaches stable
#   here; that still needs an explicitly approved promotion.
#
# A line is rebuilt when any channel it manages does not carry the tag's
# version on both architectures, when a published revision has no readable
# package manifest, when a primed Ubuntu package has a newer archive
# candidate, or when FORCE is true. A line is skipped entirely if any of its
# channels already holds a higher version, so the store is never downgraded.
#
# Writes `targets` and `builds` JSON arrays and the `stable_refresh` target
# (JSON, or empty) to $GITHUB_OUTPUT (or stdout).
#
# Snap Store requests are bounded and retried with backoff: each attempt has a
# connect timeout, an overall time limit and a stall limit, so a transfer that
# hangs or a store error page is retried instead of failing the run or hanging
# it. A store that stays unreachable through every attempt still fails the run.
#
# A revision's manifest never changes, so manifests read from published snaps
# are kept in SNAP_MANIFEST_CACHE_DIR (when set) and each revision is only
# downloaded once.
#
# Test inputs: RELEASES_FILE, SNAP_INFO_FILE, SNAP_MANIFEST_DIR (manifests
# named <revision>.yaml) and SNAP_APT_CANDIDATES_FILE replace network and apt.
# SNAP_FETCH_ATTEMPTS and SNAP_FETCH_RETRY_SECONDS shorten the retries.

SNAP_NAME="${SNAP_NAME:?SNAP_NAME is required}"
LINEAGE="${LINEAGE:-all}"
FORCE="${FORCE:-false}"
FETCH_ATTEMPTS="${SNAP_FETCH_ATTEMPTS:-5}"
FETCH_RETRY_SECONDS="${SNAP_FETCH_RETRY_SECONDS:-15}"
MANIFEST_CACHE_DIR="${SNAP_MANIFEST_CACHE_DIR:-}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

case "$LINEAGE" in all | prerelease | stable) ;; *)
  echo "Unknown lineage: $LINEAGE" >&2
  exit 1
  ;;
esac
case "$FORCE" in true | false) ;; *)
  echo "FORCE must be true or false" >&2
  exit 1
  ;;
esac

# Downloads a Snap Store URL to a file, retrying with exponential backoff.
# Every curl failure is retried: the store and its CDN return transient 5xx
# responses, and stalled HTTP/2 transfers end with errors (such as curl exit
# 92) that `curl --retry` does not retry.
store_fetch() {
  local max_seconds="$1" url="$2" destination="$3" attempt status delay
  # A published snap is ~180 MB and normally arrives in seconds; a transfer
  # slower than 1 MB/s for a minute is treated as stalled and retried.
  for ((attempt = 1; ; attempt++)); do
    status=0
    curl -fsSL \
      --connect-timeout 30 \
      --max-time "$max_seconds" \
      --speed-limit 1048576 --speed-time 60 \
      -H "Snap-Device-Series: 16" \
      -H "User-Agent: snapd/2.63" \
      -o "$destination" "$url" || status=$?
    if [ "$status" -eq 0 ]; then
      return 0
    fi
    rm -f "$destination"
    if [ "$attempt" -ge "$FETCH_ATTEMPTS" ]; then
      echo "::error::Snap Store request to ${url%%\?*} failed after $attempt attempts (last curl exit $status)." >&2
      return "$status"
    fi
    delay=$((FETCH_RETRY_SECONDS * (1 << (attempt - 1))))
    echo "Snap Store request to ${url%%\?*} failed (curl exit $status); retry $attempt/$((FETCH_ATTEMPTS - 1)) in ${delay}s." >&2
    sleep "$delay"
  done
}

if [ -n "${RELEASES_FILE:-}" ]; then
  releases="$(<"$RELEASES_FILE")"
else
  releases="$(gh api --paginate "repos/${GITHUB_REPOSITORY:?}/releases?per_page=100" | jq -s 'add')"
fi
jq -e 'type == "array"' <<<"$releases" >/dev/null

if [ -n "${SNAP_INFO_FILE:-}" ]; then
  info="$(<"$SNAP_INFO_FILE")"
else
  store_fetch 60 "https://api.snapcraft.io/v2/snaps/info/${SNAP_NAME}?fields=download,revision,version" \
    "$WORK_DIR/info.json"
  info="$(<"$WORK_DIR/info.json")"
fi
jq -e '."channel-map" | type == "array"' <<<"$info" >/dev/null

# Orders x.y.z and x.y.z-beta.N; a final release sorts after its betas.
# Anything else sorts above every release so it is never overwritten.
JQ_VERSION_KEY='def version_key:
  (capture("^(?<major>[0-9]+)\\.(?<minor>[0-9]+)\\.(?<patch>[0-9]+)(-beta\\.(?<beta>[1-9][0-9]*))?$")
   | [(.major | tonumber), (.minor | tonumber), (.patch | tonumber), (.beta // "1e9" | tonumber)])
  // [1e9];'

highest_tag() {
  jq -r --argjson prerelease "$1" --arg pattern "$2" "$JQ_VERSION_KEY"'
    [.[] | select(.draft == false and .prerelease == $prerelease and (.tag_name | test($pattern)))]
    | max_by(.tag_name | ltrimstr("v") | version_key) // empty | .tag_name
  ' <<<"$releases"
}

version_above() {
  jq -n -e --arg left "$1" --arg right "$2" "$JQ_VERSION_KEY"'($left | version_key) > ($right | version_key)' >/dev/null
}

channel_field() {
  local risk="$1" arch="$2" field="$3"
  jq -r --arg risk "$risk" --arg arch "$arch" --arg field "$field" '
    [."channel-map"[] | select(.channel.track == "latest" and .channel.risk == $risk and .channel.architecture == $arch)]
    | first // empty | if $field == "url" then .download.url else .[$field] end
  ' <<<"$info"
}

# Fetches a published revision's snap/manifest.yaml; fails if it has none.
published_manifest() {
  local revision="$1" url="$2" destination="$3"
  if [ -n "${SNAP_MANIFEST_DIR:-}" ]; then
    cp "$SNAP_MANIFEST_DIR/$revision.yaml" "$destination" 2>/dev/null
    return
  fi
  if [ -n "$MANIFEST_CACHE_DIR" ] && [ -s "$MANIFEST_CACHE_DIR/$revision.yaml" ]; then
    echo "Using cached manifest for r$revision." >&2
    cp "$MANIFEST_CACHE_DIR/$revision.yaml" "$destination"
    return
  fi
  # A failed download is an error, not a missing manifest.
  store_fetch 300 "$url" "$WORK_DIR/published.snap" || exit 1
  local status=0
  unsquashfs -cat "$WORK_DIR/published.snap" snap/manifest.yaml >"$destination" 2>/dev/null || status=$?
  rm -f "$WORK_DIR/published.snap"
  # Only a manifest that was read is cached; a missing one is checked again.
  if [ "$status" -eq 0 ] && [ -n "$MANIFEST_CACHE_DIR" ]; then
    mkdir -p "$MANIFEST_CACHE_DIR"
    cp "$destination" "$MANIFEST_CACHE_DIR/$revision.yaml"
  fi
  return "$status"
}

targets="[]"

plan_target() {
  local lineage="$1" tag="$2" upload_channel="$3" release_to="$4" refresh_stable="${5:-false}"
  local version="${tag#v}" channels="$upload_channel${release_to:+ $release_to}"
  if [ "$refresh_stable" = true ]; then
    channels="$channels stable"
  fi
  local reasons=() channel arch revision published_version stale manifest

  for channel in $channels; do
    for arch in amd64 arm64; do
      published_version="$(channel_field "$channel" "$arch" version)"
      if [ -n "$published_version" ] && version_above "$published_version" "$version"; then
        echo "$lineage $tag: skipped; $arch $channel already has newer $published_version." >&2
        return
      fi
    done
  done

  for channel in $channels; do
    for arch in amd64 arm64; do
      revision="$(channel_field "$channel" "$arch" revision)"
      published_version="$(channel_field "$channel" "$arch" version)"
      if [ -z "$revision" ]; then
        reasons+=("$arch $channel is empty")
        continue
      fi
      if [ "$published_version" != "$version" ]; then
        reasons+=("$arch $channel is $published_version (r$revision), not $version")
        continue
      fi
      # Edge and beta usually share a revision; fetch each manifest once.
      manifest="$WORK_DIR/$revision.yaml"
      if [ ! -f "$manifest" ] &&
        ! published_manifest "$revision" "$(channel_field "$channel" "$arch" url)" "$manifest"; then
        rm -f "$manifest"
        reasons+=("$arch $channel r$revision has no package manifest")
        continue
      fi
      if ! stale="$("$ROOT_DIR/scripts/snap-stale-packages.sh" "$manifest")"; then
        reasons+=("$arch $channel r$revision has no readable package manifest")
        continue
      fi
      if [ -n "$stale" ]; then
        reasons+=("$arch $channel r$revision has $(wc -l <<<"$stale" | tr -d ' ') outdated packages")
        echo "Outdated packages in $arch $channel r$revision:" >&2
        echo "$stale" >&2
      fi
    done
  done

  if [ "$FORCE" = true ]; then
    reasons+=("forced")
  fi
  if [ "${#reasons[@]}" -eq 0 ]; then
    echo "$lineage $tag: $channels is current; no rebuild needed." >&2
    return
  fi

  local reason
  reason="$(printf '%s; ' "${reasons[@]}")"
  reason="${reason%; }"
  echo "$lineage $tag: rebuild to $upload_channel (${reason})." >&2

  targets="$(jq -c \
    --arg lineage "$lineage" \
    --arg tag "$tag" \
    --arg version "$version" \
    --arg upload_channel "$upload_channel" \
    --arg release_to "$release_to" \
    --arg reason "$reason" \
    --argjson refresh_stable "$refresh_stable" \
    --arg amd64_floor "$(channel_field "$upload_channel" amd64 revision)" \
    --arg arm64_floor "$(channel_field "$upload_channel" arm64 revision)" \
    '. + [{lineage: $lineage, tag: $tag, version: $version, upload_channel: $upload_channel,
           release_to: ($release_to | split(" ") | map(select(. != ""))), reason: $reason,
           refresh_stable: $refresh_stable,
           amd64_floor: ($amd64_floor | if . == "" then 0 else tonumber end),
           arm64_floor: ($arm64_floor | if . == "" then 0 else tonumber end)}]' \
    <<<"$targets")"
}

stable_tag="$(highest_tag false '^v[0-9]+\.[0-9]+\.[0-9]+$')"
beta_tag="$(highest_tag true '^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[1-9][0-9]*$')"

beta_is_newer=false
if [ -n "$beta_tag" ] && { [ -z "$stable_tag" ] || version_above "${beta_tag#v}" "${stable_tag#v}"; }; then
  beta_is_newer=true
fi

if [ "$LINEAGE" != stable ]; then
  if [ "$beta_is_newer" = true ]; then
    plan_target prerelease "$beta_tag" edge beta
  else
    echo "prerelease: no beta release above the latest stable release." >&2
  fi
fi

if [ "$LINEAGE" != prerelease ]; then
  if [ -z "$stable_tag" ]; then
    echo "stable: no stable release found." >&2
    exit 1
  fi
  # Stable is only refreshed with a rebuild of the version it already carries.
  refresh_stable=false
  if [ "$(channel_field stable amd64 version)" = "${stable_tag#v}" ] &&
    [ "$(channel_field stable arm64 version)" = "${stable_tag#v}" ]; then
    refresh_stable=true
  else
    echo "stable: channel does not carry ${stable_tag#v} on both architectures; promotion stays manual." >&2
  fi
  if [ "$beta_is_newer" = true ]; then
    plan_target stable "$stable_tag" candidate "" "$refresh_stable"
  else
    plan_target stable "$stable_tag" candidate "beta edge" "$refresh_stable"
  fi
fi

builds="$(jq -c '[.[] as $target | {arch: "amd64", runner: "ubuntu-24.04"}, {arch: "arm64", runner: "ubuntu-24.04-arm"}
  | . + {lineage: $target.lineage, tag: $target.tag, version: $target.version, upload_channel: $target.upload_channel}]' \
  <<<"$targets")"

stable_refresh="$(jq -c 'map(select(.refresh_stable)) | first // empty' <<<"$targets")"

output="${GITHUB_OUTPUT:-/dev/stdout}"
{
  echo "targets=$targets"
  echo "builds=$builds"
  echo "stable_refresh=$stable_refresh"
} >>"$output"
