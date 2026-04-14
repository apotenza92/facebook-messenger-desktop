#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="${ISSUE49_AUTOPILOT_SESSION_NAME:-issue49-autopilot}"
POLL_SECONDS="${ISSUE49_AUTOPILOT_POLL_SECONDS:-300}"
MAX_CYCLES="${ISSUE49_AUTOPILOT_MAX_CYCLES:-8}"
PUBLIC_FLAG="${ISSUE49_AUTOPILOT_PUBLIC:-0}"
DETACHED=false

for arg in "$@"; do
  case "$arg" in
    --detached)
      DETACHED=true
      ;;
    -h|--help)
      cat <<EOF
Usage: ./scripts/start-issue49-autopilot-tmux.sh [--detached]

Environment:
  ISSUE49_AUTOPILOT_PUBLIC=1         enable push + beta release + issue comment
  ISSUE49_AUTOPILOT_POLL_SECONDS=300 poll interval in seconds
  ISSUE49_AUTOPILOT_MAX_CYCLES=8     hard stop after N handled comments
  ISSUE49_AUTOPILOT_WATCH_USERS=a,b  optional reporter login allowlist
  ISSUE49_AUTOPILOT_PI_MODEL=...     optional pi model override
  ISSUE49_AUTOPILOT_PI_THINKING=...  optional pi thinking level override
  ISSUE49_AUTOPILOT_ARGS="..."      extra raw args appended to the watcher command

By default the tmux session starts in dry-run mode and baselines the latest
existing watched comment so it only reacts to future replies. Pass
ISSUE49_AUTOPILOT_ARGS="--replay-history" if you intentionally want backlog replay.
Set ISSUE49_AUTOPILOT_PUBLIC=1 for the bounded beta autopilot that can push to
main, release betas, and post replies.
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required" >&2
  exit 1
fi

if ! command -v pi >/dev/null 2>&1; then
  echo "pi is required" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required" >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/.tmp/issue49-autopilot"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  if [ "$DETACHED" = true ]; then
    echo "tmux session '$SESSION_NAME' already exists."
    exit 0
  fi
  exec tmux attach -t "$SESSION_NAME"
fi

MODE_ARGS=(--loop --poll-seconds "$POLL_SECONDS" --max-cycles "$MAX_CYCLES")
if [ "$PUBLIC_FLAG" = "1" ]; then
  MODE_ARGS+=(--public-actions)
else
  MODE_ARGS+=(--dry-run)
fi

if [ -n "${ISSUE49_AUTOPILOT_PI_MODEL:-}" ]; then
  MODE_ARGS+=(--model "$ISSUE49_AUTOPILOT_PI_MODEL")
fi
if [ -n "${ISSUE49_AUTOPILOT_PI_THINKING:-}" ]; then
  MODE_ARGS+=(--thinking "$ISSUE49_AUTOPILOT_PI_THINKING")
fi
if [ -n "${ISSUE49_AUTOPILOT_WATCH_USERS:-}" ]; then
  IFS=',' read -ra USERS <<< "$ISSUE49_AUTOPILOT_WATCH_USERS"
  for user in "${USERS[@]}"; do
    trimmed="$(echo "$user" | xargs)"
    if [ -n "$trimmed" ]; then
      MODE_ARGS+=(--watch-user "$trimmed")
    fi
  done
fi
if [ -n "${ISSUE49_AUTOPILOT_ARGS:-}" ]; then
  # shellcheck disable=SC2206
  EXTRA_ARGS=( ${ISSUE49_AUTOPILOT_ARGS} )
  MODE_ARGS+=("${EXTRA_ARGS[@]}")
fi

CMD=(node -r ./scripts/register-ts.js scripts/issue49-autopilot.ts "${MODE_ARGS[@]}")

tmux new-session -d -s "$SESSION_NAME" -n watcher -c "$ROOT_DIR"
tmux send-keys -t "$SESSION_NAME:watcher" "echo '[watcher] ${CMD[*]}'" C-m
tmux send-keys -t "$SESSION_NAME:watcher" "${CMD[*]}" C-m

tmux new-window -t "$SESSION_NAME" -n logs -c "$ROOT_DIR"
tmux send-keys -t "$SESSION_NAME:logs" "mkdir -p .tmp/issue49-autopilot && touch .tmp/issue49-autopilot/autopilot.log && tail -f .tmp/issue49-autopilot/autopilot.log" C-m

tmux select-window -t "$SESSION_NAME:watcher"

if [ "$DETACHED" = true ]; then
  echo "tmux session '$SESSION_NAME' created (detached)."
  echo "Attach with: tmux attach -t $SESSION_NAME"
  exit 0
fi

exec tmux attach -t "$SESSION_NAME"
