#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${1:-call-test}"
ATTACH_MODE="${2:-attach}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEEPALIVE_SECONDS="${OP_KEEPALIVE_SECONDS:-1200}"

if tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
  if [[ "${ATTACH_MODE}" == "--no-attach" ]]; then
    echo "tmux session '${SESSION_NAME}' already exists."
    exit 0
  fi
  echo "tmux session '${SESSION_NAME}' already exists. Attaching..."
  exec tmux attach -t "${SESSION_NAME}"
fi

tmux new-session -d -s "${SESSION_NAME}" -n auth -c "${ROOT_DIR}"
tmux send-keys -t "${SESSION_NAME}:auth" "echo '[auth] Run once in this pane: op signin'" C-m
tmux send-keys -t "${SESSION_NAME}:auth" "echo '[auth] Verify: op whoami'" C-m
tmux send-keys -t "${SESSION_NAME}:auth" "echo '[auth] Item check: op signin >/dev/null && op item get \"Dad Facebook\" --format json >/dev/null && echo ok'" C-m

tmux new-window -t "${SESSION_NAME}" -n keepalive -c "${ROOT_DIR}"
tmux send-keys -t "${SESSION_NAME}:keepalive" "echo '[keepalive] Re-signing/checking every ${KEEPALIVE_SECONDS}s (app integration)'" C-m
tmux send-keys -t "${SESSION_NAME}:keepalive" "while true; do if op signin >/dev/null 2>&1 && op whoami >/dev/null 2>&1; then echo \"[\$(date +%H:%M:%S)] op ok\"; else echo \"[\$(date +%H:%M:%S)] op not signed in\"; fi; sleep ${KEEPALIVE_SECONDS}; done" C-m

tmux new-window -t "${SESSION_NAME}" -n runner -c "${ROOT_DIR}"
tmux send-keys -t "${SESSION_NAME}:runner" "echo '[runner] Example:'" C-m
tmux send-keys -t "${SESSION_NAME}:runner" "echo 'op signin >/dev/null && MICHAEL_PROFILE_DIR=\"$ROOT_DIR/.tmp/playwright-michael-profile\" OP_FACEBOOK_ITEM=\"Dad Facebook\" CALL_TEST_MODE=both node scripts/test-call-flows-gui.js'" C-m

tmux select-window -t "${SESSION_NAME}:auth"

if [[ "${ATTACH_MODE}" == "--no-attach" ]]; then
  echo "tmux session '${SESSION_NAME}' created (detached)."
  echo "Attach with: tmux attach -t ${SESSION_NAME}"
  exit 0
fi

exec tmux attach -t "${SESSION_NAME}"
