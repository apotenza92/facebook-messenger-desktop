#!/usr/bin/env bash
set -euo pipefail

VM_NAME="${1:-Ubuntu 24.04.3 ARM64}"
OUT_DIR="${2:-release/ubuntu-capture-check}"
COUNT="${COUNT:-10}"
DELAY_SECONDS="${DELAY_SECONDS:-1}"
SETTLE_SECONDS="${SETTLE_SECONDS:-5}"
BLACK_SIZE_THRESHOLD_BYTES="${BLACK_SIZE_THRESHOLD_BYTES:-20000}"

mkdir -p "${OUT_DIR}"

echo "[verify-capture] VM: ${VM_NAME}"
echo "[verify-capture] Output dir: ${OUT_DIR}"
echo "[verify-capture] Count=${COUNT}, Delay=${DELAY_SECONDS}s, Settle=${SETTLE_SECONDS}s"
echo "[verify-capture] Black threshold: < ${BLACK_SIZE_THRESHOLD_BYTES} bytes"

prlctl status "${VM_NAME}" >/dev/null

session_list="$(prlctl exec "${VM_NAME}" "loginctl list-sessions --no-legend")"
SESSION_ID="$(printf '%s\n' "${session_list}" | awk '$3=="parallels" {print $1; exit}')"
if [[ -z "${SESSION_ID}" ]]; then
  echo "[verify-capture] ERROR: could not find active session for user 'parallels'" >&2
  exit 1
fi

SESSION_TYPE="$(prlctl exec "${VM_NAME}" "loginctl show-session ${SESSION_ID} -p Type --value")"
LOCKED_HINT="$(prlctl exec "${VM_NAME}" "loginctl show-session ${SESSION_ID} -p LockedHint --value")"
echo "[verify-capture] Session ${SESSION_ID}: type=${SESSION_TYPE}, locked=${LOCKED_HINT}"

prlctl exec "${VM_NAME}" "loginctl unlock-session ${SESSION_ID}" >/dev/null || true
prlctl exec "${VM_NAME}" "sudo -u parallels env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus gdbus call --session --dest org.gnome.ScreenSaver --object-path /org/gnome/ScreenSaver --method org.gnome.ScreenSaver.SetActive false" >/dev/null || true

echo "[verify-capture] Waiting ${SETTLE_SECONDS}s for compositor settle..."
sleep "${SETTLE_SECONDS}"

black_count=0

for i in $(seq -w 1 "${COUNT}"); do
  file="${OUT_DIR}/capture-${i}.png"
  prlctl capture "${VM_NAME}" --file "${file}" >/dev/null
  size="$(stat -f%z "${file}")"

  if (( size < BLACK_SIZE_THRESHOLD_BYTES )); then
    echo "${i} ${size} BLACK_LIKELY ${file}"
    black_count=$((black_count + 1))
  else
    echo "${i} ${size} OK ${file}"
  fi

  sleep "${DELAY_SECONDS}"
done

echo "[verify-capture] Completed. likely-black=${black_count}/${COUNT}"
echo "[verify-capture] Session type used: ${SESSION_TYPE}"

if (( black_count > 0 )); then
  exit 2
fi
