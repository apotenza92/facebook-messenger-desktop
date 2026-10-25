#!/usr/bin/env bash
set -euo pipefail

# Lists primed Ubuntu packages in a snap manifest whose archive candidate has
# changed since the snap was built. Any output means a rebuild would pull in
# newer packages, which is what the Snap Store security scan reports on.

MANIFEST="${1:?Usage: snap-stale-packages.sh <snap/manifest.yaml>}"

candidate_version() {
  local package="$1"
  if [ -n "${SNAP_APT_CANDIDATES_FILE:-}" ]; then
    awk -v package="$package" '$1 == package { print $2; exit }' "$SNAP_APT_CANDIDATES_FILE"
  else
    apt-cache policy "$package" 2>/dev/null | awk '/^  Candidate:/ { print $2; exit }'
  fi
}

entries="$(awk '
  /^primed-stage-packages:/ { in_list = 1; next }
  in_list && /^- / { sub(/^- /, ""); gsub(/["'\'']/, ""); print; next }
  in_list { exit }
' "$MANIFEST")"

if [ -z "$entries" ]; then
  echo "No primed-stage-packages found in $MANIFEST" >&2
  exit 1
fi

while IFS= read -r entry; do
  package="${entry%%=*}"
  built_version="${entry#*=}"
  package="${package%%:*}"
  if [ "$package" = "$entry" ] || [ -z "$built_version" ]; then
    echo "Malformed manifest package entry: $entry" >&2
    exit 1
  fi

  candidate="$(candidate_version "$package")"
  if [ -z "$candidate" ] || [ "$candidate" = "(none)" ]; then
    echo "Skipping $package: no archive candidate" >&2
    continue
  fi
  if [ "$candidate" = "$built_version" ]; then
    continue
  fi
  # Only a newer candidate matters; a lagging mirror must not cause churn.
  # Without dpkg (local tests on macOS) any difference counts.
  if command -v dpkg >/dev/null && ! dpkg --compare-versions "$candidate" gt "$built_version"; then
    continue
  fi
  echo "$package $built_version -> $candidate"
done <<<"$entries"
