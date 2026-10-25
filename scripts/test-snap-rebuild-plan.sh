#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

releases="$TMP_DIR/releases.json"
cat >"$releases" <<'EOF'
[
  {"tag_name": "v1.5.0-beta.2", "draft": false, "prerelease": true, "published_at": "2026-10-16T13:07:26Z"},
  {"tag_name": "v1.5.0-beta.3", "draft": true, "prerelease": true, "published_at": "2026-10-20T00:00:00Z"},
  {"tag_name": "v1.5.0-beta.1", "draft": false, "prerelease": true, "published_at": "2026-10-07T03:59:35Z"},
  {"tag_name": "v1.4.2", "draft": false, "prerelease": false, "published_at": "2026-08-11T06:34:19Z"},
  {"tag_name": "v1.4.0", "draft": false, "prerelease": false, "published_at": "2026-08-01T15:21:39Z"}
]
EOF

channel() {
  printf '{"channel":{"track":"latest","risk":"%s","architecture":"%s"},"revision":%s,"version":"%s","download":{"url":"https://example.invalid/%s.snap"}}' \
    "$1" "$2" "$3" "$4" "$3"
}

info="$TMP_DIR/info.json"
write_info() {
  local entries
  entries="$(IFS=,; echo "$*")"
  printf '{"channel-map":[%s]}' "$entries" >"$info"
}

manifests="$TMP_DIR/manifests"
mkdir -p "$manifests"
for revision in 500 501 600 601; do
  printf 'primed-stage-packages:\n- libnss3=2:3.98-1ubuntu0.3\n' >"$manifests/$revision.yaml"
done
printf 'primed-stage-packages:\n- libnss3=2:3.98-1ubuntu0.2\n' >"$manifests/501.yaml"

candidates="$TMP_DIR/candidates.txt"
printf 'libnss3 2:3.98-1ubuntu0.3\n' >"$candidates"

plan() {
  : >"$TMP_DIR/output"
  GITHUB_OUTPUT="$TMP_DIR/output" \
    SNAP_NAME=facebook-messenger-desktop \
    RELEASES_FILE="${RELEASES_FILE_OVERRIDE:-$releases}" \
    SNAP_INFO_FILE="$info" \
    SNAP_MANIFEST_DIR="$manifests" \
    SNAP_APT_CANDIDATES_FILE="$candidates" \
    "$ROOT_DIR/scripts/snap-rebuild-plan.sh" 2>"$TMP_DIR/stderr" || return
  targets="$(sed -n 's/^targets=//p' "$TMP_DIR/output")"
  builds="$(sed -n 's/^builds=//p' "$TMP_DIR/output")"
}

# Store state as of this change: beta lags the newest beta tag and candidate is empty.
write_info \
  "$(channel stable amd64 266 1.3.0)" "$(channel stable arm64 267 1.3.0)" \
  "$(channel beta amd64 424 1.3.1-beta.45)" "$(channel beta arm64 425 1.3.1-beta.45)" \
  "$(channel edge amd64 455 1.4.2)" "$(channel edge arm64 454 1.4.2)"
plan
test "$(jq -r 'map(.tag) | join(",")' <<<"$targets")" = "v1.5.0-beta.2,v1.4.2"
test "$(jq -c '.[0] | [.upload_channel, .release_to, .amd64_floor, .arm64_floor]' <<<"$targets")" = '["edge",["beta"],455,454]'
test "$(jq -c '.[1] | [.upload_channel, .release_to, .amd64_floor, .arm64_floor]' <<<"$targets")" = '["candidate",[],0,0]'
grep -F "amd64 beta is 1.3.1-beta.45 (r424), not 1.5.0-beta.2" "$TMP_DIR/stderr"
grep -F "amd64 candidate is empty" "$TMP_DIR/stderr"
test "$(jq length <<<"$builds")" = 4
test "$(jq -r '[.[] | "\(.tag)/\(.arch)/\(.runner)"] | join(",")' <<<"$builds")" = \
  "v1.5.0-beta.2/amd64/ubuntu-24.04,v1.5.0-beta.2/arm64/ubuntu-24.04-arm,v1.4.2/amd64/ubuntu-24.04,v1.4.2/arm64/ubuntu-24.04-arm"
if jq -e '.[] | select(.upload_channel == "stable" or (.release_to | index("stable")))' <<<"$targets" >/dev/null; then
  echo "The rebuild plan must never target stable" >&2
  exit 1
fi

# Matching versions: only the line with an outdated primed package is rebuilt.
write_info \
  "$(channel beta amd64 500 1.5.0-beta.2)" "$(channel beta arm64 501 1.5.0-beta.2)" \
  "$(channel edge amd64 500 1.5.0-beta.2)" "$(channel edge arm64 501 1.5.0-beta.2)" \
  "$(channel candidate amd64 600 1.4.2)" "$(channel candidate arm64 601 1.4.2)"
plan
test "$(jq -r 'map(.tag) | join(",")' <<<"$targets")" = "v1.5.0-beta.2"
grep -F "arm64 beta r501 has 1 outdated packages" "$TMP_DIR/stderr"
grep -F "libnss3 2:3.98-1ubuntu0.2 -> 2:3.98-1ubuntu0.3" "$TMP_DIR/stderr"
grep -F "stable v1.4.2: candidate is current; no rebuild needed." "$TMP_DIR/stderr"

# An edge revision on another version also triggers the prerelease line.
printf 'primed-stage-packages:\n- libnss3=2:3.98-1ubuntu0.3\n' >"$manifests/501.yaml"
write_info \
  "$(channel beta amd64 500 1.5.0-beta.2)" "$(channel beta arm64 501 1.5.0-beta.2)" \
  "$(channel edge amd64 455 1.4.2)" "$(channel edge arm64 501 1.5.0-beta.2)" \
  "$(channel candidate amd64 600 1.4.2)" "$(channel candidate arm64 601 1.4.2)"
plan
test "$(jq -r 'map("\(.tag) \(.reason)") | join(",")' <<<"$targets")" = "v1.5.0-beta.2 amd64 edge is 1.4.2 (r455), not 1.5.0-beta.2"
write_info \
  "$(channel beta amd64 500 1.5.0-beta.2)" "$(channel beta arm64 501 1.5.0-beta.2)" \
  "$(channel edge amd64 500 1.5.0-beta.2)" "$(channel edge arm64 501 1.5.0-beta.2)" \
  "$(channel candidate amd64 600 1.4.2)" "$(channel candidate arm64 601 1.4.2)"

# Everything current: nothing to build.
plan
test "$targets" = "[]"
test "$builds" = "[]"

# A stale package only in an edge-only revision still triggers a rebuild.
printf 'primed-stage-packages:\n- libnss3=2:3.98-1ubuntu0.2\n' >"$manifests/502.yaml"
write_info \
  "$(channel beta amd64 500 1.5.0-beta.2)" "$(channel beta arm64 501 1.5.0-beta.2)" \
  "$(channel edge amd64 502 1.5.0-beta.2)" "$(channel edge arm64 501 1.5.0-beta.2)" \
  "$(channel candidate amd64 600 1.4.2)" "$(channel candidate arm64 601 1.4.2)"
plan
test "$(jq -r 'map("\(.tag) \(.reason)") | join(",")' <<<"$targets")" = "v1.5.0-beta.2 amd64 edge r502 has 1 outdated packages"

# A published revision without a package manifest is rebuilt, not a failure.
write_info \
  "$(channel beta amd64 500 1.5.0-beta.2)" "$(channel beta arm64 503 1.5.0-beta.2)" \
  "$(channel edge amd64 500 1.5.0-beta.2)" "$(channel edge arm64 503 1.5.0-beta.2)" \
  "$(channel candidate amd64 600 1.4.2)" "$(channel candidate arm64 601 1.4.2)"
plan
test "$(jq -r 'map("\(.tag) \(.reason)") | join(",")' <<<"$targets")" = "v1.5.0-beta.2 arm64 edge r503 has no package manifest; arm64 beta r503 has no package manifest"

# The store already ahead of the tag: never downgrade that line.
write_info \
  "$(channel beta amd64 500 1.5.0-beta.2)" "$(channel beta arm64 501 1.5.0-beta.2)" \
  "$(channel edge amd64 700 1.5.0-beta.3)" "$(channel edge arm64 701 1.5.0-beta.3)" \
  "$(channel candidate amd64 600 1.4.2)" "$(channel candidate arm64 601 1.4.2)"
FORCE=true plan
test "$(jq -r 'map(.tag) | join(",")' <<<"$targets")" = "v1.4.2"
grep -F "prerelease v1.5.0-beta.2: skipped; amd64 edge already has newer 1.5.0-beta.3." "$TMP_DIR/stderr"
write_info \
  "$(channel beta amd64 500 1.5.0-beta.2)" "$(channel beta arm64 501 1.5.0-beta.2)" \
  "$(channel edge amd64 500 1.5.0-beta.2)" "$(channel edge arm64 501 1.5.0-beta.2)" \
  "$(channel candidate amd64 600 1.4.2)" "$(channel candidate arm64 601 1.4.2)"

# Tags are ordered by version, not publish date: a later 1.4.3 hotfix does
# not displace the 1.5.0 beta line, and the newest-dated beta is not assumed.
jq '. + [{"tag_name": "v1.4.3", "draft": false, "prerelease": false, "published_at": "2026-10-25T00:00:00Z"},
         {"tag_name": "v1.4.1-beta.9", "draft": false, "prerelease": true, "published_at": "2026-10-26T00:00:00Z"}]' \
  "$releases" >"$TMP_DIR/releases-hotfix.json"
RELEASES_FILE_OVERRIDE="$TMP_DIR/releases-hotfix.json" FORCE=true plan
test "$(jq -c 'map([.tag, .release_to])' <<<"$targets")" = '[["v1.5.0-beta.2",["beta"]],["v1.4.3",[]]]'

# FORCE and LINEAGE narrow or widen the plan.
FORCE=true LINEAGE=stable plan
test "$(jq -r 'map("\(.tag) \(.reason)") | join(",")' <<<"$targets")" = "v1.4.2 forced"

# A stable release newer than every beta also refreshes beta and edge.
jq '. + [{"tag_name": "v1.5.0", "draft": false, "prerelease": false, "published_at": "2026-10-30T00:00:00Z"}]' \
  "$releases" >"$TMP_DIR/releases-stable.json"
mv "$TMP_DIR/releases-stable.json" "$releases"
plan
grep -F "prerelease: no beta release above the latest stable release." "$TMP_DIR/stderr"
test "$(jq -c 'map([.tag, .upload_channel, .release_to])' <<<"$targets")" = '[["v1.5.0","candidate",["beta","edge"]]]'
grep -F "amd64 beta is 1.5.0-beta.2 (r500), not 1.5.0" "$TMP_DIR/stderr"

if LINEAGE=nightly plan 2>/dev/null; then
  echo "Expected an unknown lineage to fail" >&2
  exit 1
fi

# Missing stable release or malformed input fails loudly instead of planning nothing.
jq '[.[] | select(.prerelease)]' "$releases" >"$TMP_DIR/releases-beta-only.json"
if RELEASES_FILE_OVERRIDE="$TMP_DIR/releases-beta-only.json" plan; then
  echo "Expected a missing stable release to fail" >&2
  exit 1
fi
grep -F "stable: no stable release found." "$TMP_DIR/stderr"
RELEASES_FILE_OVERRIDE="$TMP_DIR/releases-beta-only.json" LINEAGE=prerelease plan
printf '{"message": "Bad credentials"}' >"$TMP_DIR/releases-error.json"
if RELEASES_FILE_OVERRIDE="$TMP_DIR/releases-error.json" plan; then
  echo "Expected malformed releases to fail" >&2
  exit 1
fi

echo "snap rebuild plan tests passed"
