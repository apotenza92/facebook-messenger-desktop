#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

write_status() {
  local path="$1"
  shift
  {
    echo "Track    Arch    Channel    Version        Revision    Progress"
    printf '%s\n' "$@"
  } >"$path"
}

run_case() {
  local name="$1"
  local fixture="$2"
  local output="$TMP_DIR/${name}.out"
  local log="$TMP_DIR/${name}.log"

  SNAP_STATUS_FILE="$fixture" \
    SNAP_PROMOTION_TEST_TAGS="v1.3.0 v1.3.1 v1.3.1-beta.13 v1.3.1-beta.14 v1.3.1-beta.15" \
    GITHUB_OUTPUT="$output" \
    "$ROOT_DIR/scripts/snap-promotion-decision.sh" >"$log"

  echo "$output"
}

assert_output() {
  local output="$1"
  local key="$2"
  local expected="$3"
  local actual

  actual="$(awk -F= -v key="$key" '$1 == key {print $2}' "$output")"
  if [ "$actual" != "$expected" ]; then
    echo "Expected $key=$expected, got $actual" >&2
    echo "Full output:" >&2
    cat "$output" >&2
    exit 1
  fi
}

mixed_edge="$TMP_DIR/mixed-edge.status"
write_status "$mixed_edge" \
  "latest   amd64   stable     1.3.0          266         -" \
  "latest   amd64   candidate  ↑              ↑           -" \
  "latest   amd64   beta       1.3.1-beta.14  303         -" \
  "latest   amd64   edge       1.3.1-beta.15  305         -" \
  "latest   arm64   stable     1.3.0          267         -" \
  "latest   arm64   candidate  ↑              ↑           -" \
  "latest   arm64   beta       1.3.1-beta.13  302         -" \
  "latest   arm64   edge       1.3.1-beta.13  302         -"
out="$(run_case mixed-edge "$mixed_edge")"
assert_output "$out" promote_beta false
assert_output "$out" promote_stable false
assert_output "$out" promote_stable_from_beta false
assert_output "$out" rescue_arm64_edge true
assert_output "$out" edge_version ""
assert_output "$out" rescue_version "1.3.1-beta.15"

synced_prerelease="$TMP_DIR/synced-prerelease.status"
write_status "$synced_prerelease" \
  "latest   amd64   stable     1.3.0          266         -" \
  "latest   amd64   candidate  ↑              ↑           -" \
  "latest   amd64   beta       1.3.1-beta.14  303         -" \
  "latest   amd64   edge       1.3.1-beta.15  305         -" \
  "latest   arm64   stable     1.3.0          267         -" \
  "latest   arm64   candidate  ↑              ↑           -" \
  "latest   arm64   beta       1.3.1-beta.13  302         -" \
  "latest   arm64   edge       1.3.1-beta.15  306         -"
out="$(run_case synced-prerelease "$synced_prerelease")"
assert_output "$out" promote_beta true
assert_output "$out" promote_stable false
assert_output "$out" promote_stable_from_beta false
assert_output "$out" rescue_arm64_edge false
assert_output "$out" edge_version "1.3.1-beta.15"
assert_output "$out" rescue_version ""

synced_stable="$TMP_DIR/synced-stable.status"
write_status "$synced_stable" \
  "latest   amd64   stable     1.3.0          266         -" \
  "latest   amd64   candidate  ↑              ↑           -" \
  "latest   amd64   beta       1.3.0          266         -" \
  "latest   amd64   edge       1.3.1          307         -" \
  "latest   arm64   stable     1.3.0          267         -" \
  "latest   arm64   candidate  ↑              ↑           -" \
  "latest   arm64   beta       1.3.0          267         -" \
  "latest   arm64   edge       1.3.1          308         -"
out="$(run_case synced-stable "$synced_stable")"
assert_output "$out" promote_beta true
assert_output "$out" promote_stable true
assert_output "$out" promote_stable_from_beta false
assert_output "$out" rescue_arm64_edge false
assert_output "$out" edge_version "1.3.1"
assert_output "$out" rescue_version ""

stable_from_beta="$TMP_DIR/stable-from-beta.status"
write_status "$stable_from_beta" \
  "latest   amd64   stable     1.3.0          266         -" \
  "latest   amd64   candidate  ↑              ↑           -" \
  "latest   amd64   beta       1.3.1          307         -" \
  "latest   amd64   edge       1.3.1-beta.15  305         -" \
  "latest   arm64   stable     1.3.0          267         -" \
  "latest   arm64   candidate  ↑              ↑           -" \
  "latest   arm64   beta       1.3.1          308         -" \
  "latest   arm64   edge       1.3.1-beta.13  302         -"
out="$(run_case stable-from-beta "$stable_from_beta")"
assert_output "$out" promote_beta false
assert_output "$out" promote_stable false
assert_output "$out" promote_stable_from_beta true
assert_output "$out" rescue_arm64_edge false
assert_output "$out" beta_version "1.3.1"
assert_output "$out" rescue_version ""

echo "snap promotion decision tests passed"
