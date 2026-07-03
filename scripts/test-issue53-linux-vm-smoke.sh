#!/usr/bin/env bash
set -euo pipefail

fail_patterns='FATAL:sandbox|Cannot find module|App threw an error during load|SingletonLock|Lock acquired: false|Another instance is already running|Messenger-Dev'
log_dir="${ISSUE53_SMOKE_LOG_DIR:-/tmp}"

usage() {
  cat <<'EOF'
Usage:
  test-issue53-linux-vm-smoke.sh appimage <AppImage>
  test-issue53-linux-vm-smoke.sh copy-repo <shared-repo> <work-dir>
  test-issue53-linux-vm-smoke.sh build-snap <work-dir> <output-dir>
  test-issue53-linux-vm-smoke.sh install-snap <snap-file>
  test-issue53-linux-vm-smoke.sh snap-launch
EOF
}

assert_no_issue53_crash() {
  local log_file="$1"
  if grep -Eiq "$fail_patterns" "$log_file"; then
    echo "Issue #53 launch failure detected:" >&2
    grep -Ein "$fail_patterns" "$log_file" >&2 || true
    exit 1
  fi
}

assert_expected_launch_markers() {
  local log_file="$1"

  grep -Fq "[App] Starting" "$log_file" || {
    echo "Launch did not reach the app entrypoint" >&2
    exit 1
  }

  grep -Fq "[SingleInstance] Lock acquired: true" "$log_file" || {
    echo "Launch did not acquire the single-instance lock" >&2
    exit 1
  }
}

run_with_timeout() {
  local log_file="$1"
  shift

  set +e
  timeout "${ISSUE53_SMOKE_TIMEOUT:-60s}" xvfb-run -a "$@" >"$log_file" 2>&1
  local code=$?
  set -e

  cat "$log_file"
  assert_no_issue53_crash "$log_file"
  assert_expected_launch_markers "$log_file"

  if [ "$code" -ne 0 ] && [ "$code" -ne 124 ]; then
    if grep -Fq "[App] App fully ready" "$log_file"; then
      echo "Launch reached app-ready before VM display failure; accepting smoke result"
      return
    fi

    echo "Launch command exited unexpectedly with code $code" >&2
    exit "$code"
  fi
}

appimage_smoke() {
  local appimage="$1"
  local absolute_appimage
  local log_name
  local extract_parent
  local extract_dir

  absolute_appimage="$(realpath "$appimage")"
  log_name="$(basename "$appimage" | tr -c '[:alnum:]._-' '_')"
  extract_parent="$(mktemp -d)"

  mkdir -p "$log_dir"
  chmod +x "$appimage"
  (
    cd "$extract_parent"
    "$absolute_appimage" --appimage-extract >/dev/null
  )
  extract_dir="$extract_parent/squashfs-root"
  test -x "$extract_dir/AppRun"
  run_with_timeout "$log_dir/issue53-appimage-${log_name}.log" env APPDIR="$extract_dir" "$extract_dir/AppRun"
  echo "AppImage smoke passed: $appimage"
}

detect_snap_build_for() {
  if [ -n "${SNAP_BUILD_FOR:-}" ]; then
    echo "$SNAP_BUILD_FOR"
    return
  fi

  case "$(uname -m)" in
    x86_64)
      echo amd64
      ;;
    aarch64|arm64)
      echo arm64
      ;;
    *)
      dpkg --print-architecture
      ;;
  esac
}

copy_repo() {
  local shared_repo="$1"
  local work_dir="$2"

  rm -rf "$work_dir"
  mkdir -p "$work_dir"
  rsync -a --delete \
    --exclude node_modules \
    --exclude dist \
    --exclude release \
    --exclude .git \
    "$shared_repo"/ "$work_dir"/
  echo "Copied repo to $work_dir"
}

build_snap() {
  local work_dir="$1"
  local output_dir="$2"

  mkdir -p "$output_dir"
  cd "$work_dir"
  if [ "$(id -u)" -eq 0 ]; then
    snapcraft pack --destructive-mode --build-for "$(detect_snap_build_for)"
  else
    sudo --preserve-env=SNAP_BUILD_FOR,FORCE_JAVASCRIPT_ACTIONS_TO_NODE24 \
      snapcraft pack --destructive-mode --build-for "$(detect_snap_build_for)"
  fi
  cp ./*.snap "$output_dir"/
  ls -lh "$output_dir"/*.snap
}

install_snap() {
  local snap_file="$1"

  snap remove facebook-messenger-desktop >/dev/null 2>&1 || true
  snap install --dangerous "$snap_file"
  echo "Installed snap: $snap_file"
}

snap_launch() {
  mkdir -p "$log_dir"
  run_with_timeout "$log_dir/issue53-snap.log" facebook-messenger-desktop
  echo "Snap launch smoke passed"
}

main() {
  local command="${1:-}"
  shift || true

  case "$command" in
    appimage)
      [ "$#" -eq 1 ] || { usage; exit 2; }
      appimage_smoke "$1"
      ;;
    copy-repo)
      [ "$#" -eq 2 ] || { usage; exit 2; }
      copy_repo "$1" "$2"
      ;;
    build-snap)
      [ "$#" -eq 2 ] || { usage; exit 2; }
      build_snap "$1" "$2"
      ;;
    install-snap)
      [ "$#" -eq 1 ] || { usage; exit 2; }
      install_snap "$1"
      ;;
    snap-launch)
      [ "$#" -eq 0 ] || { usage; exit 2; }
      snap_launch
      ;;
    *)
      usage
      exit 2
      ;;
  esac
}

main "$@"
